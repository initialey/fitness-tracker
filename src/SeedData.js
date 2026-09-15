/**
 * 初期データ（2026-09-15 時点の暫定プラン）。
 * ホームジム前提の代替種目を投入済み。コーチ回答後にシート上で active 切替・上書きする。
 *   T-bar → ベントオーバーロウ / ペックデッキ → ケーブルフライ / マシンプレス → スミス
 *   レッグプレス → スミスハックスクワット / シーテッドハムカール → ライイングカール
 *   ロープ系 → V ハンドル / D ハンドル
 * サプリの量(dose)は空欄（コーチ回答待ち）。
 */
function seedPlanDays_() {
  return [
    { day_no: 1, name: 'Push', is_rest: false, cardio_required: true, notes: '胸・肩・三頭' },
    { day_no: 2, name: 'Pull', is_rest: false, cardio_required: true, notes: '背中・二頭' },
    { day_no: 3, name: 'Rest', is_rest: true, cardio_required: true, notes: '有酸素のみ' },
    { day_no: 4, name: 'Legs', is_rest: false, cardio_required: true, notes: '脚' },
    { day_no: 5, name: 'Upper', is_rest: false, cardio_required: true, notes: '上半身（Push 寄り）' },
    { day_no: 6, name: 'Pull & Arms', is_rest: false, cardio_required: true, notes: '背中・腕' },
    { day_no: 7, name: 'Rest', is_rest: true, cardio_required: true, notes: '有酸素のみ' }
  ];
}

function seedPlanExercises_() {
  var rows = [
    // Day1 Push
    [1, 1, 1, 'ケーブルフライ（事前疲労）', 'Cable fly (pre-exhaust)', true, '', 'WU12-15,MAIN12-15x2', 'ペックデッキの代替。肘を軽く曲げ胸で寄せる。ストレッチを感じる位置まで戻す。', 'cable fly form'],
    [2, 1, 2, 'インクラインダンベルプレス', 'Incline DB press', false, '', 'WU10-12,TOP6-8,BO10-12', '角度30°。肩甲骨を寄せて胸を張り、肘は45°。', 'incline dumbbell press form'],
    [3, 1, 3, 'スミス チェストプレス', 'Smith chest press', false, '', 'MAIN10-12x3', 'マシンプレスの代替。バーは乳首ライン。', 'smith machine bench press form'],
    [4, 1, 4, 'ダンベルショルダープレス', 'DB shoulder press', false, '', 'WU12,TOP8-10,BO10-12', '腰を反らさない。', 'dumbbell shoulder press form'],
    [5, 1, 5, 'サイドレイズ', 'Lateral raise', false, 'A', 'MAIN12-15x3', '小指側をやや上に。反動を使わない。', 'lateral raise form'],
    [6, 1, 6, 'Vハンドル プッシュダウン', 'V-handle pushdown', false, 'A', 'MAIN10-12x3,DROP12-15', 'ロープの代替。肘を固定して伸ばしきる。', 'cable pushdown form'],
    // Day2 Pull
    [7, 2, 1, 'ラットプルダウン', 'Lat pulldown', false, '', 'WU12,TOP8-10,BO10-12', '胸を張り、肘を腰へ引く。', 'lat pulldown form'],
    [8, 2, 2, 'ベントオーバーロウ', 'Bent-over row', false, '', 'WU10,TOP6-8,BO10-12', 'T-bar ロウの代替。背中フラット、へそへ引く。', 'bent over barbell row form'],
    [9, 2, 3, 'Vハンドル シーテッドロウ', 'V-handle seated row', false, '', 'MAIN10-12x3', 'ロープの代替。肩甲骨を寄せ切る。', 'seated cable row form'],
    [10, 2, 4, 'Dハンドル フェイスプル', 'D-handle face pull', false, 'B', 'MAIN12-15x3', 'ロープの代替。肘を高く、外旋を意識。', 'face pull form'],
    [11, 2, 5, 'インクラインダンベルカール', 'Incline DB curl', false, 'B', 'MAIN10-12x3', '肘を後ろに置いたまま。', 'incline dumbbell curl form'],
    [12, 2, 6, 'ハンマーカール', 'Hammer curl', false, '', 'MAIN10-12x2,DROP12-15', '親指上。', 'hammer curl form'],
    // Day4 Legs
    [13, 4, 1, 'レッグエクステンション（事前疲労）', 'Leg extension (pre-exhaust)', true, '', 'WU15,MAIN12-15x2', 'トップで1秒止める。', 'leg extension form'],
    [14, 4, 2, 'スクワット', 'Squat', false, '', 'WU10,WU8,TOP6-8,BO10-12', '深さは平行以下。膝とつま先の向きを合わせる。', 'barbell squat form'],
    [15, 4, 3, 'スミス ハックスクワット', 'Smith hack squat', false, '', 'MAIN10-12x3', 'レッグプレスの代替。足は前方に置く。', 'smith machine hack squat form'],
    [16, 4, 4, 'ライイングレッグカール', 'Lying leg curl', false, '', 'WU12,MAIN10-12x3', 'シーテッドハムカールの代替。腰を浮かせない。', 'lying leg curl form'],
    [17, 4, 5, 'ルーマニアンデッドリフト', 'Romanian deadlift', false, '', 'WU10,TOP8-10,BO10-12', 'ハムのストレッチで止める。背中は真っ直ぐ。', 'romanian deadlift form'],
    [18, 4, 6, 'スタンディングカーフレイズ', 'Standing calf raise', false, '', 'MAIN12-15x4', 'ボトムで止める。', 'standing calf raise form'],
    // Day5 Upper
    [19, 5, 1, 'インクラインダンベルプレス', 'Incline DB press', false, '', 'WU10-12,TOP6-8,BO10-12', 'Day1 と同じ。前回より重量 or 回数を狙う。', 'incline dumbbell press form'],
    [20, 5, 2, 'スミス ショルダープレス', 'Smith shoulder press', false, '', 'WU12,TOP8-10,BO10-12', '顎の前を通す。', 'smith machine shoulder press form'],
    [21, 5, 3, 'ケーブルフライ', 'Cable fly', false, '', 'MAIN12-15x3', 'ペックデッキの代替。', 'cable fly form'],
    [22, 5, 4, 'サイドレイズ', 'Lateral raise', false, 'C', 'MAIN12-15x3', '', 'lateral raise form'],
    [23, 5, 5, 'リアデルト（Dハンドル）', 'Rear delt fly (D-handle)', false, 'C', 'MAIN12-15x3', 'ロープの代替。', 'cable rear delt fly form'],
    [24, 5, 6, 'オーバーヘッド エクステンション', 'Overhead extension', false, '', 'MAIN10-12x3', '肘を閉じる。', 'overhead triceps extension form'],
    // Day6 Pull & Arms
    [25, 6, 1, 'ベントオーバーロウ', 'Bent-over row', false, '', 'WU10,TOP6-8,BO10-12', 'T-bar の代替。', 'bent over barbell row form'],
    [26, 6, 2, 'ラットプルダウン', 'Lat pulldown', false, '', 'MAIN10-12x3', '', 'lat pulldown form'],
    [27, 6, 3, 'ワンハンド ダンベルロウ', 'One-arm DB row', false, '', 'MAIN10-12x3', '', 'one arm dumbbell row form'],
    [28, 6, 4, 'バーベルカール', 'Barbell curl', false, 'D', 'MAIN8-10x3', '', 'barbell curl form'],
    [29, 6, 5, 'Vハンドル プッシュダウン', 'V-handle pushdown', false, 'D', 'MAIN10-12x3', '', 'cable pushdown form'],
    [30, 6, 6, 'Dハンドル カール', 'D-handle cable curl', false, '', 'MAIN12-15x2,DROP15', '', 'cable curl form']
  ];
  return rows.map(function (r) {
    return {
      id: r[0], day_no: r[1], order: r[2], name_ja: r[3], name_en: r[4], is_preexhaust: r[5],
      superset_group: r[6], set_scheme: r[7], how_to: r[8], video_query: r[9], active: true
    };
  });
}

function seedFoods_() {
  var rows = [
    // food_id, name_ja, name_en, per, kcal, p, f, c
    ['egg_whole', '全卵', 'Whole egg', '100g', 143, 12.6, 9.5, 0.7],
    ['egg_white', '卵白', 'Egg white', '100g', 52, 10.9, 0.2, 0.7],
    ['rice_raw', '白米（生）', 'White rice (raw)', '100g', 358, 6.1, 0.9, 77.6],
    ['rice_cooked', '白米（炊飯後）', 'White rice (cooked)', '100g', 156, 2.5, 0.3, 37.1],
    ['chicken_raw', '鶏胸肉 皮なし（生）', 'Chicken breast (raw)', '100g', 105, 23.3, 1.9, 0.1],
    ['chicken_cooked', '鶏胸肉 皮なし（加熱後）', 'Chicken breast (cooked)', '100g', 165, 31.0, 3.6, 0],
    ['green_beans', 'インゲン', 'Green beans', '100g', 23, 1.8, 0.1, 5.1],
    ['olive_oil', 'オリーブオイル', 'Olive oil', '100g', 884, 0, 100, 0],
    ['rice_flour', '米粉', 'Rice flour', '100g', 356, 6.0, 0.7, 81.3],
    ['whey', 'ホエイプロテイン', 'Whey protein', '1scoop', 120, 24, 1.5, 3],
    ['peanut_butter', 'ピーナッツバター（無糖）', 'Peanut butter (unsweetened)', '100g', 588, 25, 50, 20],
    ['beef_lean_cooked', '赤身牛肉（加熱後）', 'Lean beef (cooked)', '100g', 200, 30, 8, 0],
    ['broccoli', 'ブロッコリー', 'Broccoli', '100g', 34, 2.8, 0.4, 7.0],
    ['salmon', 'サーモン', 'Salmon', '100g', 208, 20, 13, 0],
    ['gummy', 'グミ', 'Gummy candy', '100g', 340, 7, 0, 77]
  ];
  return rows.map(function (r) {
    return { food_id: r[0], name_ja: r[1], name_en: r[2], per: r[3], kcal: r[4], p: r[5], f: r[6], c: r[7], source: 'plan', note: '一般的な栄養成分表ベース。コーチ回答後に修正' };
  });
}

function seedPlanMeals_() {
  var j = function (items) { return JSON.stringify(items); };
  return [
    { meal_no: 1, label: '食事1（朝）', default_items: j([{ food_id: 'egg_whole', grams: 100 }, { food_id: 'egg_white', grams: 200 }, { food_id: 'rice_cooked', grams: 150 }]) },
    { meal_no: 2, label: '食事2（昼）', default_items: j([{ food_id: 'chicken_cooked', grams: 150 }, { food_id: 'rice_cooked', grams: 200 }, { food_id: 'green_beans', grams: 100 }, { food_id: 'olive_oil', grams: 5 }]) },
    { meal_no: 3, label: '食事3（トレ前）', default_items: j([{ food_id: 'whey', grams: 1 }, { food_id: 'rice_flour', grams: 50 }, { food_id: 'peanut_butter', grams: 15 }]) },
    { meal_no: 4, label: '食事4（トレ後）', default_items: j([{ food_id: 'beef_lean_cooked', grams: 150 }, { food_id: 'rice_cooked', grams: 200 }, { food_id: 'broccoli', grams: 100 }, { food_id: 'gummy', grams: 30 }]) },
    { meal_no: 5, label: '食事5（夜）', default_items: j([{ food_id: 'salmon', grams: 150 }, { food_id: 'broccoli', grams: 100 }, { food_id: 'olive_oil', grams: 5 }]) }
  ];
}

function seedPlanSupplements_() {
  var rows = [
    [1, 'マルチビタミン', 'morning'], [2, 'ビタミンD', 'morning'], [3, 'フィッシュオイル', 'after_meal'],
    [4, 'カフェイン', 'pre'], [5, 'EAA', 'intra'], [6, 'クレアチン', 'post'], [7, 'マグネシウム', 'night'], [8, '亜鉛', 'night']
  ];
  return rows.map(function (r, i) { return { id: r[0], name: r[1], dose: '', timing: r[2], order: i + 1, active: true }; });
}

function seedPlanRoutine_() {
  return [
    { id: 1, name: 'ACV（アップルサイダービネガー）', timing: 'morning', order: 1, active: true },
    { id: 2, name: 'サイリウム', timing: 'night', order: 2, active: true },
    { id: 3, name: '水 5L', timing: 'anytime', order: 3, active: true }
  ];
}

function seedSettings_() {
  return Object.keys(DEFAULT_SETTINGS).map(function (k) { return { key: k, value: DEFAULT_SETTINGS[k] }; });
}
