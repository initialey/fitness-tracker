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
| `settings` | `main` | startDate, unit(kg/lb), tz, waterGoalMl, restMainSec(150), restTopSec, restOtherSec(90), incDbKg(1), incBarKg(2), weeklyGainPct(5), timerMorningMin, timerAfterMealMin, riceBasis("raw"/"cooked"), workoutMin, warmupMin, cardioLabel, times{weight,morning,meal1..5,after_meal,warmup,workout,cardio,night}, seedVersion |
| `plan_days` | dayNo | name, isRest, cardioRequired, notes |
| `plan_exercises` | id | dayNo, order, nameJa, nameEn, isPreexhaust, supersetGroup("SS"), pair[2 動作名]（スーパーセット: 各セットを 1-1/1-2 に展開、1-1 の後は休憩なし）, progressive（セットごとに少しずつ重くする、+5% 提案）, accessory("abs"/"calves": 最終種目のあとの枠、order 99), setScheme（例 `WU10-12,TOP6-8,BO10-12` / `MAIN8-12x3` / `MAIN10-15x3,DROP*`。`*` = 限界まで）, howTo, videoQuery, active, **sets[]**（展開済み。move/moveName/pairNo） |
| `plan_warmup` | id | name, nameEn, anim(swing/alt/cross/circle/hips/toe), reps, targetSets(3), minSets(2), steps[3]（コーチ指定 6 種、毎回必須） |
| `plan_meals` | mealNo | label, note, items[{foodId, grams, label?, short?, choices?}], alt?{label, items}（4食目の代替案）。foodId `rice` は settings.riceBasis で rice_raw / rice_cooked に解決 |
| `plan_supplements` | id | name, dose, timing(after_meal/night/pre), order, active, pending（量がコーチ確認中なら true。シートでタップ入力すると解除） |
| `plan_routine` | id | name, timing(morning/after_meal/anytime), order, active, isWater（水は log_daily.waterMl に保存） |
| `foods` | foodId | nameJa, nameEn, per(100g/100ml/1pc/1scoop), kcal, p, f, c, source(plan/user/ai/ai_photo), note |
| `log_weight` | YYYY-MM-DD | value, unit("kg"), skipped(bool), skipReason, loggedAt(ISO 8601), bodyFatPct（互換: weightKg, time, reason, reasonText） |
| `log_workout` | YYYY-MM-DD | sets{ "exId_setNo": {exerciseId, setNo, setType(WU/MAIN/FINAL/PRE/TOP/BO/DROP), weightKg, reps, loggedAt} }, meta{ exId: {note, rpe, subName} }, **warmup{completed, minutes, sets{id:n}, startedAt(ms), done(HH:mm), loggedAt, skipped, skipReason}**, finished(HH:mm), finishedAt(ISO。完了画面の所要時間 = warmup.startedAtIso → finishedAt) |
| `log_cardio` | YYYY-MM-DD | entries[{type(jog/incline/other。旧 walk/stairs も表示可), minutes, hr, note, at, loggedAt}] |
| `log_meals` | YYYY-MM-DD | meals{ mealNo: {status(plan / substitute / skip / photo: 品目から自動判定して保存), items[{foodId, grams, kcal, p, f, c, origin(plan/add), eaten, deleted(ソフト削除・シートを閉じると確定), planGrams, estimated}], loggedAt, photoId, reason(スキップ理由), variant(""/"alt"), photo{assetId, confidence, note}, skip{reason, reasonText}} } |
| `log_supplements` | YYYY-MM-DD | items{ id: {done, loggedAt} }、今日はなし: {done:false, na:true, reason, reasonText, loggedAt} |
| `log_routine` | YYYY-MM-DD | items{ id: {done, loggedAt} }、水は {done, value(ml), loggedAt}、今日はなし: {na, reason} |
| `log_media` | id | date, type(photo/video), category(body/form/meal), assetId, url, exerciseId, note |
| `log_daily` | YYYY-MM-DD | dayNo(手動上書き), dayChange{mode("swap"/"shift"), from, loggedAt}（その日の Day/部位の変更）, dayName, notes, waterMl, waterLoggedAt（水タブ）, skippedItems[{item, itemJa, reason, reasonJa}]（できなかった項目の自動集計）, isRestOverride, comment, warmupSkipped{reason, at}, workoutMissed{reason, reasonText, shift, loggedAt}, cardioMissed{reason, reasonText, loggedAt} |

重量は常に kg で保存。表示時のみ lb 換算（1 lb = 0.45359237 kg、小数 1 桁）。
初回起動時に `plan_days` が空、または `settings.seedVersion` が `SEED_VERSION`（現在 8 = 朝のルーティン確定: リンゴ酢 → 1 食目 → 経口サプリ 07:05 → サイリウム 07:20、クレアチンはトレ前の行）より古ければ、`SEED` 定数（[training-log-spec.md](training-log-spec.md)）で `plan_*` と `foods`(source=plan) を投入し直す。ログは触らない。プランを変えたら `SEED_VERSION` を上げて再公開する。

### 食事プラン（コーチ指定）
1. 全卵4個(約200g)・卵白150g・ヒマラヤ塩1g
2. 白米200g・鶏胸肉150g・ヒマラヤ塩1.5g・オリーブオイル3g・インゲン(バギオ豆)80g
3. 白米150g・鶏胸肉150g・ヒマラヤ塩1.5g・インゲン80g
4. クリームオブライス(乾燥)50g・ホエイ1スクープ(30g)・Skippy ピーナッツバター15g（プレワークアウト食）／ 代替案: 白米150g・鶏胸肉100g・全卵1個
5. 赤身牛肉(調理後)150g・インゲン または ブロッコリー100g（サーモン追加OK +20g、グミは自由）

2食目は筋トレ後の食事で必ず摂る。サーモンは差替えチップにだけ出る。白米は「炊飯後基準・要確認」を表示に必ず付ける（設定で生米基準に切替可）。差替えチップには「Selecta Adult 150ml」「Soya Hoops 80g」「Selecta 150ml + Soya Hoops 80g」（セットで1食分・約390kcal）も使用頻度に関わらず常時表示。
サプリ: B12＋D3・ベルベリン（1食目のあと、ラベル通り）／ マグネシウム グリシネート 400mg・アシュワガンダ 300mg（就寝前）／ フィッシュオイル・亜鉛・クレアチン（食後、量はコーチ確認中）。

### 筋トレの決まり（コーチ回答）
全セット 10〜12 回・限界 1 回手前（RIR 1）。最終セットはその日いちばん重かった重さの −30% で 16〜20 回（`suggestSets` が最重量 ×0.7 を提案）。休憩はメイン／最終 2:30、ウォームアップ後 1:30。前回 12 回できたら +1kg（ダンベル）/ +2kg（バーベル）、週 +5% 目安。腹筋は毎日（ルーティン id 4）。有酸素は 35〜40 分 Zone2。
全 7 日確定版は [training-log-spec.md](training-log-spec.md)。スーパーセット（pair）は ① を 1 セット → 休憩なしで ② → 休憩。①②は別種目として扱い、保存キー（`exId_setNo`。setNo は①②通しで一意）・前回値・提案重量（プログレッシブ/上限到達など）はすべて①②で独立に計算する（`suggestSets()` は move ごとに別の rolling state を持つ）。いまのセットカードは①②を並べて色分け表示、セット一覧は「Nセット目」の下に①②を入れ子表示、完了画面・コーチ報告テキストも①②を別行で出す。ドロップセットは休憩なしで即開始（図付き）。腹筋（Day 1・4・6）／カーフ（Day 2・5）は最終種目のあとの枠（accessory、コーチ確認中、自由入力）。最後の種目のあと「筋トレ完了」→ 完了画面（所要時間・やった内容・有酸素・コーチ報告テキスト `dayReport()`＋コピー）。

## 画面

タブは **今日・筋トレ・水・週** の 4 つ。同じ情報・同じ操作を 2 か所に置かない。

1. **今日**: 「いま」カード＋タイムライン。各行は全文表示（省略なし）: 食事は品目と kcal/PFC、サプリは名前を全部、筋トレは種目名を全部、ウォームアップは 6 種の内容。右端 ✓ でその場完了（食事の ✓ ＝ プラン通り食べた）。行タップで詳細（食事 → 下からのシート: プラン由来の品目はチェックで「食べた／食べなかった」、追加・差替えは × でソフト削除→「↩ 戻す」、直後に「元に戻す」トースト 5 秒、「↩ 1つ戻す」（最大 20 手）、「プランの内容に戻す」（確認あり）。差替えチップは「卵白150g → 卵白200g に置き換え」「サーモン150g を追加」と表示してから確定。自由入力 AI 計算／手入力）。最下部に 1 日合計（達成率バー＋あと N kcal）。日付の前後移動はここだけ。休みの日（Day 3・7）はウォームアップ・筋トレ・腹筋/カーフの行が無く、有酸素の行だけになる。上部の「Day N ・ 部位 ›」（筋トレ画面上部の Day 表示からも同じ）をタップすると変更シート: 各 Day の前回実施日（N日前／まだ）付きの一覧から選び、「今日だけ入れ替える」／「ここから順番をずらす」の2択で確定（`log_daily.dayChange`に保存、前日と同じ部位なら注意表示・記録済みなら警告、過去日は変わらない）。「予定どおりに戻す」でいつでも取り消せる
2. **筋トレ**: 筋トレの日は必ず **ウォームアップ画面** から始まる。各動きは 名前＋英名 → 棒人間のインライン SVG アニメ → やり方 3 ステップ → ▶ 動画で見る → セットカウンター「セット 0/3」＋［1セット完了］（2/3 以上で完了扱い、3/3 で緑）。上部に「6種中 N種 完了」と経過時間。全種完了で「筋トレを始める」が有効になり、所要分を log_workout.warmup.minutes に保存。飛ばすには理由入力→log_daily に記録。その後 1 画面 1 セット: 「種目 1/6 ・ セット 1/3」→ 種目名＋動画／やり方／用語 → 【いまのセット】カード（番号＋種類の日本語名＋目的の一文）→ セット一覧（完了は実績値、現在は黄色）→ 大数字±（初回は目安なし＋クイック重量ボタン、前回値があれば提案）→ 完了 → 休憩タイマー → 次セット。英略語（WU/MAIN/TOP…）は UI に出さない。休みの日（Day 3・7）はウォームアップを出さず `renderRestDay()` がいきなり有酸素の記録画面（種類・時間・心拍数・「記録する」／「今日はやらない」＋理由）を出し、記録（または「今日はやらない」）で `A.finishWorkout()` を呼んで完了画面へ進む。下部タブのアイコンもこの日だけ「有酸素」になる
3. **水**: 目標 5.0 L、累計の大数字、+500ml / +350ml / −500ml。達成で緑「5L 達成！」。`log_daily.waterMl` に保存（旧 log_routine の値は読むだけ）
4. **週**: 履歴だけ（日別 kcal・食事・ウォームアップ・筋トレ・有酸素・水・サプリの表、体重 30 日、いちばん重かった重量（種目別・日ごと）、コーチ向けレポート→コピー、写真一覧、設定・CSV）。当日の入力操作は置かない。遵守率のウォームアップは筋トレの日（Day 1・2・4・5・6）だけを分母にし、休みの日は数えない（`weekAdherence()`）

### 記録時刻（loggedAt）
すべての記録（体重・食事・サプリ・ルーティン・水・セット・有酸素・ウォームアップ・筋トレ完了・メディア）に `loggedAt`（ISO 8601、端末時刻、オフセット付き）を保存し、`settings.tz` で表示する。旧データの `time`(HH:mm) は互換的に ISO へ変換して扱う。
- 今日画面の行: 未記録は「予定 07:00」を薄字、記録済みは実績を太字＋「予定 07:00」を小さく。予定より 60 分以上ズレると黄色。実績時刻はタップで時刻ピッカー修正（`A.setLoggedAt`）
- 「いま」カード右上は現在時刻（1 分ごと更新）。予定時刻は「いま」の横に別表示
- タイマー（リンゴ酢→15 分、サプリ→15 分、セット後の休憩）は loggedAt からの時刻差で算出するので、閉じて開き直しても残り時間が続く
- 週まとめ（日別の予定/実績テーブル、遅れ列）、レポート（Timing 行）、CSV（plannedAt / loggedAt 列と times シート）に両方を出す

### 食事の 4 状態
未記録（灰○） / プラン通り（緑✓） / 変更あり（黄✓＋ラベル） / スキップ（赤−＋ラベル）。状態は記録品目から `deriveStatus` で導く。
シートの「記録を取り消す」（確認あり）と今日画面の ✓/− 再タップは記録を削除して未記録に戻し、「元に戻す」トーストで復元できる。「プランの内容に戻す」は今日の変更を破棄してプラン通りにする。

### できなかった日の扱い
- 体重: シートの「今日は測れなかった」→ 理由（体重計がない／外泊・旅行／忘れた／体調不良／その他）。行は灰色「−」＋「測れなかった（理由）」、「いま」は次へ進む。あとで数値を保存すると解除。「記録を取り消す」で未記録
- 食事スキップは理由（外食／時間なし／食欲なし／体調不良／その他）付き
- サプリ・ルーティン: 行の ○ を長押し、またはサプリシートの「今日はなし」→ 理由（切れていた／持っていない／忘れた／体調不良）
- 筋トレ・有酸素: 行の ○ → 「今日はできなかった」→ 理由（仕事／体調不良／旅行／その他）。筋トレは「Day をずらす（明日同じ Day をやり直す）／そのまま進む」を選び log_daily に保存。ずらした分だけ以降の Day 判定が繰り下がる
- 週まとめ: 体重グラフは隣り合う日だけ線で結び欠測日を飛ばす。7 日平均は暦 7 日窓の実測のみ。「体重 N/M 日 測定」、「できなかった項目とその理由」ブロック。レポートは `Weight: … (5/7 days measured, skipped: travel×2)` と Notes に自動集計。CSV に skipped / reason 列

### 写真からカロリー・PFC を推定
- 食事シートと今日画面の「📷 写真で記録」「AIで推定」は `sample` があれば常に出す。`sample.limits().images` の値では隠さず、実際に画像付きで `sample.json` を呼んで可否を判断する（`limits()` の報告が実際の対応状況とズレる環境があるため）。呼び出しが `images_unavailable` 等で失敗したときだけ案内文＋「手入力に切替」を出す。`sample` が完全に無ければ従来のテキスト入力のみ
- `<input type="file" accept="image/*">`（`capture` は付けない。付けるとカメラに直行してギャラリーを選べない端末があるため、ネイティブの選択肢で「撮影」「ギャラリーから選ぶ」を両方出す）→ 送信前に `resizeImage` で長辺 1280px・JPEG 0.8 に縮小（EXIF の向きは createImageBitmap で補正）
- 補足入力（例「ご飯は半分残した」）をプロンプトに含め、`sample.json(prompt, {images:[blob], modelTier:'default', cache:false, signal})` で
  `{items:[{name_ja,name_en,grams,kcal,p,f,c}], total, confidence:"high|medium|low", note}` を返させる。`validateEstimate` で形式を検証し、失敗時は 1 行エラー＋「手入力に切替」
- 結果は食材ごとの行（グラム ± で比例配分、× で除外、名前タップで foods から差し替え）、合計 kcal/PFC※ と推定の確度
- 「この内容で記録」→ 食材を foods に `source:"ai_photo"` で登録（100g 換算）、品目を `estimated:true` で log_meals に追加、写真は assets に保存して log_media（category:"meal", mealNo）に紐付け、meal.photo に assetId／確度／note。assets が無ければ写真はこのセッションのメモリだけに保持して推定・記録は行う
- 今日画面の「いま」カード直下に「📷 食べたものを写真で記録」を常設。撮影 → どの食事か選ぶ（記録済みなら 追加／置き換え）→ 間食（プラン外）は `log_meals.meals.snack_N` に保存して合計に加算、タイムラインは実績時刻の位置に挿入
- 今日画面の食事行に 📷（タップでサムネイル）、推定値を含む食事は kcal に「※」。週まとめ「写真記録 N回（推定値含む）」、レポート `(photo-logged: N, estimated values marked ※)`
- `openManualCalSheet()`: 今日画面の写真ボタン直下の「✏️ カロリーを手で入力」と、食事シート「変更・追加」欄の同名リンクの両方から開く。どの食事か（1〜5食目／間食）のチップ、名前（任意）、kcal（必須）、P/F/C（任意）の入力欄と「PFC から計算」（`P×4+F×9+C×4`）ボタンを持つ。名前を付けると `foods` に `per:'manual'・source:'manual'` で追加し（`grams:1` の等倍換算で kcal/PFC をそのまま保持）、同じ名前を再入力すると `matchFood()` で呼び出せる。保存は他の追加品目と同じ `A.mealApply(...,'add')` を通るため、削除・取り消しも既存の仕組みがそのまま使え、1 日合計・脂肪の塊の計算にも自動で反映される。今日画面の行には手入力を示す「✏️」を付ける（写真の 📷・AI推定の ※ と同じ並びの表記）

### ダイアログ
claude.ai のアーティファクトは sandbox iframe のため `confirm()` / `prompt()` は常に false / null を返す。確認・入力・時刻はすべてページ内ダイアログ（`askConfirm` / `askText` / `askTime`）で行う。

## 落ちた脂肪（週タブ）

BMR（Mifflin-St Jeor）×活動レベル＋運動消費 を TDEE とし、日々の収支（摂取−TDEE、食事未記録日は除外）を開始日から積み上げて `-累積÷7200` を脂肪の増減(kg)として出す。1kg≈1.1L から体積相当の直径を求め、不定形の塊を SVG（Catmull-Rom スプラインの輪郭＋feTurbulence の粒状感）で実物大（CSS mm 単位）に描く。クレジットカード基準の較正スライダー（`settings.rulerScale`）で端末ごとのズレを補正し、同じ倍率を塊・500mlボトル比較・グラフに掛ける。画面に収まらない時は 1/2, 1/4… と縮小して注記。
実測（7日平均、欠測日はつながない）と予測体重（点線、収支の累積から計算）を同じ `spark()` チャートに重ねる。実測と予測が直近7日ズレ続けたら `suggestActivityBase()` が activityBase を逆算し、`renderSummary()` から `act(A.autoAdjustActivity(...))` を呼んで保存（1週間に1回だけ、`settings.activityAdjustedWeek` で二重発火を防止）。
体重が1件も無ければ機能ごと非表示、食事の記録が1件も無い日は「まだ記録がありません」とだけ表示（1日目から表示し、3日分たまるまで待たせない）。累積がプラス（増加）なら塊の代わりに「今週は +Xkg」とだけ表示する。
体格（身長・年齢・性別）と活動レベルは週タブの「体格・活動レベルを編集」から設定（既定値は `bioHeightCm/bioAge/bioSex/activityBase`）。
週タブは実物大、`renderFatMini()` により今日画面の合計・プラン比ブロック直下にも高さ約100pxの小さい版を表示し、「今日 −N kcal → 脂肪 Ng」「これまで合計 X kg」を食事の記録のたびにリアルタイム更新する。今日の収支がプラスの日は塊を出さず「今日 +N kcal」とだけ表示（責める表現・警告色なし）。

## テスト

`npm run e2e:artifact` で mock / db（疑似ランタイム）両モードの 68 項目を実行し、結果を [TEST.md](TEST.md) に書き出す。

## モックモード

`claude.use("db")` が null（ローカルで開いた、権限なし）のときはメモリ上で動く。画面上部に「モックモード（保存されません）」と出る。
`node test/artifact-e2e.js` がこのモードで主要フローを実走する。

## コーチ未回答（UI の週タブに「コーチ確認中」として一覧表示）

- [ ] 腹筋の種目・セット数・回数（今は「限界まで × 3」の枠、種目名は自由入力）
- [ ] カーフ（スミス カーフレイズ）のセット数・回数（今は 10〜15 × 3 の枠）
- [ ] フィッシュオイル・亜鉛・ベルベリンの用量とタイミング
- [ ] クレアチン 7g を飲むタイミング
- [ ] プレワークアウト（Nitric Oxide 系）の銘柄・カフェイン量
- [ ] リンゴ酢の銘柄と量（大さじ何杯か）
- [ ] Zone 2 の目標心拍数
- [ ] 白米の「生／炊飯後」の基準（設定で切替可、既定は炊飯後）

## 既知の TODO / Phase 2 の残り

- [ ] db パスは指示の `plan/sets/{exerciseId}/{setNo}` や `log/workout/{date}/{exId}_{setNo}` ではなく、偶数セグメント制約と 5,000 ドキュメント上限のため「コレクション/日付」の 1 日 1 ドキュメント構造にしている
- [ ] `user` capability が使えるようになったら `data/users/<uid>/` へ移行（現在は rules でオーナー専用）
- [ ] db が 5,000 ドキュメントに近づいたときの古いログの整理（CSV 書き出し→削除）
- [ ] プラン編集 UI（現在は SEED を直して `SEED_VERSION` を上げ再公開）
- [ ] フィッシュオイル・亜鉛・クレアチンの量（コーチ確認中）
- [ ] タイムゾーン: 端末のローカル時刻を使っている（settings.tz は未使用）
- [ ] 写真・動画の Drive 共有リンクは無い。レポートには `/_blob/<id>` の相対 URL が入るので、コーチには Messenger で直接送る前提
- [ ] 通知（タイマー終了時のバイブのみ。バックグラウンド通知なし）
