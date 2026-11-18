// 共通ユーティリティ。決定性（同じ入力 → 同じ出力）を保つための約束をここに集める。

import { readFileSync } from "node:fs";

/** JSON にコメント（// と /* *​/) を許すローダ。文字列リテラル内の // は壊さない。 */
export function parseJsonc(text, label = "<memory>") {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  try {
    return JSON.parse(out);
  } catch (err) {
    throw new Error(`${label}: JSON として解釈できません — ${err.message}`);
  }
}

export function readJsoncFile(path) {
  return parseJsonc(readFileSync(path, "utf8"), path);
}

export const STORE_KINDS = new Set(["table", "file", "s3", "queue", "topic", "kv", "other"]);
export const BOUNDARY_KINDS = new Set(["http", "lambda", "sfn", "grpc", "cli", "other"]);

/** ID セグメントの揺らぎを寄せる: 小文字化、空白と _ を - に。表示名ではなく ID だけに通す。 */
export function normalizeIdSegment(seg) {
  return String(seg)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * "<storeKind>/<path...>" 形の参照を正規化 ID にする。
 * kind が store 側か boundary 側かで受け付ける種別を変える。
 * @returns {{ id: string, kind: "store"|"boundary", subtype: string, name: string } | null}
 */
export function refToNode(ref, side) {
  if (typeof ref !== "string") return null;
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const subtype = normalizeIdSegment(ref.slice(0, slash));
  const rest = ref.slice(slash + 1).trim();
  if (!rest) return null;
  const allowed = side === "boundary" ? BOUNDARY_KINDS : STORE_KINDS;
  if (!allowed.has(subtype)) return null;
  const segs = rest.split("/").map(normalizeIdSegment);
  if (segs.some((seg) => seg === "." || seg === "..")) return null; // 相対パスの抜け道は作らない
  const path = segs.filter(Boolean).join("/");
  if (!path) return null;
  return {
    id: `${side}:${subtype}/${path}`,
    kind: side,
    subtype,
    name: rest, // 表示名は原表記を生かす（テーブルの大文字など）
  };
}

/** ノード ID がどの kind かわかる形なら kind を返す（注釈の妥当性チェック用）。 */
export function kindOfId(id) {
  if (typeof id !== "string") return null;
  if (id.startsWith("flow:")) return "flow";
  if (id.startsWith("step:")) return "step";
  if (id.startsWith("store:")) return "store";
  if (id.startsWith("boundary:")) return "boundary";
  if (id.startsWith("code:")) return "code";
  return null;
}

export const EDGE_KINDS = new Set([
  "contains",
  "next",
  "reads",
  "writes",
  "invokes",
  "implemented-by",
  "touches",
]);

export const PROVENANCES = new Set(["definition", "static", "llm", "human"]);

/** 決定的なソート比較（文字列の辞書順）。出力の並べ順は必ずこれを通す。 */
export function byString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function edgeKey(e) {
  return `${e.source}\u0000${e.kind}\u0000${e.target}`;
}
