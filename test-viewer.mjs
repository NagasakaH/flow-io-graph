// viewer/template.html の検査。`node --test test-viewer.mjs` で走る。
// 流れ: render.mjs で flow.html を作る → Playwright で file:// 開く → DOM / localStorage / ダウンロード / hash を見る。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const ROOT = import.meta.dirname;
const OUT = join(ROOT, "out");
const HTML = join(OUT, "flow", "flow.html");
const SHOTS = join(OUT, "shots");
const GRAPH = join(OUT, "flow", "graph.json");
const TITLE = "業務フロー データ I/O";

// ブラウザバイナリ: 指定の 1248 を優先し、無ければ ms-playwright キャッシュから探す
function findBrowser() {
  const base = join(homedir(), "Library", "Caches", "ms-playwright");
  const prefs = ["chromium_headless_shell-1248", "chromium_headless_shell-1243", "chromium_headless_shell-1234"];
  for (const dir of prefs) {
    const p = join(base, dir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
    if (existsSync(p)) return p;
  }
  const dirs = readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
  for (const dir of dirs) {
    const p = join(base, dir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
    if (existsSync(p)) return p;
  }
  throw new Error("chrome-headless-shell が見つかりません: " + base);
}

let browser;
let context;
let page;
const consoleErrors = [];

async function openPage(hash) {
  const p = await context.newPage();
  p.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push("[console] " + m.text());
  });
  p.on("pageerror", (e) => consoleErrors.push("[pageerror] " + String(e && e.message ? e.message : e)));
  const url = pathToFileURL(HTML).href + (hash || "");
  await p.goto(url);
  await p.waitForSelector("#status-bar", { timeout: 15000 });
  return p;
}

before(async () => {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "bin", "render.mjs"), "--graph", GRAPH, "--out", HTML, "--title", TITLE],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, "render.mjs が失敗: " + r.stderr);
  assert.match(r.stdout, /flow\.html/);
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ executablePath: findBrowser() });
  context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 940 } });
  page = await openPage();
});

after(async () => {
  if (browser) await browser.close();
});

// ---------------------------------------------------------------- 検査

test("コンソールエラー 0 件で初期表示できる", async () => {
  assert.deepEqual(consoleErrors, []);
  const counts = await page.textContent("#status-bar");
  assert.match(counts, /表示 \d+ \/ 全 \d+ ノード/);
  assert.match(counts, /表示 \d+ \/ 全 \d+ 縁/);
  assert.match(counts, /全 21 ノード/);
});

test("ヘッダにタイトルと検索・フィルタ・ボタンがそろう", async () => {
  assert.equal((await page.textContent("#app-title")).trim(), TITLE);
  assert.equal(await page.title(), TITLE);
  assert.equal(await page.locator("#search-input").count(), 1);
  const kindChips = await page.locator("#kind-chips .chip").count();
  const provChips = await page.locator("#prov-chips .chip").count();
  assert.equal(kindChips, 5, "kind chips は flow/step/store/boundary/code");
  assert.equal(provChips, 4, "provenance chips は definition/static/llm/human");
  for (const id of ["#btn-export", "#btn-clear-ann", "#btn-share", "#chip-unlinked"]) {
    assert.equal(await page.locator(id).count(), 1, id + " が無い");
  }
  assert.equal(await page.locator(".tab-btn").count(), 5);
});

test("フロー図に注文受信と決済確定のカード、SVG の bezier 縁、境界の向こうのサブカード", async () => {
  const intake = page.locator('#view-flow .fnode[data-node="step:order-intake/receive"]');
  const charge = page.locator('#view-flow .fnode[data-node="step:order-intake/charge"]');
  assert.ok(await intake.count(), "注文受信カードが無い");
  assert.ok(await charge.count(), "決済確定カードが無い");
  assert.match(await intake.innerText(), /注文受信/);
  assert.match(await charge.innerText(), /step:order-intake\/charge/);
  const edges = await page.locator("#flow-edges path.edge").count();
  assert.ok(edges >= 6, "SVG 縁が少なすぎる: " + edges);
  // reads=水色 / writes=オレンジ / invokes=紫 のクラスが揃っている
  assert.ok(await page.locator('#flow-edges path.edge.reads').count(), "reads 縁が無い");
  assert.ok(await page.locator('#flow-edges path.edge.writes').count(), "writes 縁が無い");
  assert.ok(await page.locator('#flow-edges path.edge.invokes').count(), "invokes 縁が無い");
  // llm / human 注釈は破線
  assert.ok(await page.locator("#flow-edges path.edge.dash").count(), "破線（注釈）縁が無い");
  // 右列: 境界の下に API の向こうの格納先（boundary → store:table/payments）
  const sub = page.locator('#view-flow .sub-card[data-node="store:table/payments"]');
  assert.equal(await sub.count(), 1, "境界の向こうのサブカードが無い");
  // 未紐づけ候補は破線枠 + バッジで下段
  const cand = page.locator('#candidate-band .fnode[data-node="store:topic/analytics-events"]');
  assert.equal(await cand.count(), 1, "未紐づけ候補が下段に出ない");
  assert.match(await cand.innerText(), /未紐づけ/);
  await page.screenshot({ path: join(SHOTS, "01-flow.png"), fullPage: false });
});

test("検索 box に orders と入れると候補が出る", async () => {
  await page.fill("#search-input", "orders");
  await page.waitForSelector("#search-results .sr-item", { timeout: 5000 });
  const items = await page.locator("#search-results .sr-item").allInnerTexts();
  assert.ok(items.length > 0, "候補が出ない");
  assert.ok(items.some((t) => /orders/i.test(t)), "候補に orders がない: " + items.join(" | "));
  // code ノードの snippet からも hits になる（このデータでは schema.sql が出る）
  assert.ok(await page.locator('#search-results .sr-item[data-kind="code"]').count(), "コード抜粋からの候補が無い");
  // 候補クリックで選択が詳細パネルへ
  await page.locator('#search-results .sr-item[data-kind="store"]').first().click();
  await page.waitForFunction(() => document.querySelector("#detail-panel .dt-name"));
  const name = await page.textContent("#detail-panel .dt-name");
  assert.match(name, /orders/i);
  await page.fill("#search-input", "");
});

test("ノードをクリックすると詳細パネルに note と縁が出る", async () => {
  await page.evaluate(() => window.__flowViewer.selectNode("store:table/payments"));
  await page.waitForSelector("#detail-panel #detail-metadata");
  const text = await page.innerText("#detail-panel");
  assert.match(text, /決済サービス \(payments-svc\) の Postgres/); // metadata.note
  assert.match(text, /payments-svc の README/); // 入力縁（human）の note
  assert.match(text, /書き込み/);
  assert.match(text, /人間/); // provenance バッジ
  assert.equal(await page.locator("#detail-edges-in .edge-row").count(), 2);
  // ID コピー／URL 共有ボタンがある
  assert.ok(await page.locator('#detail-panel button:has-text("URL 共有")').count());
  await page.screenshot({ path: join(SHOTS, "03-detail.png"), clip: await page.locator("#detail-panel").boundingBox() });
});

test("タブ 3 データ格納先: 行が出てソートできる", async () => {
  await page.click('.tab-btn[data-view="stores"]');
  await page.waitForSelector("#store-rows tr");
  const rows = await page.locator("#store-rows tr").count();
  assert.ok(rows > 0, "格納先テーブルが行 0");
  assert.match(await page.innerText("#view-stores"), /orders/);
  assert.ok(await page.locator('#store-rows tr[data-node="boundary:http/payment-service/charge"]').count());
  // 名前の列で並べ替えても壊れない
  const before2 = await page.locator("#store-rows tr").first().innerText();
  await page.click('#store-table th[data-sortkey="writers"]');
  await page.waitForTimeout(120);
  assert.notEqual(await page.locator("#store-rows tr").first().innerText(), before2, "並べ替えが効いていない");
});

test("タブ 4 I/O 一覧: ステップ 1 行で reads / writes / invokes が出る", async () => {
  await page.click('.tab-btn[data-view="io"]');
  await page.waitForSelector("#io-rows tr");
  const rows = await page.locator("#io-rows tr").count();
  assert.equal(rows, 4, "ステップ 4 行のはず");
  const row = await page.innerText('#io-rows tr[data-node="step:order-intake/receive"]');
  assert.match(row, /注文受信/);
  assert.match(row, /order_drafts/);
  assert.match(row, /orders/);
  assert.match(row, /payment-service\/charge/);
  assert.match(row, /定義/); // provenance
});

test("タブ 5 コード: signals の行番号・ref・要原文確認バッジ", async () => {
  await page.click('.tab-btn[data-view="code"]');
  await page.waitForSelector("#code-list .code-item");
  const items = await page.locator("#code-list .code-item").count();
  assert.ok(items > 0, "コード一覧が空");
  await page.click('#code-list [data-code="code:src/handlers/create_order.py"] .code-head');
  await page.waitForSelector('#code-list [data-code="code:src/handlers/create_order.py"] table.signals');
  const sigRows = await page.locator('#code-list [data-code="code:src/handlers/create_order.py"] table.signals tbody tr').count();
  assert.equal(sigRows, 6, "create_order.py の signals は 6 行");
  assert.ok(await page.locator('#code-list [data-code="code:src/handlers/create_order.py"] .badge.nullref').count(),
    "ref=null に要原文確認バッジが出ていない");
  // 抜粋クリックで該当縁が詳細パネルに開く
  await page.click('#code-list [data-code="code:src/handlers/create_order.py"] td.snip >> nth=1');
  await page.waitForSelector("#detail-panel #detail-edge");
  assert.match(await page.innerText("#detail-panel"), /コードからアクセス/);
  await page.screenshot({ path: join(SHOTS, "04-code.png") });
});

test("グラフタブ: canvas が描画され ⇧クリックで 2 ホップフォーカス", async () => {
  await page.click('.tab-btn[data-view="graph"]');
  await page.waitForSelector("#graph-canvas");
  await page.waitForFunction(() => {
    const c = document.getElementById("graph-canvas");
    return c && c.width > 0 && window.__flowViewer.state.view === "graph";
  });
  await page.waitForTimeout(1600); // 力布局を落ち着かせる
  await page.screenshot({ path: join(SHOTS, "02-graph.png") });
  const box = await page.locator("#graph-canvas").boundingBox();
  // 空白をドラッグして平行移動（エラーが出ないこと）
  await page.mouse.move(box.x + 60, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 110, { steps: 5 });
  await page.mouse.up();
  // ホイール拡大
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(120);
  const zoom = await page.textContent("#hud-zoom");
  assert.notEqual(zoom.trim(), "ズーム 100%", "ホイールでズームしていない");
  // canvas 上のノード座標を画面座標に換算して ⇧クリック → フォーカス、もう一度 ⇧ → 解除
  const pt = await page.evaluate(() => {
    const g = window.__flowViewer.graphView;
    const node = g.sim.nodes.slice().sort((a, b) => b.deg - a.deg)[0];
    const rect = g.canvas.getBoundingClientRect();
    return { id: node.id, x: rect.left + node.x * g.view.k + g.view.x, y: rect.top + node.y * g.view.k + g.view.y };
  });
  await page.keyboard.down("Shift");
  await page.mouse.click(pt.x, pt.y);
  await page.keyboard.up("Shift");
  await page.waitForTimeout(150);
  let focus = await page.evaluate(() => (window.__flowViewer.graphView.focusSet || null) && window.__flowViewer.graphView.focusSet.size);
  assert.ok(focus >= 2, "⇧クリックでフォーカス集合ができない: " + focus + " " + pt.id);
  assert.match(await page.textContent("#hud-focus"), /フォーカス/);
  await page.screenshot({ path: join(SHOTS, "02b-graph-focus.png") });
  // フォーカスで画面が寄るので、座標を作り直してもう一度 ⇧クリック → 解除
  const pt2 = await page.evaluate((id) => {
    const g = window.__flowViewer.graphView;
    const node = g.sim.nodes.find((n) => n.id === id);
    const rect = g.canvas.getBoundingClientRect();
    return { x: rect.left + node.x * g.view.k + g.view.x, y: rect.top + node.y * g.view.k + g.view.y };
  }, pt.id);
  await page.keyboard.down("Shift");
  await page.mouse.click(pt2.x, pt2.y);
  await page.keyboard.up("Shift");
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.__flowViewer.graphView.focusSet === null), true,
    "もう一度 ⇧ で解除されない");
});

test("注釈フォーム c) メタデータ保存 → localStorage → 注釈 JSON ダウンロード", async () => {
  await page.evaluate(() => window.__flowViewer.selectNode("store:table/orders"));
  await page.waitForSelector("#form-meta");
  await page.click("#form-meta summary");
  await page.waitForSelector("#meta-key", { state: "visible" });
  await page.fill("#meta-key", "reviewed_at");
  await page.fill("#meta-value", "2026-11-18");
  await page.click("#btn-save-meta");
  await page.waitForFunction(() => {
    try {
      const doc = JSON.parse(localStorage.getItem("flow-annotations") || "{}");
      return (doc.metadata || []).some((m) => m.set && m.set.reviewed_at === "2026-11-18");
    } catch (e) { return false; }
  }, null, { timeout: 5000 });
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem("flow-annotations")));
  assert.equal(stored.producer, "human");
  assert.equal(stored.schemaVersion, 1);
  assert.deepEqual(stored.metadata[0].match, { kind: "store", id: "store:table/orders" });
  // 詳細パネルにも反映（再描画されている）
  assert.match(await page.innerText("#detail-metadata"), /reviewed_at/);
  // 注釈 JSON ダウンロード
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15000 }),
    page.click("#btn-export"),
  ]);
  assert.equal(download.suggestedFilename(), "human.json");
  const file = await download.path();
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(doc.producer, "human");
  assert.equal(doc.schemaVersion, 1);
  assert.ok(doc.metadata.some((m) => m.set.reviewed_at === "2026-11-18"));
});

test("注釈フォーム b) 新しい格納先を後付けすると破線で縁が増える", async () => {
  await page.evaluate(() => window.__flowViewer.setView("flow"));
  await page.evaluate(() => window.__flowViewer.selectNode("step:order-intake/notify"));
  await page.waitForSelector("#form-new");
  await page.click("#form-new summary");
  await page.waitForSelector("#ann-new-name", { state: "visible" });
  await page.selectOption("#ann-new-kind", "store");
  await page.selectOption("#ann-new-sub", "table");
  await page.fill("#ann-new-name", "EmailLog");
  await page.selectOption("#ann-new-rel", "writes");
  await page.fill("#ann-new-note", "runbook: 通知ログは maildb の EmailLog に積む");
  await page.click("#btn-ann-new");
  await page.waitForFunction(() => window.__flowViewer.state.byId.has("store:table/emaillog"));
  assert.ok(await page.locator('#view-flow [data-node="store:table/emaillog"]').count(), "新規格納先がフロー図に出ない");
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem("flow-annotations")));
  assert.ok(stored.nodes.some((n) => n.id === "store:table/emaillog"));
  const edge = stored.edges.find((e) => e.target === "store:table/emaillog");
  assert.equal(edge.kind, "writes");
  assert.equal(edge.confidence, 0.9);
});

test("未紐づけのみトグルとフィルタでステータスバーの件数が連動する", async () => {
  const all = await page.textContent("#status-counts");
  await page.click("#chip-unlinked");
  await page.waitForTimeout(120);
  const some = await page.textContent("#status-counts");
  assert.notEqual(all, some, "トグルが効いていない");
  const shown = Number(some.match(/表示 (\d+)/)[1]);
  assert.ok(shown > 0 && shown < Number(all.match(/全 (\d+)/)[1]));
  await page.click("#btn-reset-filter");
  await page.waitForTimeout(120);
  assert.equal(await page.textContent("#status-counts"), all);
});

test("hash 復元: #view=graph&flow=...&select=... で開くと選択が戻る", async () => {
  const hash = "#view=graph&flow=" + encodeURIComponent("flow:order-intake") +
    "&select=" + encodeURIComponent("step:order-intake/receive");
  const p2 = await openPage(hash);
  await p2.waitForSelector("#detail-panel .dt-name");
  assert.equal((await p2.textContent("#detail-panel .dt-name")).trim(), "注文受信");
  assert.equal(await p2.getAttribute('.tab-btn[data-view="graph"]', "aria-selected"), "true");
  assert.equal(await p2.evaluate(() => window.__flowViewer.state.flowId), "flow:order-intake");
  assert.equal(await p2.evaluate(() => window.__flowViewer.state.view), "graph");
  // 共有ボタンで URL がコピー可能（data-url に保持）
  await p2.click("#btn-share");
  const url = await p2.getAttribute("#btn-share", "data-url");
  assert.match(url, /#view=graph/);
  assert.match(url, /select=step%3Aorder-intake%2Freceive/);
  await p2.close();
});

test("ローカル注釈をクリアするとグラフが埋め込みデータに戻る", async () => {
  page.on("dialog", (d) => d.accept());
  await page.evaluate(() => window.__flowViewer.setView("flow"));
  const before2 = await page.evaluate(() => window.__flowViewer.state.byId.has("store:table/emaillog"));
  assert.equal(before2, true);
  await page.click("#btn-clear-ann");
  await page.waitForFunction(() => !window.__flowViewer.state.byId.has("store:table/emaillog"));
  assert.equal(await page.evaluate(() => localStorage.getItem("flow-annotations")), null);
  assert.equal(await page.evaluate(() => window.__flowViewer.state.graph.nodes.length), 21);
  assert.deepEqual(consoleErrors, []);
  await page.screenshot({ path: join(SHOTS, "05-flow-clean.png") });
  assert.ok(existsSync(join(SHOTS, "01-flow.png")));
  const shots = readdirSync(SHOTS).filter((f) => f.endsWith(".png"));
  assert.ok(shots.length >= 3, "スクリーンショットが足りない: " + shots.join(", "));
});
