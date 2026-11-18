#!/usr/bin/env node
// merge.mjs — フロー定義 + scan.json + annotations → graph.json
// 出力は決定的: ノードは id 順、エッジは (source, kind, target) 順。
// generatedAt を除けば同じ入力から同じバイト列が出る。

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  readJsoncFile,
  refToNode,
  kindOfId,
  EDGE_KINDS,
  byString,
  edgeKey,
} from "../lib/util.mjs";

const HELP = `merge.mjs — フロー定義 + scan + annotations を graph.json に統合する

使い方:
  node bin/merge.mjs --out graph.json [--flows <dir>] [--scan <scan.json>]
      [--annotation <annotations.json> ...] [--root <repo>]

オプション:
  --flows <dir>        フロー定義 (*.json) のディレクトリ（省略可）
  --scan <file>        scan.mjs の出力（省略可）
  --annotation <file>  注釈ファイル。繰り返し指定可。読み順は名前の並べ順どおり
  --root <dir>         graph.json に記録するリポジトリパス（既定: --scan の root か カレント）
  --out <file>         出力先（必須）
  --help               この表示
`;

const { values: opt } = parseArgs({
  options: {
    flows: { type: "string" },
    scan: { type: "string" },
    annotation: { type: "string", multiple: true, default: [] },
    root: { type: "string" },
    out: { type: "string" },
    help: { type: "boolean" },
  },
  allowPositionals: false,
});

if (opt.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (!opt.out) {
  process.stderr.write("エラー: --out は必須です。\n\n" + HELP);
  process.exit(2);
}

const warnings = [];
function warn(msg) {
  warnings.push(msg);
  process.stderr.write(`警告: ${msg}\n`);
}

/** ノード表。first-wins の名前と metadata のマージ規則をここに集中させる。 */
const nodes = new Map();
/** @returns 既存か新規のノード */
function addNode(id, kind, name, metadata = {}, origin = "definition") {
  const existing = nodes.get(id);
  if (!existing) {
    if (metadata.candidate === false) delete metadata.candidate; // 新規ノードに false は書かない
    const node = { id, kind, name, metadata: { ...metadata } };
    if (metadata.provenance === undefined) node.metadata.provenance = origin;
    nodes.set(id, node);
    return node;
  }
  // 候補ノード（scan 由来）に定義/注釈が着地した形: 候補フラグを下ろし、名前を上位由来で更新する
  const rank = { static: 0, definition: 1, llm: 2, human: 3 };
  if ((existing.metadata.candidate || rank[origin] > rank[existing.metadata.provenance ?? "definition"]) && name) {
    existing.name = name;
  }
  if (rank[origin] > rank[existing.metadata.provenance ?? "definition"]) existing.metadata.provenance = origin;
  if (metadata.candidate === false) delete existing.metadata.candidate;
  for (const [k, v] of Object.entries(metadata)) {
    if (k === "provenance" || k === "candidate") continue; // candidate は上で明示処理済み
    if (k === "evidence" && Array.isArray(v)) {
      existing.metadata.evidence = [...(existing.metadata.evidence ?? []), ...v];
      continue;
    }
    if (existing.metadata[k] === undefined) existing.metadata[k] = v;
  }
  return existing;
}

const edges = new Map(); // edgeKey → edge（lower-rank の重複は note を上位へ寄せる）
const EDGE_RANK = { definition: 0, static: 1, llm: 2, human: 3 };
function addEdge(source, target, kind, { provenance = "definition", confidence, note, metadata } = {}) {
  if (!nodes.has(source) || !nodes.has(target)) {
    warn(`エッジの端点が存在しないので捨てました: ${source} -${kind}-> ${target}`);
    return null;
  }
  if (source === target) return null; // 自己ループは張らない
  const key = edgeKey({ source, kind, target });
  const edge = { source, target, kind, provenance, ...(confidence !== undefined ? { confidence } : {}), ...(note ? { note } : {}), ...(metadata ? { metadata } : {}) };
  const kept = edges.get(key);
  if (!kept) {
    edges.set(key, edge);
    return edge;
  }
  if (EDGE_RANK[edge.provenance] > EDGE_RANK[kept.provenance] && edge.note) {
    (kept.metadata ??= {}).notesFrom = [
      ...((kept.metadata?.notesFrom) ?? []),
      { provenance: edge.provenance, confidence: edge.confidence ?? null, note: edge.note },
    ];
  }
  return kept;
}

// ---- 1. scan.json -------------------------------------------------------

let scanRoot = null;
if (opt.scan) {
  const scan = readJsoncFile(opt.scan);
  scanRoot = scan.root ?? null;
  for (const f of scan.files ?? []) {
    addNode(`code:${f.path}`, "code", f.path, {
      lang: f.lang,
      provenance: "static",
      signals: (f.signals ?? []).slice(0, 50),
    });
  }
  const signalAccess = (signal) => {
    if (!signal) return "access";
    if (signal.endsWith("-read")) return "read";
    if (signal.endsWith("-write")) return "write";
    if (["http-call", "lambda-invoke", "sfn-start"].includes(signal)) return "invoke";
    return "access";
  };
  const candidate = (list, kindField, metaField) => {
    for (const c of list ?? []) {
      const kind = kindOfId(c.id);
      if (kind !== "store" && kind !== "boundary") {
        warn(`scan の候補 ID が規則外です（スキップ）: ${c.id}`);
        continue;
      }
      addNode(c.id, kind, c.name ?? c.id, {
        [metaField]: c[kindField] ?? c.id.split(":")[1].split("/")[0],
        candidate: true,
        evidence: c.evidence ?? [],
        provenance: "static",
      });
    }
  };
  candidate(scan.stores, "storeKind", "storeKind");
  candidate(scan.boundaries, "boundaryKind", "boundaryKind");
  // code → store/boundary の touches。同一 (code, target) は 1 本に集約して evidence へ寄せる
  for (const f of scan.files ?? []) {
    for (const s of f.signals ?? []) {
      if (!s.ref) continue;
      const side = s.ref.startsWith("http/") || /^(lambda|sfn|grpc|cli)\//.test(s.ref) ? "boundary" : "store";
      const parsed = refToNode(s.ref, side);
      if (!parsed) continue;
      if (!nodes.has(parsed.id)) {
        // candidates 一覧から漏れた ref はその場で候補として起こす
        addNode(parsed.id, parsed.kind, parsed.name, {
          [parsed.kind === "store" ? "storeKind" : "boundaryKind"]: parsed.subtype,
          candidate: true,
          provenance: "static",
        });
      }
      const line = { path: f.path, line: s.line ?? null, snippet: s.snippet ?? "", signal: s.signal };
      const kept = addEdge(`code:${f.path}`, parsed.id, "touches", {
        provenance: "static",
        confidence: 1,
        metadata: { access: signalAccess(s.signal), evidence: [line] },
      });
      if (kept && kept.provenance === "static" && kept.metadata?.evidence) {
        const ev = kept.metadata.evidence;
        if (!ev.some((e) => e.path === line.path && e.line === line.line && e.signal === line.signal)) ev.push(line);
      }
    }
  }
}

// ---- 2. flows/*.json ----------------------------------------------------

if (opt.flows) {
  const files = readdirSync(opt.flows)
    .filter((f) => f.endsWith(".json"))
    .sort(byString)
    .map((f) => join(opt.flows, f));
  for (const file of files) {
    const doc = readJsoncFile(file);
    for (const flow of doc.flows ?? []) {
      if (!flow.id) {
        warn(`${file}: id の無い flow をスキップ`);
        continue;
      }
      const flowId = `flow:${flow.id}`;
      addNode(flowId, "flow", flow.name ?? flow.id, {
        owner: flow.owner,
        description: flow.description,
        provenance: "definition",
      });
      let prev = null;
      let order = 0;
      for (const step of flow.steps ?? []) {
        if (!step.id) {
          warn(`${file}: flow ${flow.id} に id の無い step をスキップ`);
          continue;
        }
        order += 1;
        const stepId = `step:${flow.id}/${step.id}`;
        if (nodes.has(stepId)) warn(`${file}: step ${stepId} が重複しています（縁は追記）`);
        const node = addNode(stepId, "step", step.name ?? step.id, {
          docs: step.docs,
          description: step.description,
          provenance: "definition",
        });
        node.parent = flowId;
        addEdge(flowId, stepId, "contains", { provenance: "definition", confidence: 1, metadata: { order } });
        if (prev) addEdge(prev, stepId, "next", { provenance: "definition", confidence: 1, metadata: { order } });
        prev = stepId;
        for (const [field, kind, side] of [
          ["reads", "reads", "store"],
          ["writes", "writes", "store"],
          ["invokes", "invokes", "boundary"],
        ]) {
          for (const ref of step[field] ?? []) {
            const parsed = refToNode(ref, side);
            if (!parsed) {
              warn(`${file}: step ${stepId} の ${field} 参照 "${ref}" が規則外なので捨てました（"<種別>/<パス>" 形へ直してください）`);
              continue;
            }
            addNode(parsed.id, parsed.kind, parsed.name, {
              [parsed.kind === "store" ? "storeKind" : "boundaryKind"]: parsed.subtype,
              candidate: false,
              provenance: "definition",
            });
            addEdge(stepId, parsed.id, kind, { provenance: "definition", confidence: 1 });
          }
        }
      }
    }
  }
}

// ---- 3. annotations ------------------------------------------------------

for (const file of [...(opt.annotation ?? [])].sort(byString)) {
  const doc = readJsoncFile(file);
  const producer = doc.producer === "human" ? "human" : "llm";
  if (doc.producer && doc.producer !== "llm" && doc.producer !== "human")
    warn(`${file}: producer "${doc.producer}" は llm に解釈し直しました`);

  for (const n of doc.nodes ?? []) {
    const kind = kindOfId(n.id);
    if (!kind || !["store", "boundary"].includes(kind)) {
      warn(`${file}: 注釈ノード ${n.id} は store:/boundary: の規則外なので捨てました（flow/step/code は注釈で作れない）`);
      continue;
    }
    addNode(n.id, kind, n.name ?? n.id, { ...(n.metadata ?? {}), provenance: producer });
  }

  for (const e of doc.edges ?? []) {
    const kind = e.kind;
    if (!EDGE_KINDS.has(kind)) {
      warn(`${file}: 未知の edge kind "${kind}" を捨てました (${e.source} -> ${e.target})`);
      continue;
    }
    if (!nodes.has(e.source) || !nodes.has(e.target)) {
      warn(`${file}: 存在しないノードへのエッジを捨てました: ${e.source} -${kind}-> ${e.target}（先に graph.json を読んで ID を合わせてください）`);
      continue;
    }
    let confidence = e.confidence;
    if (typeof confidence !== "number" || Number.isNaN(confidence)) {
      warn(`${file}: ${e.source} -${kind}-> ${e.target} に confidence が無いので 0.7 としました（注釈は必ず根拠と確度を）`);
      confidence = 0.7;
    }
    confidence = Math.min(1, Math.max(0, confidence));
    if (!e.note) warn(`${file}: ${e.source} -${kind}-> ${e.target} に note がありません（根拠を書いてください）`);
    addEdge(e.source, e.target, kind, { provenance: producer, confidence, note: e.note });
  }

  for (const m of doc.metadata ?? []) {
    const match = m.match ?? {};
    const hits = [...nodes.values()].filter((n) => {
      if (Object.keys(match).length === 0) return false;
      if (match.kind && n.kind !== match.kind) return false;
      if (match.id && n.id !== match.id) return false;
      if (match.path && n.id !== `code:${match.path}`) return false;
      if (match.name && n.name !== match.name) return false;
      return true;
    });
    if (hits.length === 0) warn(`${file}: metadata 注釈の match が 0 件: ${JSON.stringify(match)}`);
    else if (hits.length > 1) warn(`${file}: metadata 注釈の match が ${hits.length} 件あって採用しません: ${JSON.stringify(match)}`);
    else Object.assign(hits[0].metadata, m.set ?? {});
  }
}

// ---- 4. 出力 -------------------------------------------------------------

const graph = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  root: opt.root ?? scanRoot ?? process.cwd(),
  nodes: [...nodes.values()].sort((a, b) => byString(a.id, b.id)),
  edges: [...edges.values()].sort((a, b) => byString(edgeKey(a), edgeKey(b))),
  warnings: warnings.sort(byString),
};

mkdirSync(dirname(opt.out), { recursive: true });
writeFileSync(opt.out, JSON.stringify(graph, null, 2) + "\n");
const counts = {};
for (const n of graph.nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
process.stdout.write(
  `graph.json: ${graph.nodes.length} ノード (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" / ")}) / ` +
    `${graph.edges.length} 縁 / 警告 ${graph.warnings.length} 件 → ${opt.out}\n`,
);
