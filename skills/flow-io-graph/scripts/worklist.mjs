#!/usr/bin/env node
// worklist.mjs — graph.json から「LLM が注釈を書くためのワークシート」を作る。
// 出されたワークシートを読んだ LLM が、コードを開いて annotations/llm.json を書く。
// 手順全体の口は build.mjs --worklist（既定で生成）。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { byString } from "./lib/util.mjs";

const HELP = `worklist.mjs — graph.json から LLM 用の注釈ワークシート (worklist.md) を生成する

使い方:
  node scripts/worklist.mjs --graph graph.json --out worklist.md [--annotation-out annotations/llm.json]

セクション:
  1. I/O が未記入のステップ          2. 未紐づけの候補ストレージ/境界
  3. コードに未紐づきのステップ      4. ref が決まらないシグナル（原文確認待ち）
  5. 注釈の書式と決まりごと
`;

const { values: opt } = parseArgs({
  options: {
    graph: { type: "string" },
    out: { type: "string" },
    "annotation-out": { type: "string", default: "annotations/llm.json" },
    help: { type: "boolean" },
  },
});
if (opt.help || !opt.graph || !opt.out) {
  process.stdout.write(HELP);
  process.exit(opt.help ? 0 : 2);
}

const graph = JSON.parse(readFileSync(opt.graph, "utf8"));
const byId = new Map(graph.nodes.map((n) => [n.id, n]));
const outEdges = new Map();
for (const e of graph.edges) {
  if (!outEdges.has(e.source)) outEdges.set(e.source, []);
  outEdges.get(e.source).push(e);
}

const steps = graph.nodes.filter((n) => n.kind === "step");
const ioKinds = new Set(["reads", "writes", "invokes"]);
// gateway は制御の分岐点で I/O を持たないのが正常なので、未記入扱いしない
const noIo = steps.filter(
  (s) =>
    s.metadata?.stepKind !== "gateway" &&
    !(outEdges.get(s.id) ?? []).some((e) => ioKinds.has(e.kind)),
);
const noImpl = steps.filter((s) => !(outEdges.get(s.id) ?? []).some((e) => e.kind === "implemented-by"));
const candidates = graph.nodes
  .filter((n) => n.metadata?.candidate && ["store", "boundary"].includes(n.kind))
  // steps/boundaries からの縁が無いものだけが「未紐づけ」
  .filter(
    (n) =>
      !graph.edges.some(
        (e) =>
          e.target === n.id &&
          (byId.get(e.source)?.kind === "step" || byId.get(e.source)?.kind === "boundary") &&
          ["reads", "writes", "invokes"].includes(e.kind),
      ),
  )
  .sort((a, b) => byString(a.id, b.id));
const nullSignals = [];
for (const n of graph.nodes.filter((x) => x.kind === "code")) {
  for (const s of n.metadata?.signals ?? []) {
    if (!s.ref) nullSignals.push({ path: n.metadata?.lang ? n.id.slice(5) : n.id.slice(5), ...s });
  }
}
nullSignals.sort((a, b) => byString(`${a.path}:${a.line ?? 0}`, `${b.path}:${b.line ?? 0}`));

const flowOf = (s) => byId.get(s.parent)?.name ?? s.parent ?? "（フロー不明）";
const snippet = (s) => (s ?? "").replace(/\s+/g, " ").slice(0, 100);

const lines = [];
lines.push("# 注釈ワークシート", "");
lines.push(`生成: ${new Date().toISOString()} / 対象グラフ: \`${opt.graph}\`（ノード ${graph.nodes.length} / 縁 ${graph.edges.length}）`, "");
lines.push(
  "このワークシートは静的スキャンとフロー定義だけでは決まらなかった対応付けのリストです。",
  "**コードを直接読んで**根拠を確かめ、`" + opt["annotation-out"] + "` に注釈 JSON を書いてください。",
  "推測で張らない。確かめられないものは書かない（空でも構わない）。",
  "",
);

lines.push(`## 1. I/O が未記入のステップ（${noIo.length} 件）`, "");
if (!noIo.length) lines.push("なし");
for (const s of noIo) lines.push(`- \`${s.id}\` ${s.name}（フロー: ${flowOf(s)}） — reads/writes/invokes の縁が 0 本`);
lines.push("");

lines.push(`## 2. 未紐づけの候補ストレージ/境界（${candidates.length} 件）`, "");
if (!candidates.length) lines.push("なし");
for (const c of candidates) {
  lines.push(`- \`${c.id}\` ${c.name}`);
  for (const ev of (c.metadata?.evidence ?? []).slice(0, 5)) {
    lines.push(`  - ${ev.path}:${ev.line ?? "?"} [${ev.signal ?? "?"}] \`${snippet(ev.snippet)}\``);
  }
}
lines.push("");

lines.push(`## 3. コードに未紐づきのステップ（${noImpl.length} 件）`, "");
if (!noImpl.length) lines.push("なし");
for (const s of noImpl) lines.push(`- \`${s.id}\` ${s.name}（フロー: ${flowOf(s)}） — implemented-by の縁が 0 本`);
lines.push("");

lines.push(`## 4. リテラルが決まらず ref 無しで拾ったシグナル（${nullSignals.length} 件）`, "");
if (!nullSignals.length) lines.push("なし");
for (const s of nullSignals.slice(0, 200)) {
  lines.push(`- ${s.path}:${s.line ?? "?"} [${s.signal}] \`${snippet(s.snippet)}\` — 原文を開いて宛先を確定し、注釈で候補を追加/縁を張る`);
}
if (nullSignals.length > 200) lines.push(`- …他 ${nullSignals.length - 200} 件`);
lines.push("");

lines.push("## 5. 注釈の書式と決まりごと", "");
lines.push(
  "docs/schema.md の `annotations/*.json` の節が正。要約:",
  "",
  "```jsonc",
  "{",
  '  "schemaVersion": 1,',
  '  "producer": "llm",',
  '  "nodes": [   // リポジトリに見えないストレージ/境界だけ新規追加',
  '    { "id": "store:table/orders_analytics", "kind": "store", "name": "orders_analytics",',
  '      "metadata": { "storeKind": "table" } }',
  "  ],",
  '  "edges": [   // kind: reads / writes / invokes / implemented-by（+ reads/writes は boundary からも可）',
  '    { "source": "step:<flow>/<step>", "target": "store:table/orders", "kind": "writes",',
  '      "confidence": 0.95, "note": "src/handlers/create_order.py:42 の INSERT INTO orders" }',
  "  ],",
  '  "metadata": [ { "match": { "kind": "flow", "id": "flow:order-intake" }, "set": { "sla": "5分" } } ]',
  "}",
  "```",
  "",
  "1. 書く前に `graph.json` を読む。存在しない ID への縁は merge で捨てられる",
  "2. `note` に検証可能な根拠（ファイル:行・関数名・テーブル名）を必ず書く",
  "3. `confidence`: コードで確認できた 0.8 以上 / 設定や命名からの推定 0.7 台 / 運用知識のみ 0.6 以下",
  "4. 確かめられない対応は張らない。張らないことは嘘をつくより正しい",
  "",
  "書き終えたら再生成: `node scripts/build.mjs --root <repo> --annotation " + opt["annotation-out"] + "`",
  "",
);

mkdirSync(dirname(opt.out), { recursive: true });
writeFileSync(opt.out, lines.join("\n"));
process.stdout.write(
  `worklist.md: 未記入ステップ ${noIo.length} / 未紐づけ候補 ${candidates.length} / 未紐づき実装 ${noImpl.length} / ref 未決シグナル ${nullSignals.length} → ${opt.out}\n`,
);
