#!/usr/bin/env node
// render.mjs — graph.json をビューアテンプレートに埋め込んで単一ファイル flow.html を作る。
// 出力はネットワーク不要（file:// で開ける）。外部 CDN は使わない。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, "..", "viewer", "template.html");
const MARKER = '"__GRAPH_DATA__"';

const HELP = `render.mjs — graph.json を単一ファイルの flow.html に埋め込む

使い方:
  node bin/render.mjs --graph graph.json --out flow.html [--title 名前] [--template template.html]
`;

const { values: opt } = parseArgs({
  options: {
    graph: { type: "string" },
    out: { type: "string" },
    title: { type: "string", default: "業務フロー データ I/O" },
    template: { type: "string", default: TEMPLATE },
    help: { type: "boolean" },
  },
});
if (opt.help || !opt.graph || !opt.out) {
  process.stdout.write(HELP);
  process.exit(opt.help ? 0 : 2);
}

const graph = readFileSync(opt.graph, "utf8").trim();
JSON.parse(graph); // 壊れていたらここで止める
// </script> で script タグを閉じられないための保険（JSON 内の </ は文字列の中だけ）
const payload = graph.replaceAll("</", "<\\/");

const template = readFileSync(opt.template, "utf8");
if (!template.includes(MARKER)) {
  process.stderr.write(`エラー: テンプレートにマーカー ${MARKER} がありません: ${opt.template}\n`);
  process.exit(1);
}
// 順序が大事: 先にタイトル（payload 内の __TITLE__ を巻き込まない），
// payload は関数で差し込む（コード抜粋に $& や $' があっても置換pecial扱いされない）
const html = template
  .replaceAll("__TITLE__", escapeHtml(opt.title))
  .replace(MARKER, () => payload);
mkdirSync(dirname(opt.out), { recursive: true });
writeFileSync(opt.out, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
if (Buffer.byteLength(html) > 30 * 1024 * 1024) {
  process.stderr.write(`警告: flow.html が ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB あります。--exclude で対象を絞ってください\n`);
}
process.stdout.write(`flow.html: ${kb} KB → ${opt.out}\n`);

function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
