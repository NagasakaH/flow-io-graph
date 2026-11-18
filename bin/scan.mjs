#!/usr/bin/env node
// scan.mjs CLI — 仕様は docs/schema.md「scan.json」の節と lib/scan.mjs。
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { scanRepo, DEFAULT_EXCLUDE } from "../lib/scan.mjs";

const HELP = `scan.mjs — コードベースから API 境界・ストレージアクセスのシグナルを走査する

使い方:
  node bin/scan.mjs --root <repo> --out scan.json [--exclude a,b] [--max-bytes N]

オプション:
  --root <dir>        走査対象（必須）
  --out <file>        scan.json の出力先（必須）
  --exclude <a,b>    除外ディレクトリ名（既定 ${DEFAULT_EXCLUDE.join(", ")} に追記）
  --max-bytes <N>     1 ファイルの上限バイト（既定 1048576。超えたファイルはスキップ通告）
  --help              この表示
`;

const { values: opt } = parseArgs({
  options: {
    root: { type: "string" },
    out: { type: "string" },
    exclude: { type: "string" },
    "max-bytes": { type: "string" },
    help: { type: "boolean" },
  },
});
if (opt.help || !opt.root || !opt.out) {
  process.stdout.write(HELP);
  process.exit(opt.help ? 0 : 2);
}

const result = scanRepo({
  root: resolve(opt.root),
  exclude: opt.exclude ? opt.exclude.split(",").map((s) => s.trim()).filter(Boolean) : [],
  limitBytes: opt["max-bytes"] ? Number(opt["max-bytes"]) : undefined,
});
mkdirSync(dirname(opt.out), { recursive: true });
writeFileSync(opt.out, JSON.stringify(result, null, 2) + "\n");
const nSignals = result.files.reduce((n, f) => n + f.signals.length, 0);
process.stdout.write(
  `scan.json: ${result.files.length} ファイル / シグナル ${nSignals} / 候補 store ${result.stores.length} + boundary ${result.boundaries.length} → ${opt.out}\n`,
);
for (const s of result.skippedLargeFiles) process.stderr.write(`スキップ（サイズ上限超過）: ${s}\n`);
