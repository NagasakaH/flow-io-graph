// merge.mjs のテスト。`node --test test-merge.mjs` もしくは `node --test` で走る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX = join(import.meta.dirname, "tests", "fixtures", "merge");

function merge(extra = []) {
  const out = join(mkdtempSync(join(tmpdir(), "flowmerge-")), "graph.json");
  const r = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "bin", "merge.mjs"),
      "--flows", join(FIX, "flows"),
      "--scan", join(FIX, "scan.json"),
      "--annotation", join(FIX, "annotations", "llm.json"),
      "--out", out,
      ...extra,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, `merge が失敗: ${r.stderr}`);
  const graph = JSON.parse(readFileSync(out, "utf8"));
  return { graph, stderr: r.stderr, out };
}

const node = (graph, id) => graph.nodes.find((n) => n.id === id);
const edge = (graph, s, k, t) => graph.edges.find((e) => e.source === s && e.kind === k && e.target === t);

test("フロー定義から flow/step と contains/next が順番付きでできる", (t) => {
  const { graph } = merge();
  const flow = node(graph, "flow:ship");
  assert.ok(flow);
  assert.equal(flow.name, "出荷フロー");
  assert.equal(flow.metadata.owner, "logistics");
  const pick = node(graph, "step:ship/pick");
  assert.equal(pick.parent, "flow:ship");
  assert.equal(edge(graph, "flow:ship", "contains", "step:ship/pick").metadata.order, 1);
  assert.equal(edge(graph, "step:ship/pick", "next", "step:ship/pack").metadata.order, 2);
  assert.equal(edge(graph, "step:ship/pack", "next", "step:ship/label").metadata.order, 3);
});

test("参照は正規化 ID のノードになり、規則外は警告して捨てる", (t) => {
  const { graph, stderr } = merge();
  assert.ok(node(graph, "store:kv/wms-tokens"), "kv/WMS_TOKENS は store:kv/wms-tokens に正規化");
  assert.equal(node(graph, "store:kv/wms-tokens").metadata.candidate, undefined);
  assert.equal(node(graph, "boundary:http/label-api/print").kind, "boundary");
  assert.equal(node(graph, "boundary:sfn/bad-ref"), undefined, ".. を含む参照は作らない");
  assert.match(stderr, /nonsense/);
  assert.match(stderr, /sfn\/\.\.\/bad-ref/);
});

test("scan の候補は定義参照と統合され、candidate フラグが下り evidence が残る", (t) => {
  const { graph } = merge();
  const orders = node(graph, "store:table/orders");
  assert.equal(orders.metadata.candidate, undefined);
  assert.equal(orders.metadata.provenance, "definition");
  assert.ok(orders.metadata.evidence.length >= 1, "scan の evidence が残る");
  assert.equal(orders.name, "orders"); // definition 由来の名前が勝つ
  const ghost = node(graph, "store:table/ghost");
  assert.equal(ghost.metadata.candidate, true, "定義に無い候補は candidate のまま");
});

test("touches は code→store/boundary に張り、access をシグナル名から決める", (t) => {
  const { graph } = merge();
  const read = edge(graph, "code:src/pick.py", "touches", "store:table/orders");
  assert.equal(read.provenance, "static");
  assert.equal(read.metadata.access, "read");
  const write = edge(graph, "code:src/label.ts", "touches", "store:file/out/label.pdf");
  assert.equal(write.metadata.access, "write");
  const invoke = edge(graph, "code:src/label.ts", "touches", "boundary:http/label-api/print");
  assert.equal(invoke.metadata.access, "invoke");
  const kv = edge(graph, "code:src/pick.py", "touches", "store:kv/wms-tokens");
  assert.equal(kv.metadata.access, "access", "read/write を区別できないシグナルは access");
  // ref null シグナルは縁にしない（コードノードの metadata には残る）
  assert.equal(edge(graph, "code:src/pick.py", "touches", "boundary:http/null"), undefined);
  assert.equal(node(graph, "code:src/pick.py").metadata.signals.length, 3);
});

test("注釈: 新規ノード追加・edge 採用・存在しない端点は警告して捨てる", (t) => {
  const { graph, stderr } = merge();
  const erp = node(graph, "store:table/erp_invoices");
  assert.equal(erp.metadata.provenance, "llm");
  assert.equal(edge(graph, "step:ship/pack", "writes", "store:table/erp_invoices").confidence, 0.65);
  assert.match(stderr, /store:table\/nope/);
  assert.equal(node(graph, "flow:not-allowed"), undefined, "flow: は注釈で作れない");
  assert.match(stderr, /flow:not-allowed/);
});

test("注釈: confidence 欠きは 0.7 + 警告、定義と重複縁は definition が残り note は notesFrom へ", (t) => {
  const { graph, stderr } = merge();
  const impl = edge(graph, "step:ship/pick", "implemented-by", "code:src/pick.py");
  assert.equal(impl.confidence, 0.7);
  assert.match(stderr, /confidence/);
  const dup = edge(graph, "step:ship/pick", "reads", "store:table/orders");
  assert.equal(dup.provenance, "definition");
  assert.equal(dup.metadata.notesFrom[0].provenance, "llm");
});

test("metadata 注釈: 1 件命中で適用、複数命中は警告して適用しない", (t) => {
  const { graph, stderr } = merge();
  assert.equal(node(graph, "flow:ship").metadata.sla, "当日出荷");
  assert.match(stderr, /match が \d+ 件あって採用しません/);
  assert.equal(node(graph, "store:table/ghost").metadata["誰も当たらないはずはない"], undefined);
});

test("決定性: 同じ入力なら generatedAt を除きバイト一致", (t) => {
  const a = merge();
  const b = merge();
  const strip = (o) => JSON.stringify({ ...o.graph, generatedAt: null });
  assert.equal(strip(a), strip(b));
});

test("出力は id / (source,kind,target) の順に整列している", (t) => {
  const { graph } = merge();
  const ids = graph.nodes.map((n) => n.id);
  assert.deepEqual(ids, [...ids].sort());
  const keys = graph.edges.map((e) => `${e.source}\u0000${e.kind}\u0000${e.target}`);
  assert.deepEqual(keys, [...keys].sort());
});
