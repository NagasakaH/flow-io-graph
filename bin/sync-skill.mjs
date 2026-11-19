#!/usr/bin/env node
// sync-skill.mjs — 本体（bin/ lib/ viewer/ docs/）から配布用 Agent Skill
// （skills/flow-io-graph/）のブラックボックス scripts/ と references/ を同期する。

import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SKILL_DIR = join(ROOT, "skills", "flow-io-graph");
const SCRIPTS_DIR = join(SKILL_DIR, "scripts");
const SCRIPTS_LIB_DIR = join(SCRIPTS_DIR, "lib");
const REFS_DIR = join(SKILL_DIR, "references");

mkdirSync(SCRIPTS_LIB_DIR, { recursive: true });
mkdirSync(REFS_DIR, { recursive: true });

// 1. lib/*.mjs を scripts/lib/ へコピー
for (const name of ["scan.mjs", "util.mjs"]) {
  copyFileSync(join(ROOT, "lib", name), join(SCRIPTS_LIB_DIR, name));
}

// 2. viewer/template.html を scripts/template.html へコピー
copyFileSync(join(ROOT, "viewer", "template.html"), join(SCRIPTS_DIR, "template.html"));

// 3. docs/schema.md を references/schema.md へコピー
copyFileSync(join(ROOT, "docs", "schema.md"), join(REFS_DIR, "schema.md"));

// 4. bin/*.mjs を scripts/ へ相対パス書き換え付きで配置（自己完結・ポータブル化）
const binFiles = ["build.mjs", "scan.mjs", "merge.mjs", "render.mjs", "worklist.mjs"];
for (const name of binFiles) {
  let src = readFileSync(join(ROOT, "bin", name), "utf8");
  // ../lib/ → ./lib/
  src = src.replaceAll('"../lib/', '"./lib/');
  // render.mjs のテンプレート参照を同階層の template.html へ
  src = src.replace(
    'join(HERE, "..", "viewer", "template.html")',
    'join(HERE, "template.html")',
  );
  // build.mjs の lib/scan.mjs 存在チェックを ./lib/scan.mjs へ
  src = src.replace(
    'join(HERE, "..", "lib", "scan.mjs")',
    'join(HERE, "lib", "scan.mjs")',
  );
  // ヘルプ表示のパス表記を scripts/ 基準へ
  src = src.replaceAll("node bin/", "node scripts/");
  writeFileSync(join(SCRIPTS_DIR, name), src, "utf8");
}

process.stdout.write(`同期完了: ${SKILL_DIR}\n`);
