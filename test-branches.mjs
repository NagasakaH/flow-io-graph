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
  assert.match(stderr, /step:branch\/loopgate にどのステップからも到達しません/);
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
