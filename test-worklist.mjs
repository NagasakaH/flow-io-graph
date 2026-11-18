// worklist.mjs のテスト。fixtures/merge を merge した graph.json を使う。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = import.meta.dirname;
const FIX = join(ROOT, "tests", "fixtures", "merge");

function buildWorklist() {
  const dir = mkdtempSync(join(tmpdir(), "flowworklist-"));
  const graph = join(dir, "graph.json");
  let r = spawnSync(
    process.execPath,
    [
      join(ROOT, "bin", "merge.mjs"),
      "--flows", join(FIX, "flows"),
      "--scan", join(FIX, "scan.json"),
      "--annotation", join(FIX, "annotations", "llm.json"),
      "--out", graph,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const md = join(dir, "worklist.md");
  r = spawnSync(process.execPath, [join(ROOT, "bin", "worklist.mjs"), "--graph", graph, "--out", md], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return { text: readFileSync(md, "utf8"), summary: r.stdout };
}

test("ワークシートは 5 セクションを持ち、未記入ステップと候補を名指しする", (t) => {
  const { text } = buildWorklist();
  for (const heading of ["1. I/O が未記入のステップ", "2. 未紐づけの候補ストレージ/境界", "3. コードに未紐づきのステップ", "4. リテラルが決まらず ref 無しで拾ったシグナル", "5. 注釈の書式と決まりごと"]) {
    assert.match(text, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  // pack は定義 I/O あり、label もある → 1 章は「なし」
  assert.match(text, /1\. I\/O が未記入のステップ（0 件）\n\nなし/);
  // ghost テーブルは候補のまま（未紐づけ）
  assert.match(text, /store:table\/ghost/);
  // pick/pack/label は implemented-by 済み or 未 — pack は未紐づき実装
  assert.match(text, /step:ship\/pack`.*implemented-by の縁が 0 本/);
  // ref null シグナル（BASE + path）が原文確認待ちに出る
  assert.match(text, /requests\.get\(BASE \+ path\)/);
});

test("サマリ行の件数が本文と一致する", (t) => {
  const { text, summary } = buildWorklist();
  const count = (n) => Number(summary.match(new RegExp(`${n} (\\d+)`))[1]);
  const section = (label) => Number(text.match(new RegExp(`${label}（(\\d+) 件）`))[1]);
  assert.equal(count("未記入ステップ"), section("1\\. I/O が未記入のステップ"));
  assert.equal(count("未紐づけ候補"), section("2\\. 未紐づけの候補ストレージ/境界"));
  assert.equal(count("ref 未決シグナル"), section("4\\. リテラルが決まらず ref 無しで拾ったシグナル"));
});
