# Training Log

2 つの実装がある。

- **`artifact/`** — Claude Artifact 版（スマホだけで使える単一 HTML。db / assets / sample / downloads）。詳細は [artifact/README.md](artifact/README.md)
- **`src/`** — GAS + Google Sheets 版（以下）

# GAS + Google Sheets 版

コーチの週間プランを実行した記録をスマホで素早く残し、週次でコーチに共有するための個人用ウェブアプリ。
Google スプレッドシート 1 ファイルを DB、Apps Script（HTML Service）を UI として使う。

- 単位: kg / lb を画面右上で切替。**保存は常に kg**（1 lb = 0.45359237 kg、小数 1 桁）
- Day 判定: `settings.start_date`（2026-09-16）から 7 日周期で Day1〜7 を自動判定。ホームの Day 表示をタップで手動上書き
- タイムゾーン: `settings.tz`（既定 Asia/Manila）
- メディア: Drive `TrainingLog/YYYY-MM/` に保存し、URL をシートに記録
- AI 栄養推定: Claude API（`settings.ai_model`、既定 `claude-sonnet-4-6`）

## ファイル構成

```
src/
  appsscript.json   マニフェスト（TZ / スコープ / ウェブアプリ設定: 自分だけ）
  Config.js         シート定義・設定既定値
  SheetUtil.js      シート読み書きヘルパー
  Util.js           純粋関数（Day 計算、単位換算、set_scheme 解析、栄養計算）
  DateUtil.js       TZ 付き日付ヘルパー
  SeedData.js       初期データ（暫定プラン・foods・サプリ・ルーティン）
  Setup.js          setupSheets() / rebuildPlanSets() / resetLogs()
  Today.js          今日（ホーム）画面 API
  Workout.js        ワークアウト画面 API
  Meals.js          食事画面 API
  Ai.js             Claude API で栄養推定
  Media.js          写真・動画アップロード / 一覧 / 共有
  Summary.js        サマリー・週次レポート
  WebApp.js         doGet / include
  Index.html        画面の骨格
  Styles.html       CSS
  AppJs.html        クライアント JS（5 画面）
test/               Node のテスト（GAS モック上でサーバー API を実行）+ Playwright E2E
  Timeline.js       1 日の流れ（タイムライン・いまカード）生成
scripts/build-bundle.js  src/ を 1 ファイルに束ねる
dist/Code.gs        単一ファイル版（貼り付け用、自動生成）
```

## セットアップ

1. Google スプレッドシートを新規作成 → 「拡張機能 → Apps Script」
2. コードを入れる（いずれか）
   - **単一ファイル（最短）**: `dist/Code.gs` の中身を、エディタに最初からある `コード.gs` に丸ごと貼り付けて保存。これだけで動く（HTML も同梱）
   - **clasp**: `.clasp.json.example` を `.clasp.json` にコピーし `scriptId` を入れて `npx clasp push`
   - **手動（ファイル分割）**: `src/` の各ファイルをスクリプトエディタに同名で作成して貼り付け（`.js` → スクリプト、`.html` → HTML）。`appsscript.json` は「プロジェクトの設定 → マニフェストを表示」で編集
3. スクリプトエディタで `setupSheets` を実行（初回は承認ダイアログ）
   - 全シート作成、初期データ投入、`plan_sets` 展開、Drive `TrainingLog` フォルダ作成
4. AI 推定を使う場合: 「プロジェクトの設定 → スクリプト プロパティ」に `ANTHROPIC_API_KEY` を追加
5. 「デプロイ → 新しいデプロイ → ウェブアプリ」
   - 実行ユーザー: 自分 ／ アクセス: **自分のみ**
6. 発行された URL をスマホで開き「ホーム画面に追加」

## 使い方（UI は training-log-ui.html のプロトタイプを正とする）

「何をするか考えない」ための UI。タブは 4 つ（今日・筋トレ・食事・週）、ダーク固定。

| 画面 | 内容 |
|---|---|
| 今日 | 上部に **「いま」カード 1 枚**（次にやること＋必要ならカウントダウン＋ボタン）。その下に時系列タイムライン（体重→リンゴ酢→1食目→食後サプリ→サイリウム→トレ前サプリ→筋トレ→2〜5食目→有酸素→夜サプリ→水合計）。各行は ✔ でその場完了。時刻は `settings` の `time_*` テンプレ、完了後は実績時刻で上書き。リンゴ酢→15分→1食目、サプリ→15分→サイリウムのタイマーは `timer_*_min`。Day 名タップで Day 変更・休み切替 |
| 筋トレ | **1画面1セット**。上にセット進捗チップ（W/TOP/BO/DROP/MAIN）、重量・回数は大数字＋±（数字タップで直接入力）。提案重量: TOP＝前回 TOP、前回が目標上限 reps 到達なら +2kg（ダンベルは +1kg、`inc_*_kg`）／BO＝TOP×0.85／DROP＝直前×0.7／WU・MAIN＝前回値。完了→休憩タイマー（TOP 150s、他 90s、`rest_*_sec`）→次セットへ自動遷移。下部に「代替種目」「違和感メモ（RPE）」「フォーム動画」。全セット完了→筋トレ完了→有酸素入力→今日へ |
| 食事 | プランの中身＋kcal を表示、「プラン通り食べた」1 タップ。「変更して記録」で定型差替えチップ（過去の差替えから頻度順に学習、＋半分だけ、スキップ）と自由入力（例「サーモン150 米150」→ foods に一致すればそのまま、無ければ Claude API が 100g あたり栄養を推定して foods に追加）。1 日合計とプラン比 |
| 週 | 今朝の体重（開始比）、筋トレ・食事・水の遵守、体重スパークライン（実測＋7日平均）、種目別 TOP 重量推移、コーチ向けレポート（自動生成→コピー）、写真・動画の追加とリンク、単位切替 |

週次レポートの形式:

```
Week 1 (Sep 16–22) Report
Weight: 72.4 → 71.8 kg (avg 72.1)
Workouts: 5/5 done, Cardio: 6/7 (210 min)
Top sets: Incline DB press 22→24kg×7 / Squat 60→65kg×7 / ...
Meals: 33/35 on plan (2 subs: Salmon x2)
Supplements: 95%
Water: 6/7 days ≥ 5L
Notes: right shoulder slight discomfort on lateral raise
Form check videos: <Drive link> <Drive link>   ← または sent via Messenger
Body photos: <Drive link>
```

「写真・動画を共有する」にチェックすると、該当ファイルを「リンクを知っている全員（閲覧）」にしてから URL を載せる。

## コーチ回答が来たら（マスタ編集）

すべてシート上で編集する。アプリの再デプロイは不要。

- `plan_exercises`: 種目名・`set_scheme`・`active` を編集。`set_scheme` を変えたら **`rebuildPlanSets` を実行**して `plan_sets` を展開し直す
  - 記法: `WU10-12,TOP6-8,BO10-12` ／ `MAIN10-12x3,DROP10-12` ／ `MAIN8`
- `plan_supplements`: `dose` を記入（現在は空欄）
- `plan_meals.default_items`: `[{"food_id":"chicken_cooked","grams":150}, ...]` の JSON
- `foods`: 数値を修正。`per` は `100g` / `1pc` / `1scoop`
- `settings`: `unit`, `water_goal_ml`, `tz`, `ai_model`, 時刻テンプレ `time_*`, タイマー `timer_*_min`, 休憩 `rest_*_sec`, 提案増分 `inc_db_kg` / `inc_bar_kg`

`log_*` シートは触らない前提（アプリが書く）。テスト用に `resetLogs()` で全ログを消せる。

## 初期データについて

仕様書が参照する `training_plan.html` は本リポジトリに含まれていないため、`SeedData.js` の種目・食事・サプリは
仕様書の記述（Push/Pull/Rest、代替種目のリスト、foods の品目）から組んだ**暫定プラン**。コーチ回答で上書きする。
ホームジム前提の代替（T-bar→ベントオーバーロウ、ペックデッキ→ケーブルフライ、マシンプレス→スミス、
レッグプレス→スミスハックスクワット、シーテッドハムカール→ライイングカール、ロープ→V/D ハンドル）は投入済み。

## 開発

```
npm test        # Node 22+。GAS モック上でサーバー API 全体を実行
npm run e2e     # Playwright + Chromium で画面を実際に操作（要 playwright）。test/screens/ にスクリーンショット
npm run build   # src/ → dist/Code.gs（単一ファイル版）を再生成。src を変えたら実行してコミット
npx clasp push  # .clasp.json を用意してから
```

## 非機能・制約

- 1 操作 = 1 回の `google.script.run`。チェック類は楽観的 UI（即 ✔、失敗時に戻す）
- オフライン非対応。入力途中はブラウザ側に保持しない（セット単位で即保存）
- 動画は GAS のリクエスト上限のため 50MB 目安
- API キーはシートに置かずスクリプトプロパティに置く

## フェーズ 2（未着手）

Telegram Bot 入力、Apple ヘルスケア連携、Appwrite + SwiftUI への移行。
