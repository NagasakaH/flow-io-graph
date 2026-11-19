---
name: flow-io-graph
description: >-
  Generate interactive single-file HTML workflow and data I/O diagrams (flowcharts,
  dependency graphs, storage ledgers, and code-evidence tables) from any GitHub or
  local code repository. Use when the user asks to visualize business workflows,
  training/data pipelines, or data I/O lineage of a codebase as an HTML diagram.
---

# Flow I/O Graph Generator

任意のリポジトリ（Web アプリ、バッチ、ML 学習パイプライン等）から、**「どのステップが、どのデータを読んで書き、どの API 境界を呼び、どのコード根拠に紐づくか」** を可視化する単一 HTML ビューア（`flow.html`）を生成するスキルです。

## 重要原則（ブラックボックス運用）

- [scripts/](./scripts/) 配下の `.mjs` スクリプトおよび `template.html` は **ブラックボックス** として扱ってください。
- スクリプトの中身を読んだり改変したりせず、**`--help` で引数仕様を確認して実行するだけ** にします（Node.js 標準モジュールのみで動作し、`npm install` 不要）。
- グラフ定義・注釈 JSON の厳密な仕様（ID 規則やスキーマ）が必要なときだけ [references/schema.md](./references/schema.md) を参照してください。

## 汎用ワークフロー（任意のリポジトリから図を生成する手順）

以下 `<SKILL_DIR>` はこの `SKILL.md` が置かれたディレクトリを指します。

### Step 1: CLI オプションを `--help` で確認する

```sh
node <SKILL_DIR>/scripts/build.mjs --help
```

### Step 2: 対象リポジトリを初回スキャンする

```sh
node <SKILL_DIR>/scripts/build.mjs \
  --root <TARGET_REPO> \
  --out-dir <OUT_DIR> \
  --title "<図のタイトル>"
```

- 既定の除外ディレクトリ以外の巨大な生成物（例: `checkpoints,datasets`）があれば `--exclude a,b` を付けます。
- `<OUT_DIR>` に `scan.json`, `graph.json`, `flow.html`, `worklist.md` が生成されます。

### Step 3: フロー定義 JSON と注釈 JSON を作成する

1. **対象リポジトリに `flows/*.json` が無い場合（多くの GitHub リポジトリ）**:
   - リポジトリの `README`・主要エントリーポイント・`<OUT_DIR>/scan.json` を確認し、主要な処理フロー（業務フローやパイプライン）を 1〜複数本抽出します。
   - 作業ディレクトリ（例: `<OUT_DIR>/flows/main.json`、またはユーザーが望むリポジトリ内 `flows/`）にフロー定義 JSON を作成します（フォーマットは [references/schema.md](./references/schema.md) 参照）。
   - **綺麗なレイアウトにするコツ**:
     - `kind: "gateway"` の `branches` は **先頭に正常系（ハッピーパス）、2 番目以降に例外・再試行系** を配置すると、正常系が上から下に一直線・例外系が右サイドブランチとして見やすく描画されます。
     - ループは前方向ステップの ID を `to` に指定するだけで自動的にループ矢印になります。
     - 大規模リポジトリでは 1 ターンで全注釈を完璧にしようとして長考せず、まず骨格となるフロー定義 JSON を書いて `build.mjs --skip-scan` を回し、必要に応じて段階的に注釈を追記してください。
2. **コード根拠付きの注釈 JSON（`<OUT_DIR>/annotations/llm.json`）を書く**:
   - `<OUT_DIR>/worklist.md` に列挙された「未記入ステップ」「未紐づけ候補」「要原文確認シグナル」について実コードを確認します。
   - 推測でエッジを張らず、確認できた事実だけを `note`（`ファイル:行` 等の検証可能な根拠）と `confidence` 付きで記述します。

### Step 4: フロー定義・注釈を統合して `flow.html` を再生成する

```sh
node <SKILL_DIR>/scripts/build.mjs \
  --root <TARGET_REPO> \
  --flows <FLOWS_DIR> \
  --annotation <OUT_DIR>/annotations/llm.json \
  --out-dir <OUT_DIR> \
  --title "<図のタイトル>" \
  --skip-scan
```

- `--skip-scan` により `scan.json` を再利用して高速に再統合・HTML 再生成を行います。

### Step 5: 検証と納品

1. コマンドが終了コード 0 で完了し、`<OUT_DIR>/flow.html` が生成されたことを確認します。
2. `<OUT_DIR>/worklist.md` を再確認し、解消できる未紐づけ・未記入が残っていれば Step 3〜4 を反復します。
3. ユーザーに `<OUT_DIR>/flow.html` のパスと、抽出したフロー構成・未解決項目（原文確認が必要な動的参照など）を簡潔に報告します。
