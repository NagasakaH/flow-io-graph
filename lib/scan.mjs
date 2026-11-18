// scan.mjs — コードを歩いて、API 境界とストレージアクセスのヒント（シグナル）を拾う。
// 原則は「リテラルから決まらないものは張らない」。決まらないものは ref: null で残し、
// worklist.mjs が「原文を確認して注釈で埋めて」と LLM に渡す。
// 依存は node 内置と lib/util.mjs のみ。出力は generatedAt を除き決定的。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, posix } from "node:path";
import { refToNode } from "./util.mjs";

export const DEFAULT_EXCLUDE = [
  ".git", "node_modules", "dist", "build", "out", "coverage", "vendor",
  "__pycache__", ".venv", "venv", ".next", "target",
];

const LANGS = {
  ".py": "python", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
  ".cjs": "javascript", ".ts": "typescript", ".tsx": "typescript", ".go": "go",
  ".java": "java", ".cs": "csharp", ".rb": "ruby", ".php": "php", ".sql": "sql",
  ".sh": "shell", ".tf": "terraform",
};

export const DEFAULT_LIMIT_BYTES = 1024 * 1024;

const IDENT = String.raw`[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?`;

const SERVICE_HOSTS = /^(sqs|s3|sns|dynamodb)\./; // それぞれ専用シグナルで拾う側の URL

// URL リテラルから http/<host>/<path> 形 ref を作る。決まらなければ null。
function refFromUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!host || SERVICE_HOSTS.test(host)) return null;
  const segs = url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s).replace(/\.ext$/, ""));
  return ["http", host, ...segs].join("/");
}

// SQS/SNS の URL・ARN は最後の名前セグメントを採る
function refFromArnOrUrl(kind, raw) {
  if (/^https?:\/\//.test(raw)) {
    try {
      const segs = new URL(raw).pathname.split("/").filter(Boolean);
      const last = segs[segs.length - 1];
      return last ? `${kind}/${last}` : null;
    } catch {
      return null;
    }
  }
  const m = raw.split(/[:/]/).filter(Boolean);
  const last = m[m.length - 1];
  return last ? `${kind}/${last}` : null;
}

/**
 * シグナル表。side: store / boundary。ref(m) は "<subtype>/<name>" 参照か null。
 * lineHit: その名前の関数が見たら ref 無しで通告する（リテラル決定は ref が担う）。
 */
const PATTERNS = [
  // --- SQL ---
  { signal: "sql-read", side: "store", re: new RegExp(String.raw`\b(?:from|join)\s+(${IDENT})`, "gi"), ref: (m) => `table/${m[1]}` },
  { signal: "sql-write", side: "store", re: new RegExp(String.raw`\binsert\s+into\s+(${IDENT})`, "gi"), ref: (m) => `table/${m[1]}` },
  { signal: "sql-write", side: "store", re: new RegExp(String.raw`\bupdate\s+(${IDENT})\s+set\b`, "gi"), ref: (m) => `table/${m[1]}` },
  { signal: "sql-write", side: "store", re: new RegExp(String.raw`\bdelete\s+from\s+(${IDENT})`, "gi"), ref: (m) => `table/${m[1]}` },
  { signal: "sql-write", side: "store", re: new RegExp(String.raw`\b(?:create|drop|truncate|alter)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?(${IDENT})`, "gi"), ref: (m) => `table/${m[1]}` },
  { signal: "sql-write", side: "store", re: new RegExp(String.raw`\bmerge\s+into\s+(${IDENT})`, "gi"), ref: (m) => `table/${m[1]}` },
  // --- ファイル ---
  { signal: "file-read", side: "store", re: /\b(?:read_?(?:all|lines)?file(?:sync)?|read_csv|read_excel|loadtxt|File\.(?:read|readlines))\s*\(\s*['"`]([^'"`]+)['"`]/gi, ref: (m) => `file/${m[1]}` },
  { signal: "file-write", side: "store", re: /\b(?:write_?file(?:sync)?|to_csv|to_excel|savefig|imwrite|File\.(?:write|write_async))\s*\(\s*['"`]([^'"`]+)['"`]/gi, ref: (m) => `file/${m[1]}` },
  { signal: "file-write", side: "store", re: /\bto_csv\s*\(\s*\)/gi, ref: () => null },
  { signal: "file-write", side: "store", re: /\bopen\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][^'"]*[wax]/gi, ref: (m) => `file/${m[1]}` },
  { signal: "file-read", side: "store", re: /\bopen\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]r[^\s'"]*['"])?\s*\)/gi, ref: (m) => `file/${m[1]}` },
  // --- S3 ---
  { signal: "s3", side: "store", re: /\bs3:\/\/([a-z0-9][a-z0-9.\-_]+)(?:\/([^\s'"`,)]+))?/gi, ref: (m) => ["s3", m[1], ...(m[2] ? m[2].split("/").filter(Boolean) : [])].join("/") },
  { signal: "s3", side: "store", re: /\bBucket\s*[=:]\s*['"]([^'"]+)['"]/gi, ref: (m) => `s3/${m[1]}` },
  // --- キュー / トピック / KV（キー名は CamelCase と snake_case の両方を受ける） ---
  { signal: "queue", side: "store", re: /\bqueue[_ ]?(?:url|name|arn)?\s*[=:]\s*['"]([^'"]+)['"]/gi, ref: (m) => refFromArnOrUrl("queue", m[1]) },
  { signal: "queue", side: "store", re: /\b(?:send_message|receive_message|publish_message)\s*\(/gi, ref: () => null },
  { signal: "topic", side: "store", re: /\btopic[_ ]?(?:arn|name)?\s*[=:]\s*['"]([^'"]+)['"]/gi, ref: (m) => refFromArnOrUrl("topic", m[1]) },
  { signal: "topic", side: "store", re: /\b(?:producer|kafka)\.send\s*\(\s*['"]([^'"]+)['"]/gi, ref: (m) => `topic/${m[1]}` },
  { signal: "kv", side: "store", re: /\b(?:rdb|redis|cache|cacheClient)\.(?:get|set|setex|hget|hset|del|delete)\s*\(\s*(?:ctx,\s*)?['"]([^'"]+)['"]/gi, ref: (m) => `kv/${m[1]}` },
  { signal: "dynamodb", side: "store", re: /\btable[_ ]?name\s*[=:]\s*['"]([^'"]+)['"]/gi, ref: (m) => `table/${m[1]}` },
  // --- 境界 ---
  { signal: "http-call", side: "boundary", re: /['"`](https?:\/\/[^'"`\s]+)['"`]/g, ref: (m) => refFromUrl(m[1]), skipNull: true }, // SQS/S3 の URL は専用シグナル側で拾うので here は黙る
  { signal: "http-call", side: "boundary", re: /\b(?:fetch|axios|requests|httpx|got|urllib|Net::HTTP|HttpClient)\b[.\w]*\s*[(<]/g, ref: () => null },
  { signal: "lambda-invoke", side: "boundary", re: /\bfunction[_ ]?(?:name|arn)\s*[=:]\s*['"]([^'"]+)['"]/gi, ref: (m) => `lambda/${m[1]}` },
  { signal: "sfn-start", side: "boundary", re: /\bstate[_ ]?machine[_ ]?(?:arn|name)?\s*[=:]\s*['"]([^'"]+)['"]/gi, ref: (m) => refFromArnOrUrl("sfn", m[1]) },
];

const COMMENT_PREFIX = /^[#*/-]{1,2}\s/;
function isComment(line) {
  const t = line.trim();
  return t.startsWith("#") || t.startsWith("//") || t.startsWith("--") || t.startsWith("*") || t.startsWith("/*");
}

export function scanText(text, path) {
  const signals = [];
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  lines.forEach((line, idx) => {
    if (isComment(line)) return;
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line)) !== null) {
        if (m[0].length === 0) {
          p.re.lastIndex += 1;
          continue;
        }
        const ref = p.ref(m);
        if (ref === null && p.skipNull) continue;
        const key = `${p.signal}\u0000${ref ?? ""}\u0000${idx}`;
        if (seen.has(key)) continue;
        seen.add(key);
        signals.push({
          signal: p.signal,
          ref,
          line: idx + 1,
          snippet: line.trim().replace(/\s+/g, " ").slice(0, 120),
        });
      }
    }
  });
  signals.sort((a, b) => a.line - b.line || a.signal.localeCompare(b.signal) || String(a.ref).localeCompare(String(b.ref)));
  return signals;
}

function walk(dir, root, exclude, limitBytes, skipped, acc) {
  for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (exclude.includes(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, root, exclude, limitBytes, skipped, acc);
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = extname(ent.name).toLowerCase();
    const lang = LANGS[ext];
    if (!lang) continue;
    const size = statSync(full).size;
    if (size > limitBytes) {
      skipped.push(posix.relative(root, full).replaceAll("\\", "/"));
      continue;
    }
    acc.push({ path: posix.relative(root, full).replaceAll("\\", "/"), lang, full });
  }
}

export function scanRepo({ root, exclude = [], limitBytes = DEFAULT_LIMIT_BYTES, generatedAt = new Date().toISOString() }) {
  const excludeSet = [...new Set([...DEFAULT_EXCLUDE, ...exclude])];
  const skipped = [];
  const found = [];
  walk(root, root, excludeSet, limitBytes, skipped, found);
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const files = [];
  const storeEv = new Map();
  const boundaryEv = new Map();
  for (const f of found) {
    let text;
    try {
      text = readFileSync(f.full, "utf8");
    } catch {
      continue;
    }
    const signals = scanText(text, f.path);
    files.push({ path: f.path, lang: f.lang, signals });
    for (const s of signals) {
      if (!s.ref) continue;
      const side = /^(http|lambda|sfn|grpc|cli)\//.test(s.ref) ? "boundary" : "store";
      const parsed = refToNode(s.ref, side);
      if (!parsed) continue;
      const ev = { path: f.path, line: s.line, snippet: s.snippet, signal: s.signal };
      const map = side === "store" ? storeEv : boundaryEv;
      if (!map.has(parsed.id)) {
        map.set(parsed.id, {
          id: parsed.id,
          name: parsed.name,
          [side === "store" ? "storeKind" : "boundaryKind"]: parsed.subtype,
          evidence: [],
        });
      }
      map.get(parsed.id).evidence.push(ev);
    }
  }
  const sortEv = (list) =>
    list
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((c) => ({ ...c, evidence: c.evidence.sort((x, y) => x.path.localeCompare(y.path) || (x.line ?? 0) - (y.line ?? 0)) }));

  return {
    schemaVersion: 1,
    generatedAt,
    root,
    files,
    stores: sortEv([...storeEv.values()]),
    boundaries: sortEv([...boundaryEv.values()]),
    skippedLargeFiles: skipped.sort(),
  };
}
