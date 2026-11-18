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
/** store/boundary の ID は参照と同じ規則に寄せる（Order_Items と order-items が別ノードに分裂するのを防ぐ） */
function canonicalId(id) {
  const kind = kindOfId(id);
  if (!kind || (kind !== "store" && kind !== "boundary")) return id;
  const norm = refToNode(id.slice(kind.length + 1), kind);
  return norm ? norm.id : null;
}

// touches が取れる access。判定と警告の両方から参照し、警告を読んだ人が正しい値を
// 選べるようにする（unknown = 方向未判定）
const TOUCH_ACCESS = ["read", "write", "invoke", "unknown"];

// 縁の端点の型規則。注釈由来でも手作りでも、契約（docs/schema.md）の向きのまましか張らない
const EDGE_SHAPE = {
  contains: (s, t) => s.kind === "flow" && t.kind === "step" && t.parent === s.id,
  next: (s, t) => s.kind === "step" && t.kind === "step" && s.parent === t.parent,
  reads: (s, t) => ["step", "boundary"].includes(s.kind) && t.kind === "store",
  writes: (s, t) => ["step", "boundary"].includes(s.kind) && t.kind === "store",
  invokes: (s, t) => s.kind === "step" && t.kind === "boundary",
  "implemented-by": (s, t) => s.kind === "step" && t.kind === "code",
  touches: (s, t) => s.kind === "code" && ["store", "boundary"].includes(t.kind),
};

function addEdge(source, target, kind, { provenance = "definition", confidence, note, metadata } = {}) {
  if (!nodes.has(source) || !nodes.has(target)) {
    warn(`エッジの端点が存在しないので捨てました: ${source} -${kind}-> ${target}`);
    return null;
  }
  if (!(EDGE_SHAPE[kind] ?? (() => true))(nodes.get(source), nodes.get(target))) {
    warn(`エッジの端点の型が規則外なので捨てました: ${source} -${kind}-> ${target}`);
    return null;
  }
  if (source === target && kind !== "next") return null; // 自己ループは next（自分自身への分岐）だけ許す
  // next は条件ラベルとループ旗、touches は access が違う縁は別縁として立てる
  // （同一端点で黙って統合すると、条件や読み書きが最初の 1 本に吸収されて消える）
  let key = edgeKey({ source, kind, target });
  if (kind === "next") {
    if (metadata && Object.hasOwn(metadata, "label")) key += `|label:${JSON.stringify(metadata.label)}`;
    if (metadata?.loop) key += "|loop";
  }
  if (kind === "touches" && metadata?.access) key += `|${metadata.access}`;
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
    // 方向が特定できないスキャン信号は "unknown"（方向未判定）。view は「方向未判定」と出す。
    // kind 名 "touches" と同じ語を値にすると `access: access` と訳が分からなくなる
    if (!signal) return "unknown";
    if (signal.endsWith("-read")) return "read";
    if (signal.endsWith("-write")) return "write";
    if (["http-call", "lambda-invoke", "sfn-start"].includes(signal)) return "invoke";
    return "unknown";
  };
  const candidate = (list, kindField, metaField) => {
    for (const c of list ?? []) {
      const id = canonicalId(c.id);
      const kind = id ? kindOfId(id) : null;
      if (kind !== "store" && kind !== "boundary") {
        warn(`scan の候補 ID が規則外です（スキップ）: ${c.id}`);
        continue;
      }
      addNode(id, kind, c.name ?? c.id, {
        [metaField]: c[kindField] ?? c.id.split(":")[1].split("/")[0],
        candidate: true,
        evidence: c.evidence ?? [],
        provenance: "static",
      });
    }
  };
  candidate(scan.stores, "storeKind", "storeKind");
  candidate(scan.boundaries, "boundaryKind", "boundaryKind");
  // code → store/boundary の touches。同一 (code, target, access) を 1 本に集約して evidence へ寄せる
  for (const f of scan.files ?? []) {
    for (const s of f.signals ?? []) {
      if (!s.ref) continue;
      // invoke 系信号は boundary 側、他は store 側を先に試す。外れたら反対側も評価し、
      // 両方で規則外なら黙って捨てず警告する（HTTP/... の大文字混じりも正規化で拾う）
      const preferred = signalAccess(s.signal) === "invoke" ? "boundary" : "store";
      const parsed = refToNode(s.ref, preferred) ?? refToNode(s.ref, preferred === "store" ? "boundary" : "store");
      if (!parsed) {
        warn(`scan の参照が規則外なので捨てました: ${JSON.stringify(s.ref)}（${f.path}:${s.line ?? "?"}、"<種別>/<パス>" 形へ）`);
        continue;
      }
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
      if (nodes.has(flowId)) warn(`${file}: flow ${flowId} は別定義とマージされます（id を変えてください）`);
      const { id: _fid, name: _fname, owner: fOwner, description: fDesc, steps: _fSteps, ...flowMeta } = flow;
      addNode(flowId, "flow", flow.name ?? flow.id, {
        ...(fOwner !== undefined ? { owner: fOwner } : {}),
        ...(fDesc !== undefined ? { description: fDesc } : {}),
        ...flowMeta, // docs/sla など自由キーは metadata に残す
        provenance: "definition",
      });
      if ((flow.steps ?? []).length === 0) warn(`${file}: flow ${flowId} に steps がありません`);
      // 1 周目: ノードと入出力（branches の to が前方参照でも良いように、縁は 2 周目にまとめて張る）
      const seq = []; // { stepId, step, order }
      let order = 0;
      for (const step of flow.steps ?? []) {
        if (!step.id) {
          warn(`${file}: flow ${flow.id} に id の無い step をスキップ`);
          continue;
        }
        const stepId = `step:${flow.id}/${step.id}`;
        if (nodes.has(stepId)) {
          warn(`${file}: step ${stepId} が重複しています（後の定義をスキップ）`);
          continue;
        }
        order += 1;
        // branches は「キーの有無」で意味を持つ。空配列でも出口は抑止し、枝不足として警告する
        const hasBranchesKey = Object.hasOwn(step, "branches");
        if (hasBranchesKey && !Array.isArray(step.branches)) {
          warn(`${file}: ${stepId} の branches は配列でなければなりません（無視します）`);
          step.branches = [];
        }
        const hasBranches = hasBranchesKey && step.branches.length > 0;
        let gateway = step.kind === "gateway";
        if (hasBranchesKey && !gateway) {
          warn(`${file}: ${stepId} に branches キーがあるため kind: "gateway" として扱いました（宣言を推奨）`);
          gateway = true;
        }
        if (gateway && !hasBranchesKey) warn(`${file}: gateway ${stepId} に branches が無く、ただの通過点です`);
        if (gateway && hasBranchesKey && step.branches.length < 2)
          warn(`${file}: gateway ${stepId} の branches が ${step.branches.length} 本しかありません（分岐の意味を再考してください）`);
        const { id: _sid, name: _sname, kind: _skind, docs: sDocs, description: sDesc, branches: _sBr, reads: _sr, writes: _sw, invokes: _si, ...stepMeta } = step;
        const node = addNode(stepId, "step", step.name ?? step.id, {
          ...(sDocs !== undefined ? { docs: sDocs } : {}),
          ...(sDesc !== undefined ? { description: sDesc } : {}),
          ...stepMeta, // 自由キー（team など）は metadata に残す
          ...(gateway ? { stepKind: "gateway" } : {}),
          provenance: "definition",
        });
        node.parent = flowId;
        addEdge(flowId, stepId, "contains", { provenance: "definition", confidence: 1, metadata: { order } });
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
        seq.push({ stepId, step, order });
      }
      // 2 周目: next 縁（branches があれば全て明示、無ければ前ステップから暗黙の直列）
      const orderOf = new Map(seq.map((s) => [s.stepId, s.order]));
      let prev = null;
      for (const { stepId, step, order: ord } of seq) {
        const hasBranches = Object.hasOwn(step, "branches"); // 空配列でも「明示分岐のみ」という宣言とみなす
        // 前が線形ステップなら、次が gateway でも通常タスクでも暗黙の次へを張る
        // （抑止するのは branches を持つステップの「出口」だけ）
        if (prev) {
          addEdge(prev, stepId, "next", { provenance: "definition", confidence: 1, metadata: { order: ord } });
        }
        if (hasBranches) {
          if (!Array.isArray(step.branches)) {
            warn(`${file}: ${stepId} の branches が配列ではないので暗黙の次へも張らずにスキップしました`);
            prev = null;
            continue;
          }
          for (const b of step.branches) {
            // null や to が無い要素で b.to が例外になると、他の正常な分岐ごと生成が止まる。
            // 契約は「無効な宛先は警告」なので、この分岐だけ捨てて続行する
            if (typeof b?.to !== "string" || !b.to.trim()) {
              warn(`${file}: ${stepId} の branches に有効な to がありません（この分岐をスキップ）`);
              continue;
            }
            const targetId = `step:${flow.id}/${b.to}`;
            // 前方向（自身含む）への分岐はループ。自身への to は自分自身に戻る縁として残す
            const loop = orderOf.has(targetId) && orderOf.get(targetId) <= ord;
            const kept = addEdge(stepId, targetId, "next", {
              provenance: "definition",
              confidence: 1,
              metadata: {
                order: orderOf.get(targetId) ?? ord,
                ...(typeof b.label === "string" ? { label: b.label } : {}), // 空文字ラベルも保持
                ...(loop ? { loop: true } : {}),
              },
            });
            if (loop && kept) process.stdout.write(`ループ検出: ${stepId} → ${targetId}${b.label ? ` (${b.label})` : ""}\n`);
          }
          prev = null; // 分岐ステップからの暗黙の次へは張らない
          continue;
        }
        prev = stepId;
      }
      // 到達不能チェック: 入口（配列先頭）から next を辿って届かないステップは定義の穴。
      // 入次数だけでは、入口側から孤立した島（例: A→D の中で浮いている B⇄C）を見逃す
      const flowIds = new Set(seq.map((s) => s.stepId));
      const nextOf = new Map();
      for (const e of edges.values()) {
        if (e.kind === "next" && flowIds.has(e.source) && flowIds.has(e.target)) {
          if (!nextOf.has(e.source)) nextOf.set(e.source, new Set());
          nextOf.get(e.source).add(e.target);
        }
      }
      const seen = new Set();
      const stack = seq.length ? [seq[0].stepId] : [];
      while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const t of nextOf.get(cur) ?? []) stack.push(t);
      }
      for (const { stepId } of seq) {
        if (!seen.has(stepId))
          warn(`${file}: ${stepId} は入口 ${seq[0].stepId} から next で到達できません（branches の to か並び順を確認してください）`);
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
    const id = canonicalId(n.id);
    const kind = id ? kindOfId(id) : null;
    if (!kind || !["store", "boundary"].includes(kind)) {
      warn(`${file}: 注釈ノード ${n.id} は store:/boundary: の規則外なので捨てました（flow/step/code は注釈で作れない）`);
      continue;
    }
    addNode(id, kind, n.name ?? n.id, { ...(n.metadata ?? {}), provenance: producer });
  }

  for (const raw of doc.edges ?? []) {
    const kind = raw.kind;
    if (!EDGE_KINDS.has(kind)) {
      warn(`${file}: 未知の edge kind "${kind}" を捨てました (${raw.source} -> ${raw.target})`);
      continue;
    }
    const e = { ...raw, source: canonicalId(raw.source), target: canonicalId(raw.target) };
    if (e.source === null || e.target === null) {
      warn(`${file}: エッジ端点 ${e.source === null ? raw.source : raw.target} が規則外なので捨てました (${raw.source} -${kind}-> ${raw.target})`);
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
    // metadata を種別ごとに引き継ぐ。捨てると addEdge の縁分け（label・access・loop）に
    // 届かず、条件違いの next や読み書き違いの touches が定義縁に黙って統合される
    let metadata;
    if (kind === "next") {
      metadata = {};
      if (e.metadata && typeof e.metadata.label === "string") metadata.label = e.metadata.label;
      const orderOf = (stepId) => {
        for (const ed of edges.values()) {
          if (ed.kind === "contains" && ed.target === stepId) return ed.metadata?.order;
        }
        return undefined;
      };
      const os = orderOf(e.source);
      const ot = orderOf(e.target);
      // 宛先の順番を継承しないと、注釈だけで作った分岐が展開時の行先一覧で
      // 常に 0 番目（定義の分岐より前）に並んでしまう
      if (ot !== undefined) metadata.order = ot;
      if (os !== undefined && ot !== undefined && ot <= os) metadata.loop = true; // 定義側と同じ「戻る縁はループ」
      if (Object.keys(metadata).length === 0) metadata = undefined;
    } else if (kind === "touches") {
      const acc = e.metadata?.access;
      if (acc !== undefined) {
        if (!TOUCH_ACCESS.includes(acc)) {
          warn(`${file}: touches の access "${acc}" が規則外なので縁を捨てました (${e.source} -> ${e.target}。${TOUCH_ACCESS.join(" / ")} のいずれか)`);
          continue;
        }
        metadata = { access: acc };
      }
    }
    addEdge(e.source, e.target, kind, {
      provenance: producer,
      confidence,
      note: e.note,
      ...(metadata ? { metadata } : {}),
    });
  }

  for (const m of doc.metadata ?? []) {
    const match = m.match ?? {};
    const matchId = match.id === undefined ? undefined : canonicalId(match.id);
    if (match.id !== undefined && matchId === null) {
      warn(`${file}: metadata 注釈の match.id ${match.id} が規則外なので採用しません`);
      continue;
    }
    const hits = [...nodes.values()].filter((n) => {
      if (Object.keys(match).length === 0) return false;
      if (match.kind && n.kind !== match.kind) return false;
      if (matchId !== undefined && n.id !== matchId) return false;
      if (match.path && n.id !== `code:${match.path}`) return false;
      if (match.name && n.name !== match.name) return false;
      return true;
    });
    if (hits.length === 0) warn(`${file}: metadata 注釈の match が 0 件: ${JSON.stringify(match)}`);
    else if (hits.length > 1) warn(`${file}: metadata 注釈の match が ${hits.length} 件あって採用しません: ${JSON.stringify(match)}`);
    else {
      // 出所（provenance）は生成時の事実。注釈で「人」「静的解析」に偽装できなくする
      const { provenance: fakeProvenance, ...safe } = m.set ?? {};
      if (fakeProvenance !== undefined) warn(`${file}: metadata 注釈で provenance を上書きできません（${hits[0].id} への指定を無視）`);
      Object.assign(hits[0].metadata, safe);
    }
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
