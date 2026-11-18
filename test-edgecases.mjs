// 攻撃的検証（変異データ）で分かった穴の回帰テスト。
// 各ケースは独立した一時ディレクトリにフロー定義・scan・注釈を組み、merge.mjs を実行する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dirname, "bin", "merge.mjs");

function run(files) {
  const dir = mkdtempSync(join(tmpdir(), "flowec-"));
  const flows = join(dir, "flows");
  mkdirSync(flows, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    if (!name.startsWith("flows/")) {
      writeFileSync(join(dir, name), JSON.stringify(body));
      continue;
    }
    writeFileSync(join(dir, name), JSON.stringify(body));
  }
  const args = [BIN, "--flows", flows];
  if (files["scan.json"]) args.push("--scan", join(dir, "scan.json"));
  for (const k of Object.keys(files)) if (k.startsWith("ann")) args.push("--annotation", join(dir, k));
  const out = join(dir, "graph.json");
  args.push("--out", out);
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(r.status, 0, `merge 失敗: ${r.stderr}`);
  return { graph: JSON.parse(readFileSync(out, "utf8")), stderr: r.stderr, stdout: r.stdout };
}

const node = (g, id) => g.nodes.find((n) => n.id === id);
const flowDoc = (flow) => ({ schemaVersion: 1, flows: [flow] });

test("scan 候補 ID の大文字と _ 揺らぎは定義側参照と同 ID に正規化される", (t) => {
  const { graph } = run({
    "flows/f.json": flowDoc({
      id: "x",
      steps: [{ id: "a", name: "a", reads: ["table/order-items"] }],
    }),
    "scan.json": {
      schemaVersion: 1,
      files: [],
      stores: [{ id: "store:table/Order_Items", name: "Order_Items", storeKind: "table" }],
      boundaries: [],
    },
  });
  const stores = graph.nodes.filter((n) => n.kind === "store");
  assert.deepEqual(stores.map((n) => n.id), ["store:table/order-items"], "store が分裂している");
});

test("注釈ノード ID も正規化され、定義と同じ格納先へ統合される", (t) => {
  const { graph } = run({
    "flows/f.json": flowDoc({
      id: "x",
      steps: [{ id: "a", name: "a", reads: ["table/orders_analytics"] }],
    }),
    "ann.json": {
      schemaVersion: 1,
      producer: "human",
      nodes: [{ id: "store:table/Orders_Analytics", kind: "store", name: "Orders_Analytics" }],
      edges: [{ source: "store:table/orders-analytics", target: "store:table/Orders_Analytics", kind: "reads", confidence: 1, note: "集計" }],
    },
  });
  assert.deepEqual(graph.nodes.filter((n) => n.kind === "store").map((n) => n.id), ["store:table/orders-analytics"]);
});

test("注釈の metadata.set で provenance を偽装できない", (t) => {
  const { graph, stderr } = run({
    "flows/f.json": flowDoc({ id: "x", steps: [{ id: "a", name: "a" }] }),
    "ann.json": {
      schemaVersion: 1,
      producer: "llm",
      nodes: [],
      edges: [],
      metadata: [{ match: { id: "step:x/a" }, set: { provenance: "human", team: "注文" } }],
    },
  });
  assert.equal(node(graph, "step:x/a").metadata.provenance, "definition");
  assert.equal(node(graph, "step:x/a").metadata.team, "注文");
  assert.match(stderr, /provenance を上書きできません/);
});

test("step id 重複は後の定義をスキップし、偽の自己進行を作らない", (t) => {
  const { graph, stderr } = run({
    "flows/f.json": flowDoc({
      id: "x",
      steps: [{ id: "a", name: "a" }, { id: "a", name: "a 二度目" }, { id: "b", name: "b" }],
    }),
  });
  assert.match(stderr, /step:x\/a が重複しています/);
  assert.equal(node(graph, "step:x/a").name, "a");
  assert.equal(graph.edges.find((e) => e.source === "step:x/a" && e.target === "step:x/a"), undefined);
  const nexts = graph.edges.filter((e) => e.kind === "next");
  assert.deepEqual(nexts.map((e) => [e.source, e.target, e.metadata.order]), [["step:x/a", "step:x/b", 2]]);
});

test("branches の空文字 label は保持され、無 label の縁と別縁として並存する", (t) => {
  const { graph } = run({
    "flows/f.json": flowDoc({
      id: "x",
      steps: [
        { id: "g", name: "g", kind: "gateway", branches: [{ to: "t", label: "" }, { to: "t" }] },
        { id: "t", name: "t" },
      ],
    }),
  });
  const toT = graph.edges.filter((e) => e.source === "step:x/g" && e.target === "step:x/t");
  assert.equal(toT.length, 2);
  assert.ok(toT.some((e) => e.metadata && e.metadata.label === ""), "空文字 label が消えた");
  assert.ok(toT.some((e) => !(e.metadata && "label" in e.metadata)));
});

test("branches キーは空配列でも宣言とみなす（kind 省略なら昇格・出口抑止・枝不足警告）", (t) => {
  const { graph, stderr } = run({
    "flows/f.json": flowDoc({
      id: "x",
      steps: [
        { id: "a", name: "a", branches: [] },
        { id: "b", name: "b" },
      ],
    }),
  });
  assert.equal(node(graph, "step:x/a").metadata.stepKind, "gateway");
  assert.equal(graph.edges.find((e) => e.kind === "next"), undefined, "空 branches から暗黙 next が張られた");
  assert.match(stderr, /kind: "gateway" として扱いました/);
  assert.match(stderr, /branches が 0 本しかありません/);
  assert.match(stderr, /step:x\/b は入口 step:x\/a から next で到達できません/);
});

test("scan の大文字混じり参照（HTTP/...）も正規化して boundary と touches を作る", (t) => {
  const { graph, stderr } = run({
    "flows/f.json": flowDoc({ id: "x", steps: [{ id: "a", name: "a" }] }),
    "scan.json": {
      schemaVersion: 1,
      files: [
        { path: "src/pay.ts", lang: "ts", signals: [{ signal: "http-call", ref: "HTTP/Pay_API/Charge", line: 3, snippet: "fetch(...)" }] },
      ],
      stores: [],
      boundaries: [],
    },
  });
  const b = node(graph, "boundary:http/pay-api/charge");
  assert.ok(b, "boundary が作られていない");
  assert.equal(b.metadata.candidate, true);
  const touch = graph.edges.find((e) => e.source === "code:src/pay.ts" && e.target === "boundary:http/pay-api/charge");
  assert.equal(touch.metadata.access, "invoke");
  assert.doesNotMatch(stderr, /規則外/);
});

test("flow の自由キー（docs や sla）は metadata に残る", (t) => {
  const { graph } = run({
    "flows/f.json": flowDoc({ id: "x", name: "x", docs: "docs/x.md", sla: "当日処理", steps: [{ id: "a", name: "a", team: "注文" }] }),
  });
  assert.equal(node(graph, "flow:x").metadata.docs, "docs/x.md");
  assert.equal(node(graph, "flow:x").metadata.sla, "当日処理");
  assert.equal(node(graph, "step:x/a").metadata.team, "注文");
});

test("注釈エッジの端点型違反（flow→step の reads など）は警告して捨てる", (t) => {
  const { graph, stderr } = run({
    "flows/f.json": flowDoc({ id: "x", steps: [{ id: "a", name: "a", reads: ["table/t"] }] }),
    "ann.json": {
      schemaVersion: 1,
      producer: "llm",
      nodes: [],
      edges: [{ source: "flow:x", target: "step:x/a", kind: "reads", confidence: 1, note: "型違反" }],
    },
  });
  assert.equal(graph.edges.find((e) => e.kind === "reads" && e.source === "flow:x"), undefined);
  assert.match(stderr, /端点の型が規則外/);
});

test("同じ flow id を別ファイルで再定義したら警告する", (t) => {
  const { graph, stderr } = run({
    "flows/a.json": flowDoc({ id: "x", steps: [{ id: "a", name: "a" }] }),
    "flows/b.json": flowDoc({ id: "x", steps: [{ id: "b", name: "b" }] }),
  });
  assert.equal(graph.nodes.filter((n) => n.kind === "flow").length, 1);
  assert.match(stderr, /flow flow:x は別定義とマージされます/);
});

test("別フローの step を指す contains 注釈は警告して捨て、親と source の一致だけ受理する", () => {
  const { graph, stderr } = run({
    "flows/f.json": flowDoc({
      id: "x",
      steps: [{ id: "a", name: "a" }, { id: "b", name: "b" }],
    }),
    "ann.json": {
      schemaVersion: 1,
      edges: [{ source: "flow:x", target: "step:x/a", kind: "contains", confidence: 0.9, note: "再掲（同一親なので無害）" }],
    },
  });
  const contains = graph.edges.filter((e) => e.kind === "contains");
  assert.equal(contains.length, 2, `既存 2 本のはずが ${contains.length}`);

  const bad = run({
    "flows/f.json": { schemaVersion: 1, flows: [
      { id: "x", steps: [{ id: "a", name: "a" }] },
      { id: "y", steps: [{ id: "b", name: "b" }] },
    ] },
    "ann.json": {
      schemaVersion: 1,
      edges: [{ source: "flow:x", target: "step:y/b", kind: "contains", confidence: 0.9, note: "よそのフローに差し込む試み" }],
    },
  });
  assert.match(bad.stderr, /端点の型が規則外/);
  assert.ok(!bad.graph.edges.some((e) => e.source === "flow:x" && e.target === "step:y/b"), "越境 contains が残った");
});

test("注釈 next の label は別縁として立ち、戻る向きは loop が付く。touches の access も保持", () => {
  const { graph, stderr } = run({
    "flows/f.json": flowDoc({
      id: "x",
      steps: [{ id: "a", name: "a" }, { id: "b", name: "b" }],
    }),
    "scan.json": { schemaVersion: 1, files: [{ path: "s.rb", lang: "ruby", signals: [] }], stores: [{ id: "store:table/orders", name: "orders", storeKind: "table" }], boundaries: [] },
    "ann.json": {
      schemaVersion: 1,
      edges: [
        { source: "step:x/a", target: "step:x/b", kind: "next", confidence: 0.8, note: "人間が追記した条件", metadata: { label: "例外系" } },
        { source: "step:x/b", target: "step:x/a", kind: "next", confidence: 0.8, note: "巻き戻し", metadata: { label: "re" } },
        { source: "code:s.rb", target: "store:table/orders", kind: "touches", confidence: 0.8, note: "生ファイル名", metadata: { access: "read" } },
      ],
    },
  });
  const ab = graph.edges.filter((e) => e.kind === "next" && e.source === "step:x/a" && e.target === "step:x/b");
  assert.equal(ab.length, 2, `定義の無 label 縁と注釈の label 縁が並存しない: ${JSON.stringify(ab.map((e) => e.metadata))}`);
  assert.equal(ab.find((e) => e.metadata?.label === "例外系").provenance, "llm");
  const back = graph.edges.find((e) => e.kind === "next" && e.source === "step:x/b" && e.target === "step:x/a");
  assert.equal(back.metadata.loop, true, "戻る向きなのに loop が付かない");
  const touch = graph.edges.find((e) => e.kind === "touches");
  assert.equal(touch.metadata.access, "read");
  assert.doesNotMatch(stderr, /規則外/);

  const badAcc = run({
    "flows/f.json": flowDoc({ id: "x", steps: [{ id: "a", name: "a" }] }),
    "scan.json": { schemaVersion: 1, files: [{ path: "s.rb", lang: "ruby", signals: [] }], stores: [{ id: "store:table/orders", name: "orders", storeKind: "table" }], boundaries: [] },
    "ann.json": {
      schemaVersion: 1,
      edges: [{ source: "code:s.rb", target: "store:table/orders", kind: "touches", confidence: 0.8, note: "x", metadata: { access: "modify" } }],
    },
  });
  assert.match(badAcc.stderr, /access "modify" が規則外/);
  assert.ok(!badAcc.graph.edges.some((e) => e.kind === "touches"), "不正 access の touches が残った");
});

test("render: 抜粋の <!-- や <script>、タイトルの $& を壊さず埋め込まない", () => {
  const { spawnSync: sp } = { spawnSync: spawnSync };
  const dir = mkdtempSync(join(tmpdir(), "flowrd-"));
  const flows = join(dir, "flows");
  mkdirSync(flows, { recursive: true });
  writeFileSync(join(flows, "f.json"), JSON.stringify(flowDoc({
    id: "x",
    steps: [{ id: "a", name: "a" }],
  })));
  writeFileSync(join(dir, "ann.json"), JSON.stringify({
    schemaVersion: 1,
    nodes: [{ id: "store:table/t", name: "t", metadata: { note: "<!-- 怪しい抜粋 <script>alert(1)</script> -->" } }],
    edges: [],
  }));
  const graphPath = join(dir, "graph.json");
  let r = sp(process.execPath, [BIN, "--flows", flows, "--annotation", join(dir, "ann.json"), "--out", graphPath], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const htmlPath = join(dir, "flow.html");
  r = sp(process.execPath, [join(import.meta.dirname, "bin", "render.mjs"), "--graph", graphPath, "--out", htmlPath, "--title", "$&予期<!--$'"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(htmlPath, "utf8");
  assert.ok(!html.includes("$&予期"), "タイトルが未サニタイズ");
  assert.ok(!html.includes("__TITLE__amp") && !html.includes("__TITLE__予期"), "タイトル置換で $ 特殊展開が起きた");
  assert.ok(!/<script[^>]*id="graph-data"[^>]*>[\s\S]*?<!--/.test(html), "payload に素の <!-- が残る");
  const m = html.match(/<script id="graph-data" type="application\/json">([\s\S]*?)<\/script>/);
  const parsed = JSON.parse(m[1]);
  const note = parsed.nodes.find((n) => n.id === "store:table/t").metadata.note;
  assert.equal(note, "<!-- 怪しい抜粋 <script>alert(1)</script> -->", "JSON.parse で原文に戻らない");
});
