# スキーマ定義

この仕組みは 4 種の入力を `graph.json` 1 つに統合し、そこから単一ファイルの
`flow.html` を生成する。ここではノード/エッジの ID 規則と、各ファイルの形を決める。

```
flows/*.json  ─┐
scan.json     ─┼─ merge.mjs ─→ graph.json ─ render.mjs ─→ flow.html（データ埋め込み）
annotations/* ─┘
worklist.mjs ←─ graph.json（LLM が注釈を書くためのワークシート）
```

## graph.json

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-18T00:00:00.000Z", // 唯一起点となる時刻。決定性検査では除外する
  "root": "/path/to/repo",
  "nodes": [ /* Node */ ],
  "edges": [ /* Edge  */ ]
}
```

### Node

| 欄 | 型 | 意味 |
| --- | --- | --- |
| `id` | string | 下記「ID 規則」。全域一意 |
| `kind` | string | `flow` / `step` / `store` / `boundary` / `code` |
| `name` | string | 表示名 |
| `parent` | string? | 階層の親（`contains` とは別に持つ。`step` の親は `flow`） |
| `metadata` | object? | 自由キー。下記の約束事 |

`metadata` の約束事:

- `provenance`: `"static"`（スキャン）/ `"definition"`（フロー定義）/ `"llm"` / `"human"`
  （注釈由来のノードのみ）。無ければ `definition`
- `stepKind`（`step` のみ）: `"gateway"` のとき分岐ノード（ビューアでひし形）。通常タスクは無し
- `candidate: true` — スキャンが候補として出しただけのノード（まだステップに紐づいていない）。
  ビューアで「未紐づけ」フィルタの材料
- `evidence`: `[{ "path", "line", "snippet", "signal" }]` — スキャンが拾った根拠
- `storeKind`（`store` のみ）: `table` / `file` / `s3` / `queue` / `topic` / `kv` / `other`
- `boundaryKind`（`boundary` のみ）: `http` / `lambda` / `sfn` / `grpc` / `cli` / `other`

### Edge

| 欄 | 型 | 意味 |
| --- | --- | --- |
| `source` / `target` | string | ノード ID |
| `kind` | string | 下記「エッジ種別」 |
| `provenance` | string | `definition` / `static` / `llm` / `human` |
| `confidence` | number? | 0〜1。注釈は必ず付ける。静的/定義は既定 1 |
| `note` | string? | 根拠。LLM 注釈は必須（他人が検証できる手がかりを書く） |

### エッジ種別

方向は「データの動き」側で張る。

| kind | source → target | 意味 |
| --- | --- | --- |
| `contains` | flow → step | 階層（`parent` とあわせて持つ） |
| `next` | step → step | フロー内の進行（`metadata.order` に連番、分岐は `metadata.label` に条件ラベル。`to` が前方向ならループ） |
| `reads` | step / boundary → store | 入力に読む |
| `writes` | step / boundary → store | 出力に書く |
| `invokes` | step → boundary | API 実行などの境界を呼ぶ |
| `implemented-by` | step → code | そのステップを実装しているコード（主に注釈） |
| `touches` | code → store / boundary | スキャンがコード内で検出したアクセス（`metadata.access` = `read` / `write` / `invoke`） |

`boundary → store` の `reads` / `writes` が「API の向こう側で最終的にどのテーブル/ファイルに
届くか」を表す。境界の向こうはコードに見えないので、原則として注釈（`llm` / `human`）が張る。

## ID 規則

| ノード | ID | 例 |
| --- | --- | --- |
| flow | `flow:<flowId>` | `flow:order-intake` |
| step | `step:<flowId>/<stepId>` | `step:order-intake/receive` |
| store | `store:<storeKind>/<path...>` | `store:table/orders`、`store:file/reports/daily.csv`、`store:s3/analytics-bucket/inbox` |
| boundary | `boundary:<boundaryKind>/<path...>` | `boundary:http/payment-service/charge`、`boundary:lambda/send-notify` |
| code | `code:<repo 相対パス>` | `code:src/handlers/create_order.py` |

`<path...>` は `/` 区切りの小文字正規化名。同じストレージを別の書き方で指してノードが
二重化しないよう、`merge.mjs` は ID を作るときに `-` `_` の揺らぎと大文字を寄せる
（`normalizeIdSegment()`）。注側から書く参照は `<storeKind>/<path>` の形（後述）。

## flows/*.json（人が管理する業務フロー定義）

JSON にコメントを許す（JSONC）。`--flows` に渡したディレクトリの `*.json` を全部読む。

```jsonc
{
  "schemaVersion": 1,
  "flows": [
    {
      "id": "order-intake",            // flow:<id> になる
      "name": "注文受付フロー",
      "owner": "orders-team",          // 自由キー。description / docs なども metadata に入る
      "steps": [
        {
          "id": "receive",
          "name": "注文受信",
          // いずれも "<種別>/<パス>" 参照の配列。ノードが無ければ作られる
          "reads":   ["table/orders_draft"],
          "writes":  ["table/orders"],
          "invokes": ["http/payment-service/charge"],
          "docs": "Notion の URL など"
        },
        {
          "id": "result",
          "name": "決済結果",
          "kind": "gateway",           // 分岐ノード（ビューアでひし形）
          "branches": [                // 条件付きの next。to は同一 flow の step id
            { "to": "charge", "label": "成功" },
            { "to": "retry",  "label": "失敗" }
          ]
        },
        {
          "id": "retry",
          "name": "再試行判定",
          "kind": "gateway",
          "branches": [
            { "to": "receive", "label": "3回目まで再実行" }, // 前方向の to = ループ
            { "to": "notify",  "label": "打ち切り" }
          ]
        }
      ]
    }
  ]
}
```

- 参照文字列の種別プレフィックスは `store` 側が `table` `file` `s3` `queue` `topic` `kv` `other`、
  `invokes` だけが `boundary` 側（`http` `lambda` `sfn` `grpc` `cli` `other`）
- `steps` の配列順が `next` エッジの順序になる。ただし **`branches` を持つステップからは
  暗黙の「次へ」縁を張らない**（分岐はすべて明示縁になる）
- **分岐・ループ**: `branches[].to` は同一 flow 内の step id を指す。前方向（配列で前の
  ステップ）を指せばそれがループで、追加の構文は無い。`label` はビューアの縁ラベルに使う
  （「在庫あり」などの条件を人間が読むために書く）
- `branches` を書いたのに `kind: "gateway"` を忘れた場合は gateway に昇格させて警告を出す。
  gateway に branches が 2 未満、`to` が同一フローに存在しない、他のステップから一度も
  到達できない場合も警告する（グラフにしないよりマシなので張るが、穴は残さない）
- 同じステップに `reads` と `writes` で同じ参照を書くと双向の縁になる（自己ループにはしない）

## scan.json（scan.mjs の出力）

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "...",
  "root": "/path/to/repo",
  "files": [
    {
      "path": "src/handlers/create_order.py",   // リポジトリ相対
      "lang": "python",
      "signals": [
        { "signal": "sql-write", "ref": "table/orders", "line": 42,
          "snippet": "INSERT INTO orders ..." }
      ]
    }
  ],
  "stores":     [ { "id": "store:table/orders", "name": "orders", "storeKind": "table",
                    "evidence": [ /* ↑の signals の形 */ ] } ],
  "boundaries": [ { "id": "boundary:http/payment-service/charge", "name": "…",
                    "boundaryKind": "http", "evidence": [] } ]
}
```

- `signals[].ref` は `<storeKind>/<path>` / `<boundaryKind>/<path>` 形。決まらないシグナルは
  `ref: null` で `signal` と `snippet` だけ残す（候補ノードは作らない。ワークシートに出す）
- `files[].signals` は高々 1 ファイル内。パス・行・抜粋だけなので LLM が原文を読む入口になる
- 生成は決定性: 同じ入力・同じ除外設定なら `generatedAt` 除きバイト一致

## annotations/*.json（LLM・人が後から紐づける）

```jsonc
{
  "schemaVersion": 1,
  "producer": "llm",                  // "llm" または "human"
  "nodes": [
    { "id": "store:table/orders_analytics", "kind": "store", "name": "orders_analytics",
      "metadata": { "storeKind": "table", "note": "バッチが集計を書き戻す" } }
  ],
  "edges": [
    { "source": "step:order-intake/receive", "target": "boundary:http/payment-service/charge",
      "kind": "invokes", "confidence": 0.95,
      "note": "create_order.py:88 の charge_payment() が POST /charge を呼ぶ" },
    { "source": "boundary:http/payment-service/charge", "target": "store:table/payments",
      "kind": "writes", "confidence": 0.6,
      "note": "決済サービス側の README に記載。コードでは確認できず" }
  ],
  "metadata": [
    { "match": { "kind": "flow", "id": "flow:order-intake" },
      "set": { "sla": "5 分以内" } }
  ]
}
```

決まりごと（やらないとグラフが嘘をつく）:

1. **先に `graph.json` を読んでから書く。** 存在しないノード ID へのエッジは merge が
   警告して捨てる。曖昧なときは推測で張らず `ref: null` シグナルとして残す
2. **`note` に根拠を必ず書く。** ファイル:行、関数名、テーブル名、設定キーなど
3. **`confidence` をつける。** コードに現れない運用知識は 0.6 台どまり。`provenance` は
   ファイルの `producer` から取る
4. **注釈で新規ノードを作るのは、リポジトリに定義が見えないストレージ/境界だけ**
   （外部 SaaS の保存先、別チームのテーブルなど）

## worklist.md（LLM への引き継ぎ書）

`worklist.mjs` が `graph.json` から作る。構成は固定で、LLM はこれを読み、コードを
開いて `annotations/llm.json` を書く:

1. **未紐づけのステップ** — reads/writes/invokes が 1 つも無いステップと、そのフローの残り候補
2. **未紐づけの候補** — `candidate: true` の store/boundary と `evidence`（file:line + snippet）
3. **コードに紐づいていないステップ** — `implemented-by` の無いステップ
4. **書式と決まりごと** — 上の annotations ルールの要約と出力先パス

## flow.html（ビューア）

データは `<script id="graph-data" type="application/json">` に埋め込み。外部 CDN・
ネットワーク不要で `file://` で開ける。ビューア側で人を編集できる注釈は
localStorage に集約し、「注釈 JSON」で書き出して `annotations/human.json` に定着させる。
