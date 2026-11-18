// scan（lib/scan.mjs + bin/scan.mjs）のテスト。`node --test test-scan.mjs`
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "./lib/scan.mjs";

const FIX = join(import.meta.dirname, "tests", "fixtures", "scan");
const scan = () => scanRepo({ root: FIX, generatedAt: "2026-01-01T00:00:00.000Z" });
const file = (r, path) => r.files.find((f) => f.path === path);
const has = (r, path, signal, ref) =>
  file(r, path)?.signals.some((s) => s.signal === signal && s.ref === ref);
const store = (r, id) => r.stores.find((s) => s.id === id);

test("期待する (path, signal, ref) が全て出る", () => {
  const r = scan();
  assert.ok(has(r, "app.py", "sql-read", "table/orders"));
  assert.ok(has(r, "app.py", "sql-write", "table/audit_log"));
  assert.ok(has(r, "app.py", "queue", "queue/job-queue"));
  assert.ok(has(r, "app.py", "file-read", "file/data/in.json"));
  assert.ok(has(r, "app.py", "file-write", "file/data/out.json"));
  assert.ok(has(r, "app.py", "kv", "kv/cache/last-run"));
  assert.ok(has(r, "app.py", "dynamodb", "table/job_locks"));
  assert.ok(has(r, "app.py", "http-call", "http/catalog.internal"));
  assert.ok(has(r, "job.js", "s3", "s3/report-bucket"));
  assert.ok(has(r, "job.js", "file-write", "file/reports/out.csv"));
  assert.ok(has(r, "job.js", "http-call", "http/alert-api/v1/fire"));
  assert.ok(has(r, "sync.go", "topic", "topic/analytics-events"));
  assert.ok(has(r, "sync.go", "file-read", "file/conf/app.yaml"));
  assert.ok(has(r, "sync.go", "kv", "kv/cache/summary"));
  assert.ok(has(r, "handler.rb", "queue", "queue/order-events"));
  assert.ok(has(r, "handler.rb", "sql-write", "table/notifications"));
  assert.ok(has(r, "handler.rb", "sql-write", "table/orders"));
  assert.ok(has(r, "orders.sql", "sql-write", "table/orders"));
  assert.ok(has(r, "orders.sql", "sql-read", "table/public.orders"));
  assert.ok(has(r, "orders.sql", "sql-read", "table/public.audit_log"));
});

test("出してはいけないもの: 変数 URL に ref を張らない・コメント内 SQL を拾わない・サービスホスト URL を http にしない", () => {
  const r = scan();
  // BASE_URL + path は ref null の http-call として残る
  const py = file(r, "app.py");
  assert.ok(py.signals.some((s) => s.signal === "http-call" && s.ref === null && /BASE_URL/.test(s.snippet)));
  // テンプレートリテラルの fetch も ref null
  const js = file(r, "job.js");
  assert.ok(js.signals.some((s) => s.signal === "http-call" && s.ref === null && /WEBHOOK_BASE/.test(s.snippet)));
  // コメント内の ghost 群は縁にも候補にも出ない
  for (const ghost of ["ghost_table", "ghost_js", "ghost_sql", "ghost_rb"]) {
    const needle = ghost.replace("_", "-");
    assert.equal(r.stores.find((s) => s.id.includes(needle)), undefined, ghost);
  }
  // SQS の URL から make-up した http 境界を作らない
  assert.equal(r.boundaries.find((b) => b.id.includes("sqs.")), undefined);
  assert.ok(!js.signals.some((s) => s.signal === "http-call" && s.ref === null && /DELETE/.test(s.snippet)));
});

test("store/boundary 集約: 複数ファイルの evidence が 1 ノードに集まる", () => {
  const r = scan();
  const orders = store(r, "store:table/orders");
  assert.ok(orders);
  assert.equal(orders.storeKind, "table");
  const paths = new Set(orders.evidence.map((e) => e.path));
  assert.ok(paths.has("app.py") && paths.has("orders.sql") && paths.has("handler.rb"), [...paths].join(","));
  const fire = r.boundaries.find((b) => b.id === "boundary:http/alert-api/v1/fire");
  assert.equal(fire.boundaryKind, "http");
});

test("除外: node_modules 配下は走査しない", () => {
  const r = scan();
  assert.equal(file(r, "node_modules/pkg/hidden.py"), undefined);
  assert.equal(store(r, "store:table/hidden_table"), undefined);
});

test("CLI が走り、決定性: generatedAt を除きバイト一致", () => {
  const a = join(mkdtempSync(join(tmpdir(), "flowscan-")), "scan.json");
  const b = join(mkdtempSync(join(tmpdir(), "flowscan-")), "scan.json");
  for (const out of [a, b]) {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "bin", "scan.mjs"), "--root", FIX, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  const strip = (p) => JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), generatedAt: null });
  assert.equal(strip(a), strip(b));
});

test("シグナルは行順・stores は id 順に並ぶ", () => {
  const r = scan();
  for (const f of r.files) {
    const lines = f.signals.map((s) => s.line);
    assert.deepEqual(lines, [...lines].sort((x, y) => x - y), f.path);
  }
  const ids = r.stores.map((s) => s.id);
  assert.deepEqual(ids, [...ids].sort());
});
