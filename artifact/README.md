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
| `settings` | `main` | startDate, unit(kg/lb), tz, waterGoalMl, restTopSec, restOtherSec, incDbKg, incBarKg, timerMorningMin, timerAfterMealMin, times{weight,morning,meal1..5,after_meal,pre,workout,cardio,night}, seeded |
| `plan_days` | dayNo | name, isRest, cardioRequired, notes |
| `plan_exercises` | id | dayNo, order, nameJa, nameEn, isPreexhaust, supersetGroup, setScheme, howTo, videoQuery, active, **sets[]**（set_scheme を展開済み） |
| `plan_meals` | mealNo | label, items[{foodId, grams}] |
| `plan_supplements` | id | name, dose(空欄), timing, order, active |
| `plan_routine` | id | name, timing, order, active, isWater |
| `foods` | foodId | nameJa, nameEn, per(100g/1pc/1scoop), kcal, p, f, c, source(plan/user/ai), note |
| `log_weight` | YYYY-MM-DD | time, weightKg, bodyFatPct |
| `log_workout` | YYYY-MM-DD | sets{ "exId_setNo": {exerciseId, setNo, setType, weightKg, reps, at} }, meta{ exId: {note, rpe, subName} }, finished(HH:mm) |
| `log_cardio` | YYYY-MM-DD | entries[{type, minutes, note, at}] |
| `log_meals` | YYYY-MM-DD | meals{ mealNo: {status(plan/sub/skip), items[{foodId, grams, kcal, p, f, c}]} } |
| `log_supplements` | YYYY-MM-DD | items{ id: {done, time} } |
| `log_routine` | YYYY-MM-DD | items{ id: {done, time} }、水は {done, value(ml)} |
| `log_media` | id | date, type(photo/video), category(body/form/meal), assetId, url, exerciseId, note |
| `log_daily` | YYYY-MM-DD | dayNo(手動上書き), isRestOverride, comment |

重量は常に kg で保存。表示時のみ lb 換算（1 lb = 0.45359237 kg、小数 1 桁）。
初回起動時に `plan_days` が空なら `SEED` 定数（spec 第 5 章、ホームジム代替入り、サプリ量は空欄）を投入する。

## 画面

1. **今日**: 「いま」カード＋タイムライン。リンゴ酢→15 分→1 食目、食後サプリ→15 分→サイリウムのタイマー。各行 ✔ で即保存。体重入力、水 +250/+500、未入力は薄く表示
2. **筋トレ**: 1 画面 1 セット。提案重量（TOP=前回 TOP、上限 reps 到達で +2kg／DB は +1kg、BO=TOP×0.85、DROP=直前×0.7）。完了→休憩タイマー（TOP 150s／他 90s）→次セットへ自動。代替種目名、違和感メモ、RPE、フォーム動画（assets）
3. **食事**: 「プラン通り食べた」1 タップで plan_meals の items を展開し kcal/PFC 集計。「変更」→定型チップ（過去の差替えから学習）＋半分＋スキップ＋自由入力（foods に無い食品は sample で推定して source:"ai" で追加。sample が無いときは手入力）
4. **週まとめ**: 体重（実測＋7 日平均）SVG、種目別 TOP 推移、遵守率、コーチ向け英文レポート→コピー、写真・動画一覧、CSV 書き出し（downloads）

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
