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

// 縁は requestAnimationFrame で引き直すので、本数がそろうまで待つ
// 縁は I/O 縁（edgeItems）と分岐・ループ縁（linkItems）を合わせて rAF で引く
async function waitForEdgesAtLeast(p, n) {
  await p.waitForFunction((n) => {
    const v = window.__flowViewer.flowView;
    const want = v.edgeItems.length + v.linkItems.length;
    return v.edgeItems.length >= n && want === document.querySelectorAll("#flow-edges path.edge").length;
  }, n, { timeout: 8000 });
}
async function laneSeq(p) {
  return p.evaluate(() => Array.from(document.querySelectorAll("#flow-chart > .fc-row")).map((r) =>
    r.classList.contains("fc-arrow-row") ? "▼" : (r.dataset.row || "").split("/").pop()));
}
async function waitForHlEdges(p, n) {
  await p.waitForFunction((n) => document.querySelectorAll("#flow-edges path.edge.hl").length >= n, n, { timeout: 8000 });
}

// ---------------------------------------------------------------- 検査

test("コンソールエラー 0 件で初期表示できる", async () => {
  assert.deepEqual(consoleErrors, []);
  const counts = await page.textContent("#status-bar");
  assert.match(counts, /表示 \d+ \/ 全 \d+ ノード/);
  assert.match(counts, /表示 \d+ \/ 全 \d+ 縁/);
  assert.match(counts, /全 23 ノード/);
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

test("フロー図の既定はたたんだフローチャート（ボックスと ▼、分岐は側面の縁）", async () => {
  const boxes = page.locator('#flow-chart .step-box');
  assert.equal(await boxes.count(), 6, "ステップボックスが 6 個無い");
  const receive = page.locator('#flow-chart .step-box[data-node="step:order-intake/receive"]');
  assert.equal(await receive.count(), 1, "注文受信のボックスが無い");
  const txt = await receive.innerText();
  assert.match(txt, /注文受信/);
  for (const want of ["読 1", "書 1", "呼 1"]) assert.match(txt, new RegExp(want), "バッジが無い: " + want);
  const order = await page.locator("#flow-chart .step-box .nm").allInnerTexts();
  assert.deepEqual(order, ["注文受信", "決済結果", "再試行判定", "決済確定", "購入者通知", "日次レポート"],
    "next の順（contains の order）が崩れている");
  // ▼ は線形 next の間だけ: gate-result -> retry-gate は分岐縁なので ▼ を置かない
  assert.deepEqual(await laneSeq(page),
    ["receive", "▼", "gate-result", "retry-gate", "charge", "▼", "notify", "▼", "daily-report"],
    "▼ の位置が next 縁と合っていない");
  assert.equal(await page.locator("#flow-chart .fc-arrow").count(), 3, "▼ 矢印が 3 本無い");
  // 既定は左右の格納先カラムを出さない（3 列常時表示はやめた）
  assert.equal(await page.locator("#flow-chart .fc-side .fnode").count(), 0, "既定でサイドカードが出ている");
  // 分岐・ループの縁は展開と無関係に常時描く
  assert.equal(await page.locator("#flow-edges path.edge.reads, #flow-edges path.edge.writes, #flow-edges path.edge.invokes").count(), 0,
    "たたんだ状態に I/O 縁が描かれている");
  assert.equal(await page.locator("#flow-edges path.edge.next").count(), 3, "分岐 next 縁が 3 本描かれない");
  // 展開操作方法のヒントがレーンヘッダに 1 行ある
  assert.match(await page.textContent("#flow-hint"), /クリック.*展開.*ⓘ/s);
  // 未紐づけ候補バンドは従来どおり下段
  const cand = page.locator('#candidate-band .fnode[data-node="store:topic/analytics-events"]');
  assert.equal(await cand.count(), 1, "未紐づけ候補が下段に出ない");
  assert.match(await cand.innerText(), /未紐づけ/);
  await page.screenshot({ path: join(SHOTS, "01-flow.png") });
});

test("分岐ノード（gateway）はひし形で描き、条件ラベルを縁の中点に出す", async () => {
  const gws = page.locator("#flow-chart .step-box.gw");
  assert.equal(await gws.count(), 2, "ひし形の分岐ノードが 2 個無い");
  assert.deepEqual(await gws.evaluateAll((bs) => bs.map((b) => b.dataset.node)),
    ["step:order-intake/gate-result", "step:order-intake/retry-gate"]);
  const gate = page.locator('#flow-chart .step-box[data-node="step:order-intake/gate-result"]');
  const gtxt = await gate.innerText();
  assert.match(gtxt, /◇/, "ひし形の目印 ◇ が無い");
  assert.match(gtxt, /決済結果/);
  assert.match(gtxt, /分岐 2/, "分岐数のバッジが無い: " + gtxt);
  // gateway は I/O 未記入とは数えない（分岐ノードなので）
  assert.equal(await gate.locator(".badge.empty-io").count(), 0, "分岐ノードに未記入バッジが出ている");
  // ひし形として描画されている（clip-path を効かせた疑似要素がある）
  const clip = await gate.evaluate((b) => getComputedStyle(b, "::before").clipPath);
  assert.match(clip, /polygon/, "ひし形の clip-path が効いていない: " + clip);
  // 条件ラベルが縁の中点のテキストとして出る
  const labels = await page.locator("#flow-edge-labels text").evaluateAll((ts) => ts.map((t) => t.textContent.trim()));
  for (const want of ["成功", "失敗", "打ち切り（失敗通知）"]) {
    assert.ok(labels.some((t) => t.trim() === want), "縁のラベルが無い: " + want + " / " + JSON.stringify(labels));
  }
  // gate-result の 2 本の分岐縁はそれぞれ別ターゲットへ
  assert.equal(await page.locator('#flow-edges path.edge[data-edge="step:order-intake/gate-result|next|step:order-intake/charge"]').count(), 1);
  assert.equal(await page.locator('#flow-edges path.edge[data-edge="step:order-intake/gate-result|next|step:order-intake/retry-gate"]').count(), 1);
  // 詳細パネルの縁一覧にもラベルが出る
  await gate.locator(".info").click();
  await page.waitForSelector("#detail-panel .dt-name");
  assert.equal((await page.textContent("#detail-panel .dt-name")).trim(), "決済結果");
  const outTxt = await page.textContent("#detail-edges-out");
  assert.match(outTxt, /成功/, "詳細パネルの縁一覧に条件ラベルが無い");
  assert.match(outTxt, /失敗/);
  await page.screenshot({ path: join(SHOTS, "01e-gateway.png") });
});

test("前方向ループ（metadata.loop）は左側を回る強調縁と ↺ ラベルで示す", async () => {
  const loopPath = page.locator('#flow-edges path.edge.loop[data-edge="step:order-intake/retry-gate|next|step:order-intake/receive"]');
  assert.equal(await loopPath.count(), 1, "retry-gate → receive のループ縁が描画されない");
  const d = await loopPath.getAttribute("d");
  const n = d.match(/[-\d.]+/g).map(Number);
  const [x1, y1, cx1, , cx2, , x2, y2] = n;
  assert.ok(y2 < y1, "ループ縁が前方向に戻っていない: " + d);
  assert.ok(cx1 < x1 && cx2 < x2, "ループ縁がレーン左側を回っていない: " + d);
  const labels = await page.locator("#flow-edge-labels text.loop").evaluateAll((ts) => ts.map((t) => t.textContent.trim()));
  assert.equal(labels.length, 1, "ループのラベルが無い: " + JSON.stringify(labels));
  assert.match(labels[0], /↺/, "ループラベルに ↺ が無い: " + labels[0]);
  assert.match(labels[0], /3回目まで再実行/);
  assert.equal(await page.locator("#flow-edges path.edge.next.loop").count(), 0, "ループ縁が分岐縁を兼ねている");
  await page.screenshot({ path: join(SHOTS, "01d-loop.png") });
});

test("分岐ノードもクリックで展開（行先一覧）／もう一度でたためる", async () => {
  const gate = page.locator('#flow-chart .step-box[data-node="step:order-intake/retry-gate"]');
  await gate.click();
  await page.waitForSelector('#flow-chart .sub-card.branch', { timeout: 5000 });
  assert.equal(await gate.getAttribute("data-expanded"), "true");
  const right = page.locator('#flow-chart .fc-side.right[data-for="step:order-intake/retry-gate"]');
  assert.match(await right.innerText(), /この分岐の行先/);
  const chips = (await right.locator(".sub-card.branch").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
  assert.equal(chips.length, 2, "行先が 2 件並ばない: " + JSON.stringify(chips));
  assert.match(chips.join(" | "), /3回目まで再実行: 注文受信/);
  assert.match(chips.join(" | "), /打ち切り（失敗通知）: 購入者通知/);
  assert.match(chips.join(" | "), /ループ/, "ループの行先にループバッジが無い");
  // I/O は無いので「未記入」の案内は出さない
  assert.equal(await right.locator(".hint").count(), 0, "分岐ノードに I/O 未記入の案内が出ている");
  // 行先チップをクリックするとそのステップを選択（展開状態はそのまま）
  await right.locator('.sub-card.branch[data-node="step:order-intake/receive"]').click();
  assert.equal((await page.textContent("#detail-panel .dt-name")).trim(), "注文受信");
  assert.equal(await gate.getAttribute("data-expanded"), "true", "行先チップで展開が解除された");
  await gate.click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator("#flow-chart .sub-card.branch").count(), 0, "たたんでも行先が残る");
});

test("ステップをクリックすると入出力が展開され、もう一度でたためる", async () => {
  const box = page.locator('#flow-chart .step-box[data-node="step:order-intake/receive"]');
  await box.click();
  await page.waitForSelector('#flow-chart .fc-side .fnode', { timeout: 5000 });
  await waitForEdgesAtLeast(page, 4); // reads + writes + invokes + 境界→格納先
  assert.equal(await box.getAttribute("data-expanded"), "true");
  const left = page.locator('#flow-chart .fc-side.left[data-for="step:order-intake/receive"]');
  const right = page.locator('#flow-chart .fc-side.right[data-for="step:order-intake/receive"]');
  assert.equal(await left.locator('[data-node="store:table/order-drafts"]').count(), 1, "order_drafts が左に出ない");
  assert.equal(await right.locator('[data-node="store:table/orders"]').count(), 1, "orders が右に出ない");
  assert.equal(await right.locator('[data-node="boundary:http/payment-service/charge"]').count(), 1,
    "payment-service/charge が右に出ない");
  const sub = right.locator('.sub-card[data-node="store:table/payments"]');
  assert.equal(await sub.count(), 1, "境界の向こうのサブカードが無い");
  assert.match(await right.innerText(), /API の向こうの格納先/);
  assert.ok(await page.locator("#flow-edges path.edge.reads").count(), "reads 縁が無い");
  assert.ok(await page.locator("#flow-edges path.edge.writes").count(), "writes 縁が無い");
  assert.ok(await page.locator("#flow-edges path.edge.invokes").count(), "invokes 縁が無い");
  assert.ok(await page.locator("#flow-edges path.edge.dash").count(), "破線（注釈）縁が無い");
  const paths = await page.locator("#flow-edges path.edge").count();
  assert.ok(paths >= 8, "展開後の縁が少ない（I/O 4 + 分岐 4）: " + paths);
  const ioPaths = await page.locator("#flow-edges path.edge.reads, #flow-edges path.edge.writes, #flow-edges path.edge.invokes")
    .evaluateAll((ps) => ps.map((x) => x.getAttribute("d")));
  for (const d2 of ioPaths) {
    const n = d2.match(/[-\d.]+/g).map(Number);
    const [x1, , cx1, , cx2, , x2] = n;
    const lo = Math.min(x1, x2) - 1, hi = Math.max(x1, x2) + 1;
    assert.ok(cx1 >= lo && cx1 <= hi && cx2 >= lo && cx2 <= hi, "経路が巻き戻っている: " + d2);
  }
  // ⓘ は展開せず詳細パネルだけ開く
  await page.click('#flow-chart .step-box[data-node="step:order-intake/charge"] .info');
  await page.waitForSelector("#detail-panel .dt-name");
  assert.equal((await page.textContent("#detail-panel .dt-name")).trim(), "決済確定");
  assert.equal(await page.getAttribute('#flow-chart .step-box[data-node="step:order-intake/charge"]', "data-expanded"), "false",
    "ⓘ クリックで展開してしまった");
  await page.screenshot({ path: join(SHOTS, "01b-flow-expanded.png") });
  await page.click('#flow-chart .fc-side .fnode[data-node="store:table/orders"]');
  assert.equal((await page.textContent("#detail-panel .dt-name")).trim(), "orders");
  // もう一度クリック → たたんで素のフローチャートに戻る
  await box.click();
  await page.waitForTimeout(150);
  assert.equal(await box.getAttribute("data-expanded"), "false");
  assert.equal(await page.locator("#flow-chart .fc-side .fnode").count(), 0, "たたんでもサイドカードが残っている");
  assert.equal(await page.locator("#flow-edges path.edge.reads, #flow-edges path.edge.writes, #flow-edges path.edge.invokes").count(), 0,
    "たたんでも I/O 縁が残っている");
  assert.equal(await page.locator("#flow-edges path.edge.next, #flow-edges path.edge.loop").count(), 4,
    "たたんだら分岐・ループ縁が 4 本に戻るはず");
});

test("全展開 / 全たたむ と展開状態の hash 復元（共有 URL にも載る）", async () => {
  await page.click("#btn-expand-all");
  await page.waitForSelector('#flow-chart .step-box[data-expanded="true"]', { timeout: 5000 });
  await waitForEdgesAtLeast(page, 13);
  assert.equal(await page.locator('#flow-chart .step-box[data-expanded="true"]').count(), 6, "全展開で 6 倀開かない");
  assert.equal(await page.locator('#flow-chart .step-box.gw[data-expanded="true"]').count(), 2, "分岐ノードが開かない");
  const cards = await page.locator("#flow-chart .fc-side .fnode").count();
  assert.ok(cards >= 11, "全展開でのサイドカードが少ない: " + cards);
  const paths = await page.locator("#flow-edges path.edge").count();
  assert.ok(paths >= 17, "全展開の縁が少ない（I/O 13 + 分岐 4）: " + paths);
  const hash = await page.evaluate(() => location.hash);
  const expPart = (hash.match(/expanded=([^&]*)/) || [])[1] || "";
  assert.ok(!expPart.includes(","), "expanded が URL エンコードされていない: " + hash);
  assert.deepEqual(expPart.split("%2C").map(decodeURIComponent).sort(), [
    "step:order-intake/charge", "step:order-intake/daily-report", "step:order-intake/gate-result",
    "step:order-intake/notify", "step:order-intake/receive", "step:order-intake/retry-gate",
  ], "expanded に 6 ステップ（gateway 含む）が揃わない: " + hash);
  await page.click("#btn-collapse-all");
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#flow-chart .step-box[data-expanded="true"]').count(), 0, "全たたむが効いていない");
  assert.equal(await page.locator("#flow-chart .fc-side .fnode").count(), 0);
  assert.equal(await page.locator("#flow-edges path.edge").count(), 4, "たたんでも分岐・ループ縁は残るはず");
  // gateway の id を含めて expanded を復元する
  const ids = "step:order-intake/gate-result,step:order-intake/receive,step:order-intake/retry-gate";
  const hash2 = "#view=flow&flow=" + encodeURIComponent("flow:order-intake") +
    "&expanded=" + encodeURIComponent(ids) +
    "&select=" + encodeURIComponent("store:table/payments");
  const p2 = await openPage(hash2);
  await p2.waitForSelector('#flow-chart .step-box[data-expanded="true"]');
  assert.deepEqual(await p2.evaluate(() => Array.from(window.__flowViewer.state.expanded)),
    ["step:order-intake/gate-result", "step:order-intake/receive", "step:order-intake/retry-gate"]);
  assert.equal(await p2.locator('#flow-chart .step-box[data-expanded="true"]').count(), 3);
  assert.equal(await p2.locator('#flow-chart .step-box.gw[data-expanded="true"]').count(), 2, "復元後にひし形が開かない");
  assert.equal(await p2.locator("#flow-chart .fc-side .fnode").count(), 3, "復元後にサイドカードが出ない");
  assert.equal(await p2.locator("#flow-chart .sub-card.branch").count(), 4, "復元後に分岐の行先が出ない");
  assert.equal((await p2.textContent("#detail-panel .dt-name")).trim(), "payments");
  await p2.click("#btn-share");
  const url = await p2.getAttribute("#btn-share", "data-url");
  const urlExp = ((url.match(/expanded=([^&]*)/) || [])[1] || "").split("%2C").map(decodeURIComponent);
  assert.deepEqual(urlExp.sort(), ["step:order-intake/gate-result", "step:order-intake/receive", "step:order-intake/retry-gate"],
    "共有 URL に gateway の展開状態が無い: " + url);
  await p2.close();
});

test("クロスハイライト: 展開中のストアを選ぶと結ばれた全ステップと縁が強調される", async () => {
  // orders は 注文受信が書き、日次レポートが読む（決済確定は関係しない）
  await page.click("#btn-collapse-all");
  await page.waitForTimeout(120);
  await page.click('#flow-chart .step-box[data-node="step:order-intake/receive"]');
  await waitForEdgesAtLeast(page, 4);
  await page.click('#flow-chart .step-box[data-node="step:order-intake/charge"]');
  await waitForEdgesAtLeast(page, 8);
  await page.click('#flow-chart .fc-side .fnode[data-node="store:table/orders"]');
  await waitForHlEdges(page, 1);
  const hl = await page.evaluate(() => Array.from(document.querySelectorAll("#flow-chart .step-box.hl"))
    .map((b) => b.dataset.node + "=" + b.querySelector(".xcount").textContent));
  assert.deepEqual(hl.sort(), ["step:order-intake/daily-report=1 縁", "step:order-intake/receive=1 縁"],
    "注文受信と日次レポートが強調されない: " + JSON.stringify(hl));
  assert.equal(await page.locator('#flow-chart .step-box[data-node="step:order-intake/charge"].hl').count(), 0,
    "関係ない決済確定まで強調されている");
  const hlEdges = await page.evaluate(() => Array.from(document.querySelectorAll("#flow-edges path.edge.hl"))
    .map((p) => p.getAttribute("data-edge")));
  assert.ok(hlEdges.includes("step:order-intake/receive|writes|store:table/orders"),
    "orders への縁が強調されない: " + JSON.stringify(hlEdges));
  assert.ok(await page.locator("#flow-edges path.edge.dimmed").count(), "無関係な縁が困轉しない");
  // 分岐・ループ縁も無関係なら困轉する
  assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll("#flow-edges path.edge.loop"))
    .every((p) => p.classList.contains("dimmed"))), true, "ループ縁が困轉しない");
  await page.click('#flow-chart .sub-card[data-node="store:table/payments"] >> nth=0');
  await page.waitForSelector('#flow-chart .step-box[data-node="step:order-intake/charge"].hl', { timeout: 5000 });
  await waitForHlEdges(page, 3);
  const hl2 = await page.evaluate(() => {
    const b = document.querySelector('.step-box[data-node="step:order-intake/charge"]');
    return { cls: b.className, n: b.querySelector(".xcount").textContent };
  });
  assert.match(hl2.cls, /\bhl\b/);
  assert.equal(hl2.n, "2 縁");
  await page.screenshot({ path: join(SHOTS, "01c-flow-crosslight.png") });
  await page.evaluate(() => window.__flowViewer.selectNode("flow:order-intake"));
  await page.waitForTimeout(250);
  assert.equal(await page.locator("#flow-chart .step-box.hl").count(), 0, "選択解除後も強調が残る");
  assert.equal(await page.locator("#flow-edges path.edge.dimmed").count(), 0, "選択解除後も困轉が残る");
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

test("タブ 4 I/O 一覧: ステップ 6 行（分岐ノードも含む）で reads / writes / invokes が出る", async () => {
  await page.click('.tab-btn[data-view="io"]');
  await page.waitForSelector("#io-rows tr");
  const rows = await page.locator("#io-rows tr").count();
  assert.equal(rows, 6, "ステップ 6 行のはず");
  // 分岐ノードも 1 行として数える（I/O は 0 件）
  const gwRow = await page.innerText('#io-rows tr[data-node="step:order-intake/gate-result"]');
  assert.match(gwRow, /決済結果/, "分岐ノードが行に無い");
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
  // フロー図は折りたたみ既定なので、縁を見るには該当ステップを展開する
  await page.click("#btn-collapse-all");
  await page.waitForTimeout(120);
  await page.click('#flow-chart .step-box[data-node="step:order-intake/notify"]');
  await waitForEdgesAtLeast(page, 2); // 既存の reads + writes
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
  await waitForEdgesAtLeast(page, 3); // 後付けした writes が足される
  const mail = page.locator('#flow-chart .fc-side .fnode[data-node="store:table/emaillog"]');
  assert.equal(await mail.count(), 1, "後付けした格納先が購入者通知の展開時に出ない");
  assert.ok(await page.locator('#flow-edges path.edge[data-edge="step:order-intake/notify|writes|store:table/emaillog"]').count(),
    "後付け縁がフロー図に描画されない");
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
  assert.equal(await page.evaluate(() => window.__flowViewer.state.graph.nodes.length), 23);
  assert.deepEqual(consoleErrors, []);
  await page.screenshot({ path: join(SHOTS, "05-flow-clean.png") });
  assert.ok(existsSync(join(SHOTS, "01-flow.png")));
  const shots = readdirSync(SHOTS).filter((f) => f.endsWith(".png"));
  assert.ok(shots.length >= 8, "スクリーンショットが足りない: " + shots.join(", "));
  for (const need of ["01-flow.png", "01b-flow-expanded.png", "01d-loop.png", "01e-gateway.png"]) {
    assert.ok(shots.includes(need), "必須のスクリーンショットが無い: " + need);
  }
});
