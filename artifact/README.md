# トレログ — Claude Artifact 版

`index.html` 1 ファイル。GAS / スプレッドシートは使わず、Artifact ランタイムの `db` / `assets` / `sample` / `downloads` で動く。
スマホの claude.ai だけで使う・直す前提。

## 公開時の capabilities 宣言

```json
{
  "db": { "rules": [ { "path": "", "read": "owner", "write": "owner" } ] },
  "assets": {},
  "sample": {},
  "downloads": true
}
```

- **db を owner 専用にしている理由**: 指示にあった `data/users/<uid>/...` は `user` capability（viewer id）が必要で、このアカウントでは利用不可。
  代わりにルートの `rules` で「読み書きともオーナーのみ」に固定し、同じ「オーナー専用」を満たしている。
  `user` が使えるようになったら `data/users/<uid>/` 配下へ移す（TODO）。
- 公開すると組織内限定になり、公開リンク共有はできない（db/assets を宣言するアーティファクトの仕様）。

## データモデル（db）

パスは偶数セグメント必須のため、指示の `plan/days/1`（3 セグメント）形式は使えない。またアーティファクト全体で 5,000 ドキュメント上限があるため、**ログは 1 日 1 ドキュメント**にまとめた。

| コレクション | doc id | 内容 |
|---|---|---|
| `settings` | `main` | startDate, unit(kg/lb), tz, waterGoalMl, restTopSec, restOtherSec, incDbKg, incBarKg, timerMorningMin, timerAfterMealMin, **riceBasis("raw"/"cooked"、コーチ回答待ち)**, workoutMin, warmupMin, cardioLabel, times{weight,morning,meal1..5,after_meal,warmup,workout,cardio,night}, seedVersion |
| `plan_days` | dayNo | name, isRest, cardioRequired, notes |
| `plan_exercises` | id | dayNo, order, nameJa, nameEn, isPreexhaust, supersetGroup, setScheme, howTo, videoQuery, active, **sets[]**（set_scheme を展開済み） |
| `plan_warmup` | id | name, nameEn, anim(swing/alt/cross/circle/hips/toe), reps, targetSets(3), minSets(2), steps[3]（コーチ指定 6 種、毎回必須） |
| `plan_meals` | mealNo | label, items[{foodId, grams, label?, short?, choices?}], alt?{label, items}（4食目の代替案）。foodId `rice` は settings.riceBasis で rice_raw / rice_cooked に解決 |
| `plan_supplements` | id | name, dose(空欄), timing, order, active |
| `plan_routine` | id | name, timing, order, active, isWater |
| `foods` | foodId | nameJa, nameEn, per(100g/1pc/1scoop), kcal, p, f, c, source(plan/user/ai), note |
| `log_weight` | YYYY-MM-DD | loggedAt(ISO 8601), time, weightKg, bodyFatPct |
| `log_workout` | YYYY-MM-DD | sets{ "exId_setNo": {exerciseId, setNo, setType, weightKg, reps, at} }, meta{ exId: {note, rpe, subName} }, **warmup{sets{id:n}, startedAt(ms), done(HH:mm), minutes, skipped, skipReason}**, finished(HH:mm) |
| `log_cardio` | YYYY-MM-DD | entries[{type, minutes, note, at}] |
| `log_meals` | YYYY-MM-DD | meals{ mealNo: {status(plan/sub/skip: 品目から自動判定), variant(""/"alt"), items[{foodId, grams, kcal, p, f, c, origin(plan/add), eaten, deleted(ソフト削除・シートを閉じると確定), planGrams, choiceOf}]} } |
| `log_supplements` | YYYY-MM-DD | items{ id: {done, time} } |
| `log_routine` | YYYY-MM-DD | items{ id: {done, time} }、水は {done, value(ml)} |
| `log_media` | id | date, type(photo/video), category(body/form/meal), assetId, url, exerciseId, note |
| `log_daily` | YYYY-MM-DD | dayNo(手動上書き), isRestOverride, comment, warmupSkipped{reason, at} |

重量は常に kg で保存。表示時のみ lb 換算（1 lb = 0.45359237 kg、小数 1 桁）。
初回起動時に `plan_days` が空、または `settings.seedVersion` が `SEED_VERSION` より古ければ、`SEED` 定数（spec 第 5 章、ホームジム代替入り、サプリ量は空欄）で `plan_*` と `foods`(source=plan) を投入し直す。ログは触らない。プランを変えたら `SEED_VERSION` を上げて再公開する。

### 食事プラン（コーチ指定）
1. 全卵4個(約200g)・卵白150g・ヒマラヤ塩1g
2. 白米200g・鶏胸肉150g・ヒマラヤ塩1.5g・オリーブオイル3g・インゲン(バギオ豆)80g
3. 白米150g・鶏胸肉150g・ヒマラヤ塩1.5g・インゲン80g
4. 米粉(クリームオブライス)乾燥50g・ホエイ1スクープ(30g)・無糖ピーナッツバター15g ／ 代替案: 白米150g・鶏胸肉100g・全卵1個
5. 赤身牛肉(調理後)150g・インゲン または ブロッコリー100g

サーモンは差替えチップにだけ出る。白米は「炊飯後基準・要確認」を表示に必ず付ける（設定で生米基準に切替可）。
食後サプリ 7 種: クレアチン・マグネシウム・フィッシュオイル・亜鉛・アシュワガンダ・B12+D3・ベルベリン（量はコーチ回答待ち）。

## 画面

タブは **今日・筋トレ・週** の 3 つ。同じ情報・同じ操作を 2 か所に置かない。

1. **今日**: 「いま」カード＋タイムライン。各行は全文表示（省略なし）: 食事は品目と kcal/PFC、サプリは名前を全部、筋トレは種目名を全部、ウォームアップは 6 種の内容。右端 ✓ でその場完了（食事の ✓ ＝ プラン通り食べた）。行タップで詳細（食事 → 下からのシート: プラン由来の品目はチェックで「食べた／食べなかった」、追加・差替えは × でソフト削除→「↩ 戻す」、直後に「元に戻す」トースト 5 秒、「↩ 1つ戻す」（最大 20 手）、「プランの内容に戻す」（確認あり）。差替えチップは「卵白150g → 卵白200g に置き換え」「サーモン150g を追加」と表示してから確定。自由入力 AI 計算／手入力）。最下部に 1 日合計（達成率バー＋あと N kcal）。日付の前後移動はここだけ
2. **筋トレ**: 必ず **ウォームアップ画面** から始まる。各動きは 名前＋英名 → 棒人間のインライン SVG アニメ → やり方 3 ステップ → ▶ 動画で見る → セットカウンター「セット 0/3」＋［1セット完了］（2/3 以上で完了扱い、3/3 で緑）。上部に「6種中 N種 完了」と経過時間。全種完了で「筋トレを始める」（休みの日は「有酸素を始める」）が有効になり、所要分を log_workout.warmup.minutes に保存。飛ばすには理由入力→log_daily に記録。休みの日も有酸素前に同じ 6 種。その後 1 画面 1 セット: 「種目 1/6 ・ セット 1/3」→ 種目名＋動画／やり方／用語 → 【いまのセット】カード（番号＋種類の日本語名＋目的の一文）→ セット一覧（完了は実績値、現在は黄色）→ 大数字±（初回は目安なし＋クイック重量ボタン、前回値があれば提案）→ 完了 → 休憩タイマー → 次セット。英略語（WU/MAIN/TOP…）は UI に出さない
3. **週**: 履歴だけ（日別 kcal・食事・ウォームアップ・筋トレ・有酸素・水・サプリの表、体重 30 日、TOP 重量推移、コーチ向けレポート→コピー、写真一覧、設定・CSV）。当日の入力操作は置かない

### 記録時刻（loggedAt）
すべての記録（体重・食事・サプリ・ルーティン・水・セット・有酸素・ウォームアップ・筋トレ完了・メディア）に `loggedAt`（ISO 8601、端末時刻、オフセット付き）を保存し、`settings.tz` で表示する。旧データの `time`(HH:mm) は互換的に ISO へ変換して扱う。
- 今日画面の行: 未記録は「予定 07:00」を薄字、記録済みは実績を太字＋「予定 07:00」を小さく。予定より 60 分以上ズレると黄色。実績時刻はタップで時刻ピッカー修正（`A.setLoggedAt`）
- 「いま」カード右上は現在時刻（1 分ごと更新）。予定時刻は「いま」の横に別表示
- タイマー（リンゴ酢→15 分、サプリ→15 分、セット後の休憩）は loggedAt からの時刻差で算出するので、閉じて開き直しても残り時間が続く
- 週まとめ（日別の予定/実績テーブル、遅れ列）、レポート（Timing 行）、CSV（plannedAt / loggedAt 列と times シート）に両方を出す

### 食事の 4 状態
未記録（灰○） / プラン通り（緑✓） / 変更あり（黄✓＋ラベル） / スキップ（赤−＋ラベル）。状態は記録品目から `deriveStatus` で導く。
シートの「記録を取り消す」（確認あり）と今日画面の ✓/− 再タップは記録を削除して未記録に戻し、「元に戻す」トーストで復元できる。「プランの内容に戻す」は今日の変更を破棄してプラン通りにする。

### ダイアログ
claude.ai のアーティファクトは sandbox iframe のため `confirm()` / `prompt()` は常に false / null を返す。確認・入力・時刻はすべてページ内ダイアログ（`askConfirm` / `askText` / `askTime`）で行う。

## テスト

`npm run e2e:artifact` で mock / db（疑似ランタイム）両モードの 36 項目を実行し、結果を [TEST.md](TEST.md) に書き出す。

## モックモード

`claude.use("db")` が null（ローカルで開いた、権限なし）のときはメモリ上で動く。画面上部に「モックモード（保存されません）」と出る。
`node test/artifact-e2e.js` がこのモードで主要フローを実走する。

## 既知の TODO / Phase 2 の残り

- [ ] `user` capability が使えるようになったら `data/users/<uid>/` へ移行（現在は rules でオーナー専用）
- [ ] db が 5,000 ドキュメントに近づいたときの古いログの整理（CSV 書き出し→削除）
- [ ] コーチ回答後のプラン編集 UI（現在は Claude に頼んで db を書き換えるか、SEED を直して再公開）
- [ ] タイムゾーン: 端末のローカル時刻を使っている（settings.tz は未使用）
- [ ] 写真・動画の Drive 共有リンクは無い。レポートには `/_blob/<id>` の相対 URL が入るので、コーチには Messenger で直接送る前提
- [ ] 通知（タイマー終了時のバイブのみ。バックグラウンド通知なし）
