// viewer/template.html の検査。`node --test test-viewer.mjs` で走る。
// 流れ: render.mjs で flow.html を作る → Playwright で file:// 開く → DOM / localStorage / ダウンロード / hash を見る。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  // 既存検査は従来どおりダーク描画（ライトは下の別コンテキストで検証する）
  context = await browser.newContext({ acceptDownloads: true, colorScheme: "dark", viewport: { width: 1500, height: 940 } });
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
    // サイド列をスクロールして画面外になった端点の縁は描かないので、描けるぶんだけ比較する
    const want = v.edgeItems.concat(v.linkItems).filter((it) => it.d).length;
    return v.edgeItems.length >= n && want === document.querySelectorAll("#flow-edges path.edge").length;
  }, n, { timeout: 8000 });
}
async function laneSeq(p) {
  return p.evaluate(() => Array.from(document.querySelectorAll("#flow-chart > .fc-row")).map((r) =>
    r.classList.contains("fc-arrow-row") ? "▼"
      : r.classList.contains("fc-term-row") ? r.querySelector(".term").textContent.trim()
        : (r.dataset.row || "").split("/").pop()));
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
    ["開始", "▼", "receive", "▼", "gate-result", "retry-gate", "charge", "▼", "notify", "▼", "daily-report", "▼", "終了"],
    "▼ と開始／終了の位置が next 縁と合っていない");
  // 線形 next の ▼ 3 本 + 開始・終了の目印の矢印 2 本
  assert.equal(await page.locator("#flow-chart .fc-arrow").count(), 5, "▼ 矢印の本数が違う");
  assert.deepEqual(await page.locator("#flow-chart .fc-term-row .term").allInnerTexts(), ["開始", "終了"],
    "フローの先頭・末尾の目印が無い");
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

test("前方向ループ（metadata.loop）は左頂点から出て左ガターを回り、行き先の下辺へ上向きに戻る", async () => {
  const SRC = "step:order-intake/retry-gate";
  const loopPath = page.locator('#flow-edges path.edge.loop[data-edge="step:order-intake/retry-gate|next|step:order-intake/receive"]');
  assert.equal(await loopPath.count(), 1, "retry-gate → receive のループ縁が描画されない");
  const d = await loopPath.getAttribute("d");
  const n = d.match(/[-\d.]+/g).map(Number);
  // M 出所 C 制御 .. .. 折れ L ガター走行 .. C .. .. 進入前 L 終点
  const [x1, y1] = n;
  const [gx, gy] = n.slice(6, 8);
  const [x3, y3, x2, y2] = n.slice(-4);
  assert.equal(await loopPath.getAttribute("data-route"), "loop", "ループ縁の経路種別が違う");
  assert.ok(y2 < y1 - 40, "ループ縁が前方向に戻っていない: " + d);
  assert.ok(gx < Math.min(x1, x2) - 6, "ループ縁がレーン左側を回っていない: " + d);
  // 出口は出所の「左頂点」（前方分岐は下頂点）。折れの直前まで真横に走る
  const anchor = await page.evaluate((id) => {
    const lane = document.querySelector("#flow-chart").getBoundingClientRect();
    const r = document.querySelector('.step-box[data-node="' + id + '"]').getBoundingClientRect();
    return { left: r.left - lane.left, cy: (r.top + r.bottom) / 2 - lane.top };
  }, SRC);
  assert.ok(Math.abs(x1 - anchor.left) <= 2, "ループ縁が左頂点から出ていない: " + d);
  assert.ok(Math.abs(y1 - anchor.cy) <= 2, "ループ縁の出口がひし形の左頂点の高さに無い: " + d);
  assert.ok(Math.abs(n[3] - y1) < 0.01, "左頂点から真横に出ている（折れが角丸）: " + d);
  assert.ok(Math.abs(n[8] - gx) < 0.01, "ガターが縦一直線になっていない: " + d);
  assert.ok(x3 === x2 && y3 > y2 + 6, "ループ縁が行き先の下辺へ上向きに届いていない: " + d);
  assert.equal(await loopPath.getAttribute("data-face"), "up", "ループ縁の入り方向が違う");
  const labels = await page.locator("#flow-edge-labels text.loop").evaluateAll((ts) => ts.map((t) => t.textContent.trim()));
  assert.equal(labels.length, 1, "ループのラベルが無い: " + JSON.stringify(labels));
  assert.match(labels[0], /↺/, "ループラベルに ↺ が無い: " + labels[0]);
  assert.match(labels[0], /3回目まで再実行/);
  assert.equal(await page.locator("#flow-edges path.edge.next.loop").count(), 0, "ループ縁が分岐縁を兼ねている");
  await page.screenshot({ path: join(SHOTS, "01d-loop.png") });
});

test("gateway はどのビューでも未記入に数えない（フロー一覧 / I/O 一覧 / 詳細パネル）", async () => {
  const GW = "step:order-intake/gate-result";
  // 新規ページ（ノード未選択）: サマリーのフロー一覧は未記入 0（修正前は gateway 2 個を数えていた）
  const p0 = await openPage();
  await p0.waitForSelector("#detail-summary table");
  assert.equal(await p0.locator("#detail-summary .badge.empty-io").count(), 0, "フロー一覧の未記列が gateway を数えている");
  await p0.close();
  // I/O 一覧: gateway 行の名前セル（3 列目。1 列目はフロー）は「分岐 N」バッジで「未記入」ではない
  await page.click('.tab-btn[data-view="io"]');
  await page.waitForSelector("#io-rows tr");
  const gwCell = await page.locator(`#io-rows tr[data-node="${GW}"] td`).nth(2).innerText();
  assert.match(gwCell, /分岐 \d/, "I/O 一覧の gateway 行に分岐バッジが無い: " + gwCell);
  assert.doesNotMatch(gwCell, /未記入/, "I/O 一覧の gateway が未記入扱い");
  // 詳細パネル: gateway 選択時は分岐バッジを出し、未記入バッジは出さない
  await page.locator(`#io-rows tr[data-node="${GW}"]`).click();
  await page.waitForSelector("#detail-panel .dt-name");
  assert.equal((await page.textContent("#detail-panel .dt-name")).trim(), "決済結果", "gateway 行クリックで選択が違う");
  const head = await page.locator("#detail-panel").evaluate((d) => ({
    badges: [...d.querySelectorAll(".dt-head + div .badge")].map((b) => b.textContent.trim()),
    hasEmpty: !!d.querySelector(".badge.empty-io"),
  }));
  assert.ok(!head.hasEmpty, "詳細パネルの gateway に未記入バッジ: " + JSON.stringify(head.badges));
  assert.ok(head.badges.some((t) => /分岐 \d/.test(t)), "詳細パネルに gateway バッジが無い: " + JSON.stringify(head.badges));
  // 後の検査のためフロー図タブに戻す
  await page.click('.tab-btn[data-view="flow"]');
  await page.waitForSelector('#flow-chart .step-box');
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
    const [x1, y1, cx1, , cx2, , x3, y3, x2, y2] = n;
    const allow = Math.max(12, Math.abs(x2 - x1) * 0.5) + 1;
    const lo = Math.min(x1, x2) - allow, hi = Math.max(x1, x2) + allow;
    assert.ok(cx1 >= lo && cx1 <= hi && cx2 >= lo && cx2 <= hi, "経路が巻き戻っている: " + d2);
    assert.ok(Math.abs(x2 - x3) + Math.abs(y2 - y3) >= 7, "終点直前が直進していない（矢印が寝て見える）: " + d2);
    void y1;
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
  // 境界からの書き込み 1 本。読み取り 1 本は 格納先 → タスク 向きで描くので出力縁側へ移る
  assert.equal(await page.locator("#detail-edges-in .edge-row").count(), 1);
  assert.match(await page.innerText("#detail-edges-out"), /reads/);
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

// ============================================================
//  フェーズ 4: 矢印の向きとテーマ（ライトモード）
// ============================================================
function insidePt(p, d) {
  return Math.abs(p.x - d.cx) / d.a + Math.abs(p.y - d.cy) / d.b <= 1;
}

const FACE_DEG = { down: 90, up: -90, right: 0, left: 180 };
function angDiff(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return Math.abs(d);
}
function rgbOf(c) {
  const t = String(c).trim();
  const h = t.match(/^#([0-9a-f]{6})[0-9a-f]{0,2}$/i);
  if (h) return [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16));
  const m = t.match(/[\d.]+/g);
  return m && m.length >= 3 ? m.slice(0, 3).map(Number) : null;
}
function lum(c) {
  const m = rgbOf(c);
  if (!m) return 0;
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
}
function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// テーマ検証用のページ（prefers-color-scheme と localStorage を外から制御する）
async function openThemed(colorScheme, hash) {
  const ctx = await browser.newContext({ colorScheme, viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error") consoleErrors.push("[light console] " + m.text()); });
  p.on("pageerror", (e) => consoleErrors.push("[light pageerror] " + String(e && e.message ? e.message : e)));
  await p.goto(pathToFileURL(HTML).href + (hash || ""));
  await p.waitForSelector("#status-bar", { timeout: 15000 });
  return { ctx, p };
}
const themeState = (p) => p.evaluate(() => {
  let stored = "ERR";
  try { stored = localStorage.getItem("flow-theme"); } catch (e) { /* ignore */ }
  const btn = document.querySelector("#btn-theme");
  return {
    theme: document.documentElement.dataset.theme,
    mode: document.documentElement.dataset.themeMode,
    btn: btn ? btn.textContent : "",
    stored,
  };
});

test("縁の三角は終端接線と同じ向き（▼・分岐・ループ・展開時 I/O）", async () => {
  await page.evaluate(() => window.__flowViewer.setView("flow"));
  await page.click("#btn-expand-all");
  await page.waitForFunction(() => window.__flowViewer.flowView.edgeItems.length > 0, null, { timeout: 8000 });
  await page.waitForTimeout(400);
  // マーカーは orient="auto"（手書きポリゴンを回していないか）
  const marks = await page.evaluate(() => Array.prototype.map.call(
    document.querySelectorAll("#flow-edges marker"), (m) => m.getAttribute("orient")));
  assert.ok(marks.length >= 4, "マーカー定義が少ない: " + marks.join(","));
  assert.ok(marks.every((o) => o === "auto"), "orient=auto でないマーカーがある: " + marks.join(","));
  // ▼: 軸の終端接線と三角の向き
  const dn = await page.evaluate(() => {
    const stem = document.querySelector(".fc-arrow-svg path[data-arrow='stem']");
    const head = document.querySelector(".fc-arrow-svg path[data-arrow='head']");
    if (!stem || !head) return null;
    const L = stem.getTotalLength();
    const a = stem.getPointAtLength(L), b = stem.getPointAtLength(Math.max(0, L - 4));
    const p = head.getAttribute("d").match(/-?[\d.]+/g).map(Number);
    return {
      arrows: document.querySelectorAll(".fc-arrow-svg").length,
      stem: Math.atan2(a.y - b.y, a.x - b.x) * 180 / Math.PI,
      head: Math.atan2(p[5] - (p[1] + p[3]) / 2, p[4] - (p[0] + p[2]) / 2) * 180 / Math.PI,
    };
  });
  // 線形 next の ▼ 3 本 + 開始／終了の目印の ▼ 2 本
  assert.ok(dn && dn.arrows === 5, "▼ が SVG 矢印として描画されていない: " + JSON.stringify(dn));
  assert.ok(angDiff(dn.stem, dn.head) <= 10, "▼ の軸と三角の向きがズレている: " + JSON.stringify(dn));
  assert.ok(angDiff(dn.head, 90) <= 10, "▼ が真下を向いていない: " + dn.head);
  // 各縁: 実パスの終端接線を getPointAtLength で測り、三角の向き（data-tan）と入る辺の法線へ照合
  const rows = await page.locator("#flow-edges path.edge[data-tan]").evaluateAll((ps) => ps.map((el) => {
    const L = el.getTotalLength();
    const a = el.getPointAtLength(L), b = el.getPointAtLength(Math.max(0, L - 6));
    return {
      edge: el.dataset.edge, face: el.dataset.face, tan: Number(el.dataset.tan),
      meas: Math.atan2(a.y - b.y, a.x - b.x) * 180 / Math.PI,
    };
  }));
  assert.ok(rows.length >= 12, "角度を比較できる縁が少ない: " + rows.length);
  const kinds = new Set();
  for (const r of rows) {
    kinds.add(r.edge.split("|")[1]);
    assert.ok(angDiff(r.tan, r.meas) <= 10, "三角の向きと実パスの終端接線が食い違う: " + JSON.stringify(r));
    assert.ok(angDiff(r.meas, FACE_DEG[r.face]) <= 10, "三角が入る辺の法線を向いていない: " + JSON.stringify(r));
  }
  assert.ok(kinds.has("next"), "分岐／ループ縁の角度を検査できない");
  assert.ok(["reads", "writes", "invokes"].some((k) => kinds.has(k)), "I/O 縁の角度を検査できない: " + [...kinds].join(","));
  // 直線 ▼ とは別に、曲線縁（分岐）の角度も個別に確認しておく
  const br = rows.find((r) => r.face === "down");
  assert.ok(br, "上辺へ入る分岐縁が無い");
  await page.screenshot({ path: join(SHOTS, "01f-arrow-angle.png") });
  await page.click("#btn-collapse-all");
  await page.waitForTimeout(250);
});

// ページ側で縁・ラベル・ひし形の幾何を実測する（たたむ／全展開の両方で呼ぶ）
function flowGeomAudit() {
  const fv = window.__flowViewer.flowView;
  const m = fv.svg.getScreenCTM();
  const to = (x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
  const gws = Array.from(fv.lane.querySelectorAll(".step-box.gw")).map((b) => {
    const r = b.getBoundingClientRect();
    return {
      node: b.dataset.node, cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      a: r.width / 2, b: r.height / 2, x0: r.left, y0: r.top, x1: r.right, y1: r.bottom,
    };
  });
  const infos = Array.from(fv.lane.querySelectorAll(".step-box .info")).map((b) => {
    const r = b.getBoundingClientRect();
    return { node: b.parentElement.dataset.node, x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
  });
  const inside = (p, d) => Math.abs(p.x - d.cx) / d.a + Math.abs(p.y - d.cy) / d.b <= 0.96;
  const paths = Array.from(fv.svg.querySelectorAll("path.edge[data-route]")).map((p) => {
    const L = p.getTotalLength();
    const steps = Math.max(10, Math.round(L / 4));
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const q = p.getPointAtLength((L * i) / steps);
      pts.push(to(q.x, q.y));
    }
    const start = pts[0];
    const end = pts[pts.length - 1];
    const bad = [];
    pts.forEach((q) => {
      if (Math.hypot(q.x - start.x, q.y - start.y) < 9 || Math.hypot(q.x - end.x, q.y - end.y) < 9) return;
      gws.forEach((d) => {
        if (inside(q, d)) bad.push(d.node + "@" + Math.round(q.x) + "," + Math.round(q.y));
      });
    });
    return {
      edge: p.getAttribute("data-edge"), route: p.getAttribute("data-route"), len: L,
      hspan: p.getBBox().width, start: start, end: end, bad: bad, pts: pts,
    };
  });
  const labels = Array.from(document.querySelectorAll("#flow-edge-labels text")).map((t) => {
    const bg = t.previousElementSibling;
    const bb = bg && bg.tagName === "rect" ? bg.getBBox() : t.getBBox();
    const mm = t.ownerSVGElement.getScreenCTM();
    const p0 = { x: mm.a * bb.x + mm.e, y: mm.d * bb.y + mm.f };
    const p1 = { x: mm.a * (bb.x + bb.width) + mm.e, y: mm.d * (bb.y + bb.height) + mm.f };
    return { text: t.textContent.trim(), x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y };
  });
  // 通常進行の ▼（.fc-arrow-row）と、同じ行の .fc-mid（ステップ列）の中心 X
  const cx = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
  const arrows = Array.from(fv.lane.querySelectorAll(".fc-arrow-row")).map((r) => {
    const g = r.querySelector(".fc-arrow-svg") || r.querySelector(".fc-arrow");
    const q = g.getBoundingClientRect();
    const pv = r.previousElementSibling ? r.previousElementSibling.querySelector(".fc-mid") : null;
    const nx = r.nextElementSibling ? r.nextElementSibling.querySelector(".fc-mid") : null;
    return {
      cx: q.left + q.width / 2, prev: pv ? cx(pv) : null, next: nx ? cx(nx) : null,
      y0: q.top, y1: q.bottom,
    };
  });
  // 見えているサイドカード（注釈チップ込みの矩形。列ではみ出した部分はクリップして数えない）
  const cards = [];
  Array.prototype.forEach.call(fv.lane.querySelectorAll(".fc-side"), (col) => {
    const cr = col.getBoundingClientRect();
    Array.prototype.forEach.call(col.querySelectorAll(".fnode, .sub-card"), (c) => {
      const r = c.getBoundingClientRect();
      const x0 = Math.max(r.left, cr.left), x1 = Math.min(r.right, cr.right);
      const y0 = Math.max(r.top, cr.top), y1 = Math.min(r.bottom, cr.bottom);
      if (x1 - x0 > 2 && y1 - y0 > 2) cards.push({ node: c.dataset.node || c.className, x0: x0, y0: y0, x1: x1, y1: y1 });
    });
  });
  return { paths: paths, labels: labels, infos: infos, gws: gws, arrows: arrows, cards: cards };
}

const hitRect = (a, b) => a.x1 > b.x0 + 1 && b.x1 > a.x0 + 1 && a.y1 > b.y0 + 1 && b.y1 > a.y0 + 1;
const ccw3 = (a, b, c) => (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x) > 0;
const segHit = (a, b, c, d) => ccw3(a, c, d) !== ccw3(b, c, d) && ccw3(a, b, c) !== ccw3(a, b, d);
const rectCorner = (R, i) => ({ x: i % 2 ? R.x1 : R.x0, y: i < 2 ? R.y0 : R.y1 });

function checkFlowGeom(rep, tag) {
  assert.equal(rep.gws.length, 2, tag + ": 分岐ノードが 2 つ描画されていない");
  assert.equal(rep.paths.length, 4, tag + ": 分岐・ループ縁の本数が違う: " + rep.paths.map((p) => p.edge).join(" / "));
  // 1) ひし形のシルエット上を走る縁は無し（自ノードの頂点接続だけ許す）
  for (const p of rep.paths) {
    assert.deepEqual(p.bad, [], tag + ": 縁がひし形の中を横切っている: " + p.edge + " → " + p.bad.join(", "));
  }
  // 2) 出所は前方分岐なら下頂点、ループ／後ろ向き縁なら左頂点（頂点の重複使用をやめた）
  for (const p of rep.paths) {
    const src = rep.gws.find((d) => d.node === p.edge.split("|")[0]);
    if (!src) continue;
    if (p.route === "loop") {
      assert.ok(Math.abs(p.start.x - src.x0) < 4, tag + ": 左頂点から出ていない（x）: " + p.edge);
      assert.ok(Math.abs(p.start.y - src.cy) < 4, tag + ": 左頂点から出ていない（y）: " + p.edge);
    } else if (p.route === "vertex") {
      // 頂点直結は同宛先の条件数だけ下辺に沿って左右へ刻む（ひし形の輪郭の上にあること）
      const hw = (src.x1 - src.x0) / 2, hh = (src.y1 - src.y0) / 2;
      const off = Math.abs(Math.abs(p.start.x - src.cx) / hw + (p.start.y - src.cy) / hh - 1);
      assert.ok(off < 0.08, tag + ": 頂点直結縁の出所がひし形の下辺上にない: " + p.edge + " 差=" + off.toFixed(2));
      assert.ok(Math.abs(p.start.x - src.cx) <= hw * 0.6, tag + ": 頂点直結縁の出所が頂点から離れすぎ: " + p.edge);
    } else {
      assert.ok(Math.abs(p.start.x - src.cx) < 4, tag + ": 出所が下頂点の真下にない: " + p.edge);
      assert.ok(Math.abs(p.start.y - src.y1) < 4, tag + ": 出所が下頂点から出ていない: " + p.edge);
    }
  }
  // 3) ゲートウェイ間の「失敗」は頂点から頂点への垂直下降（水平成分 20% 未満）
  const fail = rep.paths.find((p) => p.edge === "step:order-intake/gate-result|next|step:order-intake/retry-gate");
  assert.ok(fail, tag + ": 失敗縁が無い");
  assert.equal(fail.route, "vertex", tag + ": 失敗縁が頂点直結になっていない");
  assert.ok(fail.hspan / fail.len < 0.2,
    tag + ": 失敗縁の水平成分が大きすぎる: " + fail.hspan.toFixed(1) + "/" + fail.len.toFixed(1));
  const dst = rep.gws.find((d) => d.node === "step:order-intake/retry-gate");
  assert.ok(Math.abs(fail.end.x - dst.cx) < 4 && Math.abs(fail.end.y - dst.y0) < 4,
    tag + ": 失敗縁が再試行判定の上頂点へ入っていない: " + JSON.stringify(fail.end));
  // 4) 縁ラベルは ⓘ ともひし形の輪郭とも重ならない
  for (const L of rep.labels) {
    for (const I of rep.infos) {
      assert.ok(!hitRect(L, I),
        tag + ": ラベル「" + L.text + "」が ⓘ と重なっている: " + JSON.stringify(L) + " vs " + JSON.stringify(I));
    }
    for (const d of rep.gws) {
      const V = [{ x: d.cx, y: d.y0 }, { x: d.x1, y: d.cy }, { x: d.cx, y: d.y1 }, { x: d.x0, y: d.cy }];
      let hit = false;
      for (let i = 0; i < 4 && !hit; i++) {
        for (let j = 0; j < 4 && !hit; j++) {
          if (segHit(V[i], V[(i + 1) % 4], rectCorner(L, j), rectCorner(L, (j + 1) % 4))) hit = true;
        }
      }
      [0, 1, 2, 3].forEach((i) => { if (insidePt(rectCorner(L, i), d)) hit = true; });
      assert.ok(!hit, tag + ": ラベル「" + L.text + "」がひし形の輪郭に掛かっている: " + JSON.stringify(L));
    }
  }
  // 5) ⓘ はひし形の輪郭の内側（頂上付近）に置かない
  for (const I of rep.infos) {
    const d = rep.gws.find((g) => g.node === I.node);
    if (!d) continue;
    const c = { x: (I.x0 + I.x1) / 2, y: (I.y0 + I.y1) / 2 };
    assert.ok(!insidePt(c, d), tag + ": 分岐ノードの ⓘ がひし形の中にある: " + I.node);
  }
  // 6) 分岐・ループ縁どうしが交差しない（成功経路と打ち切り経路が重なって見えないこと）。
  //    同じ頂点から出る縁は始点近傍を除外する（頂点を共有するのは仕様どおり）
  const nearPt = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 14;
  for (let i = 0; i < rep.paths.length; i++) {
    for (let j = i + 1; j < rep.paths.length; j++) {
      const A = rep.paths[i], B = rep.paths[j];
      let cross = null;
      for (let a = 0; a < A.pts.length - 1 && !cross; a++) {
        for (let b = 0; b < B.pts.length - 1 && !cross; b++) {
          if (nearPt(A.pts[a], B.pts[b]) || nearPt(A.pts[a + 1], B.pts[b]) ||
            nearPt(A.pts[a], B.pts[b + 1]) || nearPt(A.pts[a + 1], B.pts[b + 1])) continue;
          if (segHit(A.pts[a], A.pts[a + 1], B.pts[b], B.pts[b + 1])) cross = A.pts[a];
        }
      }
      assert.equal(cross, null, tag + ": 分岐縁が交差している: " + A.edge + " × " + B.edge);
    }
  }
  assert.ok(rep.labels.length >= 4, tag + ": 縁ラベルが少ない: " + rep.labels.map((l) => l.text).join("/"));
  // 7) 通常進行の ▼ はステップ列の中央にある（矢印行だけ幅配分が違うと図全体が左にずれて見える）
  assert.ok(rep.arrows.length >= 3, tag + ": 通常進行の ▼ 行が少ない: " + rep.arrows.length);
  for (const A of rep.arrows) {
    for (const [rel, v] of [["上", A.prev], ["下", A.next]]) {
      if (v === null) continue;
      assert.ok(Math.abs(A.cx - v) <= 1,
        tag + ": ▼ の中心 X がステップ列の中心と違う（" + rel + "行との差 " + (A.cx - v).toFixed(1) + "px）");
    }
  }
  // 8) 縁ラベルは展開中のサイドカード（注釈チップ込み）に重ならない
  const clash = [];
  for (const L of rep.labels) {
    for (const C of rep.cards) {
      if (hitRect(L, C)) clash.push(L.text + " × " + C.node);
    }
  }
  assert.deepEqual(clash, [], tag + ": 縁ラベルがサイドカードに重なっている");
}

test("分岐縁は下頂点から出てひし形を横切らない（頂点のみ進入・ラベル重なり 0）", async () => {
  await page.evaluate(() => window.__flowViewer.setView("flow"));
  await page.click("#btn-collapse-all");
  await page.waitForTimeout(200);
  checkFlowGeom(await page.evaluate(flowGeomAudit), "たたんだ状態");
  await page.screenshot({ path: join(SHOTS, "01g-branch.png") });
  // 展開時はサイドカードがガターに重なるので、同じ検査を通す
  await page.click("#btn-expand-all");
  await page.waitForTimeout(300);
  checkFlowGeom(await page.evaluate(flowGeomAudit), "全展開");
  await page.screenshot({ path: join(SHOTS, "01h-branch-expanded.png") });
  await page.click("#btn-collapse-all");
});

// ラベル無し分岐・同一端点の並行縁・自己ループは実データに無いので合成グラフで検査する
function synthGraph() {
  const edges = [];
  const E = (source, target, kind, metadata) => edges.push(
    metadata ? { source, target, kind, provenance: "definition", confidence: 1, metadata }
      : { source, target, kind, provenance: "definition", confidence: 1 });
  ["s1", "s2", "s3", "s4", "s5"].forEach((id, i) => E("flow:sync", "step:sync/" + id, "contains", { order: i + 1 }));
  E("step:sync/s1", "step:sync/s2", "next", { order: 2 });
  E("step:sync/s2", "step:sync/s3", "next", { order: 3 });
  E("step:sync/s3", "step:sync/s4", "next", { order: 4 });
  E("step:sync/s4", "step:sync/s5", "next", { order: 5 });
  // ラベルの無い非隣接分岐（旧実装は中央 ▼ に吸収して消していた）
  E("step:sync/s2", "step:sync/s4", "next", { order: 4 });
  // 同一端点の並行縁（条件違い）
  E("step:sync/s2", "step:sync/s4", "next", { order: 4, label: "リトライ" });
  E("step:sync/s2", "step:sync/s4", "next", { order: 4, label: "フォールバック" });
  E("step:sync/s2", "step:sync/s4", "next", { order: 4, label: "条件名が長い場合は折り返さず左右どちらかへ寄せる" });
  E("step:sync/s2", "step:sync/s4", "next", { order: 4, label: "打ち切り" });
  // ゲートウェイ同士で宛先が同じ 2 条件（頂点直結が重なってはいけない）
  E("step:sync/s2", "step:sync/s3", "next", { order: 3, label: "経路A" });
  E("step:sync/s2", "step:sync/s3", "next", { order: 3, label: "経路B" });
  // 自身に戻る分岐（source === target）
  E("step:sync/s3", "step:sync/s3", "next", { order: 3, label: "やり直し", loop: true });
  // 同じ格納先を読む／書く
  E("step:sync/s4", "store:table/sync-state", "reads", { access: "read" });
  E("step:sync/s4", "store:table/sync-state", "writes", { access: "write" });
  // API の向こうの格納先を読む縁（サブカード側も 格納先 → API の向きで描く）
  E("step:sync/s3", "boundary:http/sync-api/fetch", "invokes");
  E("boundary:http/sync-api/fetch", "store:table/sync-state", "reads", { access: "read" });
  // 同じ API・同じ格納先への書き込み（seen の重複除去で片方が消えないこと）
  E("boundary:http/sync-api/fetch", "store:table/sync-state", "writes", { access: "write" });
  // 末尾ステップが後方 next（自分自身へのリトライ）だけならフローは終わっていない
  E("step:sync/s5", "step:sync/s5", "next", { order: 5, label: "リトライ", loop: true });
  // scan 由来の方向未判定アクセス（詳細パネルで「方向未判定」として出す）
  E("code:src/sync.ts#run", "store:table/sync-state", "touches", { access: "unknown" });
  const step = (id, name, md) => Object.assign(
    { id: "step:sync/" + id, kind: "step", name: name, parent: "flow:sync", metadata: { provenance: "definition" } },
    md ? { metadata: Object.assign({ provenance: "definition" }, md) } : {});
  return {
    schemaVersion: 1, generatedAt: "2026-01-01T00:00:00Z", root: "flow:sync", warnings: [],
    nodes: [
      { id: "flow:sync", kind: "flow", name: "検査用フロー", metadata: { provenance: "definition" } },
      step("s1", "取り込み"),
      step("s2", "振り分け", { stepKind: "gateway", description: "ラベル無し分岐を検証する門" }),
      step("s3", "同期待ち", { stepKind: "gateway", description: "自分自身へ戻る分岐" }),
      step("s4", "反映"),
      step("s5", "後処理"),
      { id: "store:table/sync-state", kind: "store", name: "sync-state", metadata: { storeKind: "table", provenance: "definition" } },
      { id: "boundary:http/sync-api/fetch", kind: "boundary", name: "sync-api/fetch", metadata: { boundaryKind: "http", provenance: "definition" } },
      { id: "code:src/sync.ts#run", kind: "code", name: "sync.ts#run", metadata: { path: "src/sync.ts", provenance: "definition" } },
    ],
    edges,
  };
}

// 縁の縦走り（ガター）の x を最頻値で測る。ページ側で走る自己完結の関数
const runXs = (els) => els.map((el) => {
  const L = el.getTotalLength();
  const c = {};
  for (let i = 0; i <= L; i += 4) {
    const x = Math.round(el.getPointAtLength(i).x);
    c[x] = (c[x] || 0) + 1;
  }
  return Number(Object.keys(c).sort((a, b) => c[b] - c[a])[0]);
});

// レーン基準のボックス位置（縁の始点・終点は #flow-chart 基準の座標で描かれる）
const boxOf = (p, sel) => p.evaluate((sel) => {
  const lane = document.querySelector("#flow-chart").getBoundingClientRect();
  const r = document.querySelector(sel).getBoundingClientRect();
  return {
    x0: r.left - lane.left, y0: r.top - lane.top, x1: r.right - lane.left, y1: r.bottom - lane.top,
    cx: (r.left + r.right) / 2 - lane.left, cy: (r.top + r.bottom) / 2 - lane.top,
  };
}, sel);

async function openFile(absPath, hash, sink) {
  const p = await context.newPage();
  const errs = sink || consoleErrors;
  p.on("console", (m) => { if (m.type() === "error") errs.push("[console] " + m.text()); });
  p.on("pageerror", (e) => errs.push("[pageerror] " + String(e && e.message ? e.message : e)));
  await p.goto(pathToFileURL(absPath).href + (hash || ""));
  await p.waitForSelector("#status-bar", { timeout: 15000 });
  return p;
}

test("読み取り縁は「格納先 → タスク」向きに描く（データ上の向きは step → store のまま）", async () => {
  await page.evaluate(() => window.__flowViewer.setView("flow"));
  await page.click("#btn-collapse-all");
  await page.waitForTimeout(200);
  await page.click('.step-box[data-node="step:order-intake/receive"]');
  await waitForEdgesAtLeast(page, 3);
  await page.waitForTimeout(250);
  const geo = await page.evaluate(() => {
    const p = document.querySelector('#flow-edges path.edge.reads[data-edge="step:order-intake/receive|reads|store:table/order-drafts"]');
    if (!p) return null;
    const L = p.getTotalLength();
    const m = p.getScreenCTM();
    const to = (pt) => ({ x: m.a * pt.x + m.c * pt.y + m.e, y: m.b * pt.x + m.d * pt.y + m.f });
    const rect = (sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x0: r.left, x1: r.right, y0: r.top, y1: r.bottom };
    };
    return {
      face: p.getAttribute("data-face"),
      start: to(p.getPointAtLength(0)), end: to(p.getPointAtLength(L)),
      card: rect('.fc-side .fnode[data-node="store:table/order-drafts"]'),
      box: rect('.step-box[data-node="step:order-intake/receive"]'),
    };
  });
  assert.ok(geo, "reads 縁が描画されていない");
  assert.ok(Math.abs(geo.start.x - geo.card.x1) <= 4 && geo.start.y >= geo.card.y0 - 4 && geo.start.y <= geo.card.y1 + 4,
    "読み取り縁が格納先カードから始まっていない: " + JSON.stringify(geo));
  assert.ok(Math.abs(geo.end.x - geo.box.x0) <= 4 && geo.end.y >= geo.box.y0 - 4 && geo.end.y <= geo.box.y1 + 4,
    "読み取り縁がステップ箱の左辺へ入っていない: " + JSON.stringify(geo));
  assert.equal(geo.face, "right", "三角が箱の左辺（+x 方向）を向いていない");
  await page.screenshot({ path: join(SHOTS, "01i-reads-direction.png") });
  await page.click('.step-box[data-node="step:order-intake/receive"]');
  await page.waitForTimeout(200);
});

test("詳細パネル: コード抜粋を開いたまま別ノードを選ぶと抜粋が消える", async () => {
  await page.click('.tab-btn[data-view="code"]');
  await page.waitForSelector("#code-list .code-item");
  // 前の検査で展開済みならヘッダークリックは「閉じる」動作になるので確かめてから押す
  const sig = '#code-list [data-code="code:src/handlers/create_order.py"] table.signals';
  if (!(await page.locator(sig).count())) {
    await page.click('#code-list [data-code="code:src/handlers/create_order.py"] .code-head');
  }
  await page.waitForSelector(sig);
  await page.click('#code-list [data-code="code:src/handlers/create_order.py"] td.snip >> nth=1');
  await page.waitForSelector("#detail-panel #detail-evidence");
  await page.waitForTimeout(150);
  const loc = await page.innerText("#detail-panel #detail-evidence .loc");
  assert.match(loc, /create_order\.py/, "抜粋のファイル名が違う: " + loc);
  await page.evaluate(() => window.__flowViewer.selectNode("flow:order-intake"));
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#detail-panel #detail-evidence").count(), 0,
    "縁と無関係なノードの詳細に前のコード抜粋が残っている");
  await page.click('.tab-btn[data-view="flow"]');
  await page.waitForTimeout(150);
});

test("合成グラフ: ラベル無し分岐も描く／同一端点の並行縁は扇／自己ループは ↺／API の向こうも格納先向き", async () => {
  const dir = join(OUT, "synth");
  const json = join(dir, "branch-synth.json");
  const html = join(dir, "branch-synth.html");
  mkdirSync(dir, { recursive: true });
  writeFileSync(json, JSON.stringify(synthGraph(), null, 1));
  const r = spawnSync(process.execPath,
    [join(ROOT, "bin", "render.mjs"), "--graph", json, "--out", html, "--title", "並行縁の検査"], { encoding: "utf8" });
  assert.equal(r.status, 0, "合成グラフの描画に失敗: " + r.stderr);
  const errs = [];
  const p = await openFile(html, "#view=flow", errs);
  await p.waitForSelector(".step-box");
  await waitForEdgesAtLeast(p, 0);
  await p.waitForTimeout(250);

  // 1) ラベルの有無に関係なく、非隣接の分岐 next は全部 SVG 経路で描かれる
  const par = '#flow-edges path.edge[data-edge="step:sync/s2|next|step:sync/s4"]';
  assert.equal(await p.locator(par).count(), 5, "s2 → s4 の分岐縁が 5 本（ラベル無し込み）描かれていない");
  // 2) 同一端点の並行縁は重ならない（縦走りの x が 6px 以上離れる）
  const runs = await p.locator(par).evaluateAll(runXs);
  const spread = Math.min.apply(null, runs.slice(1).map((x, i) => Math.abs(x - runs[i])));
  assert.equal(new Set(runs).size, 5, "並行縁が同じ経路に重なっている: " + JSON.stringify(runs));
  assert.ok(spread >= 8, "並行縁の横オフセットが 8px 未満（扇になっていない）: " + JSON.stringify(runs));
  // 3) 自身に戻る分岐は左頂点から出て左側を回る ↺ 縁（詳細パネルの縁一覧にも出る）
  // 2b) ゲートウェイ同士・同宛先（頂点直結）の 2 条件は重ならず左右に分かれる
  const vert = '#flow-edges path.edge[data-edge="step:sync/s2|next|step:sync/s3"]';
  const vPaths = await p.locator(vert).evaluateAll((ps) => ps.map((el) => {
    const L = el.getTotalLength();
    const q = el.getPointAtLength(L * 0.5);
    return Math.round(q.x * 10) / 10;
  }));
  assert.ok(vPaths.length >= 2, "ゲートウェイ同士の同宛先縁が " + vPaths.length + " 本しかない");
  assert.ok(new Set(vPaths).size === vPaths.length, "頂点直結の同宛先縁が重なっている: " + JSON.stringify(vPaths));
  const vGap = Math.min.apply(null, vPaths.slice(1).map((x, i) => Math.abs(x - vPaths[i])));
  assert.ok(vGap >= 6, "頂点直結の同宛先縁の間隔が狭い（" + vGap.toFixed(1) + "px）: " + JSON.stringify(vPaths));
  // 2c) ラベル同士、ラベルと縁の終端（矢印）が重なっていないか
  const lab = await p.evaluate(() => {
    const ts = Array.prototype.slice.call(document.querySelectorAll("#flow-edge-labels text"));
    const rs = ts.map((t) => {
      const r = t.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, s: (t.textContent || "").trim() };
    }).filter((r) => r.w > 1);
    const pairs = [];
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const A = rs[i], B = rs[j];
        const w = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
        const h = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
        if (w > 1 && h > 1) pairs.push(A.s + " × " + B.s);
      }
    }
    const hits = [];
    Array.prototype.forEach.call(document.querySelectorAll("#flow-edges path.edge"), (el) => {
      const L = el.getTotalLength();
      let n = 0;
      for (let i = Math.max(0, L - 16); i <= L; i += 3) {
        const q = el.getPointAtLength(i).matrixTransform(el.getScreenCTM());
        if (rs.some((r) => q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h)) n++;
      }
      if (n >= 3) hits.push(el.getAttribute("data-edge"));
    });
    return { n: rs.length, pairs, hits };
  });
  assert.deepEqual(lab.pairs, [], "条件ラベル同士が重なっている: " + lab.pairs.join(" / "));
  assert.deepEqual(lab.hits, [], "条件ラベルと縁の終端（矢印）が重なっている: " + lab.hits.join(" / "));

  // 3) 自身に戻る分岐は左頂点から出て左側を回る ↺ 縁（詳細パネルの縁一覧にも出る）
  const self = '#flow-edges path.edge.loop[data-edge="step:sync/s3|next|step:sync/s3"]';
  assert.equal(await p.locator(self).count(), 1, "自己ループ縁が描かれない");
  const d = await p.locator(self).getAttribute("d");
  const n = d.match(/[-\d.]+/g).map(Number);
  const gw = await boxOf(p, '.step-box[data-node="step:sync/s3"]');
  assert.equal(await p.locator(self).getAttribute("data-route"), "loop", "自己ループの経路種別が違う");
  assert.ok(Math.abs(n[0] - gw.x0) <= 2 && Math.abs(n[1] - gw.cy) <= 2,
    "自己ループが左頂点から出ていない: " + d);
  const selfLbl = await p.locator("#flow-edge-labels text.loop").evaluateAll((ts) => ts.map((t) => t.textContent));
  assert.ok(selfLbl.some((t) => /↺/.test(t) && /やり直し/.test(t)),
    "自己ループのラベルが無い: " + JSON.stringify(selfLbl));
  // 3b) 全展開の狭い通路でも並行縁は同じ x に潰れない（全展開で各ステップの I/O も出る）
  await p.click("#btn-expand-all");
  await waitForEdgesAtLeast(p, 3);
  await p.waitForTimeout(300);
  const runsOpen = await p.locator(par).evaluateAll(runXs);
  assert.ok(new Set(runsOpen).size >= 2, "全展開で並行縁が同じ x に潰れている: " + JSON.stringify(runsOpen));
  // 4) 同じ格納先を読む／書く縁は向きが違う（読み=格納先→箱、書き=箱→格納先）
  const io = await p.evaluate(() => {
    const one = (sel) => {
      const p2 = document.querySelector(sel);
      if (!p2) return null;
      const L = p2.getTotalLength();
      const m = p2.getScreenCTM();
      const to = (pt) => ({ x: m.a * pt.x + m.c * pt.y + m.e, y: m.b * pt.x + m.d * pt.y + m.f });
      return { face: p2.getAttribute("data-face"), start: to(p2.getPointAtLength(0)), end: to(p2.getPointAtLength(L)) };
    };
    const box = document.querySelector('.step-box[data-node="step:sync/s4"]').getBoundingClientRect();
    return {
      read: one('#flow-edges path.edge.reads[data-edge="step:sync/s4|reads|store:table/sync-state"]'),
      write: one('#flow-edges path.edge.writes[data-edge="step:sync/s4|writes|store:table/sync-state"]'),
      box: { x0: box.left, x1: box.right, y0: box.top, y1: box.bottom },
    };
  });
  assert.ok(io.read && io.write, "同じ格納先への reads / writes が両方描かれていない: " + JSON.stringify(io));
  assert.ok(io.read.start.x < io.box.x0 && Math.abs(io.read.end.x - io.box.x0) <= 4,
    "reads が 格納先 → 箱 の向きで描かれていない: " + JSON.stringify(io.read));
  assert.ok(Math.abs(io.write.start.x - io.box.x1) <= 4 && io.write.end.x > io.box.x1 + 6,
    "writes が 箱 → 格納先 の向きで描かれていない: " + JSON.stringify(io.write));
  // 5) API の向こうの格納先を読む縁も「格納先 → API」向き
  const sub = await p.evaluate(() => {
    const p2 = document.querySelector('#flow-edges path.edge.reads[data-edge="boundary:http/sync-api/fetch|reads|store:table/sync-state"]');
    if (!p2) return null;
    const L = p2.getTotalLength();
    const r1 = document.querySelector('.fc-side .sub-card[data-node="store:table/sync-state"]').getBoundingClientRect();
    const r2 = document.querySelector('.fc-side .fnode[data-node="boundary:http/sync-api/fetch"]').getBoundingClientRect();
    const m = p2.getScreenCTM();
    const to = (pt) => ({ x: m.a * pt.x + m.c * pt.y + m.e, y: m.b * pt.x + m.d * pt.y + m.f });
    const inRect = (q, r) => q.x >= r.left - 5 && q.x <= r.right + 5 && q.y >= r.top - 5 && q.y <= r.bottom + 5;
    return {
      startInStore: inRect(to(p2.getPointAtLength(0)), r1),
      endInBoundary: inRect(to(p2.getPointAtLength(L)), r2),
    };
  });
  assert.ok(sub, "API の向こうの格納先への reads 縁が無い");
  assert.ok(sub.startInStore && sub.endInBoundary,
    "API の向こうの格納先が 格納先 → API の向きで描かれていない: " + JSON.stringify(sub));
  // 6) 末尾が後方 next（自己ループ）だけなら「終了」を出さない
  const terms = (await p.locator("#flow-chart .fc-term-row .term").allInnerTexts()).map((t) => t.trim());
  assert.ok(terms.includes("開始"), "「開始」の目印が無い: " + JSON.stringify(terms));
  assert.ok(!terms.includes("終了"),
    "末尾ステップが自己ループしか持たないフローに「終了」が出ている: " + JSON.stringify(terms));
  // 7) 同じ API・格納先間の reads / writes はサイド列に 2 枚出る（1 枚に潰れない）
  const backCards = await p.locator('.fc-side .sub-card[data-node="store:table/sync-state"]').count();
  assert.ok(backCards >= 2, "API の向こうの同一格納先への reads / writes がカード " + backCards + " 枚に潰れている");
  assert.equal(await p.locator('#flow-edges path.edge.reads[data-edge="boundary:http/sync-api/fetch|reads|store:table/sync-state"]').count(),
    1, "API の向こうの格納先への reads 縁が描かれていない");
  assert.equal(await p.locator('#flow-edges path.edge.writes[data-edge="boundary:http/sync-api/fetch|writes|store:table/sync-state"]').count(),
    1, "API の向こうの格納先への writes 縁が描かれていない");
  // 8) 全展開でも縁ラベルはサイドカードに重ならない
  const openGeom = await p.evaluate(flowGeomAudit);
  const clash = [];
  for (const L of openGeom.labels) {
    for (const C of openGeom.cards) {
      if (hitRect(L, C)) clash.push(L.text + " × " + C.node);
    }
  }
  assert.deepEqual(clash, [], "全展開で縁ラベルがサイドカードに重なっている");
  // 9) 方向未判定の access は「方向未判定」として出す（access: unknown を素出ししない）
  await p.evaluate(() => window.__flowViewer.selectNode("store:table/sync-state"));
  await p.waitForTimeout(150);
  const detTxt = await p.locator("#detail-panel").innerText();
  assert.ok(/方向未判定/.test(detTxt), "方向未判定の touches 縁が「方向未判定」として出ていない: " + detTxt.slice(0, 400));
  assert.ok(!/access:\s*unknown/.test(detTxt), "metadata.access の unknown を素出ししている");
  assert.deepEqual(errs, [], "合成グラフでコンソールエラー: " + errs.join(" / "));
  await p.screenshot({ path: join(SHOTS, "04-synth-branch.png") });
  await p.close();
});

test("さらに表示で切れた行の先に後続があれば「終了」を出さない", async () => {
  const dir = join(OUT, "synth");
  mkdirSync(dir, { recursive: true });
  const json = join(dir, "long-synth.json");
  const html = join(dir, "long-synth.html");
  const nodes = [{ id: "flow:long", kind: "flow", name: "長いフロー", metadata: { provenance: "definition" } }];
  const edges = [];
  const TOTAL = 262; // 初期表示の上限（250）を超える
  for (let i = 1; i <= TOTAL; i++) {
    nodes.push({
      id: "step:long/s" + i, kind: "step", name: "工程 " + i, parent: "flow:long",
      metadata: { provenance: "definition" },
    });
    edges.push({ source: "flow:long", target: "step:long/s" + i, kind: "contains", provenance: "definition", confidence: 1, metadata: { order: i } });
    if (i > 1) edges.push({ source: "step:long/s" + (i - 1), target: "step:long/s" + i, kind: "next", provenance: "definition", confidence: 1 });
  }
  writeFileSync(json, JSON.stringify({
    schemaVersion: 1, generatedAt: "2026-01-01T00:00:00Z", root: "flow:long", warnings: [], nodes: nodes, edges: edges,
  }, null, 1));
  const r = spawnSync(process.execPath,
    [join(ROOT, "bin", "render.mjs"), "--graph", json, "--out", html, "--title", "表示上限の検査"], { encoding: "utf8" });
  assert.equal(r.status, 0, "合成グラフの描画に失敗: " + r.stderr);
  const errs = [];
  const p = await openFile(html, "#view=flow", errs);
  await p.waitForSelector(".step-box");
  await p.waitForTimeout(300);
  const shown = await p.locator("#flow-chart .fc-row[data-row]").count();
  assert.ok(shown < TOTAL, "初期表示が上限を超えている: " + shown + "/" + TOTAL);
  assert.equal(await p.locator("#flow-more-note").count(), 1, "「さらに表示」の注記が無い");
  const cut = (await p.locator("#flow-chart .fc-term-row .term").allInnerTexts()).map((t) => t.trim());
  assert.ok(!cut.includes("終了"), "表示上限で切れた行の後ろに「終了」が出ている: " + JSON.stringify(cut));
  // 全部表示すれば最後の行（後続なし）でのみ「終了」が出る
  await p.click("#flow-more");
  await p.waitForTimeout(600);
  const all = await p.locator("#flow-chart .fc-row[data-row]").count();
  assert.equal(all, TOTAL, "さらに表示後も全ステップが出ていない: " + all + "/" + TOTAL);
  const full = (await p.locator("#flow-chart .fc-term-row .term").allInnerTexts()).map((t) => t.trim());
  assert.ok(full.includes("終了"), "後続の無い末尾行で「終了」が出ていない: " + JSON.stringify(full));
  assert.deepEqual(errs, [], "合成グラフでコンソールエラー: " + errs.join(" / "));
  await p.screenshot({ path: join(SHOTS, "06-flow-cap.png") });
  await p.close();
});

test("狭い画面（360px）ではフローバーが図に重ならず、図の高さを確保する", async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  const errs = [];
  p.on("console", (m) => { if (m.type() === "error") errs.push("[console] " + m.text()); });
  p.on("pageerror", (e) => errs.push("[pageerror] " + String(e && e.message ? e.message : e)));
  await p.goto(pathToFileURL(HTML).href + "#view=flow");
  await p.waitForSelector("#status-bar", { timeout: 15000 });
  await p.waitForTimeout(400);
  const m = await p.evaluate(() => {
    const sc = document.querySelector("#flow-scroll");
    const bar = document.querySelector("#flow-bar");
    return {
      ch: sc.clientHeight, sh: sc.scrollHeight,
      barH: Math.round(bar.getBoundingClientRect().height),
      barPos: getComputedStyle(bar).position,
      pane: Math.round(document.querySelector("#flow-scroll").parentElement.getBoundingClientRect().height),
    };
  });
  assert.ok(m.ch >= 280, "360px で図領域の高さが足りない（" + m.ch + "px / ペイン " + m.pane + "px, バー " + m.barH + "px）");
  assert.equal(m.barPos, "relative", "狭い画面のフローバーが sticky のまま（図がバーに埋もれる）: " + m.barPos);
  // 縦スクロールして先頭ボックスを一番上へ寄せてもバーと交差せず、画面内に収まる
  const hit = await p.evaluate(() => {
    const box = document.querySelector("#flow-chart .step-box");
    box.scrollIntoView({ block: "start" });
    const b = box.getBoundingClientRect();
    const bar = document.querySelector("#flow-bar").getBoundingClientRect();
    const sc = document.querySelector("#flow-scroll").getBoundingClientRect();
    return {
      hit: b.top < bar.bottom && b.bottom > bar.top,
      inScroll: b.top >= sc.top - 1 && b.bottom <= sc.bottom + 1,
      box: [Math.round(b.top), Math.round(b.bottom)],
    };
  });
  assert.equal(hit.hit, false, "先頭のステップボックスがフローバーと交差している: " + JSON.stringify(hit));
  assert.equal(hit.inScroll, true, "先頭のステップボックスが図領域から見切れている: " + JSON.stringify(hit));
  assert.deepEqual(errs, [], "360px でコンソールエラー: " + errs.join(" / "));
  await p.screenshot({ path: join(SHOTS, "05-narrow-360.png") });
  await ctx.close();
});

test("読み取り縁の見た目の向きはグラフタブと詳細パネルでも 格納先 → タスク", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const p = await ctx.newPage();
  // canvas の moveTo / lineTo を記録して、縁がどちらからどちらへ描かれたかを実測する
  await p.addInitScript(() => {
    const proto = window.CanvasRenderingContext2D.prototype;
    const mt = proto.moveTo, lt = proto.lineTo;
    window.__segs = [];
    proto.moveTo = function (x, y) { this.__fx = x; this.__fy = y; return mt.call(this, x, y); };
    proto.lineTo = function (x, y) {
      if (window.__segs.length < 400000) window.__segs.push([this.__fx, this.__fy, x, y]);
      return lt.call(this, x, y);
    };
  });
  const errs = [];
  p.on("console", (m) => { if (m.type() === "error") errs.push("[console] " + m.text()); });
  p.on("pageerror", (e) => errs.push("[pageerror] " + String(e && e.message ? e.message : e)));
  await p.goto(pathToFileURL(HTML).href + "#view=graph");
  await p.waitForSelector("#status-bar", { timeout: 15000 });
  await p.waitForFunction(() => window.__flowViewer.graphView.headsDrawn > 0, null, { timeout: 25000 });
  const cv = await p.evaluate(() => {
    const gv = window.__flowViewer.graphView;
    // 物理演算を止めてから描き直し、記録した線分と同じ瞬間の座標で突き合わせる
    gv.ticking = false;
    window.__segs.length = 0;
    gv.draw();
    const step = gv.pos.get("step:order-intake/receive");
    const store = gv.pos.get("store:table/order-drafts");
    const d0 = (q, r) => Math.hypot(q[0] - r.x, q[1] - r.y);
    const d1 = (q, r) => Math.hypot(q[2] - r.x, q[3] - r.y);
    const fromStore = window.__segs.filter((q) => d0(q, store) < 2);
    const fromStep = window.__segs.filter((q) => d0(q, step) < 2);
    return {
      fromStore: fromStore.length, fromStep: fromStep.length,
      storeToStep: fromStore.filter((q) => d1(q, step) < d1(q, store)).length,
      storeEndsAtStore: fromStep.filter((q) => d1(q, store) < d1(q, step)).length,
    };
  });
  assert.ok(cv.fromStore >= 1, "格納先から出始める読み取り縁が canvas に無い（データ向きで描いている）: " + JSON.stringify(cv));
  assert.equal(cv.storeToStep, cv.fromStore, "格納先から出た縁がタスク側へ入っていない: " + JSON.stringify(cv));
  assert.ok(cv.storeEndsAtStore >= 1, "書き込み縁が 格納先 側で終わっていない: " + JSON.stringify(cv));
  // データ上の向きは step → store のまま（JSON は書き換えていない）
  const raw = await p.evaluate(() => (window.__flowViewer.state.graph.edges || [])
    .filter((e) => e.kind === "reads" && e.source === "step:order-intake/receive")
    .map((e) => e.source + ">" + e.target));
  assert.deepEqual(raw, ["step:order-intake/receive>store:table/order-drafts"], "JSON 上の reads の向きが変わっている: " + JSON.stringify(raw));
  // 詳細パネル: ストア側は出力縁、タスク側は入力縁に読み取りが出る
  await p.evaluate(() => window.__flowViewer.selectNode("store:table/order-drafts"));
  await p.waitForTimeout(200);
  const sOut = await p.locator("#detail-edges-out").innerText();
  const sIn = await p.locator("#detail-edges-in").innerText();
  assert.ok(/reads/.test(sOut), "ストア詳細の出力縁に読み取りが出ていない: " + sOut.slice(0, 200));
  assert.ok(!/reads/.test(sIn), "ストア詳細の入力縁に読み取りが混ざっている: " + sIn.slice(0, 200));
  await p.locator("#detail-edges-out .edge-row").first().click();
  await p.waitForSelector("#detail-edge");
  const edgeTxt = await p.locator("#detail-edge").innerText();
  assert.ok(edgeTxt.indexOf("order_drafts") >= 0 && edgeTxt.indexOf("order_drafts") < edgeTxt.indexOf("注文受信"),
    "選択中の縁の説明が 格納先 → タスク の順になっていない: " + edgeTxt.slice(0, 200));
  await p.screenshot({ path: join(SHOTS, "01i-reads-direction.png") });
  await p.evaluate(() => window.__flowViewer.selectNode("step:order-intake/receive"));
  await p.waitForTimeout(200);
  const tOut = await p.locator("#detail-edges-out").innerText();
  const tIn = await p.locator("#detail-edges-in").innerText();
  assert.ok(/reads/.test(tIn), "タスク詳細の入力縁に読み取りが出ていない: " + tIn.slice(0, 200));
  assert.ok(!/reads/.test(tOut), "タスク詳細の出力縁に読み取りが混ざっている: " + tOut.slice(0, 200));
  assert.deepEqual(errs, [], "グラフタブ / 詳細パネルでコンソールエラー: " + errs.join(" / "));
  await ctx.close();
});

test("グラフタブ（canvas）の縁にも終端三角があり、向きは atan2 の実測と一致する", async () => {
  await page.evaluate(() => window.__flowViewer.setView("graph"));
  await page.waitForFunction(() => window.__flowViewer.graphView.headsDrawn > 0, null, { timeout: 20000 });
  const g = await page.evaluate(() => {
    const gv = window.__flowViewer.graphView;
    const heads = [];
    const V = window.__flowViewer.visualEnds;
    gv.sim.edges.forEach((e) => {
      const ve = V(e);
      const a = gv.pos.get(ve[0]), b = gv.pos.get(ve[1]);
      const h = gv.headOf(a, b);
      if (!h) return;
      heads.push({
        ang: h.ang, indep: Math.atan2(b.y - a.y, b.x - a.x), kind: e.kind,
        rim: Math.hypot(h.tipX - b.x, h.tipY - b.y), radius: gv.radius(b),
      });
    });
    return { drawn: gv.headsDrawn, total: gv.sim.edges.length, heads };
  });
  assert.ok(g.heads.length >= Math.floor(g.total * 0.8), "三角を作れない縁が多すぎる: " + g.heads.length + "/" + g.total);
  assert.ok(g.drawn >= Math.floor(g.total * 0.8), "canvas に描画された三角が少ない: " + g.drawn + "/" + g.total);
  for (const h of g.heads) {
    assert.ok(Math.abs(h.ang - h.indep) < 1e-9, "三角の角度が終端接線と違う: " + JSON.stringify(h));
    assert.ok(Math.abs(h.rim - h.radius) <= 3, "三角の頂点がノードの縁についていない: " + JSON.stringify(h));
  }
  // ピクセル検査: 三角の内部にはインクがあり、その横（三角の外）は地色
  const px = await page.evaluate(() => {
    const gv = window.__flowViewer.graphView;
    const cv = document.querySelector("#graph-canvas");
    const ctx = cv.getContext("2d");
    const at = (wx, wy) => {
      const x = Math.round(gv.dpr * (gv.view.x + gv.view.k * wx));
      const y = Math.round(gv.dpr * (gv.view.y + gv.view.k * wy));
      if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return null;
      const d = ctx.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const out = [];
    const V = window.__flowViewer.visualEnds;
    // 分岐 next と読み取り縁を混ぜて検査（読み取りは見た目の向きが反転する）
    const pick = gv.sim.edges.filter((e) => e.kind === "next").slice(0, 3)
      .concat(gv.sim.edges.filter((e) => e.kind === "reads").slice(0, 3));
    pick.forEach((e) => {
      const ve = V(e);
      const a = gv.pos.get(ve[0]), b = gv.pos.get(ve[1]);
      const h = gv.headOf(a, b);
      if (!h) return;
      const mx = h.tipX - h.ux * h.len * 0.45, my = h.tipY - h.uy * h.len * 0.45;
      const inside = at(mx, my);
      const off = h.wid + 7;
      const side = [at(mx - h.uy * off, my + h.ux * off), at(mx + h.uy * off, my - h.ux * off)];
      const far = side.filter(Boolean).sort((u, v) => Math.hypot(v[0] - inside[0], v[1] - inside[1]) -
        Math.hypot(u[0] - inside[0], u[1] - inside[1]))[0];
      if (inside && far) out.push({ kind: e.kind, d: Math.hypot(inside[0] - far[0], inside[1] - far[1]) });
    });
    return out;
  });
  assert.ok(px.length >= 3, "ピクセル検査できる縁が少ない: " + px.length);
  for (const q of px) {
    assert.ok(q.d > 14, "三角が描画されていない（頂点付近が地色と同じ）: " + JSON.stringify(q));
  }
  await page.screenshot({ path: join(SHOTS, "02c-graph-arrows.png") });
});

test("テーマ: prefers-color-scheme 追従 → 3 態トグル → localStorage flow-theme", async () => {
  const dk = await openThemed("dark");
  assert.deepEqual(await themeState(dk.p), { theme: "dark", mode: "system", btn: "◐ システム", stored: null },
    "保存値なし / prefers dark の初期状態が違う");
  await dk.ctx.close();

  const lt = await openThemed("light");
  assert.equal((await themeState(lt.p)).theme, "light", "prefers-color-scheme: light に追従していない");
  // 注釈（flow-annotations）を 1 件置いて、テーマ切替が混入しないことを確認する
  const annSeed = JSON.stringify({ nodes: { "flow:order-intake": { note: "テーマ検査" } }, edges: [] });
  await lt.p.evaluate((v) => localStorage.setItem("flow-annotations", v), annSeed);

  await lt.p.click("#btn-theme");
  let st = await themeState(lt.p);
  assert.equal(st.mode, "dark", "1 回目のクリックがダークにならない");
  assert.equal(st.theme, "dark", "ライト設定でも保存値ダークが適用されない");
  assert.equal(st.stored, "dark", "localStorage flow-theme に保存されていない");
  assert.match(st.btn, /☾/);

  await lt.p.click("#btn-theme");
  st = await themeState(lt.p);
  assert.deepEqual({ mode: st.mode, theme: st.theme, stored: st.stored }, { mode: "light", theme: "light", stored: "light" });
  assert.match(st.btn, /☀/);

  await lt.p.click("#btn-theme");
  st = await themeState(lt.p);
  assert.deepEqual({ mode: st.mode, theme: st.theme, stored: st.stored }, { mode: "system", theme: "light", stored: "system" },
    "3 態目システムで prefers-color-scheme に戻らない");
  assert.match(st.btn, /◐/);

  // テーマ切替は注釈に触れない（保存キーが別 / 注釈 JSON に theme を混ぜない）
  assert.equal(await lt.p.evaluate(() => localStorage.getItem("flow-annotations")), annSeed);
  const doc = JSON.parse(await lt.p.evaluate(() => localStorage.getItem("flow-annotations")));
  assert.ok(!("theme" in doc), "注釈ドキュメントに theme が混入している: " + Object.keys(doc).join(","));

  // 次回起動: 保存値が prefers-color-scheme より優先
  await lt.p.evaluate(() => localStorage.setItem("flow-theme", "dark"));
  await lt.p.reload();
  await lt.p.waitForSelector("#status-bar", { timeout: 15000 });
  st = await themeState(lt.p);
  assert.equal(st.theme, "dark", "保存値が prefers-color-scheme に勝っていない");
  assert.equal(st.mode, "dark");
  // 保存値をクリアすればシステム追従に戻る
  await lt.p.evaluate(() => {
    localStorage.removeItem("flow-theme");
    history.replaceState(null, "", location.href.split("#")[0]); // hash の theme= は保存値より優先なので消す
  });
  await lt.p.reload();
  await lt.p.waitForSelector("#status-bar", { timeout: 15000 });
  st = await themeState(lt.p);
  assert.equal(st.theme, "light", "保存値クリア後にシステム追従へ戻っていない");
  await lt.ctx.close();
});

test("テーマ: hash の theme= で共有（システム時は載せない）、トグルで保存値が優先", async () => {
  const dk = await openThemed("dark");
  // 既定（システム）の共有 URL には theme を載せない
  await dk.p.click("#btn-share");
  assert.doesNotMatch(await dk.p.getAttribute("#btn-share", "data-url"), /theme=/,
    "システム時の共有 URL に theme が入っている");
  // hash で直接ライト
  await dk.p.evaluate(() => { location.hash = "#view=flow&theme=light"; });
  await dk.p.waitForFunction(() => document.documentElement.dataset.theme === "light", null, { timeout: 5000 });
  assert.equal((await themeState(dk.p)).mode, "light");
  await dk.p.click("#btn-share");
  const url = await dk.p.getAttribute("#btn-share", "data-url");
  assert.match(url, /theme=light/, "ライト共有 URL に theme が無い: " + url);
  // hash で開いたページ（保存値なし）もライトになる
  const t = await openThemed("dark", "#view=flow&theme=light");
  assert.equal((await themeState(t.p)).theme, "light", "hash の theme=light が効いていない");
  assert.equal(await t.p.evaluate(() => localStorage.getItem("flow-theme")), null,
    "hash 適用が localStorage に書き込まれている");
  // hash で light 表示していても、トグルは 3 態の順（light → system → dark）で進む
  await t.p.click("#btn-theme");
  let ts = await themeState(t.p);
  assert.equal(ts.mode, "system", "light の次がシステムにならない");
  assert.equal(ts.stored, "system");
  assert.equal(ts.theme, "dark", "システムに戻れば prefers-color-scheme: dark のはず");
  await t.p.click("#btn-share");
  assert.doesNotMatch(await t.p.getAttribute("#btn-share", "data-url"), /theme=/,
    "システムに戻ったのに hash に theme が残る: " + await t.p.getAttribute("#btn-share", "data-url"));
  await t.p.click("#btn-theme");   // system → dark
  assert.equal((await themeState(t.p)).mode, "dark");
  await t.p.click("#btn-share");
  assert.match(await t.p.getAttribute("#btn-share", "data-url"), /theme=dark/);
  await t.p.reload();
  await t.p.waitForSelector("#status-bar", { timeout: 15000 });
  ts = await themeState(t.p);
  assert.equal(ts.theme, "dark", "保存値（または hash）が次回起動で適用されない");
  assert.equal(ts.mode, "dark");
  await dk.ctx.close();
  await t.ctx.close();
});

test("テーマ: ライトで全タブが読める（コントラスト）＋ライト版スクリーンショット", async () => {
  const { ctx, p } = await openThemed("light");
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), "light");
  const vars = await p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    return {
      bg: g("--bg"), bg2: g("--bg2"), fg: g("--fg"), muted: g("--muted"), dim: g("--dim"),
      reads: g("--e-reads"), writes: g("--e-writes"), invokes: g("--e-invokes"),
      next: g("--e-next"), loop: g("--e-loop"), cont: g("--e-cont"),
      warn: g("--warn"), accent: g("--accent"), store: g("--k-store"), boundary: g("--k-boundary"),
      canvasA: g("--canvas-a"), llmBd: g("--pv-llm-bd"), humBd: g("--pv-hum-bd"),
      halo: g("--halo"), scheme: cs.colorScheme,
    };
  });
  assert.equal(vars.scheme, "light", "color-scheme が light でない（フォーム控件が黒いまま）");
  assert.ok(lum(vars.bg) > 0.7 && lum(vars.bg2) > 0.7, "地色が明るくない: " + vars.bg + " / " + vars.bg2);
  assert.ok(contrast(vars.bg2, vars.fg) >= 6, "本文文字のコントラスト不足: " + vars.fg);
  assert.ok(contrast(vars.bg2, vars.muted) >= 3.5, "補助文字のコントラスト不足: " + vars.muted);
  // 縁色 5 種＋破線（contains）は白地で沈まない色に調整してある
  for (const k of ["reads", "writes", "invokes", "next", "loop"]) {
    assert.ok(contrast(vars.bg2, vars[k]) >= 2.8, "ライトの縁色が地色に沈む: " + k + "=" + vars[k]);
  }
  // contains は構造の骨格として淡く見せる設計（ダークでも最も薄い色）
  assert.ok(contrast(vars.bg2, vars.cont) >= 2 && contrast(vars.bg2, vars.cont) < 3.2,
    "contains 縁の濃度が設計範囲外: " + vars.cont);
  // クロスハイライトの琥珀・候補バンド・注釈 badges・グラフ地色
  assert.ok(contrast(vars.bg2, vars.warn) >= 3.5, "クロスハイライトの琥珀が読めない: " + vars.warn);
  assert.ok(contrast(vars.bg2, vars.store) >= 3, "格納先の色が読めない: " + vars.store);
  assert.ok(contrast(vars.bg2, vars.boundary) >= 3, "境界の色が読めない: " + vars.boundary);
  // 注釈 badge は「文字が読める + 地色より明らかな淡色背景」で判定する（枠線は意図的に淡い）
  const badges = await p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    return { llmFg: g("--pv-llm-fg"), llmBg: g("--pv-llm-bg"), humFg: g("--pv-hum-fg"), humBg: g("--pv-hum-bg") };
  });
  assert.ok(contrast(vars.bg2, badges.llmFg) >= 3.5 && contrast(vars.bg2, badges.humFg) >= 3.5,
    "注釈 badge の文字が読めない: " + JSON.stringify(badges));
  for (const k of ["llmBg", "humBg"]) {
    assert.ok(contrast(vars.bg2, badges[k]) >= 1.12 && lum(badges[k]) < lum(vars.bg2),
      "注釈 badge の背景が地色と同化: " + k + "=" + badges[k]);
  }
  void vars.llmBd; void vars.humBd;
  assert.ok(lum(vars.canvasA) > 0.7, "グラフタブの地色がダークのまま: " + vars.canvasA);
  // ラベルのハローも白に（ダーク用 #0b1016 のままなら不合格）
  assert.ok(lum(vars.halo) > 0.7, "ラベルのハローがダーク用: " + vars.halo);

  await p.evaluate(() => window.__flowViewer.setView("flow"));
  await p.click("#btn-expand-all");
  await p.waitForFunction(() => window.__flowViewer.flowView.edgeItems.length > 0, null, { timeout: 8000 });
  await p.waitForTimeout(450);
  await p.screenshot({ path: join(SHOTS, "01b-flow-light-expanded.png") });
  await p.click("#btn-collapse-all");
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(SHOTS, "01-flow-light.png") });
  // 地色違いでも行の幅配分が変わらないこと（▼ の中央揃えとラベル回避をライトでも同じ検査）
  checkFlowGeom(await p.evaluate(flowGeomAudit), "ライト・たたんだ状態");
  await p.click("#btn-expand-all");
  await p.waitForFunction(() => window.__flowViewer.flowView.edgeItems.length > 0, null, { timeout: 8000 });
  await p.waitForTimeout(450);
  checkFlowGeom(await p.evaluate(flowGeomAudit), "ライト・全展開");
  await p.click("#btn-collapse-all");
  await p.waitForTimeout(300);
  for (const [tab, shot] of [["stores", "06-stores-light.png"], ["io", "07-io-light.png"], ["code", "08-code-light.png"]]) {
    await p.evaluate((v) => window.__flowViewer.setView(v), tab);
    await p.waitForTimeout(350);
    await p.screenshot({ path: join(SHOTS, shot) });
  }
  // 詳細パネル（注釈フォーム）もライト地色
  await p.evaluate(() => window.__flowViewer.setView("flow"));
  await p.waitForTimeout(250);
  await p.click('#flow-chart .step-box[data-node="step:order-intake/charge"] .info');
  await p.waitForSelector("#detail-panel .dt-name");
  const form = await p.evaluate(() => {
    const box = document.querySelector("#detail-panel");
    const inp = box.querySelector("input, textarea");
    return {
      bg: getComputedStyle(box).backgroundColor,
      color: getComputedStyle(box.querySelector(".dt-name")).color,
      input: inp ? getComputedStyle(inp).backgroundColor : null,
    };
  });
  assert.ok(lum(form.bg) > 0.7, "詳細パネルがダークのまま: " + form.bg);
  assert.ok(contrast(form.bg, form.color) >= 6, "詳細パネルの文字コントラスト不足");
  if (form.input) assert.ok(lum(form.input) > 0.65, "注釈フォームの入力欄がダークのまま: " + form.input);
  await p.screenshot({ path: join(SHOTS, "03-detail-light.png") });
  // グラフタブ（canvas）の地色とラベル
  await p.evaluate(() => window.__flowViewer.setView("graph"));
  await p.waitForFunction(() => window.__flowViewer.graphView.headsDrawn > 0, null, { timeout: 20000 });
  await p.waitForTimeout(300);
  const bgpx = await p.evaluate(() => {
    const cv = document.querySelector("#graph-canvas");
    const d = cv.getContext("2d").getImageData(3, 3, 1, 1).data;
    return { a: d[3], rgb: "rgb(" + d[0] + "," + d[1] + "," + d[2] + ")", css: getComputedStyle(cv).backgroundImage };
  });
  // canvas の bitmap は透明で CSS の地色勾配を見せるので、見える地色は CSS 側で判定する
  assert.ok(bgpx.a === 0 || lum(bgpx.rgb) > 0.7, "canvas の bitmap が暗い地色で塗られている: " + JSON.stringify(bgpx));
  const ground = String(bgpx.css).match(/rgba?\([^)]*\)/);
  assert.ok(ground, "グラフタブの地色勾配が読めない: " + bgpx.css);
  assert.ok(lum(ground[0]) > 0.7, "グラフタブの地色がダークのまま: " + ground[0]);
  await p.screenshot({ path: join(SHOTS, "02-graph-light.png") });
  // 未紐づけ候補バンド
  await p.evaluate(() => window.__flowViewer.setView("flow"));
  await p.waitForTimeout(250);
  const band = await p.evaluate(() => {
    const b = document.querySelector("#candidate-band .sub-card, #candidate-band .cand");
    return b ? getComputedStyle(b).backgroundColor : null;
  });
  if (band) assert.ok(lum(band) > 0.6, "候補バンドがダークのまま: " + band);
  await ctx.close();
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
  assert.ok(shots.length >= 15, "スクリーンショットが足りない: " + shots.join(", "));
  for (const need of ["01-flow.png", "01b-flow-expanded.png", "01d-loop.png", "01e-gateway.png", "01g-branch.png",
    "01-flow-light.png", "01b-flow-light-expanded.png", "02-graph-light.png", "06-stores-light.png",
    "07-io-light.png", "08-code-light.png", "02c-graph-arrows.png"]) {
    assert.ok(shots.includes(need), "必須のスクリーンショットが無い: " + need);
  }
});
