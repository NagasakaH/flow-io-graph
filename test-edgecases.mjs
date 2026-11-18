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
