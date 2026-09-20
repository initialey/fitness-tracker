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
| `settings` | `main` | startDate, unit(kg/lb), tz, waterGoalMl, restMainSec(150), restTopSec, restOtherSec(90), restAccessorySec(90: 腹筋・カーフ), incDbKg(1), incBarKg(2), weeklyGainPct(5), timerMorningMin, timerAfterMealMin, riceBasis("raw"/"cooked"), targetKcal(2632)/targetP(210)/targetF(69)/targetC(295)（1日の目標・全曜日共通）, workoutMin, warmupMin, bioWeightKg(72.4: 体重未記録のときの有酸素kcal計算の初期値), cardioLabel, times{weight,morning,meal1..5,after_meal,warmup,workout,cardio,night}, seedVersion |
| `plan_days` | dayNo | name, isRest, cardioRequired, notes |
| `plan_exercises` | id | dayNo（数値 または 複数日の配列。腹筋は `[1,4,6]`、カーフは `[2,5]` で 1 つの exerciseId を共有し履歴が途切れない）, order, seq（SEED の並び順。order が同じ選択肢の表示順に使う）, nameJa, nameEn, isPreexhaust, supersetGroup("SS"), pair[2 動作名]（スーパーセット: 各セットを 1-1/1-2 に展開、1-1 の後は休憩なし）, progressive（セットごとに少しずつ重くする）, accessory("abs"/"calves": 最終種目のあとの枠、order 99〜101), choiceGroup（同じ値の種目はその日どれか 1 つだけを選ぶ＝「A または B」）, bodyweight（自重。重量欄を出さない）, setScheme（例 `WU10-12,TOP6-8,BO10-12` / `MAIN8-12x3` / `MAIN10-15x3,DROP*` / `TOP6-8,MID16-20` / `MID12-15x2,MID12-15?`。`*` = 限界まで、`MID` = 中重量、末尾 `?` = 任意のセット）, howTo, videoQuery, active, **sets[]**（展開済み。move/moveName/pairNo/optional） |
| `plan_warmup` | id | name, nameEn, anim(swing/alt/cross/circle/hips/toe), reps, targetSets(3), minSets(2), steps[3]（コーチ指定 6 種、毎回必須） |
| `plan_meals` | mealNo | label, note, items[{foodId, grams, label?, short?, choices?}], alt?{label, items}（4食目の代替案）。foodId `rice` は settings.riceBasis で rice_raw / rice_cooked に解決 |
| `plan_supplements` | id | name, dose, timing(after_meal/night/pre), order, active, pending（量がコーチ確認中なら true。シートでタップ入力すると解除） |
| `plan_routine` | id | name, timing(morning/after_meal/anytime), order, active, isWater（水は log_daily.waterMl に保存） |
| `foods` | foodId | nameJa, nameEn, per(100g/100ml/1pc), kcal, p, f, c（100g・100ml・1個あたり）, unitG/unitLabel（個・スクープ・貫で数えるもの。全卵 50g/個、ホエイ 30g/スクープ）, portionG（「＋ 他のものを追加」で出す既定の分量）, source(plan/user/ai/ai_photo), note |
| `log_weight` | YYYY-MM-DD | value, unit("kg"), skipped(bool), skipReason, loggedAt(ISO 8601), bodyFatPct（互換: weightKg, time, reason, reasonText） |
| `log_workout` | YYYY-MM-DD | sets{ "exId_setNo": {exerciseId, setNo, setType(WU/MAIN/FINAL/PRE/TOP/BO/DROP/MID), weightKg, reps, loggedAt} }, choices{ choiceGroup: exerciseId }（その日「A または B」でどれを選んだか。選び直すと選択とその日の記録を消す）, meta{ exId: {note, rpe, subName} }, **warmup{completed, minutes, sets{id:n}, startedAt(ms), done(HH:mm), loggedAt, skipped, skipReason}**, finished(HH:mm), finishedAt(ISO。完了画面の所要時間 = warmup.startedAtIso → finishedAt) |
| `log_cardio` | YYYY-MM-DD | entries[{type(jog/incline/padel/pickleball/other。旧 walk/stairs も表示可), minutes, hr, note, at, loggedAt, intensity(パデル・ピックルボールのみ: light/normal/hard、既定 normal), kcal(同上: 保存時点の体重×METs×時間で計算。パデル 5.5/7.0/8.5、ピックルボール 4.5/5.5/7.0)}] |
| `log_meals` | YYYY-MM-DD | meals{ 紐づけ先（mealNo または snack_N）: {linkedSlot(1〜5 / "snack"), linkOverride(手で紐づけ先を変えたら true。以後は自動判定で書き換えない), status(plan / substitute / skip / photo: 品目から自動判定して保存), items[{foodId, grams, kcal, p, f, c, origin(plan/add), eaten, deleted(ソフト削除・シートを閉じると確定), planGrams, estimated}], loggedAt, photoId, reason(スキップ理由), variant(""/"alt"), photo{assetId, confidence, note}, skip{reason, reasonText}} } |
| `log_supplements` | YYYY-MM-DD | items{ id: {done, loggedAt} }、今日はなし: {done:false, na:true, reason, reasonText, loggedAt} |
| `log_routine` | YYYY-MM-DD | items{ id: {done, loggedAt} }、水は {done, value(ml), loggedAt}、今日はなし: {na, reason} |
| `log_media` | id | date, type(photo/video), category(body/form/meal), assetId, url, exerciseId, note |
| `log_daily` | YYYY-MM-DD | dayNo(手動上書き), dayChange{from, loggedAt}（その日の Day/部位の差し替え。「未消化キュー」方式はこのフィールドだけで表現し、他の日付は書き換えない）, dayName, notes, waterMl, waterLoggedAt（水タブ）, skippedItems[{item, itemJa, reason, reasonJa}]（できなかった項目の自動集計）, isRestOverride, comment, warmupSkipped{reason, at}, workoutMissed{reason, reasonText, loggedAt}, cardioMissed{reason, reasonText, loggedAt}, restDone{loggedAt}（休みの日の「有酸素はやらない」） |

重量は常に kg で保存。表示時のみ lb 換算（1 lb = 0.45359237 kg、小数 1 桁）。
初回起動時に `plan_days` が空、または `settings.seedVersion` が `SEED_VERSION`（現在 9 = Day4 をコーチ原文どおりに差し替え、「A または B」を選択式に分割、腹筋3種・カーフ3択を確定）より古ければ、`SEED` 定数（[training-log-spec.md](training-log-spec.md)）で `plan_*` と `foods`(source=plan) を投入し直す。ログは触らない。プランを変えたら `SEED_VERSION` を上げて再公開する。

### 食事プラン（コーチ指定）
1. 全卵4個(約200g)・卵白150g・ヒマラヤ塩1g
2. 白米200g・鶏胸肉150g・ヒマラヤ塩1.5g・オリーブオイル3g・インゲン(バギオ豆)80g
3. 白米150g・鶏胸肉150g・ヒマラヤ塩1.5g・インゲン80g
4. クリームオブライス(乾燥)50g・ホエイ1スクープ(30g)・Skippy ピーナッツバター15g（プレワークアウト食）／ 代替案: 白米150g・鶏胸肉100g・全卵1個
5. 赤身牛肉(調理後)150g・インゲン または ブロッコリー100g（サーモン追加OK +20g、グミは自由）

2食目は筋トレ後の食事で必ず摂る。サーモンは差替えチップにだけ出る。白米は「炊飯後基準・要確認」を表示に必ず付ける（設定で生米基準に切替可）。差替えチップには「Selecta Adult 150ml」「Soya Hoops 80g」「Selecta 150ml + Soya Hoops 80g」（セットで1食分・約390kcal）「ピスタチオ(Meadows)（40g）」「ピスタチオ(Meadows) 20g」も使用頻度に関わらず常時表示。
サプリ: B12＋D3・ベルベリン（1食目のあと、ラベル通り）／ マグネシウム グリシネート 400mg・アシュワガンダ 300mg（就寝前）／ フィッシュオイル・亜鉛・クレアチン（食後、量はコーチ確認中）。

### 筋トレの決まり（コーチ回答）
全セット 10〜12 回・限界 1 回手前（RIR 1）。最終セットはその日いちばん重かった重さの −30% で 16〜20 回（`suggestSets` が最重量 ×0.7 を提案）。休憩はメイン／最終 2:30、ウォームアップ後 1:30。前回 12 回できたら +1kg（ダンベル）/ +2kg（バーベル）、週 +5% 目安。腹筋は毎日（ルーティン id 4）。有酸素は 35〜40 分 Zone2。
全 7 日確定版は [training-log-spec.md](training-log-spec.md)。スーパーセット（pair）は ① を 1 セット → 休憩なしで ② → 休憩。①②は別種目として扱い、保存キー（`exId_setNo`。setNo は①②通しで一意）・前回値・提案重量（漸増/上限到達など）はすべて①②で独立に計算する（`suggestSets()` は move ごとに別の rolling state を持つ）。いまのセットカードは①②を並べて色分け表示、セット一覧は「Nセット目」の下に①②を入れ子表示、完了画面・コーチ報告テキストも①②を別行で出す。ドロップセットは休憩なしで即開始（図付き）。最後の種目のあと「筋トレ完了」→ 完了画面（所要時間・やった内容・有酸素・コーチ報告テキスト `dayReport()`＋コピー）。

**「A または B」の種目（`choiceGroup`）**: `exercisesFor(date)` が同じ `choiceGroup` の種目を 1 枠にまとめ、その日の `log_workout[date].choices[group]` で選ばれた 1 つに解決する（未選択なら `needsChoice` の仮スロット）。`renderExerciseChoice()` がセット入力の前に選択カードを出し、選択肢ごとに `lastDoneOf(exId, date)` の「前回 M/D ・ Xkg×Y回」（記録が無ければ「記録なし」、14 日以上空いていれば「しばらくやっていません」）を添える。選択肢は別々の exerciseId なので前回値・提案・履歴・週まとめ・グラフはすべて独立。種目名の横の「選び直す」（`#rePick`）は 1 セット以上記録済みなら確認ダイアログを出し、`A.setExerciseChoice(date, group, null, [exId])` で選択とその日の記録を消す。対象は Day1/2/4/5 の「or」種目とカーフ 3 択。

**腹筋・カーフ（確定）**: 腹筋は Day 1・4・6 の最終種目のあとに 3 種すべて（ケーブルクランチ → ケーブル 片手 オブリーククランチ → ハンギングニーレイズ、各 3 × 15〜20。ハンギングニーレイズは `bodyweight` で重量欄なし）。カーフは Day 2・5 に 3 種から 1 つ（スミスマシン カーフレイズ／ドンキーカーフレイズ／レッグプレス トープレス、2 セット必須＋3 セット目は任意）。どちらも `dayNo` を配列にして 1 つの exerciseId を複数日で共有するので履歴が日をまたいでつながる。休憩は `restAccessorySec`（90 秒）。提案は腹筋 +2.5kg／カーフ +5kg（`bumpStep`）で、20 回に届いたときだけ伸ばす。今日画面のタイムラインも種目名を省略せずに全部出す。

**入力ポップアップ（`openSetInput`）**: 重量と回数を 1 つのポップアップに左右で並べ、重量 ±2.5（ダンベルは ±1）・回数 ±1、初期値は提案重量と目標回数の下限。数字をタップすれば直接入力でき、「記録する」1 つで `commitSet()` → 休憩タイマー開始。自重種目は回数だけ。見出しは日本語（「1セット目 ・ ウォームアップ ・ 10〜12回」など。英略語は出さない）。目標回数の範囲外でも記録は止めず、「目標を超えました。次回は重量を上げてください」／「目標に届きませんでした。次回は同じ重量で」をトーストで出すだけ。

**セット種類ごとの提案（`suggestSets`）**: ウォームアップ = その日のトップ予定 × 0.55（トップは後ろにあるので `topPlan` で先に見積もる）／トップ = 前回のトップ、上限到達で `bumpKg`（+5%、ダンベルは +1kg）／バックオフ = 今日のトップ × 0.85／中重量（MID）= 16〜20 回ならトップ × 0.70、10〜15 回ならトップ × 0.80／漸増 = 1 セット目は前回の 1 セット目（前回上限到達なら 1 段階重く）、2 セット目以降は前のセットから 1 段階重く（ダンベル +1kg、腹筋 +2.5kg、カーフ +5kg、それ以外 +2.5kg。前のセットを記録済みで上限に届かなかったときだけ据え置き）／ドロップ = 直前 × 0.7／最終 = 最重量 × 0.7。

**任意のセット**: `setScheme` の末尾 `?` のセットは「（任意）」表示＋「このセットは飛ばす（任意）」ボタン。任意セットを開いている間はボタンが「このセット完了」のままで（未記録のまま完了画面に飛ばない）、飛ばした時点で残りが無ければ筋トレ完了に進む。遵守率のセット数も、任意セットは記録したときだけ分母に数える。

前回の重量は全種目・全セット位置（トップ／バックオフ／ウォームアップ、スーパーセット①②）で常に表示する。`exerciseHistory(exId, setNos, beforeDate, limit)` が位置（setNo）ごとに過去日付を遡って直近 `limit` 件（無制限も可）の実施履歴を集め、`workoutModel()` の各セットに `prevWeightKg`/`prevReps`/`prevDate`/`prevSubName`/`history[]` として持たせる（単に「その種目を最後に触った日」ではなく位置ごとに独立して遡るため、途中で終えたセッションがあっても以前の記録を見失わない）。入力欄の下に「前回 M/D（N日前） ・ Xkg×Y → 今日は Zkg を提案（理由）」、履歴が2件以上あれば「履歴 …」の行（タップで `openExerciseHistorySheet()` の全履歴＋グラフ）。代替種目（subName）で実施した履歴も同じ exerciseId で拾い、当日と違うときだけ「〜で実施」を添える。未記録のセット一覧行にも薄く前回値。

有酸素にラケット競技（パデル・ピックルボール）を追加。強度3段階を `RACKET_INTENSITY` にまとめて持ち、パデルは 軽め 5.5 / ふつう 7.0 / 激しめ 8.5、ピックルボールは 4.5 / 5.5 / 7.0（コートが狭く移動距離が短いぶん1段階低い）。既定はどちらも「ふつう」で、種目を選び直すたびに強度チップを出し直して「ふつう」に戻す（前の種目の選択を引きずらない）。30分単位ボタン（30/60/90/120・＋30分）・分数の自由入力を両方の記録画面（今日画面の `openCardioSheet()`、休みの日の `renderRestDay()`）に用意し、`racketKcal(type, minutes, intensity, weightKg)` でその場に「消費カロリー 約 594 kcal（体重 72kg で計算）」とプレビューを出す（`kcalPreviewText()`）。計算に使う体重は `cardioWeightKg(date)` = 直近の実測値、まだ一度も測っていなければ `settings.bioWeightKg`（初期値 72.4kg）にフォールバックするので、体重未記録でもエラーにならない。保存時にも同じ式で `entry.kcal` を確定して保存する。今日画面・完了画面には記録した種目名を出して「パデル・ピックルボールは強度が変動するので、Zone 2 とは別物です」という注意書きを1行出す（`racketNote()`）。`weekAdherence()` の `cardio` は `zone2` / `padel` / `pickleball` を件数・分数・kcal で別集計し、週タブには `#cardioBreak` として「Zone 2 4回 / 目標5回」「パデル 2回 ・ 合計3.0時間 ・ 1,188 kcal」「ピックルボール 1回 ・ 合計1.5時間 ・ 594 kcal」と種目名つきで並べる（Zone 2 の遵守率にはラケット競技を入れない）。コーチ向けレポートの Cardio 行も `Zone 2 x4 (150 min) ・ Padel x2 (180 min, 3.0 hrs, ~1,188 kcal) ・ Pickleball x1 (90 min, 1.5 hrs, ~594 kcal)` のように分けて出す（`exerciseKcalFor()` の TDEE 運動分にもそのまま加算）。

## 画面

タブは **今日・筋トレ・水・週** の 4 つ。同じ情報・同じ操作を 2 か所に置かない。

1. **今日**: 「いま」カード＋**時刻順**のタイムライン。各行は全文表示（省略なし）: 食事は品目と kcal/PFC、サプリは名前を全部、筋トレは種目名を全部、ウォームアップは 6 種の内容。日付の前後移動はここだけ。休みの日（Day 3・7）はウォームアップ・筋トレ・腹筋/カーフの行が無く、有酸素の行だけになる。上部の「Day N ・ 部位 ›」（筋トレ画面上部の Day 表示からも同じ）をタップすると Day ピッカー: 今日の予定（未実施なら持ち越し日付つき）→ その他の未実施（持ち越しが古い順）→ 残りは Day 番号順、の一覧から選んで確定（`log_daily.dayChange`に保存、前日と同じ部位なら注意表示・記録済みなら警告、過去日は変わらない）。キューの消化判定は曜日の種類で分ける: **筋トレの日（Day 1・2・4・5・6）** は `log_workout[date].finished` だけで判定し、食事などの記録があっても未完了なら持ち越す。**休みの日（Day 3・7）** は `restDayConsumed(date)`（有酸素の記録／食事・体重・サプリのいずれか1件以上／`log_daily.restDone`（「有酸素はやらない」）／`cardioMissed`／`log_workout.finished`）のどれかで消化する。休みの日に求められているのは「トレーニングをしないこと」なので、その日を過ごした記録が残っていれば消化とみなす。「未消化キュー」方式なので差し替えで後回しになった Day はキューに残ったまま消えず、他を消化した後に自然と繰り越して出てくる（今日画面に「M/D は Day N に差し替えたため持ち越し」等の注記、未実施が2つ以上なら注意バナー）。「予定どおりに戻す」（差し替え済みのときだけ）でいつでも取り消せる（確認なし）
   - **今日以外の日付**: `renderToday()` は `#now` を描かず、代わりに `#pastBar` を 1 行出す（「9/18（金）の記録 ・ 過去」「9/23（水）の予定 ・ 未来」）。行から `data-open` を外し、`.chk` は `disabled` ＋ `.off` で灰色に。記録カードは `bindLongPress` の長押し →「修正する」でだけ開く（`openTimeSheet`/`openWeightSheet` は元の `loggedAt` を初期値にするので、今の時刻が入ることはない）。「いま」カードで今の時刻の記録が過去・未来の日付に入ってしまう事故を防ぐための措置
   - **画面下部の固定バー（`renderBottomBar()` → `#bbar`）**: 今日の日付を見ているときだけ出す（過去・未来では出さない＝誤って今日に入れないため）。1日合計（カロリーのバー＋タンパク質・脂質・炭水化物）と「📷 写真で記録」「✏️ 手で入力」を横並びで固定。タブバーのすぐ上に置き、スクロールしても消えない（`body:has(#bbar:not([hidden])) main` の下余白と、トーストの退避位置も合わせて調整）。合計をタップすると `UI.totalsOpen` で上に展開し、`totalsBlock()` の内訳・`renderFatMini()` の塊・「週まとめを見る」を出す
   - **食事は「枠を埋める」ではなく「食べたら記録する」**: 未記録の枠（`planOnly`）は破線の枠で、`.chk` は付けない。タップすると `openMealPickSheet()` の**品目選択シート**が開く。予定時刻を 2 時間過ぎたら `overdue` で枠線をオレンジにし「まだ記録がありません」を 1 行足す（自動でスキップ扱いにはしない）。記録済みの食事の行は従来どおりで、左下に紐づけ先のチップ（`[data-relink]` → `openSlotSheet()`）が付き、食べなかった品目は `mealStep()` の `lineHtml` で `<s>` の打ち消し線として残し、プランとのカロリー差も出す。記録済みの行タップは今までどおり詳細シート（プラン由来の品目はチェックで「食べた／食べなかった」、追加・差替えは × でソフト削除→「↩ 戻す」、直後に「元に戻す」トースト 5 秒、「↩ 1つ戻す」（最大 20 手）、「プランの内容に戻す」（確認あり）、「品目を選び直す」、差替えチップ、自由入力 AI 計算／手入力）
2. **筋トレ**: 筋トレの日は必ず **ウォームアップ画面** から始まる。各動きは 名前＋英名 → 棒人間のインライン SVG アニメ → やり方 3 ステップ → ▶ 動画で見る → セットカウンター「セット 0/3」＋［1セット完了］（2/3 以上で完了扱い、3/3 で緑）。上部に「6種中 N種 完了」と経過時間。全種完了で「筋トレを始める」が有効になり、所要分を log_workout.warmup.minutes に保存。飛ばすには理由入力→log_daily に記録。その後 1 画面 1 セット: 「種目 1/6 ・ セット 1/3」→ 種目名＋動画／やり方／用語 → 【いまのセット】カード（番号＋種類の日本語名＋目的の一文）→ セット一覧（完了は実績値、現在は黄色）→ 大数字±（初回は目安なし＋クイック重量ボタン、前回値があれば提案）→ 完了 → 休憩タイマー → 次セット。英略語（WU/MAIN/TOP…）は UI に出さない。休みの日（Day 3・7）はウォームアップを出さず `renderRestDay()` がいきなり有酸素の記録画面（種類・時間・心拍数・「記録する」／「今日はやらない」＋理由）を出し、記録（または「今日はやらない」）で `A.finishWorkout()` を呼んで完了画面へ進む。下部タブのアイコンもこの日だけ「有酸素」になる
3. **水**: 目標 5.0 L、累計の大数字、+500ml / +350ml / −500ml。達成で緑「5L 達成！」。`log_daily.waterMl` に保存（旧 log_routine の値は読むだけ）
4. **週**: 履歴だけ（日別 kcal・食事・ウォームアップ・筋トレ・有酸素・水・サプリの表、体重 30 日、いちばん重かった重量（種目別・日ごと）、コーチ向けレポート→コピー、写真一覧、設定・CSV）。当日の入力操作は置かない。遵守率のウォームアップは筋トレの日（Day 1・2・4・5・6）だけを分母にし、休みの日は数えない（`weekAdherence()`）

### 1日の目標（プラン比の分母）

`coachTarget()` が `settings.targetKcal/targetP/targetF/targetC`（既定 2632 / 210 / 69 / 295）を返し、`mealsModel().planTotal` はこれを使う。休みの日も同じ5食なので曜日では変えない。プランの品目を足した値は `planItemsTotal` として別に持ち、目標と 50kcal 以上ズレていたら `totalsBlock()` が差を 1 行で出す（いまの SEED の品目合計は 2,178 kcal ＝ P223 F56 C193 なので、目標まで 454kcal 足りないことが画面に出る）。

### 体重の入力

入力欄は常に空（`value=""`）で、前回値はプレースホルダーとしてだけ出す。`#nowW` / `#shW` に何か入るまで保存ボタンを `disabled` にして、測っていないのに前回値で保存される事故を防ぐ。体脂肪率は任意。

### 記録時刻（loggedAt）
すべての記録（体重・食事・サプリ・ルーティン・水・セット・有酸素・ウォームアップ・筋トレ完了・メディア）に `loggedAt`（ISO 8601、端末時刻、オフセット付き）を保存し、`settings.tz` で表示する。旧データの `time`(HH:mm) は互換的に ISO へ変換して扱う。
- 今日画面の行: 未記録は「予定 07:00」を薄字、記録済みは実績を太字＋「予定 07:00」を小さく。予定より 60 分以上ズレると黄色。実績時刻はタップで時刻ピッカー修正（`A.setLoggedAt`）
- 「いま」カード右上は現在時刻（1 分ごと更新）。予定時刻は「いま」の横に別表示
- タイマー（リンゴ酢→15 分、サプリ→15 分、セット後の休憩）は loggedAt からの時刻差で算出するので、閉じて開き直しても残り時間が続く
- 週まとめ（日別の予定/実績テーブル、遅れ列）、レポート（Timing 行）、CSV（plannedAt / loggedAt 列と times シート）に両方を出す

### 品目選択シート（`openMealPickSheet`）

プランの食事カードをタップして開く。`UI.mealPick = { date, mealNo, rows }` にローカルな状態を持ち、チェック・分量の変更は `render()` を呼ばずにシート内だけを描き直す（入力中にフォーカスが飛ばないようにするため）。

- 品目は最初から全部チェック。チェックを外すと合計から外れる。分量を変えると `calcMacros()` で即座に再計算し、各行のカロリーと下部の「合計 / （プラン …）」を更新する
- 「全部食べた」は `planGrams` に戻したうえで全品目を `eaten: true` にして 1 タップで `A.mealCommit()`
- 分量の欄は `bindLongPress` で「×0.5 / ×1.5 / ×2」
- `unitG`/`unitLabel` を持つ食品（全卵 50g「個」、ホエイ 30g「スクープ」、サーモン寿司 1「貫」）は入力も表示も単位で行う（`unitOf()` / `amountText()`）
- 「＋ 他のものを追加」は `openAddFoodSheet()`。`portionG` を持つ食品を「よく使うもの」として並べ、検索と「＋ 新しい食品を登録」（入力した分量あたりの値を 100g あたりに直して `A.addFood`）を同じシートに持つ。写真の推定結果も `#phReg`「食品マスタに登録」で同じマスタに入る

### 食事の記録と枠の自動紐づけ

食事は「食べたら記録して、アプリが枠に紐づける」方式。記録画面で「どの食事か」は一切聞かない。

- `slotWindows()` がプランの予定時刻から各枠の担当時間帯を作る。境目は隣り合う予定時刻のまん中、1食目は予定の 2 時間前から、最後の食事は 24:00 まで。既定（07:00/10:30/13:30/16:30/19:30）なら 05:00–08:45 / 08:45–12:00 / 12:00–15:00 / 15:00–18:00 / 18:00–24:00
- `slotForTime(hm)` がその時刻を担当する枠を返す（どこにも入らなければ `'snack'`）。`autoSlotFor(date)` は、さらにその枠が**すでに記録済み**なら `nextSnackKey(date)` を返す＝間食として独立して残す
- 記録は `loggedAt` に記録した瞬間の時刻が自動で入る（入力させない）。あとから直したいときだけ行の時刻タップ（`openTimeSheet`）
- `openSlotSheet(date, fromKey)` で紐づけ先（1食目〜5食目 / 間食）を選び直す。記録済みの枠には「（記録済み）」と添え、選ぶと `askConfirm` の確認のうえ `A.relinkMeal()` が 2 つの記録の紐づけ先を**入れ替える**。移した記録には `linkOverride: true` が付き、以後アプリの自動判定で書き換えない
- タイムラインは `buildTimeline()` の最後で食事だけを取り出し、`insertByTime()` で「記録済みは実績時刻・未記録は予定時刻」の位置に置き直す。だから紐づけ先を変えても並びは時刻順のまま動かない
- **写真**: 固定バーの `#photoBtn` → `photoFromToday()` が縮小して `UI.sheetMeal.photoOnly = true` で写真パネルだけのシートを開く（プランの内容も枠の選択も出さない）。紐づけ先は `autoSlotFor()` が決め、シート冒頭に「記録した時刻から、◯◯ として記録します（あとから変えられます）」と出す
- **手入力**: `openManualCalSheet(date, null)` は「プランにないものを記録」専用（プランの食事は品目選択シートから記録する）。枠の選択もプランのチップも持たない。カロリーのみ必須、品目名は任意（例「コンビニのサンドイッチ」）、「タンパク質・脂質・炭水化物から計算」で P×4 + F×9 + C×4。食事シートの「変更・追加」欄から開いたときだけ、その食事に固定して追加する
- 保存形式は「1 日 1 ドキュメント」の制約を保つため **キー＝紐づけ先**（`1`〜`5` / `snack_N`）のままにし、各レコードに `linkedSlot` と `linkOverride` を明示的に持たせた。1 つの枠に紐づく記録は仕様上つねに 1 件なので、キーを別 ID にするのと情報量は同じで、既存データの移行が要らない（古いドキュメントは次に書き込んだ時点で `linkedSlot` が付く）

### 食事の 4 状態
未記録（灰○） / プラン通り（緑✓） / 変更あり（黄✓＋ラベル） / スキップ（赤−＋ラベル）。状態は記録品目から `deriveStatus` で導く。
シートの「記録を取り消す」（確認あり）と今日画面の ✓/− 再タップは記録を削除して未記録に戻し、「元に戻す」トーストで復元できる。「プランの内容に戻す」は今日の変更を破棄してプラン通りにする。

### できなかった日の扱い
- 体重: シートの「今日は測れなかった」→ 理由（体重計がない／外泊・旅行／忘れた／体調不良／その他）。行は灰色「−」＋「測れなかった（理由）」、「いま」は次へ進む。あとで数値を保存すると解除。「記録を取り消す」で未記録
- 食事スキップは理由（外食／時間なし／食欲なし／体調不良／その他）付き
- サプリ・ルーティン: 行の ○ を長押し、またはサプリシートの「今日はなし」→ 理由（切れていた／持っていない／忘れた／体調不良）
- 筋トレ・有酸素: 行の ○ → 「今日はできなかった」→ 理由（仕事／体調不良／旅行／その他）を log_daily に保存するだけでよい。「未消化キュー」方式では「完了しなかった」だけで自動的にその Day がキューの先頭に残り、翌日も同じ Day が繰り越して出る（完了の判定は `log_workout.finished`／休みの日は `log_cardio` の記録の有無で、`workoutMissed` の記録自体は Day の判定に影響しない）
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

`npm run e2e:artifact` で mock / db（疑似ランタイム）両モードの 79 項目を実行し、結果を [TEST.md](TEST.md) に書き出す。

## モックモード

`claude.use("db")` が null（ローカルで開いた、権限なし）のときはメモリ上で動く。画面上部に「モックモード（保存されません）」と出る。
`node test/artifact-e2e.js` がこのモードで主要フローを実走する。

## コーチ未回答（UI の週タブに「コーチ確認中」として一覧表示）

- [x] 腹筋の種目・セット数・回数 → 週 3 回（Day 1・4・6）・3 種すべて・各 3 × 15〜20 で確定
- [x] カーフのセット数・回数 → 週 2〜3 回（Day 2・5）・3 種から 1 つ・2 セット必須＋任意 1 セット・15〜20 で確定
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
