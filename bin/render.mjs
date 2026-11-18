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
// script タグを閉じられないための保険。`</script>` だけでなく `<!--`（script を escaped
// state に入れて素の `</script>` を無効化し内容が画面に漏れる）も防ぐため、`<` を
// 全部 \u003c にエスケープする。JSON の構造文字に `<` は無いので必ず文字列リテラル
// 内で、\u003c は JSON.parse で < に戻る（JSON として有効なまま HTML を安全化）。
const payload = graph.replaceAll("<", "\\u003c");

const template = readFileSync(opt.template, "utf8");
if (!template.includes(MARKER)) {
  process.stderr.write(`エラー: テンプレートにマーカー ${MARKER} がありません: ${opt.template}\n`);
  process.exit(1);
}
// 順序が大事: 先にタイトル（payload 内の __TITLE__ を巻き込まない），
// どちらも関数で差し込む（文字列リプレイサだとタイトルや payload の `$&` `$'` `$\`` が
// 置換特殊文字として展開され、入力を壊す）
const html = template
  .replaceAll("__TITLE__", () => escapeHtml(opt.title))
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
