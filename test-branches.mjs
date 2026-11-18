// 分岐・ループ構文（branches / kind: gateway）の merge テスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX = join(import.meta.dirname, "tests", "fixtures", "merge");

function merge(extra = []) {
  const out = join(mkdtempSync(join(tmpdir(), "flowbr-")), "graph.json");
  const r = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "bin", "merge.mjs"), "--flows", join(FIX, "flows"), "--out", out, ...extra],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, `merge が失敗: ${r.stderr}`);
  return { graph: JSON.parse(readFileSync(out, "utf8")), stderr: r.stderr, stdout: r.stdout };
}

const node = (g, id) => g.nodes.find((n) => n.id === id);
const edgesFrom = (g, id, kind) => g.edges.filter((e) => e.source === id && e.kind === kind);
const edge = (g, s, k, t) => g.edges.find((e) => e.source === s && e.kind === k && e.target === t);

test("branches を持つステップは gateway に昇格し、警告が出る", (t) => {
  const { graph, stderr } = merge();
  assert.equal(node(graph, "step:branch/gate").metadata.stepKind, "gateway");
  assert.match(stderr, /gate .*kind: "gateway" として扱いました/);
  assert.equal(node(graph, "step:branch/start").metadata.stepKind, undefined);
});

test("branches はラベル付き next 縁になり、暗黙の直列 next はsuppressされる", (t) => {
  const { graph } = merge();
  const br = edgesFrom(graph, "step:branch/gate", "next");
  assert.deepEqual(br.map((e) => e.target).sort(), ["step:branch/late", "step:branch/orphan"]);
  assert.equal(edge(graph, "step:branch/gate", "next", "step:branch/late").metadata.label, "後方参照");
  // gate から 2 本の明示縁だけ（暗黙の late への直列縁は重複として増えていない＝本数 2）
  assert.equal(br.length, 2);
  // 線形側の挙動は無傷（ship: pick→pack）
  assert.ok(edge(graph, "step:ship/pick", "next", "step:ship/pack"));
});

test("前方向の to はループとして metadata.loop が付き、stdout にも通告する", (t) => {
  const { graph, stdout } = merge();
  const loop = edge(graph, "step:branch/loopgate", "next", "step:branch/start");
  assert.equal(loop.metadata.loop, true);
  assert.equal(loop.metadata.label, "やり直し");
  assert.match(stdout, /ループ検出: step:branch\/loopgate → step:branch\/start/);
});

test("どの next でも到達できないステップは警告する（グラフ自体は捨てる）", (t) => {
  const { stderr } = merge();
  assert.match(stderr, /step:branch\/loopgate は入口 step:branch\/start から next で到達できません/);
});

test("同じ宛先への条件違い branches は別縁として残る（自分自身への to もループ縁になる）", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "flowbr2-"));
  const flows = join(dir, "flows");
  mkdirSync(flows, { recursive: true });
  writeFileSync(
    join(flows, "dup.json"),
    JSON.stringify({
      schemaVersion: 1,
      flows: [
        {
          id: "dup",
          steps: [
            { id: "a", name: "a" },
            {
              id: "s",
              name: "s",
              kind: "gateway",
              branches: [
                { to: "t", label: "成功" },
                { to: "t", label: "失敗" },
                { to: "s", label: "自分へ再試行" },
              ],
            },
            { id: "t", name: "t" },
          ],
        },
      ],
    }),
  );
  const out = join(dir, "graph.json");
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "bin", "merge.mjs"), "--flows", flows, "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const g = JSON.parse(readFileSync(out, "utf8"));
  const toT = g.edges.filter((e) => e.source === "step:dup/s" && e.kind === "next" && e.target === "step:dup/t");
  assert.deepEqual(toT.map((e) => e.metadata.label).sort(), ["失敗", "成功"]);
  const self = g.edges.find((e) => e.source === "step:dup/s" && e.target === "step:dup/s");
  assert.ok(self, "自身への分岐縁が残っていない");
  assert.equal(self.metadata.loop, true);
  assert.match(r.stdout, /ループ検出: step:dup\/s → step:dup\/s \(自分へ再試行\)/);
});

test("同一コード×同一格納先の読みと書きは access 別に別縁（信号順に依存しない）", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "flowbr3-"));
  const flows = join(dir, "flows");
  mkdirSync(flows, { recursive: true });
  writeFileSync(join(flows, "io.json"), JSON.stringify({ schemaVersion: 1, flows: [{ id: "x", steps: [{ id: "a", name: "a" }] }] }));
  const mkSignals = (swapped) => {
    const read = { signal: "sql-read", ref: "table/t", line: 2, snippet: "SELECT * FROM t" };
    const write = { signal: "sql-write", ref: "table/t", line: 1, snippet: "INSERT INTO t SELECT * FROM u" };
    return swapped ? [write, read] : [read, write];
  };
  const accessesOf = (swapped) => {
    const scanPath = join(dir, "scan.json");
    writeFileSync(
      scanPath,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-01-01T00:00:00.000Z",
        root: "/fixture",
        files: [{ path: "src/a.sql", lang: "sql", signals: mkSignals(swapped) }],
        stores: [{ id: "store:table/t", name: "t", storeKind: "table" }],
        boundaries: [],
      }),
    );
    const out = join(dir, "g.json");
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "bin", "merge.mjs"), "--flows", flows, "--scan", scanPath, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const g = JSON.parse(readFileSync(out, "utf8"));
    return g.edges
      .filter((e) => e.source === "code:src/a.sql" && e.target === "store:table/t")
      .map((e) => e.metadata.access)
      .sort();
  };
  assert.deepEqual(accessesOf(false), ["read", "write"]);
  assert.deepEqual(accessesOf(true), ["read", "write"]);
});

test("gateway に branches が 1 本しかない場合は警告", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "flowbr1-"));
  const flows = join(dir, "flows");
  mkdirSync(flows, { recursive: true });
  writeFileSync(
    join(flows, "one.json"),
    JSON.stringify({
      schemaVersion: 1,
      flows: [
        {
          id: "x",
          steps: [
            { id: "a", name: "a" },
            { id: "g", name: "g", kind: "gateway", branches: [{ to: "a", label: "もどる" }] },
          ],
        },
      ],
    }),
  );
  const out = join(dir, "graph.json");
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "bin", "merge.mjs"), "--flows", flows, "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /gateway step:x\/g の branches が 1 本/);
});
