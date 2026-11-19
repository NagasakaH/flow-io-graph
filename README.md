# 業務フロー データ I/O ビューア

業務フローの「どのステップが、どのデータを読んで書き、どの API 境界を呼び、その果てに
どのテーブル・ファイル・バケットへ届くか」を、**人間が見やすい静的 HTML** として管理する仕組み。

```
業務フロー定義 (人が編集)  ─┐
コードベースの静的スキャン  ─┼─→ graph.json ─→ flow.html（単一ファイル・ブラウザで開くだけ）
注釈 annotations/*.json     ─┘        │
   ↑                                  └─→ worklist.md（LLM への引き継ぎ書）
   └── LLM がコードを読んで書く（ワークシートが入口）
```

## いちばん短い手順

```sh
node bin/build.mjs --root /path/to/repo
# → out/flow/flow.html をブラウザで開く
```

`<repo>/flows/*.json` があれば業務フローとして取り込み、無ければスキャンによる
「コードが見ているストレージ・境界」の一覧だけが出る。そこからが本番で、
**out/flow/worklist.md を LLM に渡して注釈を書かせ、再生成する**とグラフが育つ。

```sh
node bin/build.mjs --root /path/to/repo --annotation annotations/llm.json
```

手元で全部試したい場合は同梱のデモを回す:

```sh
node bin/build.mjs --root demo --flows demo/flows \
  --annotation demo/annotations/human.json --annotation demo/annotations/llm.json
open out/flow/flow.html
node --test          # 全テスト
```

## 運用サイクル

1. **人がフローを定義する** — `flows/*.json` にステップと入出力を書く（JSON、コメント可）。
   完璧でなくてよい。ステップ名だけ並べておくのでも十分。分岐は gateway、ループは `to` が
   前を向くだけで書ける:

   ```jsonc
   { "id": "gate-result", "name": "決済結果", "kind": "gateway",
     "branches": [
       { "to": "charge", "label": "成功" },
       { "to": "retry-gate", "label": "失敗" }
     ] },
   // ...
   { "id": "retry-gate", "name": "再試行判定", "kind": "gateway",
     "branches": [
       { "to": "receive", "label": "3回目まで再実行" }, // 前方向の to = ループ
       { "to": "notify", "label": "打ち切り" }
     ] }
   ```

   `branches` を書いたステップからは暗黙の「次へ」が立たない（分岐はすべて明示）。
   書かなければ従来の線形定義はそのままで動く
2. **スキャンが実線を拾う** — 多言語（py / js / ts / go / java / cs / rb / php / sql / sh / tf）から
   SQL のテーブル名、S3・SQS・Kafka・Redis・HTTP URL・Lambda・Step Functions の**リテラル**を拾う。
   変数や補間で決まらないものは無理に推測せず「要原文確認」として残す
3. **LLM が注釈を書く** — `worklist.md` が「未記入のステップ」「未紐づけの候補」「原文確認待ちの
   シグナル」を列挙するので、LLM はコードを開いて確かめ、`annotations/llm.json` に
   根拠 (`note`) と確度 (`confidence`) 付きで縁を張る
4. **人がブラウザで締める** — `flow.html` のフロー図で穴を探し、詳細パネルからその場で
   注釈を後付けできる（localStorage に保存、「注釈 JSON」で書き出してリポジトリに定着）

## 見られるもの（flow.html）

| タブ | 何が見えるか |
| --- | --- |
| フロー図 | 左=入力ソース / 中央=ステップ列 / 右=出力と API 境界。**境界の向こうの格納先**（決済サービスが書く payments テーブル等）まで続く |
| グラフ | 全ノードの力布局。⇧クリックで周辺 2 ホップにフォーカス |
| データ格納先 | テーブル・ファイル・バケット単位の「誰が読み／誰が書き／コード根拠 N 件」台帳 |
| I/O 一覧 | ステップ × 入出力の表。縁ごとの provenance（定義/静的/LLM/人間）と確度 |
| コード | スキャンが拾ったシグナルの一覧（ファイル:行と抜粋）。要原文確認が明示される |

## ドキュメント

- [docs/schema.md](docs/schema.md) — graph.json / flows / annotations / scan の正式仕様。
  **注釈を書くときはこれを読む**（ID 規則と「嘘をつかないための決まりごと」）
- `demo/` — ツール自身の回帰台を兼ねるサンプル（多言語コード + フロー定義 + 注釈の実例）

## 設計上の決まりごと

- **推測で縁を張らない。** 静的スキャンはリテラルだけ。LLM 注釈は `note`（検証可能な根拠）と
  `confidence` 必須。張らないことは嘘をつくより正しい
- **由来を表示で隠さない。** 定義 / 静的解析 / LLM / 人間の 4 種の provenance を常にチップで出す
- **決定性。** 同じ入力から `generatedAt` を除きバイト一致の graph.json / scan.json が出る
  （差分レビューができる）
- **実行環境は Node のみ。** ビルドもビューアも依存ゼロ（ビューアは CDN 不使用の単一ファイル、
  `file://` で開ける）

## Agent Skill として配布・利用する

[skills/flow-io-graph/](skills/flow-io-graph/) に自己完結型の Agent Skill パッケージを同梱しています（`npm install` 不要、Node.js のみで動作）。

- **インストール例**: `skills/flow-io-graph/` を対象リポジトリの `.agents/skills/flow-io-graph/` または `~/.gemini/config/skills/flow-io-graph/` へコピーするだけ。
- **スキル側の運用**: エージェントは `scripts/` 配下の `.mjs` をブラックボックスとして扱い、`node scripts/build.mjs --help` の確認と実行のみで任意のリポジトリから `flow.html` を生成できます。
- **本体更新時の同期**: `bin/`, `lib/`, `viewer/template.html`, `docs/schema.md` を更新したら `npm run sync:skill` でスキル側へ反映します。
