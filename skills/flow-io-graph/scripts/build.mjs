#!/usr/bin/env node
// build.mjs — 単一コマンドの口。scan → merge → render（→ worklist）を順に回す。
//
//   node scripts/build.mjs --root /path/to/repo [--flows <dir>] [--annotation a.json ...]
//       [--exclude a,b] [--out-dir out/flow] [--title 名前] [--skip-scan] [--no-worklist]
//
// 生成物（既定 out/flow/）:
//   scan.json    走査の生の結果（LLM がコードを読む入口）
//   graph.json   統合グラフ（機械が読む側。注釈を書くときはこれを読む）
//   flow.html    人間が見る単一ファイルビューア
//   worklist.md  LLM への引き継ぎ書

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = (name) => join(HERE, name);

const HELP = `build.mjs — 業務フローのデータ I/O グラフを作る単一コマンド

使い方:
  node scripts/build.mjs --root <repo> [オプション]

オプション:
  --flows <dir>        フロー定義の dir（既定: <repo>/flows。無ければスキップ）
  --annotation <file>  注釈 JSON。繰り返し指定可
  --exclude <a,b>      スキャンの除外ディレクトリ名（スキャナの既定に追記）
  --out-dir <dir>      出力先（既定: out/flow）
  --title <名前>       flow.html のタイトル
  --skip-scan          scan.json を再利用して merge/render だけ回す
  --no-worklist        worklist.md を作らない
  --help               この表示
`;

const { values: opt } = parseArgs({
  options: {
    root: { type: "string" },
    flows: { type: "string" },
    annotation: { type: "string", multiple: true, default: [] },
    exclude: { type: "string" },
    "out-dir": { type: "string", default: "out/flow" },
    title: { type: "string", default: "業務フロー データ I/O" },
    "skip-scan": { type: "boolean" },
    "no-worklist": { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (opt.help || !opt.root) {
  process.stdout.write(HELP);
  process.exit(opt.help ? 0 : 2);
}

const root = resolve(opt.root);
const outDir = resolve(opt["out-dir"]);
mkdirSync(outDir, { recursive: true });
const scanPath = join(outDir, "scan.json");
const graphPath = join(outDir, "graph.json");
const htmlPath = join(outDir, "flow.html");
const worklistPath = join(outDir, "worklist.md");
const flowsDir = opt.flows ?? join(root, "flows");

function run(label, args) {
  process.stdout.write(`▶ ${label}\n`);
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (r.status !== 0) {
    process.stderr.write(`エラー: ${label} が終了コード ${r.status ?? "signal"} で失敗しました\n`);
    process.exit(r.status ?? 1);
  }
}

if (!opt["skip-scan"]) {
  if (!existsSync(BIN("scan.mjs")) && !existsSync(join(HERE, "lib", "scan.mjs"))) {
    process.stderr.write("エラー: lib/scan.mjs がありません（スキャナ未実装?)。--skip-scan で flows/annotations だけ統合できます\n");
    process.exit(1);
  }
  const scanArgs = [BIN("scan.mjs"), "--root", root, "--out", scanPath];
  if (opt.exclude) scanArgs.push("--exclude", opt.exclude);
  run("scan", scanArgs);
} else if (!existsSync(scanPath)) {
  process.stderr.write(`エラー: --skip-scan ですが ${scanPath} がありません\n`);
  process.exit(1);
}

const mergeArgs = [BIN("merge.mjs"), "--out", graphPath, "--root", root];
if (existsSync(flowsDir)) mergeArgs.push("--flows", flowsDir);
if (existsSync(scanPath)) mergeArgs.push("--scan", scanPath);
for (const a of opt.annotation) mergeArgs.push("--annotation", resolve(a));
run("merge", mergeArgs);

run("render", [BIN("render.mjs"), "--graph", graphPath, "--out", htmlPath, "--title", opt.title]);

if (!opt["no-worklist"]) {
  run("worklist", [BIN("worklist.mjs"), "--graph", graphPath, "--out", worklistPath]);
}

process.stdout.write(`\n完了: ${htmlPath} をブラウザで開いてください\n`);
process.stdout.write(`注釈を追記して再生成: node scripts/build.mjs --root ${opt.root} --annotation <annotations.json> --skip-scan\n`);
