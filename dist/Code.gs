/**
 * Training Log — 単一ファイル版（自動生成: node scripts/build-bundle.js）
 * Apps Script エディタの Code.gs にこのファイル全体を貼り付けて保存し、setupSheets を実行する。
 */

// ===== Ai.js =====
/**
 * Claude API で食品の 100g あたり栄養素を推定し foods に source=ai で追加する。
 * API キーはシートではなくスクリプトプロパティ ANTHROPIC_API_KEY に置く
 * （スクリプトエディタ → プロジェクトの設定 → スクリプト プロパティ）。
 * モデルは settings.ai_model（既定 claude-sonnet-4-6）。
 */
function estimateFoodWithAi(foodName) {
  if (!foodName || !String(foodName).trim()) throw new Error('食品名を入力してください');
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('スクリプトプロパティ ANTHROPIC_API_KEY が未設定です');
  var model = getSettings().ai_model || 'claude-sonnet-4-6';

  var system = [
    'You are a nutrition database. Given a food name (Japanese or English), return typical nutrition per 100 g as edible portion.',
    'Respond with ONLY a JSON object, no prose, no code fence, exactly these keys:',
    '{"name_ja":string,"name_en":string,"kcal":number,"p":number,"f":number,"c":number,"note":string}',
    'p/f/c are grams of protein/fat/carbohydrate per 100 g. note: one short line on the assumption (e.g. cooked vs raw, brand).',
    'If the name is ambiguous, assume the most common preparation and say so in note.'
  ].join('\n');

  var payload = {
    model: model,
    max_tokens: 512,
    system: system,
    messages: [{ role: 'user', content: String(foodName).trim() }]
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) throw new Error('Claude API エラー ' + code + ': ' + body.slice(0, 300));
  var msg = JSON.parse(body);
  if (msg.stop_reason === 'refusal') throw new Error('Claude API が応答を拒否しました');
  var text = (msg.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  var est = parseAiJson_(text);
  var row = addFood({ name_ja: est.name_ja || foodName, name_en: est.name_en || '', per: '100g', kcal: est.kcal, p: est.p, f: est.f, c: est.c, source: 'ai', note: est.note || '' });
  return row;
}

/** モデル出力から JSON を取り出す（コードフェンスや前置きがあっても拾う）。 */
function parseAiJson_(text) {
  var s = String(text || '').trim();
  var m = /\{[\s\S]*\}/.exec(s);
  if (!m) throw new Error('AI 応答を解釈できません: ' + s.slice(0, 200));
  var obj = JSON.parse(m[0]);
  ['kcal', 'p', 'f', 'c'].forEach(function (k) {
    obj[k] = Number(obj[k]);
    if (isNaN(obj[k])) throw new Error('AI 応答の ' + k + ' が数値ではありません');
  });
  return obj;
}

// ===== Config.js =====
/**
 * 定数・設定アクセス。
 * すべてのログは kg で保存し、表示時のみ換算する。
 */
var LB_TO_KG = 0.45359237;

var SHEETS = {
  settings: ['key', 'value'],
  plan_days: ['day_no', 'name', 'is_rest', 'cardio_required', 'notes'],
  plan_exercises: ['id', 'day_no', 'order', 'name_ja', 'name_en', 'is_preexhaust', 'superset_group', 'set_scheme', 'how_to', 'video_query', 'active'],
  plan_sets: ['exercise_id', 'set_no', 'set_type', 'target_reps_min', 'target_reps_max', 'note'],
  plan_meals: ['meal_no', 'label', 'default_items'],
  plan_supplements: ['id', 'name', 'dose', 'timing', 'order', 'active'],
  plan_routine: ['id', 'name', 'timing', 'order', 'active'],
  foods: ['food_id', 'name_ja', 'name_en', 'per', 'kcal', 'p', 'f', 'c', 'source', 'note'],
  log_weight: ['date', 'time', 'weight_kg', 'body_fat_pct', 'note'],
  log_workout: ['date', 'day_no', 'exercise_id', 'set_no', 'set_type', 'weight_kg', 'reps', 'rpe', 'note', 'created_at'],
  log_cardio: ['date', 'type', 'minutes', 'note'],
  log_meals: ['date', 'meal_no', 'food_id', 'grams', 'kcal', 'p', 'f', 'c', 'status', 'note'],
  log_supplements: ['date', 'item_id', 'done', 'time'],
  log_routine: ['date', 'item_id', 'done', 'value'],
  log_media: ['date', 'type', 'category', 'drive_url', 'exercise_id', 'note'],
  log_daily: ['date', 'day_no_actual', 'is_rest_override', 'comment']
};

var DEFAULT_SETTINGS = {
  start_date: '2026-09-16',
  unit: 'kg',
  tz: 'Asia/Manila',
  water_goal_ml: '5000',
  coach_name: 'Albert',
  drive_folder_id: '',
  ai_model: 'claude-sonnet-4-6'
};

var TIMINGS = ['morning', 'pre', 'intra', 'post', 'night', 'after_meal', 'anytime'];
var TIMING_LABELS = {
  morning: '朝', pre: 'トレ前', intra: 'トレ中', post: 'トレ後',
  night: '夜', after_meal: '食後', anytime: '随時'
};

/** 設定を {key: value} で返す（実行内キャッシュ）。 */
function getSettings() {
  if (getSettings._cache) return getSettings._cache;
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = DEFAULT_SETTINGS[k]; });
  var rows = readRows_('settings');
  rows.forEach(function (r) {
    if (r.key !== '' && r.key != null) out[String(r.key)] = r.value == null ? '' : String(r.value);
  });
  if (out.start_date instanceof Date) out.start_date = formatDate_(out.start_date, out.tz);
  getSettings._cache = out;
  return out;
}

function setSetting(key, value) {
  var sh = getSheet_('settings');
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      sh.getRange(i + 1, 2).setValue(value);
      getSettings._cache = null;
      return;
    }
  }
  sh.appendRow([key, value]);
  getSettings._cache = null;
}

function getTz_() {
  return getSettings().tz || 'Asia/Manila';
}

// ===== DateUtil.js =====
/** GAS 依存の日付ヘルパー（TZ は settings.tz）。 */
function formatDate_(d, tz) {
  return Utilities.formatDate(d, tz || getTz_(), 'yyyy-MM-dd');
}

function todayYmd_() {
  return formatDate_(new Date(), getTz_());
}

function nowHm_() {
  return Utilities.formatDate(new Date(), getTz_(), 'HH:mm');
}

function nowIso_() {
  return Utilities.formatDate(new Date(), getTz_(), "yyyy-MM-dd'T'HH:mm:ss");
}

/** その日の実効 Day 番号（log_daily の手動上書きを優先）。 */
function effectiveDayNo_(dateYmd, dailyRow) {
  var s = getSettings();
  if (dailyRow === undefined) dailyRow = findRow_('log_daily', function (r) { return r.date === dateYmd; });
  if (dailyRow && dailyRow.day_no_actual !== '' && dailyRow.day_no_actual != null) {
    return Number(dailyRow.day_no_actual);
  }
  return calcDayNo_(s.start_date, dateYmd);
}

// ===== Meals.js =====
/** ④ 食事（差替え・追加）画面のサーバー API。 */
function foodMap_() {
  var map = {};
  readRows_('foods').forEach(function (f) { map[String(f.food_id)] = f; });
  return map;
}

function getMeals(dateYmd) {
  var date = dateYmd || todayYmd_();
  var foods = foodMap_();
  var logs = findRows_('log_meals', function (r) { return r.date === date; });
  var planMeals = readRows_('plan_meals').sort(function (a, b) { return Number(a.meal_no) - Number(b.meal_no); });
  var planTotal = { kcal: 0, p: 0, f: 0, c: 0 };
  var meals = planMeals.map(function (m) {
    var items = logs.filter(function (r) { return Number(r.meal_no) === Number(m.meal_no); });
    var planItems = parseItemsJson_(m.default_items).map(function (it) {
      var f = foods[it.food_id];
      var mac = f ? calcMacros_(f, it.grams) : { kcal: 0, p: 0, f: 0, c: 0 };
      planTotal.kcal += mac.kcal; planTotal.p += mac.p; planTotal.f += mac.f; planTotal.c += mac.c;
      return { food_id: it.food_id, name: f ? f.name_ja : it.food_id, grams: it.grams, per: f ? f.per : '100g', kcal: mac.kcal };
    });
    return {
      meal_no: Number(m.meal_no), label: m.label, status: mealStatus_(items), plan_items: planItems,
      items: items.filter(function (r) { return r.status !== 'skip'; }).map(function (r) {
        var f = foods[r.food_id];
        return { _row: r._row, food_id: r.food_id, name: f ? f.name_ja : r.food_id, per: f ? f.per : '100g', grams: Number(r.grams), kcal: Number(r.kcal), p: Number(r.p), f: Number(r.f), c: Number(r.c), status: r.status, note: r.note };
      })
    };
  });
  var total = { kcal: 0, p: 0, f: 0, c: 0 };
  logs.forEach(function (r) { total.kcal += Number(r.kcal) || 0; total.p += Number(r.p) || 0; total.f += Number(r.f) || 0; total.c += Number(r.c) || 0; });
  ['kcal', 'p', 'f', 'c'].forEach(function (k) { total[k] = round1_(total[k]); planTotal[k] = round1_(planTotal[k]); });
  return { date: date, meals: meals, total: total, plan_total: planTotal, foods: listFoods_() };
}

function listFoods_() {
  return readRows_('foods').map(function (f) {
    return { food_id: String(f.food_id), name_ja: f.name_ja, name_en: f.name_en, per: f.per, kcal: Number(f.kcal), p: Number(f.p), f: Number(f.f), c: Number(f.c), source: f.source };
  });
}

/** 食品を追加。status は 'sub'（差替え）または 'plan'。 */
function addMealItem(dateYmd, mealNo, foodId, amount, status, note) {
  var f = foodMap_()[String(foodId)];
  if (!f) throw new Error('foods に ' + foodId + ' がありません');
  if (amount === '' || isNaN(Number(amount))) throw new Error('量を入力してください');
  var m = calcMacros_(f, amount);
  return withLock_(function () {
    // skip 行が残っていれば消す
    deleteRowsWhere_('log_meals', function (r) { return r.date === dateYmd && Number(r.meal_no) === Number(mealNo) && r.status === 'skip'; });
    appendRow_('log_meals', { date: dateYmd, meal_no: Number(mealNo), food_id: String(foodId), grams: Number(amount), kcal: m.kcal, p: m.p, f: m.f, c: m.c, status: status || 'sub', note: note || '' });
    return getMeals(dateYmd);
  });
}

function deleteMealItem(dateYmd, rowIndex) {
  return withLock_(function () {
    var rows = readRows_('log_meals');
    var target = rows.filter(function (r) { return r._row === Number(rowIndex) && r.date === dateYmd; })[0];
    if (!target) throw new Error('行が見つかりません（再読込してください）');
    deleteRow_('log_meals', target._row);
    return getMeals(dateYmd);
  });
}

/** foods マスタに追加（手入力 or AI）。 */
function addFood(food) {
  if (!food || !food.name_ja) throw new Error('食品名が必要です');
  var id = String(food.food_id || slugify_(food.name_en || food.name_ja));
  var existing = foodMap_()[id];
  if (existing) id = id + '_' + Date.now().toString(36);
  var row = { food_id: id, name_ja: food.name_ja, name_en: food.name_en || '', per: food.per || '100g',
    kcal: Number(food.kcal) || 0, p: Number(food.p) || 0, f: Number(food.f) || 0, c: Number(food.c) || 0,
    source: food.source || 'user', note: food.note || '' };
  withLock_(function () { appendRow_('foods', row); });
  return row;
}

function slugify_(s) {
  var t = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return t || ('food_' + Date.now().toString(36));
}

// ===== Media.js =====
/** ⑤ メディア（写真・動画）API。Drive の TrainingLog/YYYY-MM/ に保存。 */
function monthFolder_(dateYmd) {
  var rootId = ensureDriveFolder_();
  var root = DriveApp.getFolderById(rootId);
  var name = String(dateYmd).slice(0, 7);
  var it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

/**
 * base64 でアップロード。GAS の 1 リクエスト上限（約 50MB）を超える場合はクライアント側で弾く。
 * meta: {date, category(body/form/meal), exercise_id, note}
 */
function uploadMedia(base64, mimeType, fileName, meta) {
  var date = meta.date || todayYmd_();
  var bytes = Utilities.base64Decode(base64);
  var blob = Utilities.newBlob(bytes, mimeType, date + '_' + (meta.category || 'misc') + '_' + fileName);
  var folder = monthFolder_(date);
  var file = folder.createFile(blob);
  var type = /^video\//.test(mimeType) ? 'video' : 'photo';
  var url = file.getUrl();
  withLock_(function () {
    appendRow_('log_media', { date: date, type: type, category: meta.category || 'body', drive_url: url, exercise_id: meta.exercise_id || '', note: meta.note || '' });
  });
  return { url: url, type: type, id: file.getId() };
}

/** Drive アプリで直接アップした URL を登録。 */
function addMediaUrl(meta) {
  if (!meta.drive_url) throw new Error('URL を入力してください');
  var type = meta.type || 'video';
  withLock_(function () {
    appendRow_('log_media', { date: meta.date || todayYmd_(), type: type, category: meta.category || 'form', drive_url: meta.drive_url, exercise_id: meta.exercise_id || '', note: meta.note || '' });
  });
  return { ok: true };
}

function listMedia(limit) {
  var rows = readRows_('log_media').sort(function (a, b) { return b.date.localeCompare(a.date) || b._row - a._row; });
  var exs = {};
  readRows_('plan_exercises').forEach(function (e) { exs[Number(e.id)] = e.name_ja; });
  return rows.slice(0, limit || 100).map(function (r) {
    var id = driveIdFromUrl_(r.drive_url);
    return { _row: r._row, date: r.date, type: r.type, category: r.category, drive_url: r.drive_url,
      thumb: id ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w400' : '',
      exercise: r.exercise_id !== '' ? (exs[Number(r.exercise_id)] || '') : '', note: r.note };
  });
}

function deleteMedia(rowIndex) {
  return withLock_(function () { deleteRow_('log_media', Number(rowIndex)); return { ok: true }; });
}

function driveIdFromUrl_(url) {
  var m = /\/d\/([A-Za-z0-9_-]+)/.exec(String(url)) || /[?&]id=([A-Za-z0-9_-]+)/.exec(String(url));
  return m ? m[1] : '';
}

/** 共有用: ファイルを「リンクを知っている全員（閲覧）」にする。 */
function shareMediaForCoach(url) {
  var id = driveIdFromUrl_(url);
  if (!id) throw new Error('Drive URL ではありません');
  var f = DriveApp.getFileById(id);
  f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { url: f.getUrl() };
}

function listExercisesForSelect() {
  return readRows_('plan_exercises').filter(function (e) { return e.active !== false; })
    .sort(function (a, b) { return Number(a.day_no) - Number(b.day_no) || Number(a.order) - Number(b.order); })
    .map(function (e) { return { id: Number(e.id), label: 'Day' + e.day_no + ' ' + e.name_ja }; });
}

// ===== SeedData.js =====
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

// ===== Setup.js =====
/**
 * ① シート生成 + 初期データ投入。
 * スクリプトエディタから setupSheets() を 1 回実行する。
 * 既存シートは残し、足りないシート・ヘッダーだけ作る。ログシートは触らない。
 */
function setupSheets() {
  var ss = getSs_();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var header = SHEETS[name];
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // 日付/時刻列は文字列として保存する
    header.forEach(function (h, i) {
      if (['date', 'time', 'created_at', 'value', 'start_date'].indexOf(h) >= 0 || name === 'settings') {
        sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
      }
    });
  });
  var s = ss.getSheetByName('Sheet1') || ss.getSheetByName('シート1');
  if (s && ss.getSheets().length > 1) ss.deleteSheet(s);
  seedIfEmpty_();
  ensureDriveFolder_();
  return 'OK: ' + Object.keys(SHEETS).length + ' sheets';
}

/** マスタ系が空のときだけ初期データを投入。 */
function seedIfEmpty_() {
  if (readRows_('settings').length === 0) appendRows_('settings', seedSettings_());
  if (readRows_('plan_days').length === 0) appendRows_('plan_days', seedPlanDays_());
  if (readRows_('plan_exercises').length === 0) appendRows_('plan_exercises', seedPlanExercises_());
  if (readRows_('plan_meals').length === 0) appendRows_('plan_meals', seedPlanMeals_());
  if (readRows_('plan_supplements').length === 0) appendRows_('plan_supplements', seedPlanSupplements_());
  if (readRows_('plan_routine').length === 0) appendRows_('plan_routine', seedPlanRoutine_());
  if (readRows_('foods').length === 0) appendRows_('foods', seedFoods_());
  if (readRows_('plan_sets').length === 0) rebuildPlanSets();
  getSettings._cache = null;
}

/**
 * plan_exercises.set_scheme を plan_sets に展開し直す。
 * コーチ回答で set_scheme を編集したあとに手動実行する。
 */
function rebuildPlanSets() {
  var exercises = readRows_('plan_exercises');
  var rows = [];
  exercises.forEach(function (ex) {
    parseSetScheme_(ex.set_scheme).forEach(function (s) {
      rows.push({ exercise_id: ex.id, set_no: s.set_no, set_type: s.set_type, target_reps_min: s.target_reps_min, target_reps_max: s.target_reps_max, note: '' });
    });
  });
  var sh = getSheet_('plan_sets');
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, SHEETS.plan_sets.length).clearContent();
  appendRows_('plan_sets', rows);
  return rows.length + ' sets';
}

/** Drive の TrainingLog ルートフォルダを作成し settings.drive_folder_id に保存。 */
function ensureDriveFolder_() {
  var s = getSettings();
  if (s.drive_folder_id) {
    try { DriveApp.getFolderById(s.drive_folder_id); return s.drive_folder_id; } catch (e) { /* recreate */ }
  }
  var it = DriveApp.getFoldersByName('TrainingLog');
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder('TrainingLog');
  setSetting('drive_folder_id', folder.getId());
  return folder.getId();
}

/** 全ログを削除して初期状態に戻す（マスタは維持）。テスト用。 */
function resetLogs() {
  Object.keys(SHEETS).forEach(function (name) {
    if (name.indexOf('log_') !== 0) return;
    var sh = getSheet_(name);
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, SHEETS[name].length).clearContent();
  });
  return 'logs cleared';
}

// ===== SheetUtil.js =====
/**
 * シート読み書きの共通ヘルパー。
 * 日付列は 'YYYY-MM-DD' の文字列として扱う（TZ ずれ防止のため列書式は文字列）。
 */
function getSs_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name) {
  var sh = getSs_().getSheetByName(name);
  if (!sh) throw new Error('シートがありません: ' + name + ' （setupSheets を実行してください）');
  return sh;
}

/** ヘッダー行をキーにしたオブジェクト配列で返す。 */
function readRows_(name) {
  var sh = getSheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var header = SHEETS[name];
  var values = sh.getRange(2, 1, last - 1, header.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var empty = true;
    var obj = { _row: i + 2 };
    for (var j = 0; j < header.length; j++) {
      var v = row[j];
      if (v instanceof Date) v = normalizeCell_(header[j], v);
      if (v !== '' && v != null) empty = false;
      obj[header[j]] = v;
    }
    if (!empty) out.push(obj);
  }
  return out;
}

function normalizeCell_(col, v) {
  if (col === 'date' || col === 'start_date') return formatDate_(v, getTz_());
  if (col === 'time' || col === 'created_at') return Utilities.formatDate(v, getTz_(), 'HH:mm');
  return v;
}

function appendRow_(name, obj) {
  var header = SHEETS[name];
  var row = header.map(function (h) { return obj[h] == null ? '' : obj[h]; });
  getSheet_(name).appendRow(row);
  return row;
}

function appendRows_(name, objs) {
  if (!objs.length) return;
  var header = SHEETS[name];
  var rows = objs.map(function (obj) {
    return header.map(function (h) { return obj[h] == null ? '' : obj[h]; });
  });
  var sh = getSheet_(name);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
}

function updateRow_(name, rowIndex, obj) {
  var header = SHEETS[name];
  var sh = getSheet_(name);
  var cur = sh.getRange(rowIndex, 1, 1, header.length).getValues()[0];
  var row = header.map(function (h, i) { return obj.hasOwnProperty(h) ? (obj[h] == null ? '' : obj[h]) : cur[i]; });
  sh.getRange(rowIndex, 1, 1, header.length).setValues([row]);
}

function deleteRow_(name, rowIndex) {
  getSheet_(name).deleteRow(rowIndex);
}

/** 条件に一致する行を後ろから削除（行番号ズレ防止）。 */
function deleteRowsWhere_(name, pred) {
  var rows = readRows_(name).filter(pred);
  var sh = getSheet_(name);
  rows.sort(function (a, b) { return b._row - a._row; });
  rows.forEach(function (r) { sh.deleteRow(r._row); });
  return rows.length;
}

function findRows_(name, pred) {
  return readRows_(name).filter(pred);
}

function findRow_(name, pred) {
  var rows = findRows_(name, pred);
  return rows.length ? rows[0] : null;
}

function nextId_(name, idCol) {
  var rows = readRows_(name);
  var max = 0;
  rows.forEach(function (r) { var n = Number(r[idCol]); if (n > max) max = n; });
  return max + 1;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ===== Summary.js =====
/** ⑥ サマリー / コーチ共有。 */
function getSummary(weekNo) {
  var s = getSettings();
  var today = todayYmd_();
  var curWeek = calcWeekNo_(s.start_date, today);
  var wk = weekNo ? Number(weekNo) : curWeek;
  var range = weekRange_(s.start_date, wk);

  // 体重推移（全期間、日付昇順、同日は最後の値）
  var wmap = {};
  readRows_('log_weight').forEach(function (r) { wmap[r.date] = Number(r.weight_kg); });
  var weights = Object.keys(wmap).sort().map(function (d) { return { date: d, value: wmap[d] }; });
  var ma = movingAverage_(weights, 7);

  // 種目別 TOP set 推移
  var exNames = {};
  readRows_('plan_exercises').forEach(function (e) { exNames[Number(e.id)] = e.name_en || e.name_ja; });
  var top = {};
  readRows_('log_workout').forEach(function (r) {
    if (r.set_type !== 'TOP' || r.weight_kg === '') return;
    var id = Number(r.exercise_id);
    var key = exNames[id] || ('#' + id);
    (top[key] = top[key] || []).push({ date: r.date, value: Number(r.weight_kg), reps: Number(r.reps) || 0 });
  });
  var topSeries = Object.keys(top).map(function (k) {
    var pts = top[k].sort(function (a, b) { return a.date.localeCompare(b.date); });
    return { name: k, points: pts };
  });

  return {
    unit: s.unit, week_no: wk, current_week: curWeek, range: range,
    weights: weights, weights_ma7: ma, top_sets: topSeries,
    adherence: weekAdherence_(range, s)
  };
}

/** 週の遵守率。 */
function weekAdherence_(range, s) {
  var inRange = function (r) { return r.date >= range.start && r.date <= range.end; };
  var planDays = readRows_('plan_days');
  var dailies = findRows_('log_daily', inRange);
  var workoutLogs = findRows_('log_workout', inRange).filter(function (r) { return Number(r.set_no) > 0; });
  var cardioLogs = findRows_('log_cardio', inRange);
  var mealLogs = findRows_('log_meals', inRange);
  var supLogs = findRows_('log_supplements', inRange);
  var rtLogs = findRows_('log_routine', inRange);
  var activeSup = readRows_('plan_supplements').filter(function (r) { return r.active !== false; }).length;
  var waterGoal = Number(s.water_goal_ml) || 5000;
  var waterId = (findRow_('plan_routine', function (r) { return /水/.test(String(r.name)); }) || {}).id;
  var mealsPerDay = readRows_('plan_meals').length;
  var today = todayYmd_();

  var trainPlanned = 0, trainDone = 0, cardioPlanned = 0, cardioDone = 0, mealPlanned = 0, mealOk = 0, subs = 0, skips = 0;
  var supPlanned = 0, supDone = 0, waterDays = 0, waterOk = 0, daysElapsed = 0;
  var trainDoneDays = [], cardioDays = {};
  cardioLogs.forEach(function (c) { cardioDays[c.date] = true; });
  var subFoods = {};

  for (var d = range.start; d <= range.end; d = addDays_(d, 1)) {
    if (d > today) continue;
    daysElapsed++;
    var daily = dailies.filter(function (r) { return r.date === d; })[0];
    var dayNo = effectiveDayNo_(d, daily || null);
    var pd = planDays.filter(function (r) { return Number(r.day_no) === dayNo; })[0] || {};
    var isRest = daily && daily.is_rest_override !== '' && daily.is_rest_override != null ? !!daily.is_rest_override : !!pd.is_rest;
    var trained = workoutLogs.some(function (r) { return r.date === d; });
    if (!isRest) { trainPlanned++; if (trained) { trainDone++; trainDoneDays.push(d); } }
    if (pd.cardio_required !== false) { cardioPlanned++; if (cardioDays[d]) cardioDone++; }
    mealPlanned += mealsPerDay;
    supPlanned += activeSup;
    waterDays++;
    var w = rtLogs.filter(function (r) { return r.date === d && Number(r.item_id) === Number(waterId); })[0];
    if (w && Number(w.value) >= waterGoal) waterOk++;
  }
  var mealSeen = {};
  mealLogs.forEach(function (r) {
    var k = r.date + '#' + r.meal_no;
    if (r.status === 'sub') { subs++; subFoods[r.food_id] = (subFoods[r.food_id] || 0) + 1; }
    if (mealSeen[k]) return;
    mealSeen[k] = true;
    if (r.status === 'plan' || r.status === 'sub') mealOk++; else skips++;
  });
  supLogs.forEach(function (r) { if (r.done) supDone++; });

  return {
    days_elapsed: daysElapsed,
    workouts: { done: trainDone, planned: trainPlanned, dates: trainDoneDays },
    cardio: { done: cardioDone, planned: cardioPlanned, minutes: cardioLogs.reduce(function (a, c) { return a + Number(c.minutes); }, 0) },
    meals: { on_plan: mealOk, planned: mealPlanned, subs: subs, skips: skips, sub_foods: subFoods },
    supplements: { done: supDone, planned: supPlanned, pct: pct_(supDone, supPlanned) },
    water: { ok: waterOk, days: waterDays }
  };
}

/** 週次レポートのテキストを生成。Messenger に貼る用。 */
function generateWeeklyReport(weekNo, opts) {
  opts = opts || {};
  var s = getSettings();
  var sum = getSummary(weekNo);
  var r = sum.range, a = sum.adherence;
  var foods = foodMap_();
  var exNames = {};
  readRows_('plan_exercises').forEach(function (e) { exNames[Number(e.id)] = e.name_en || e.name_ja; });

  var inRange = function (x) { return x.date >= r.start && x.date <= r.end; };
  var ws = sum.weights.filter(inRange);
  var wLine = 'Weight: n/a';
  if (ws.length) {
    var avg = round1_(ws.reduce(function (acc, w) { return acc + w.value; }, 0) / ws.length);
    var first = ws[0].value, last = ws[ws.length - 1].value;
    var u = s.unit === 'lb' ? function (k) { return kgToLb_(k); } : function (k) { return round1_(k); };
    wLine = 'Weight: ' + u(first) + ' → ' + u(last) + ' ' + s.unit + ' (avg ' + u(avg) + ')';
  }

  // Top sets: 種目ごとに前週最終 → 今週最良
  var prevRange = weekRange_(s.start_date, sum.week_no - 1);
  var topLogs = readRows_('log_workout').filter(function (x) { return x.set_type === 'TOP' && x.weight_kg !== ''; });
  var byEx = {};
  topLogs.forEach(function (x) { (byEx[Number(x.exercise_id)] = byEx[Number(x.exercise_id)] || []).push(x); });
  var topParts = [];
  Object.keys(byEx).forEach(function (id) {
    var cur = byEx[id].filter(inRange).sort(function (p, q) { return Number(q.weight_kg) - Number(p.weight_kg) || Number(q.reps) - Number(p.reps); })[0];
    if (!cur) return;
    var prev = byEx[id].filter(function (x) { return x.date >= prevRange.start && x.date <= prevRange.end; })
      .sort(function (p, q) { return Number(q.weight_kg) - Number(p.weight_kg); })[0];
    var fmt = function (k) { return s.unit === 'lb' ? kgToLb_(k) : round1_(k); };
    var part = (exNames[id] || ('#' + id)) + ' ' + (prev ? fmt(prev.weight_kg) + '→' : '') + fmt(cur.weight_kg) + s.unit + '×' + (cur.reps || '?');
    topParts.push(part);
  });

  var subList = Object.keys(a.meals.sub_foods).map(function (fid) {
    var f = foods[fid];
    return (f ? (f.name_en || f.name_ja) : fid) + ' x' + a.meals.sub_foods[fid];
  });
  var mealLine = 'Meals: ' + a.meals.on_plan + '/' + a.meals.planned + ' on plan' +
    (a.meals.subs ? ' (' + a.meals.subs + ' subs: ' + subList.join(', ') + ')' : '') +
    (a.meals.skips ? ' (' + a.meals.skips + ' skipped)' : '');

  var notes = findRows_('log_daily', inRange).map(function (x) { return String(x.comment || '').trim(); }).filter(Boolean);
  var exNotes = findRows_('log_workout', function (x) { return inRange(x) && Number(x.set_no) === 0 && String(x.note).replace(/^\[sub:.+?\]\s*/, '').trim(); })
    .map(function (x) { return (exNames[Number(x.exercise_id)] || '') + ': ' + String(x.note).replace(/^\[sub:.+?\]\s*/, '').trim(); });
  var allNotes = notes.concat(exNotes);

  var media = findRows_('log_media', inRange);
  var formVideos = media.filter(function (m) { return m.category === 'form'; });
  var bodyPhotos = media.filter(function (m) { return m.category === 'body'; });
  var linkLine = function (label, items, viaMessenger) {
    if (viaMessenger) return label + ': sent via Messenger';
    if (!items.length) return label + ': none';
    return label + ': ' + items.map(function (m) { return m.drive_url; }).join(' ');
  };
  if (opts.share_links) {
    formVideos.concat(bodyPhotos).forEach(function (m) { try { shareMediaForCoach(m.drive_url); } catch (e) { /* 非 Drive URL は無視 */ } });
  }

  var lines = [
    'Week ' + sum.week_no + ' (' + shortRange_(r.start, r.end) + ') Report',
    wLine,
    'Workouts: ' + a.workouts.done + '/' + a.workouts.planned + ' done, Cardio: ' + a.cardio.done + '/' + a.cardio.planned + (a.cardio.minutes ? ' (' + a.cardio.minutes + ' min)' : ''),
    'Top sets: ' + (topParts.length ? topParts.join(' / ') : 'n/a'),
    mealLine,
    'Supplements: ' + a.supplements.pct + '%',
    'Water: ' + a.water.ok + '/' + a.water.days + ' days ≥ ' + (Number(s.water_goal_ml) / 1000) + 'L',
    'Notes: ' + (allNotes.length ? allNotes.join('; ') : 'none'),
    linkLine('Form check videos', formVideos, opts.form_via_messenger),
    linkLine('Body photos', bodyPhotos, false)
  ];
  return { text: lines.join('\n'), week_no: sum.week_no, range: r };
}

// ===== Today.js =====
/**
 * ② 今日（ホーム）画面のサーバー API。
 * 1 操作 = 1 回の google.script.run。返り値はすべて JSON 化可能なプレーンオブジェクト。
 */
function getToday(dateYmd) {
  var s = getSettings();
  var date = dateYmd || todayYmd_();
  var daily = findRow_('log_daily', function (r) { return r.date === date; });
  var dayNo = effectiveDayNo_(date, daily);
  var day = findRow_('plan_days', function (r) { return Number(r.day_no) === dayNo; }) || { day_no: dayNo, name: 'Day ' + dayNo, is_rest: false };
  var isRest = daily && daily.is_rest_override !== '' && daily.is_rest_override != null ? !!daily.is_rest_override : !!day.is_rest;

  var weights = findRows_('log_weight', function (r) { return r.date === date; });
  var weight = weights.length ? weights[weights.length - 1] : null;
  var prevWeight = latestWeightBefore_(date);

  var supRows = findRows_('log_supplements', function (r) { return r.date === date; });
  var supplements = readRows_('plan_supplements').filter(function (r) { return r.active !== false; })
    .sort(function (a, b) { return Number(a.order) - Number(b.order); })
    .map(function (p) {
      var l = supRows.filter(function (r) { return Number(r.item_id) === Number(p.id); }).pop();
      return { id: Number(p.id), name: p.name, dose: p.dose, timing: p.timing, done: !!(l && l.done), time: l ? l.time : '' };
    });

  var rtRows = findRows_('log_routine', function (r) { return r.date === date; });
  var waterMl = 0;
  var routine = readRows_('plan_routine').filter(function (r) { return r.active !== false; })
    .sort(function (a, b) { return Number(a.order) - Number(b.order); })
    .map(function (p) {
      var l = rtRows.filter(function (r) { return Number(r.item_id) === Number(p.id); }).pop();
      var isWater = /水/.test(String(p.name));
      if (isWater && l) waterMl = Number(l.value) || 0;
      return { id: Number(p.id), name: p.name, timing: p.timing, done: !!(l && l.done), value: l ? l.value : '', is_water: isWater };
    });

  var mealLogs = findRows_('log_meals', function (r) { return r.date === date; });
  var meals = readRows_('plan_meals').sort(function (a, b) { return Number(a.meal_no) - Number(b.meal_no); }).map(function (m) {
    var logs = mealLogs.filter(function (r) { return Number(r.meal_no) === Number(m.meal_no); });
    var status = mealStatus_(logs);
    return { meal_no: Number(m.meal_no), label: m.label, status: status, items: logs.length, kcal: round1_(logs.reduce(function (a, r) { return a + (Number(r.kcal) || 0); }, 0)) };
  });

  var workoutSets = findRows_('log_workout', function (r) { return r.date === date; }).length;
  var cardio = findRows_('log_cardio', function (r) { return r.date === date; });

  return {
    date: date,
    weekday: ['日', '月', '火', '水', '木', '金', '土'][parseYmd_(date).getUTCDay()],
    unit: s.unit,
    day_no: dayNo,
    day_name: day.name,
    day_notes: day.notes || '',
    is_rest: isRest,
    day_override: !!(daily && daily.day_no_actual !== '' && daily.day_no_actual != null),
    week_no: calcWeekNo_(s.start_date, date),
    comment: daily ? daily.comment : '',
    weight: weight ? { weight_kg: Number(weight.weight_kg), body_fat_pct: weight.body_fat_pct === '' ? '' : Number(weight.body_fat_pct), time: weight.time } : null,
    prev_weight: prevWeight ? { date: prevWeight.date, weight_kg: Number(prevWeight.weight_kg) } : null,
    supplements: supplements,
    routine: routine,
    water_ml: waterMl,
    water_goal_ml: Number(s.water_goal_ml) || 5000,
    meals: meals,
    workout_sets: workoutSets,
    cardio: cardio.map(function (c) { return { type: c.type, minutes: Number(c.minutes), note: c.note }; }),
    timing_labels: TIMING_LABELS,
    days: readRows_('plan_days').map(function (d) { return { day_no: Number(d.day_no), name: d.name, is_rest: !!d.is_rest }; })
  };
}

function mealStatus_(logs) {
  if (!logs.length) return '';
  if (logs.every(function (r) { return r.status === 'skip'; })) return 'skip';
  if (logs.some(function (r) { return r.status === 'sub'; })) return 'sub';
  return 'plan';
}

function latestWeightBefore_(date) {
  var rows = findRows_('log_weight', function (r) { return r.date < date; });
  if (!rows.length) return null;
  rows.sort(function (a, b) { return a.date === b.date ? String(a.time).localeCompare(String(b.time)) : a.date.localeCompare(b.date); });
  return rows[rows.length - 1];
}

/** 体重保存（同日は上書き）。value は画面の単位。 */
function saveWeight(dateYmd, value, unit, bodyFat, note) {
  var kg = toKg_(value, unit);
  if (kg === '') throw new Error('体重が数値ではありません');
  return withLock_(function () {
    var existing = findRow_('log_weight', function (r) { return r.date === dateYmd; });
    var obj = { date: dateYmd, time: nowHm_(), weight_kg: kg, body_fat_pct: bodyFat === '' || bodyFat == null ? '' : Number(bodyFat), note: note || '' };
    if (existing) updateRow_('log_weight', existing._row, obj); else appendRow_('log_weight', obj);
    var prev = latestWeightBefore_(dateYmd);
    return { weight_kg: kg, prev_weight: prev ? { date: prev.date, weight_kg: Number(prev.weight_kg) } : null };
  });
}

function toggleSupplement(dateYmd, itemId, done) {
  return withLock_(function () {
    var ex = findRow_('log_supplements', function (r) { return r.date === dateYmd && Number(r.item_id) === Number(itemId); });
    var obj = { date: dateYmd, item_id: Number(itemId), done: !!done, time: done ? nowHm_() : '' };
    if (ex) updateRow_('log_supplements', ex._row, obj); else appendRow_('log_supplements', obj);
    return { done: !!done, time: obj.time };
  });
}

function toggleRoutine(dateYmd, itemId, done) {
  return withLock_(function () {
    var ex = findRow_('log_routine', function (r) { return r.date === dateYmd && Number(r.item_id) === Number(itemId); });
    var obj = { date: dateYmd, item_id: Number(itemId), done: !!done, value: ex ? ex.value : '' };
    if (ex) updateRow_('log_routine', ex._row, obj); else appendRow_('log_routine', obj);
    return { done: !!done };
  });
}

/** 水を ml 追加（負値で減らす）。水ルーティン行の value に累計を保存。ゴール到達で done。 */
function addWater(dateYmd, deltaMl) {
  var s = getSettings();
  var goal = Number(s.water_goal_ml) || 5000;
  var water = findRow_('plan_routine', function (r) { return /水/.test(String(r.name)); });
  if (!water) throw new Error('plan_routine に「水」の行がありません');
  return withLock_(function () {
    var ex = findRow_('log_routine', function (r) { return r.date === dateYmd && Number(r.item_id) === Number(water.id); });
    var cur = ex ? Number(ex.value) || 0 : 0;
    var next = Math.max(0, cur + Number(deltaMl));
    var obj = { date: dateYmd, item_id: Number(water.id), done: next >= goal, value: next };
    if (ex) updateRow_('log_routine', ex._row, obj); else appendRow_('log_routine', obj);
    return { water_ml: next, done: obj.done, item_id: Number(water.id) };
  });
}

/** 食事「プラン通り ✔」: default_items を log_meals に展開（既存行は置換）。 */
function mealPlanDone(dateYmd, mealNo) {
  var meal = findRow_('plan_meals', function (r) { return Number(r.meal_no) === Number(mealNo); });
  if (!meal) throw new Error('plan_meals に食事 ' + mealNo + ' がありません');
  var foods = foodMap_();
  var items = parseItemsJson_(meal.default_items);
  var rows = items.map(function (it) {
    var f = foods[it.food_id];
    if (!f) throw new Error('foods に ' + it.food_id + ' がありません');
    var m = calcMacros_(f, it.grams);
    return { date: dateYmd, meal_no: Number(mealNo), food_id: it.food_id, grams: Number(it.grams), kcal: m.kcal, p: m.p, f: m.f, c: m.c, status: 'plan', note: '' };
  });
  return withLock_(function () {
    deleteRowsWhere_('log_meals', function (r) { return r.date === dateYmd && Number(r.meal_no) === Number(mealNo); });
    appendRows_('log_meals', rows);
    return { meal_no: Number(mealNo), status: 'plan', items: rows.length, kcal: round1_(rows.reduce(function (a, r) { return a + r.kcal; }, 0)) };
  });
}

/** 食事を skip 扱いにする（1 行だけ status=skip で残す）。 */
function mealSkip(dateYmd, mealNo) {
  return withLock_(function () {
    deleteRowsWhere_('log_meals', function (r) { return r.date === dateYmd && Number(r.meal_no) === Number(mealNo); });
    appendRow_('log_meals', { date: dateYmd, meal_no: Number(mealNo), food_id: '', grams: 0, kcal: 0, p: 0, f: 0, c: 0, status: 'skip', note: '' });
    return { meal_no: Number(mealNo), status: 'skip', items: 0, kcal: 0 };
  });
}

/** Day 手動上書き（dayNo=null で自動判定に戻す）。 */
function setDayOverride(dateYmd, dayNo, isRestOverride) {
  return withLock_(function () {
    var ex = findRow_('log_daily', function (r) { return r.date === dateYmd; });
    var obj = { date: dateYmd, day_no_actual: dayNo == null || dayNo === '' ? '' : Number(dayNo), is_rest_override: isRestOverride == null ? '' : !!isRestOverride, comment: ex ? ex.comment : '' };
    if (ex) updateRow_('log_daily', ex._row, obj); else appendRow_('log_daily', obj);
    return { day_no: effectiveDayNo_(dateYmd, undefined) };
  });
}

function saveDailyComment(dateYmd, comment) {
  return withLock_(function () {
    var ex = findRow_('log_daily', function (r) { return r.date === dateYmd; });
    if (ex) updateRow_('log_daily', ex._row, { comment: comment || '' });
    else appendRow_('log_daily', { date: dateYmd, day_no_actual: '', is_rest_override: '', comment: comment || '' });
    return { ok: true };
  });
}

function saveUnit(unit) {
  if (unit !== 'kg' && unit !== 'lb') throw new Error('unit は kg か lb');
  setSetting('unit', unit);
  return { unit: unit };
}

// ===== Util.js =====
/**
 * 純粋関数群（日付・Day 判定・単位換算・set_scheme 解析）。
 * Node のテストからも読み込めるよう GAS 固有 API に依存しない。
 */

/** 'YYYY-MM-DD' → UTC 正午の Date（日付演算用、TZ 影響を受けない）。 */
function parseYmd_(ymd) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd).trim());
  if (!m) throw new Error('日付形式が不正です: ' + ymd);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0));
}

function ymdFromUtcDate_(d) {
  var y = d.getUTCFullYear();
  var mo = ('0' + (d.getUTCMonth() + 1)).slice(-2);
  var da = ('0' + d.getUTCDate()).slice(-2);
  return y + '-' + mo + '-' + da;
}

/** 'YYYY-MM-DD' に日数を足す。 */
function addDays_(ymd, n) {
  var d = parseYmd_(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return ymdFromUtcDate_(d);
}

/** 2 つの 'YYYY-MM-DD' の差（b - a、日数）。 */
function diffDays_(a, b) {
  return Math.round((parseYmd_(b) - parseYmd_(a)) / 86400000);
}

/** 開始日からの 7 日周期で Day1〜7 を返す。開始日前でも周期は成立させる。 */
function calcDayNo_(startYmd, dateYmd) {
  var d = diffDays_(startYmd, dateYmd);
  return ((d % 7) + 7) % 7 + 1;
}

/** 週番号（開始日を含む週が Week 1）。開始日前は 0 以下。 */
function calcWeekNo_(startYmd, dateYmd) {
  return Math.floor(diffDays_(startYmd, dateYmd) / 7) + 1;
}

/** Week N の開始日・終了日。 */
function weekRange_(startYmd, weekNo) {
  var s = addDays_(startYmd, (weekNo - 1) * 7);
  return { start: s, end: addDays_(s, 6) };
}

function round1_(n) {
  return Math.round(n * 10) / 10;
}

function kgToLb_(kg) {
  return round1_(Number(kg) / LB_TO_KG);
}

function lbToKg_(lb) {
  return round1_(Number(lb) * LB_TO_KG);
}

/** 入力値(unit)を kg に正規化。 */
function toKg_(value, unit) {
  if (value === '' || value == null) return '';
  var n = Number(value);
  if (isNaN(n)) return '';
  return unit === 'lb' ? lbToKg_(n) : round1_(n);
}

/**
 * set_scheme 記法を plan_sets 行に展開する。
 *   'WU10-12,TOP6-8,BO10-12'      → WU / TOP / BO 各 1 セット
 *   'MAIN10-12x3,DROP10-12'       → MAIN ×3 + DROP
 *   'MAIN8'                       → min=max=8
 * 戻り値: [{set_no, set_type, target_reps_min, target_reps_max}]
 */
function parseSetScheme_(scheme) {
  var out = [];
  if (!scheme) return out;
  var parts = String(scheme).split(',');
  var setNo = 1;
  parts.forEach(function (raw) {
    var p = raw.trim();
    if (!p) return;
    var m = /^([A-Za-z]+)\s*(\d+)(?:\s*-\s*(\d+))?(?:\s*x\s*(\d+))?$/i.exec(p);
    if (!m) throw new Error('set_scheme の記法が不正です: ' + p);
    var type = m[1].toUpperCase();
    var min = +m[2];
    var max = m[3] ? +m[3] : min;
    var count = m[4] ? +m[4] : 1;
    for (var i = 0; i < count; i++) {
      out.push({ set_no: setNo++, set_type: type, target_reps_min: min, target_reps_max: max });
    }
  });
  return out;
}

/** 1 行の plan_meals.default_items(JSON) を安全に配列へ。 */
function parseItemsJson_(s) {
  if (!s) return [];
  if (typeof s !== 'string') return s;
  try {
    var v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

/** 食品マスタ 1 行と量から kcal/PFC を算出。per が 100g 以外は「個数/杯数」扱い。 */
function calcMacros_(food, amount) {
  var factor = food.per === '100g' ? Number(amount) / 100 : Number(amount);
  return {
    kcal: round1_(Number(food.kcal) * factor),
    p: round1_(Number(food.p) * factor),
    f: round1_(Number(food.f) * factor),
    c: round1_(Number(food.c) * factor)
  };
}

/** 7 日移動平均。values: [{date, value}] 日付昇順。 */
function movingAverage_(values, window) {
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var from = Math.max(0, i - window + 1);
    var sum = 0, n = 0;
    for (var j = from; j <= i; j++) { sum += Number(values[j].value); n++; }
    out.push({ date: values[i].date, value: round1_(sum / n) });
  }
  return out;
}

function pct_(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 100);
}

function fmtWeight_(kg, unit) {
  if (kg === '' || kg == null || isNaN(Number(kg))) return '-';
  return unit === 'lb' ? kgToLb_(kg) + 'lb' : round1_(kg) + 'kg';
}

/** 'Sep 16–22' のような短い日付レンジ。 */
function shortRange_(startYmd, endYmd) {
  var mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var s = parseYmd_(startYmd), e = parseYmd_(endYmd);
  var a = mon[s.getUTCMonth()] + ' ' + s.getUTCDate();
  var b = (s.getUTCMonth() === e.getUTCMonth() ? '' : mon[e.getUTCMonth()] + ' ') + e.getUTCDate();
  return a + '–' + b;
}

// ===== WebApp.js =====
/** Web アプリのエントリ。 */
function doGet(e) {
  var t = typeof BUNDLED_FILES !== 'undefined'
    ? HtmlService.createTemplate(BUNDLED_FILES.Index)
    : HtmlService.createTemplateFromFile('Index');
  t.bootstrap = JSON.stringify(bootstrap_());
  return t.evaluate()
    .setTitle('Training Log')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-status-bar-style', 'black-translucent')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** 単一ファイル版（dist/Code.gs）では BUNDLED_FILES から、通常はファイルから読む。 */
function include(name) {
  if (typeof BUNDLED_FILES !== 'undefined') return BUNDLED_FILES[name];
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function bootstrap_() {
  var s = getSettings();
  return { today: todayYmd_(), unit: s.unit, start_date: s.start_date, coach_name: s.coach_name, water_goal_ml: Number(s.water_goal_ml) || 5000 };
}

/** 画面共通: 今日の日付と単位を返す（日付切替時などに使用）。 */
function getBootstrap() {
  return bootstrap_();
}

// ===== Workout.js =====
/** ③ ワークアウト画面のサーバー API。 */
function getWorkout(dateYmd) {
  var s = getSettings();
  var date = dateYmd || todayYmd_();
  var daily = findRow_('log_daily', function (r) { return r.date === date; });
  var dayNo = effectiveDayNo_(date, daily);
  var day = findRow_('plan_days', function (r) { return Number(r.day_no) === dayNo; }) || { name: 'Day ' + dayNo, is_rest: false };
  var isRest = daily && daily.is_rest_override !== '' && daily.is_rest_override != null ? !!daily.is_rest_override : !!day.is_rest;

  var exercises = readRows_('plan_exercises')
    .filter(function (e) { return Number(e.day_no) === dayNo && e.active !== false; })
    .sort(function (a, b) { return Number(a.order) - Number(b.order); });
  var planSets = readRows_('plan_sets');
  var todayLogs = findRows_('log_workout', function (r) { return r.date === date; });
  var allLogs = readRows_('log_workout');

  var result = exercises.map(function (ex) {
    var exId = Number(ex.id);
    var sets = planSets.filter(function (p) { return Number(p.exercise_id) === exId; }).sort(function (a, b) { return Number(a.set_no) - Number(b.set_no); });
    if (!sets.length) sets = parseSetScheme_(ex.set_scheme);
    var logsForEx = todayLogs.filter(function (r) { return Number(r.exercise_id) === exId; });
    var prevDate = lastDateBefore_(allLogs, exId, date);
    var prevLogs = prevDate ? allLogs.filter(function (r) { return Number(r.exercise_id) === exId && r.date === prevDate; }) : [];
    var noteRow = logsForEx.filter(function (r) { return Number(r.set_no) === 0; })[0];
    var subName = '';
    logsForEx.forEach(function (r) { var m = /^\[sub:(.+?)\]/.exec(String(r.note || '')); if (m) subName = m[1]; });
    return {
      id: exId,
      name_ja: ex.name_ja, name_en: ex.name_en, how_to: ex.how_to || '',
      video_url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(ex.video_query || ex.name_en || ex.name_ja),
      is_preexhaust: !!ex.is_preexhaust, superset_group: ex.superset_group || '',
      sub_name: subName,
      note: noteRow ? String(noteRow.note).replace(/^\[sub:.+?\]\s*/, '') : '',
      rpe: noteRow && noteRow.rpe !== '' ? Number(noteRow.rpe) : '',
      prev_date: prevDate,
      sets: sets.map(function (p) {
        var l = logsForEx.filter(function (r) { return Number(r.set_no) === Number(p.set_no); }).pop();
        var pl = prevLogs.filter(function (r) { return Number(r.set_no) === Number(p.set_no); }).pop();
        return {
          set_no: Number(p.set_no), set_type: p.set_type,
          target: p.target_reps_min === p.target_reps_max ? String(p.target_reps_min) : p.target_reps_min + '-' + p.target_reps_max,
          weight_kg: l ? l.weight_kg : '', reps: l ? l.reps : '', done: !!l,
          prev_weight_kg: pl ? pl.weight_kg : '', prev_reps: pl ? pl.reps : ''
        };
      })
    };
  });

  var cardio = findRows_('log_cardio', function (r) { return r.date === date; });
  return { date: date, unit: s.unit, day_no: dayNo, day_name: day.name, is_rest: isRest, exercises: result,
    cardio: cardio.map(function (c) { return { type: c.type, minutes: Number(c.minutes), note: c.note, _row: c._row }; }) };
}

function lastDateBefore_(logs, exId, date) {
  var best = '';
  logs.forEach(function (r) {
    if (Number(r.exercise_id) === exId && r.date < date && Number(r.set_no) > 0 && r.date > best) best = r.date;
  });
  return best || '';
}

/** 1 セット保存（同日同種目同セットは上書き）。weight は画面単位。 */
function saveSet(dateYmd, exerciseId, setNo, setType, weight, unit, reps, subName) {
  var kg = toKg_(weight, unit);
  var dayNo = effectiveDayNo_(dateYmd, undefined);
  return withLock_(function () {
    var ex = findRow_('log_workout', function (r) { return r.date === dateYmd && Number(r.exercise_id) === Number(exerciseId) && Number(r.set_no) === Number(setNo); });
    var obj = { date: dateYmd, day_no: dayNo, exercise_id: Number(exerciseId), set_no: Number(setNo), set_type: setType,
      weight_kg: kg, reps: reps === '' || reps == null ? '' : Number(reps), rpe: ex ? ex.rpe : '',
      note: subName ? '[sub:' + subName + ']' : (ex ? String(ex.note).replace(/^\[sub:.+?\]\s*/, '') : ''), created_at: nowIso_() };
    if (ex) updateRow_('log_workout', ex._row, obj); else appendRow_('log_workout', obj);
    return { weight_kg: kg, reps: obj.reps, set_no: Number(setNo) };
  });
}

function deleteSet(dateYmd, exerciseId, setNo) {
  return withLock_(function () {
    var n = deleteRowsWhere_('log_workout', function (r) { return r.date === dateYmd && Number(r.exercise_id) === Number(exerciseId) && Number(r.set_no) === Number(setNo); });
    return { deleted: n };
  });
}

/** 種目メモ / RPE / 代替種目名 は set_no=0 の行に保持する。 */
function saveExerciseMeta(dateYmd, exerciseId, note, rpe, subName) {
  var dayNo = effectiveDayNo_(dateYmd, undefined);
  return withLock_(function () {
    var ex = findRow_('log_workout', function (r) { return r.date === dateYmd && Number(r.exercise_id) === Number(exerciseId) && Number(r.set_no) === 0; });
    var noteVal = (subName ? '[sub:' + subName + '] ' : '') + (note || '');
    var obj = { date: dateYmd, day_no: dayNo, exercise_id: Number(exerciseId), set_no: 0, set_type: 'META', weight_kg: '', reps: '',
      rpe: rpe === '' || rpe == null ? '' : Number(rpe), note: noteVal, created_at: nowIso_() };
    if (ex) updateRow_('log_workout', ex._row, obj); else appendRow_('log_workout', obj);
    return { ok: true };
  });
}

function saveCardio(dateYmd, type, minutes, note) {
  if (!minutes || isNaN(Number(minutes))) throw new Error('分数を入力してください');
  return withLock_(function () {
    appendRow_('log_cardio', { date: dateYmd, type: type || 'walk', minutes: Number(minutes), note: note || '' });
    return { ok: true };
  });
}

function deleteCardio(rowIndex) {
  return withLock_(function () { deleteRow_('log_cardio', Number(rowIndex)); return { ok: true }; });
}

// ===== HTML files (Index / Styles / AppJs) =====
var BUNDLED_FILES = {
  "AppJs": "<script>\n(function () {\n  'use strict';\n  var LB = 0.45359237;\n  var S = { date: BOOT.today, unit: BOOT.unit, tab: 'today', today: null, workout: null, meals: null, media: null, summary: null, mealSel: 1 };\n  var $ = function (s, el) { return (el || document).querySelector(s); };\n  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };\n  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>\"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]; }); };\n  var r1 = function (n) { return Math.round(n * 10) / 10; };\n  var view = $('#view');\n\n  // ---- server call wrapper: 1 操作 = 1 回 ----\n  function call(fn) {\n    var args = Array.prototype.slice.call(arguments, 1);\n    return new Promise(function (resolve, reject) {\n      var runner = google.script.run.withSuccessHandler(resolve).withFailureHandler(function (e) { reject(e); });\n      runner[fn].apply(runner, args);\n    });\n  }\n  var toastT;\n  function toast(msg, err) {\n    var t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');\n    clearTimeout(toastT); toastT = setTimeout(function () { t.className = 'toast'; }, err ? 3500 : 1600);\n  }\n  function fail(e) { toast((e && e.message) || String(e), true); }\n\n  // ---- unit helpers (保存は kg、表示は unit) ----\n  function disp(kg) { if (kg === '' || kg == null || isNaN(Number(kg))) return ''; return S.unit === 'lb' ? r1(Number(kg) / LB) : r1(Number(kg)); }\n  function unitLabel() { return S.unit; }\n\n  // ---- sheet (bottom modal) ----\n  function openSheet(html) { var s = $('#sheet'); $('.sheet-body', s).innerHTML = html; s.classList.remove('hidden'); return s; }\n  function closeSheet() { $('#sheet').classList.add('hidden'); }\n  $('#sheet').addEventListener('click', function (e) { if (e.target === this) closeSheet(); });\n\n  // ---- header ----\n  function fmtDate(ymd) {\n    var d = new Date(ymd + 'T12:00:00Z');\n    var w = ['日', '月', '火', '水', '木', '金', '土'][d.getUTCDay()];\n    return (ymd === BOOT.today ? '今日 ' : '') + (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '(' + w + ')';\n  }\n  function shiftDate(n) {\n    var d = new Date(S.date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);\n    S.date = d.toISOString().slice(0, 10);\n    S.today = S.workout = S.meals = null;\n    render();\n  }\n  $('#datePrev').onclick = function () { shiftDate(-1); };\n  $('#dateNext').onclick = function () { shiftDate(1); };\n  $('#unitBtn').onclick = function () {\n    var u = S.unit === 'kg' ? 'lb' : 'kg';\n    S.unit = u; renderHeader(); render();\n    call('saveUnit', u).catch(fail);\n  };\n  function renderHeader() { $('#dateLabel').textContent = fmtDate(S.date); $('#unitBtn').textContent = S.unit; }\n\n  $$('.tabs button').forEach(function (b) { b.onclick = function () { go(b.dataset.tab); }; });\n  function go(tab, opts) { S.tab = tab; S.nav = opts || {}; render(); window.scrollTo(0, 0); }\n\n  function render() {\n    renderHeader();\n    $$('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === S.tab); });\n    ({ today: renderToday, workout: renderWorkout, meals: renderMeals, media: renderMedia, summary: renderSummary })[S.tab]();\n  }\n\n  // ======================= 今日 =======================\n  function renderToday() {\n    if (!S.today) { view.innerHTML = '<div class=\"loading\">読み込み中…</div>'; return call('getToday', S.date).then(function (d) { S.today = d; renderToday(); }).catch(fail); }\n    var d = S.today, h = '';\n    h += '<div class=\"dayhead\" id=\"dayHead\"><div><div class=\"muted\">Week ' + d.week_no + (d.day_override ? ' · 手動' : '') + '</div><div class=\"d\">Day ' + d.day_no + ' · ' + esc(d.day_name) + (d.is_rest ? ' <span class=\"rest\">休み</span>' : '') + '</div>' + (d.day_notes ? '<div class=\"muted small\">' + esc(d.day_notes) + '</div>' : '') + '</div><div class=\"muted\">変更 ›</div></div>';\n\n    // 未入力インジケータ\n    var supDone = d.supplements.filter(function (s) { return s.done; }).length;\n    var mealDone = d.meals.filter(function (m) { return m.status; }).length;\n    var ind = [\n      ['体重', !!d.weight], ['食事 ' + mealDone + '/' + d.meals.length, mealDone === d.meals.length],\n      ['サプリ ' + supDone + '/' + d.supplements.length, d.supplements.length > 0 && supDone === d.supplements.length],\n      ['筋トレ', d.is_rest ? null : d.workout_sets > 0], ['有酸素', d.cardio.length > 0]\n    ];\n    h += '<div class=\"ind\">' + ind.map(function (x) { return x[1] === null ? '' : '<span class=\"badge ' + (x[1] ? 'ok' : 'bad') + '\">' + (x[1] ? '✔ ' : '未 ') + esc(x[0]) + '</span>'; }).join('') + '</div>';\n\n    // 体重\n    var diff = d.weight && d.prev_weight ? r1(d.weight.weight_kg - d.prev_weight.weight_kg) : null;\n    var diffTxt = diff === null ? '' : (diff > 0 ? '+' : '') + disp(diff) + unitLabel() + ' <span class=\"muted\">(前回 ' + esc(d.prev_weight.date.slice(5)) + ')</span>';\n    h += '<div class=\"card\"><h2>体重</h2><div class=\"row\"><input type=\"number\" step=\"0.1\" inputmode=\"decimal\" id=\"wIn\" placeholder=\"' + unitLabel() + '\" value=\"' + (d.weight ? disp(d.weight.weight_kg) : '') + '\"><input type=\"number\" step=\"0.1\" inputmode=\"decimal\" id=\"bfIn\" placeholder=\"体脂肪%\" value=\"' + (d.weight ? d.weight.body_fat_pct : '') + '\"><button class=\"btn primary\" id=\"wSave\">保存</button></div>' +\n      '<div class=\"muted small\" style=\"margin-top:6px\" id=\"wDiff\">' + (d.weight ? '記録済 ' + esc(d.weight.time) + '　前日比 ' + (diffTxt || '-') : (d.prev_weight ? '前回 ' + disp(d.prev_weight.weight_kg) + unitLabel() + ' (' + esc(d.prev_weight.date.slice(5)) + ')' : '')) + '</div></div>';\n\n    // ボタン\n    h += '<div class=\"grid3\" style=\"margin-bottom:12px\"><button class=\"btn primary\" id=\"goWorkout\">' + (d.is_rest ? '有酸素' : '筋トレ開始') + '</button><button class=\"btn\" id=\"goCardio\">有酸素を記録</button><button class=\"btn\" id=\"goMedia\">写真・動画</button></div>';\n\n    // 水\n    var pctW = Math.min(100, Math.round(d.water_ml / d.water_goal_ml * 100));\n    h += '<div class=\"card\"><h2>水 <span id=\"waterTxt\">' + d.water_ml + ' / ' + d.water_goal_ml + ' ml</span></h2><div class=\"bar\"><div id=\"waterBar\" style=\"width:' + pctW + '%\"></div></div><div class=\"grid3\"><button class=\"btn\" data-water=\"250\">+250ml</button><button class=\"btn\" data-water=\"500\">+500ml</button><button class=\"btn\" data-water=\"-250\">−250</button></div></div>';\n\n    // ルーティン・サプリ（timing ごと）\n    var groups = {};\n    d.routine.filter(function (r) { return !r.is_water; }).forEach(function (r) { (groups[r.timing] = groups[r.timing] || []).push({ kind: 'routine', it: r }); });\n    d.supplements.forEach(function (s) { (groups[s.timing] = groups[s.timing] || []).push({ kind: 'sup', it: s }); });\n    var order = ['morning', 'pre', 'intra', 'post', 'after_meal', 'night', 'anytime'];\n    h += '<div class=\"card\"><h2>ルーティン・サプリ</h2>';\n    order.concat(Object.keys(groups).filter(function (k) { return order.indexOf(k) < 0; })).forEach(function (t) {\n      if (!groups[t]) return;\n      h += '<div class=\"timing\">' + esc(d.timing_labels[t] || t) + '</div>';\n      groups[t].forEach(function (g) {\n        var it = g.it;\n        h += '<div class=\"check' + (it.done ? ' on' : '') + '\" data-kind=\"' + g.kind + '\" data-id=\"' + it.id + '\"><div class=\"box\">' + (it.done ? '✔' : '') + '</div><div class=\"name\">' + esc(it.name) + (it.dose ? ' <span class=\"muted small\">' + esc(it.dose) + '</span>' : '') + '</div><div class=\"muted small time\">' + esc(it.time || '') + '</div></div>';\n      });\n    });\n    h += '</div>';\n\n    // 食事\n    h += '<div class=\"card\"><h2>食事</h2>';\n    d.meals.forEach(function (m) {\n      var st = m.status === 'plan' ? '<span class=\"badge ok\">プラン通り</span>' : m.status === 'sub' ? '<span class=\"badge warn\">差替え</span>' : m.status === 'skip' ? '<span class=\"badge bad\">スキップ</span>' : '<span class=\"badge\">未</span>';\n      h += '<div class=\"meal\" data-meal=\"' + m.meal_no + '\"><div class=\"grow\"><div>' + esc(m.label) + '</div><div class=\"small\">' + st + (m.kcal ? ' <span class=\"muted\">' + m.kcal + ' kcal</span>' : '') + '</div></div>' +\n        '<button class=\"btn sm ok\" data-plan=\"' + m.meal_no + '\">プラン通り ✔</button><button class=\"btn sm\" data-sub=\"' + m.meal_no + '\">差替</button><button class=\"btn sm danger\" data-skip=\"' + m.meal_no + '\">×</button></div>';\n    });\n    h += '</div>';\n\n    // 有酸素\n    h += '<div class=\"card\"><h2>有酸素</h2>' + (d.cardio.length ? d.cardio.map(function (c) { return '<div class=\"small\">' + esc(c.type) + ' ' + c.minutes + '分 ' + esc(c.note || '') + '</div>'; }).join('') : '<div class=\"muted small\">未記録</div>') + '</div>';\n\n    // コメント\n    h += '<div class=\"card\"><h2>今日のメモ</h2><textarea id=\"dayComment\" placeholder=\"体調、違和感など（週次レポートに載ります）\">' + esc(d.comment || '') + '</textarea></div>';\n    view.innerHTML = h;\n\n    // handlers\n    $('#dayHead').onclick = openDayPicker;\n    $('#wSave').onclick = function () {\n      var v = $('#wIn').value, bf = $('#bfIn').value;\n      if (!v) return toast('体重を入力', true);\n      call('saveWeight', d.date, v, S.unit, bf, '').then(function (res) { toast('体重を保存'); S.today = null; renderToday(); }).catch(fail);\n    };\n    $('#goWorkout').onclick = function () { go('workout'); };\n    $('#goCardio').onclick = function () { openCardioSheet(); };\n    $('#goMedia').onclick = function () { go('media'); };\n    $$('[data-water]').forEach(function (b) {\n      b.onclick = function () {\n        var delta = Number(b.dataset.water);\n        var next = Math.max(0, d.water_ml + delta); d.water_ml = next;\n        $('#waterTxt').textContent = next + ' / ' + d.water_goal_ml + ' ml';\n        $('#waterBar').style.width = Math.min(100, Math.round(next / d.water_goal_ml * 100)) + '%';\n        call('addWater', d.date, delta).then(function (res) { d.water_ml = res.water_ml; }).catch(function (e) { d.water_ml = next - delta; fail(e); renderToday(); });\n      };\n    });\n    $$('.check').forEach(function (el) {\n      el.onclick = function () {\n        var kind = el.dataset.kind, id = Number(el.dataset.id);\n        var list = kind === 'sup' ? d.supplements : d.routine;\n        var it = list.filter(function (x) { return x.id === id; })[0];\n        var next = !it.done; it.done = next;\n        el.classList.toggle('on', next); $('.box', el).textContent = next ? '✔' : '';\n        var hm = new Date(); var tm = ('0' + hm.getHours()).slice(-2) + ':' + ('0' + hm.getMinutes()).slice(-2);\n        if (kind === 'sup') $('.time', el).textContent = next ? tm : '';\n        call(kind === 'sup' ? 'toggleSupplement' : 'toggleRoutine', d.date, id, next).then(function (res) { if (res.time !== undefined) { it.time = res.time; $('.time', el).textContent = res.time; } })\n          .catch(function (e) { it.done = !next; el.classList.toggle('on', !next); $('.box', el).textContent = !next ? '✔' : ''; fail(e); });\n      };\n    });\n    $$('[data-plan]').forEach(function (b) { b.onclick = function () { b.disabled = true; call('mealPlanDone', d.date, Number(b.dataset.plan)).then(function () { toast('食事' + b.dataset.plan + ' プラン通り'); S.today = null; S.meals = null; renderToday(); }).catch(function (e) { b.disabled = false; fail(e); }); }; });\n    $$('[data-sub]').forEach(function (b) { b.onclick = function () { S.mealSel = Number(b.dataset.sub); go('meals'); }; });\n    $$('[data-skip]').forEach(function (b) { b.onclick = function () { if (!confirm('食事' + b.dataset.skip + ' をスキップにしますか？')) return; call('mealSkip', d.date, Number(b.dataset.skip)).then(function () { S.today = null; S.meals = null; renderToday(); }).catch(fail); }; });\n    var ta = $('#dayComment'); ta.onblur = function () { if (ta.value === (d.comment || '')) return; d.comment = ta.value; call('saveDailyComment', d.date, ta.value).then(function () { toast('メモを保存'); }).catch(fail); };\n  }\n\n  function openDayPicker() {\n    var d = S.today;\n    var h = '<h2 style=\"margin:0 0 8px\">Day を変更</h2><div class=\"muted small\" style=\"margin-bottom:8px\">予定変更で Day を入れ替えた日に使用。自動判定: Day ' + d.day_no + '</div><div class=\"grid2\">';\n    d.days.forEach(function (x) { h += '<button class=\"btn' + (x.day_no === d.day_no ? ' primary' : '') + '\" data-day=\"' + x.day_no + '\">Day ' + x.day_no + ' ' + esc(x.name) + '</button>'; });\n    h += '</div><div style=\"margin-top:12px\" class=\"row\"><button class=\"btn grow\" id=\"dayAuto\">自動判定に戻す</button><button class=\"btn grow\" id=\"restToggle\">' + (d.is_rest ? '休みを解除' : '今日を休みにする') + '</button></div>';\n    var s = openSheet(h);\n    $$('[data-day]', s).forEach(function (b) { b.onclick = function () { call('setDayOverride', d.date, Number(b.dataset.day), null).then(function () { closeSheet(); S.today = S.workout = null; render(); }).catch(fail); }; });\n    $('#dayAuto', s).onclick = function () { call('setDayOverride', d.date, null, null).then(function () { closeSheet(); S.today = S.workout = null; render(); }).catch(fail); };\n    $('#restToggle', s).onclick = function () { call('setDayOverride', d.date, d.day_override ? d.day_no : null, !d.is_rest).then(function () { closeSheet(); S.today = S.workout = null; render(); }).catch(fail); };\n  }\n\n  function openCardioSheet(after) {\n    var h = '<h2 style=\"margin:0 0 8px\">有酸素を記録</h2><label class=\"lbl\">種類</label><select id=\"cType\"><option value=\"walk\">ウォーク</option><option value=\"jog\">ジョグ</option><option value=\"stairs\">階段</option><option value=\"other\">その他</option></select><label class=\"lbl\">分数</label><input type=\"number\" inputmode=\"numeric\" id=\"cMin\" placeholder=\"分\"><label class=\"lbl\">メモ</label><input type=\"text\" id=\"cNote\"><div style=\"margin-top:12px\" class=\"row\"><button class=\"btn grow\" id=\"cSkip\">' + (after ? 'スキップ' : 'キャンセル') + '</button><button class=\"btn primary grow\" id=\"cSave\">保存</button></div>';\n    var s = openSheet(h);\n    $('#cMin', s).focus();\n    $('#cSkip', s).onclick = function () { closeSheet(); if (after) after(); };\n    $('#cSave', s).onclick = function () {\n      call('saveCardio', S.date, $('#cType', s).value, $('#cMin', s).value, $('#cNote', s).value).then(function () { toast('有酸素を保存'); closeSheet(); S.today = S.workout = null; if (after) after(); else render(); }).catch(fail);\n    };\n  }\n\n  // ======================= ワークアウト =======================\n  function renderWorkout() {\n    if (!S.workout) { view.innerHTML = '<div class=\"loading\">読み込み中…</div>'; return call('getWorkout', S.date).then(function (d) { S.workout = d; renderWorkout(); }).catch(fail); }\n    var d = S.workout, h = '';\n    h += '<div class=\"dayhead\"><div><div class=\"d\">Day ' + d.day_no + ' · ' + esc(d.day_name) + '</div><div class=\"muted small\">' + esc(d.date) + ' · 単位 ' + unitLabel() + '</div></div>' + (d.is_rest ? '<span class=\"badge warn\">休み</span>' : '<span class=\"badge\">' + d.exercises.length + ' 種目</span>') + '</div>';\n    if (d.is_rest || !d.exercises.length) {\n      h += '<div class=\"card\"><h2>有酸素</h2>' + (d.cardio.length ? d.cardio.map(function (c) { return '<div class=\"row small\" style=\"padding:4px 0\"><span class=\"grow\">' + esc(c.type) + ' ' + c.minutes + '分 ' + esc(c.note || '') + '</span><button class=\"btn sm danger\" data-delc=\"' + c._row + '\">削除</button></div>'; }).join('') : '<div class=\"muted small\">未記録</div>') + '<button class=\"btn primary block\" id=\"addCardio\" style=\"margin-top:8px\">有酸素を記録</button></div>';\n      view.innerHTML = h;\n      $('#addCardio').onclick = function () { openCardioSheet(); };\n      $$('[data-delc]').forEach(function (b) { b.onclick = function () { call('deleteCardio', Number(b.dataset.delc)).then(function () { S.workout = S.today = null; render(); }).catch(fail); }; });\n      return;\n    }\n    d.exercises.forEach(function (ex, i) {\n      h += '<div class=\"card ex' + (ex.is_preexhaust ? ' pre' : '') + (ex.superset_group ? ' ss-' + esc(ex.superset_group) : '') + '\" data-ex=\"' + ex.id + '\">';\n      h += '<div class=\"row\"><div class=\"grow\"><div class=\"title\" data-toggle=\"' + i + '\">' + (i + 1) + '. ' + esc(ex.sub_name || ex.name_ja) + (ex.sub_name ? ' <span class=\"badge warn\">代替</span>' : '') + '</div><div class=\"muted small\">' + esc(ex.name_en) + (ex.is_preexhaust ? ' · <span style=\"color:var(--pre)\">事前疲労</span>' : '') + (ex.superset_group ? ' · SS ' + esc(ex.superset_group) : '') + (ex.prev_date ? ' · 前回 ' + esc(ex.prev_date.slice(5)) : '') + '</div></div><button class=\"btn sm\" data-toggle=\"' + i + '\">ⓘ</button></div>';\n      h += '<div class=\"howto hidden\" id=\"howto' + i + '\">' + (ex.how_to ? esc(ex.how_to) + '<br>' : '') + '<a href=\"' + esc(ex.video_url) + '\" target=\"_blank\" rel=\"noopener\" style=\"color:var(--accent)\">▶ 動画で見る</a></div>';\n      ex.sets.forEach(function (st) {\n        var prev = st.prev_weight_kg !== '' ? disp(st.prev_weight_kg) + '×' + st.prev_reps : '';\n        h += '<div class=\"set' + (st.done ? ' done' : '') + '\" data-set=\"' + st.set_no + '\"><div class=\"type ' + esc(st.set_type) + '\">' + esc(st.set_type) + '</div><div class=\"target\">' + esc(st.target) + '</div><div class=\"prev' + (prev ? ' has' : '') + '\" data-pw=\"' + disp(st.prev_weight_kg) + '\" data-pr=\"' + esc(st.prev_reps) + '\">' + (prev || '—') + '</div>' +\n          '<input type=\"number\" step=\"0.5\" inputmode=\"decimal\" class=\"w\" placeholder=\"' + unitLabel() + '\" value=\"' + disp(st.weight_kg) + '\"><input type=\"number\" inputmode=\"numeric\" class=\"r\" placeholder=\"回\" value=\"' + esc(st.reps) + '\"><button class=\"ok\">' + (st.done ? '✔' : '○') + '</button></div>';\n      });\n      h += '<div class=\"row\" style=\"margin-top:8px\"><input type=\"text\" class=\"exnote\" placeholder=\"メモ（違和感など）\" value=\"' + esc(ex.note) + '\"><select class=\"rpe\" style=\"width:90px\"><option value=\"\">RPE</option>' + [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (n) { return '<option' + (ex.rpe === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select><button class=\"btn sm subbtn\">代替</button></div>';\n      h += '</div>';\n    });\n    h += '<div class=\"card\"><h2>有酸素</h2>' + (d.cardio.length ? d.cardio.map(function (c) { return '<div class=\"small\">' + esc(c.type) + ' ' + c.minutes + '分</div>'; }).join('') : '<div class=\"muted small\">完了ボタンで入力</div>') + '</div>';\n    h += '<button class=\"btn primary block\" id=\"finish\" style=\"padding:14px;font-size:17px\">完了 → 有酸素入力</button>';\n    view.innerHTML = h;\n\n    $$('[data-toggle]').forEach(function (el) { el.onclick = function () { $('#howto' + el.dataset.toggle).classList.toggle('hidden'); }; });\n    $$('.ex').forEach(function (card) {\n      var exId = Number(card.dataset.ex);\n      var ex = d.exercises.filter(function (x) { return x.id === exId; })[0];\n      $$('.set', card).forEach(function (row) {\n        var setNo = Number(row.dataset.set);\n        var st = ex.sets.filter(function (x) { return x.set_no === setNo; })[0];\n        var wIn = $('.w', row), rIn = $('.r', row), ok = $('.ok', row);\n        $('.prev', row).onclick = function () { if (this.dataset.pw === '') return; wIn.value = this.dataset.pw; rIn.value = this.dataset.pr; };\n        var save = function () {\n          if (wIn.value === '' && rIn.value === '') return toast('重量か回数を入力', true);\n          row.classList.add('done'); ok.textContent = '✔';\n          call('saveSet', d.date, exId, setNo, st.set_type, wIn.value, S.unit, rIn.value, ex.sub_name || '').then(function (res) { st.done = true; st.weight_kg = res.weight_kg; st.reps = res.reps; S.today = null; })\n            .catch(function (e) { row.classList.remove('done'); ok.textContent = '○'; fail(e); });\n        };\n        ok.onclick = function () {\n          if (row.classList.contains('done')) {\n            if (!confirm('セット ' + setNo + ' の記録を削除しますか？')) return;\n            row.classList.remove('done'); ok.textContent = '○';\n            call('deleteSet', d.date, exId, setNo).then(function () { st.done = false; }).catch(function (e) { row.classList.add('done'); ok.textContent = '✔'; fail(e); });\n          } else save();\n        };\n        rIn.onkeydown = function (e) { if (e.key === 'Enter') { rIn.blur(); save(); } };\n      });\n      var saveMeta = function () { call('saveExerciseMeta', d.date, exId, $('.exnote', card).value, $('.rpe', card).value, ex.sub_name || '').then(function () { ex.note = $('.exnote', card).value; ex.rpe = $('.rpe', card).value; }).catch(fail); };\n      $('.exnote', card).onblur = function () { if (this.value !== ex.note) saveMeta(); };\n      $('.rpe', card).onchange = saveMeta;\n      $('.subbtn', card).onclick = function () {\n        var name = prompt('代替種目名（空欄で解除）。マスタは変更しません。', ex.sub_name || '');\n        if (name === null) return;\n        ex.sub_name = name.trim();\n        call('saveExerciseMeta', d.date, exId, $('.exnote', card).value, $('.rpe', card).value, ex.sub_name).then(function () { S.workout = null; renderWorkout(); }).catch(fail);\n      };\n    });\n    $('#finish').onclick = function () { openCardioSheet(function () { S.today = null; go('today'); }); };\n  }\n\n  // ======================= 食事 =======================\n  function renderMeals() {\n    if (!S.meals) { view.innerHTML = '<div class=\"loading\">読み込み中…</div>'; return call('getMeals', S.date).then(function (d) { S.meals = d; renderMeals(); }).catch(fail); }\n    var d = S.meals, h = '';\n    var diffTag = function (k) { var x = r1(d.total[k] - d.plan_total[k]); return '<div class=\"d ' + (x > 0 ? 'plus' : x < 0 ? 'minus' : '') + '\">' + (x > 0 ? '+' : '') + x + '</div>'; };\n    h += '<div class=\"card\"><h2>1日合計 <span class=\"muted\">（差 = プラン基準比）</span></h2><div class=\"tot\">' + ['kcal', 'p', 'f', 'c'].map(function (k) { return '<div><div class=\"k\">' + k.toUpperCase() + '</div><div class=\"v\">' + d.total[k] + '</div>' + diffTag(k) + '</div>'; }).join('') + '</div><div class=\"muted small\" style=\"margin-top:6px;text-align:center\">プラン: ' + d.plan_total.kcal + ' kcal / P' + d.plan_total.p + ' F' + d.plan_total.f + ' C' + d.plan_total.c + '</div></div>';\n    h += '<div class=\"row wrap\" style=\"margin-bottom:12px\">' + d.meals.map(function (m) { return '<button class=\"chip' + (m.meal_no === S.mealSel ? ' on' : '') + '\" data-msel=\"' + m.meal_no + '\">' + m.meal_no + (m.status ? (m.status === 'plan' ? ' ✔' : m.status === 'sub' ? ' ↔' : ' ×') : '') + '</button>'; }).join('') + '</div>';\n    var m = d.meals.filter(function (x) { return x.meal_no === S.mealSel; })[0] || d.meals[0];\n    h += '<div class=\"card\"><h2>' + esc(m.label) + ' <span class=\"badge ' + (m.status === 'plan' ? 'ok' : m.status === 'sub' ? 'warn' : m.status === 'skip' ? 'bad' : '') + '\">' + (m.status || '未') + '</span></h2>';\n    if (m.items.length) m.items.forEach(function (it) { h += '<div class=\"item\"><span>' + esc(it.name) + ' <span class=\"muted\">' + it.grams + (it.per === '100g' ? 'g' : '') + '</span> <span class=\"badge ' + (it.status === 'sub' ? 'warn' : 'ok') + '\">' + it.status + '</span></span><span class=\"row\"><span class=\"muted\">' + it.kcal + ' kcal · P' + it.p + ' F' + it.f + ' C' + it.c + '</span><button class=\"btn sm danger\" data-del=\"' + it._row + '\">×</button></span></div>'; });\n    else h += '<div class=\"muted small\">記録なし。プラン: ' + m.plan_items.map(function (p) { return esc(p.name) + ' ' + p.grams + (p.per === '100g' ? 'g' : ''); }).join(' / ') + '</div>';\n    h += '<div class=\"row\" style=\"margin-top:8px\"><button class=\"btn sm ok\" id=\"mPlan\">プラン通り ✔</button><button class=\"btn sm\" id=\"mAddPlanItem\">プラン品目を1つ追加</button></div>';\n    h += '</div>';\n    // 追加\n    h += '<div class=\"card\"><h2>食品を追加（差替え・追加）</h2><input type=\"text\" id=\"fq\" placeholder=\"食品名で検索（例: 鶏、salmon）\" autocomplete=\"off\"><div class=\"foodlist\" id=\"flist\" style=\"margin-top:8px\"></div>' +\n      '<div class=\"row\" style=\"margin-top:8px\"><input type=\"number\" inputmode=\"decimal\" id=\"famt\" placeholder=\"量\" class=\"grow\"><span class=\"muted small\" id=\"funit\">g</span><select id=\"fstatus\" style=\"width:110px\"><option value=\"sub\">差替え</option><option value=\"plan\">プラン</option></select><button class=\"btn primary\" id=\"fadd\" disabled>追加</button></div>' +\n      '<div class=\"row\" style=\"margin-top:8px\"><button class=\"btn sm grow\" id=\"aiBtn\">🤖 AIで推定して foods に追加</button><button class=\"btn sm\" id=\"manualBtn\">手入力</button></div><div class=\"muted small\" style=\"margin-top:4px\">検索に無い食品は AI 推定（100g あたり、source=ai）。あとでシートで修正可。</div></div>';\n    view.innerHTML = h;\n\n    $$('[data-msel]').forEach(function (b) { b.onclick = function () { S.mealSel = Number(b.dataset.msel); renderMeals(); }; });\n    $$('[data-del]').forEach(function (b) { b.onclick = function () { call('deleteMealItem', d.date, Number(b.dataset.del)).then(function (res) { S.meals = res; S.today = null; renderMeals(); }).catch(fail); }; });\n    $('#mPlan').onclick = function () { call('mealPlanDone', d.date, m.meal_no).then(function () { S.meals = null; S.today = null; renderMeals(); }).catch(fail); };\n    $('#mAddPlanItem').onclick = function () {\n      var s = openSheet('<h2 style=\"margin:0 0 8px\">プラン品目を追加</h2>' + m.plan_items.map(function (p, i) { return '<button class=\"btn block\" style=\"margin-bottom:6px\" data-pi=\"' + i + '\">' + esc(p.name) + ' ' + p.grams + (p.per === '100g' ? 'g' : '') + '</button>'; }).join(''));\n      $$('[data-pi]', s).forEach(function (b) { b.onclick = function () { var p = m.plan_items[Number(b.dataset.pi)]; closeSheet(); call('addMealItem', d.date, m.meal_no, p.food_id, p.grams, 'plan', '').then(function (res) { S.meals = res; S.today = null; renderMeals(); }).catch(fail); }; });\n    };\n    var sel = null, q = $('#fq'), list = $('#flist'), amt = $('#famt'), addBtn = $('#fadd');\n    function drawList() {\n      var t = q.value.trim().toLowerCase();\n      var fs = d.foods.filter(function (f) { return !t || (f.name_ja + ' ' + f.name_en + ' ' + f.food_id).toLowerCase().indexOf(t) >= 0; }).slice(0, 40);\n      list.innerHTML = fs.length ? fs.map(function (f) { return '<div class=\"food' + (sel && sel.food_id === f.food_id ? ' sel' : '') + '\" data-fid=\"' + esc(f.food_id) + '\"><span>' + esc(f.name_ja) + (f.source === 'ai' ? ' <span class=\"badge\">ai</span>' : '') + '</span><span class=\"m\">' + f.kcal + 'kcal P' + f.p + ' F' + f.f + ' C' + f.c + ' /' + esc(f.per) + '</span></div>'; }).join('') : '<div class=\"food muted\">該当なし → AI で推定</div>';\n      $$('.food[data-fid]', list).forEach(function (el) { el.onclick = function () { sel = d.foods.filter(function (f) { return f.food_id === el.dataset.fid; })[0]; $('#funit').textContent = sel.per === '100g' ? 'g' : sel.per.replace('1', ''); addBtn.disabled = false; drawList(); amt.focus(); }; });\n    }\n    q.oninput = drawList; drawList();\n    addBtn.onclick = function () { if (!sel) return; call('addMealItem', d.date, m.meal_no, sel.food_id, amt.value, $('#fstatus').value, '').then(function (res) { S.meals = res; S.today = null; toast('追加しました'); renderMeals(); }).catch(fail); };\n    $('#aiBtn').onclick = function () {\n      var name = q.value.trim() || prompt('食品名'); if (!name) return;\n      $('#aiBtn').disabled = true; toast('AI 推定中…');\n      call('estimateFoodWithAi', name).then(function (f) { toast(f.name_ja + ' を追加: ' + f.kcal + 'kcal/100g'); S.meals = null; S.aiPick = f.food_id; renderMeals(); }).catch(function (e) { $('#aiBtn').disabled = false; fail(e); });\n    };\n    $('#manualBtn').onclick = function () {\n      var s = openSheet('<h2 style=\"margin:0 0 8px\">食品を手入力（100g あたり）</h2><label class=\"lbl\">名前</label><input type=\"text\" id=\"mfName\" value=\"' + esc(q.value) + '\"><div class=\"grid2\"><div><label class=\"lbl\">kcal</label><input type=\"number\" id=\"mfK\"></div><div><label class=\"lbl\">P</label><input type=\"number\" id=\"mfP\"></div><div><label class=\"lbl\">F</label><input type=\"number\" id=\"mfF\"></div><div><label class=\"lbl\">C</label><input type=\"number\" id=\"mfC\"></div></div><button class=\"btn primary block\" id=\"mfSave\" style=\"margin-top:12px\">保存</button>');\n      $('#mfSave', s).onclick = function () { call('addFood', { name_ja: $('#mfName', s).value, kcal: $('#mfK', s).value, p: $('#mfP', s).value, f: $('#mfF', s).value, c: $('#mfC', s).value, source: 'user' }).then(function (f) { closeSheet(); S.meals = null; S.aiPick = f.food_id; renderMeals(); }).catch(fail); };\n    };\n    if (S.aiPick) { sel = d.foods.filter(function (f) { return f.food_id === S.aiPick; })[0] || null; S.aiPick = null; if (sel) { q.value = sel.name_ja; addBtn.disabled = false; drawList(); } }\n  }\n\n  // ======================= メディア =======================\n  function renderMedia() {\n    if (!S.media) { view.innerHTML = '<div class=\"loading\">読み込み中…</div>'; return Promise.all([call('listMedia', 60), call('listExercisesForSelect')]).then(function (r) { S.media = { list: r[0], exercises: r[1] }; renderMedia(); }).catch(fail); }\n    var d = S.media, h = '';\n    var exOpts = '<option value=\"\">（種目なし）</option>' + d.exercises.map(function (e) { return '<option value=\"' + e.id + '\">' + esc(e.label) + '</option>'; }).join('');\n    h += '<div class=\"card\"><h2>アップロード → Drive/TrainingLog/' + esc(S.date.slice(0, 7)) + '/</h2><div class=\"row wrap\" id=\"catRow\"><button class=\"chip on\" data-cat=\"body\">body 体の変化</button><button class=\"chip\" data-cat=\"form\">form フォーム確認</button><button class=\"chip\" data-cat=\"meal\">meal</button></div>' +\n      '<label class=\"lbl\">種目（form のとき）</label><select id=\"mEx\">' + exOpts + '</select><label class=\"lbl\">メモ</label><input type=\"text\" id=\"mNote\">' +\n      '<label class=\"lbl\">ファイル（写真・動画、50MB 目安）</label><input type=\"file\" id=\"mFile\" accept=\"image/*,video/*\"><div class=\"muted small\" id=\"mProg\"></div><button class=\"btn primary block\" id=\"mUp\" style=\"margin-top:8px\">アップロード</button></div>';\n    h += '<div class=\"card\"><h2>Drive アプリで直接アップした場合（URL 登録）</h2><input type=\"url\" id=\"mUrl\" placeholder=\"https://drive.google.com/file/d/…\"><button class=\"btn block\" id=\"mUrlAdd\" style=\"margin-top:8px\">URL を登録</button></div>';\n    h += '<div class=\"card\"><h2>一覧（新しい順）</h2><div class=\"gallery\">' + d.list.map(function (m) { return '<a class=\"thumb\" href=\"' + esc(m.drive_url) + '\" target=\"_blank\" rel=\"noopener\">' + (m.thumb ? '<img src=\"' + esc(m.thumb) + '\" loading=\"lazy\" alt=\"\">' : '') + '<div class=\"cap\">' + esc(m.date.slice(5)) + ' ' + esc(m.category) + (m.type === 'video' ? ' ▶' : '') + (m.exercise ? '<br>' + esc(m.exercise) : '') + '</div><button class=\"del\" data-delm=\"' + m._row + '\">×</button></a>'; }).join('') + '</div>' + (d.list.length ? '' : '<div class=\"muted small\">まだありません</div>') + '</div>';\n    view.innerHTML = h;\n    var cat = 'body';\n    $$('[data-cat]').forEach(function (b) { b.onclick = function () { cat = b.dataset.cat; $$('[data-cat]').forEach(function (x) { x.classList.toggle('on', x === b); }); }; });\n    $('#mUp').onclick = function () {\n      var f = $('#mFile').files[0]; if (!f) return toast('ファイルを選択', true);\n      if (f.size > 50 * 1024 * 1024) return toast('50MB を超えています。Drive アプリで直接アップして URL を登録してください', true);\n      $('#mUp').disabled = true; $('#mProg').textContent = '読み込み中… (' + Math.round(f.size / 1024 / 1024 * 10) / 10 + 'MB)';\n      var reader = new FileReader();\n      reader.onload = function () {\n        var b64 = String(reader.result).split(',')[1];\n        $('#mProg').textContent = 'アップロード中…';\n        call('uploadMedia', b64, f.type || 'application/octet-stream', f.name, { date: S.date, category: cat, exercise_id: $('#mEx').value, note: $('#mNote').value })\n          .then(function () { toast('アップロード完了'); S.media = null; renderMedia(); }).catch(function (e) { $('#mUp').disabled = false; $('#mProg').textContent = ''; fail(e); });\n      };\n      reader.readAsDataURL(f);\n    };\n    $('#mUrlAdd').onclick = function () { call('addMediaUrl', { date: S.date, drive_url: $('#mUrl').value, category: cat, exercise_id: $('#mEx').value, note: $('#mNote').value, type: 'video' }).then(function () { toast('登録しました'); S.media = null; renderMedia(); }).catch(fail); };\n    $$('[data-delm]').forEach(function (b) { b.onclick = function (e) { e.preventDefault(); e.stopPropagation(); if (!confirm('一覧から削除しますか？（Drive のファイルは残ります）')) return; call('deleteMedia', Number(b.dataset.delm)).then(function () { S.media = null; renderMedia(); }).catch(fail); }; });\n  }\n\n  // ======================= サマリー =======================\n  function renderSummary() {\n    if (!S.summary) { view.innerHTML = '<div class=\"loading\">読み込み中…</div>'; return call('getSummary', S.summaryWeek || null).then(function (d) { S.summary = d; S.summaryWeek = d.week_no; renderSummary(); }).catch(fail); }\n    var d = S.summary, a = d.adherence, h = '';\n    h += '<div class=\"dayhead\"><button class=\"icon\" id=\"wkPrev\">‹</button><div style=\"text-align:center\"><div class=\"d\">Week ' + d.week_no + '</div><div class=\"muted small\">' + esc(d.range.start) + ' 〜 ' + esc(d.range.end) + '</div></div><button class=\"icon\" id=\"wkNext\">›</button></div>';\n    var cell = function (k, v, den) { return '<div><div class=\"k\">' + k + '</div><div class=\"v\">' + v + (den != null ? '<span class=\"muted small\">/' + den + '</span>' : '') + '</div></div>'; };\n    h += '<div class=\"card\"><h2>週の遵守率（' + a.days_elapsed + ' 日経過）</h2><div class=\"tot\">' + cell('筋トレ', a.workouts.done, a.workouts.planned) + cell('有酸素', a.cardio.done, a.cardio.planned) + cell('食事', a.meals.on_plan, a.meals.planned) + cell('サプリ', a.supplements.pct + '%') + '</div><div class=\"muted small\" style=\"margin-top:6px;text-align:center\">水 ' + a.water.ok + '/' + a.water.days + ' 日達成 · 差替え ' + a.meals.subs + ' · スキップ ' + a.meals.skips + '</div></div>';\n    h += '<div class=\"card\"><h2>体重推移 <span class=\"muted\">（点線 = 7日移動平均）</span></h2>' + lineChart(d.weights.map(function (w) { return { x: w.date, y: disp(w.value) }; }), d.weights_ma7.map(function (w) { return { x: w.date, y: disp(w.value) }; })) + '</div>';\n    var exNames = d.top_sets.map(function (t) { return t.name; });\n    var selName = S.topSel && exNames.indexOf(S.topSel) >= 0 ? S.topSel : exNames[0];\n    var ts = d.top_sets.filter(function (t) { return t.name === selName; })[0];\n    h += '<div class=\"card\"><h2>種目別 TOP セット重量</h2>' + (exNames.length ? '<select id=\"topSel\">' + exNames.map(function (n) { return '<option' + (n === selName ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select>' + lineChart(ts.points.map(function (p) { return { x: p.date, y: disp(p.value), lbl: '×' + p.reps }; }), null) : '<div class=\"muted small\">TOP セットの記録がまだありません</div>') + '</div>';\n    h += '<div class=\"card\"><h2>週次レポート</h2><label class=\"row small\"><input type=\"checkbox\" id=\"optShare\"> 写真・動画を「リンクを知っている全員」に共有する</label><label class=\"row small\" style=\"margin-top:4px\"><input type=\"checkbox\" id=\"optMsgr\"> フォーム動画は Messenger で送った（sent via Messenger）</label><button class=\"btn primary block\" id=\"genRep\" style=\"margin-top:10px\">週次レポート生成</button><div id=\"repOut\"></div></div>';\n    view.innerHTML = h;\n    $('#wkPrev').onclick = function () { S.summaryWeek = d.week_no - 1; S.summary = null; renderSummary(); };\n    $('#wkNext').onclick = function () { S.summaryWeek = d.week_no + 1; S.summary = null; renderSummary(); };\n    var ts_ = $('#topSel'); if (ts_) ts_.onchange = function () { S.topSel = ts_.value; renderSummary(); };\n    $('#genRep').onclick = function () {\n      $('#genRep').disabled = true;\n      call('generateWeeklyReport', d.week_no, { share_links: $('#optShare').checked, form_via_messenger: $('#optMsgr').checked }).then(function (r) {\n        $('#repOut').innerHTML = '<pre class=\"report\" id=\"repText\">' + esc(r.text) + '</pre><button class=\"btn ok block\" id=\"copyRep\">コピー（Messenger に貼る）</button>';\n        $('#copyRep').onclick = function () {\n          var txt = r.text;\n          (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(function () { toast('コピーしました'); }).catch(function () {\n            var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('コピーしました');\n          });\n        };\n        $('#genRep').disabled = false;\n      }).catch(function (e) { $('#genRep').disabled = false; fail(e); });\n    };\n  }\n\n  /** 依存なしの簡易折れ線 SVG。s1: [{x:date,y}], s2: 任意（移動平均）。 */\n  function lineChart(s1, s2) {\n    if (!s1.length) return '<div class=\"muted small\">データなし</div>';\n    var W = 600, H = 180, L = 36, R = 8, T = 10, B = 22;\n    var ys = s1.map(function (p) { return p.y; }).concat(s2 ? s2.map(function (p) { return p.y; }) : []);\n    var mn = Math.min.apply(null, ys), mx = Math.max.apply(null, ys);\n    if (mx === mn) { mx += 1; mn -= 1; }\n    var pad = (mx - mn) * 0.1; mn -= pad; mx += pad;\n    var n = s1.length;\n    var X = function (i) { return L + (n === 1 ? (W - L - R) / 2 : (W - L - R) * i / (n - 1)); };\n    var Y = function (v) { return T + (H - T - B) * (1 - (v - mn) / (mx - mn)); };\n    var path = function (s) { return s.map(function (p, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(p.y).toFixed(1); }).join(' '); };\n    var h = '<svg class=\"chart\" viewBox=\"0 0 ' + W + ' ' + H + '\" preserveAspectRatio=\"none\">';\n    [0, 0.5, 1].forEach(function (f) { var v = mn + (mx - mn) * f; h += '<line class=\"axis\" x1=\"' + L + '\" x2=\"' + (W - R) + '\" y1=\"' + Y(v) + '\" y2=\"' + Y(v) + '\"/><text class=\"lbl\" x=\"2\" y=\"' + (Y(v) + 3) + '\">' + r1(v) + '</text>'; });\n    if (s2) h += '<path class=\"l2\" d=\"' + path(s2) + '\"/>';\n    h += '<path class=\"l1\" d=\"' + path(s1) + '\"/>';\n    s1.forEach(function (p, i) { h += '<circle class=\"pt\" r=\"3\" cx=\"' + X(i) + '\" cy=\"' + Y(p.y) + '\"><title>' + esc(p.x) + ' ' + p.y + (p.lbl || '') + '</title></circle>'; });\n    var step = Math.max(1, Math.ceil(n / 6));\n    s1.forEach(function (p, i) { if (i % step === 0 || i === n - 1) h += '<text class=\"lbl\" x=\"' + X(i) + '\" y=\"' + (H - 6) + '\" text-anchor=\"middle\">' + esc(p.x.slice(5)) + '</text>'; });\n    return h + '</svg>';\n  }\n\n  render();\n})();\n</script>\n",
  "Index": "<!DOCTYPE html>\n<html lang=\"ja\">\n<head>\n  <meta charset=\"utf-8\">\n  <base target=\"_top\">\n  <title>Training Log</title>\n  <?!= include('Styles') ?>\n</head>\n<body>\n  <header class=\"top\">\n    <button class=\"icon\" id=\"datePrev\" aria-label=\"前日\">‹</button>\n    <div class=\"date\" id=\"dateLabel\"></div>\n    <button class=\"icon\" id=\"dateNext\" aria-label=\"翌日\">›</button>\n    <button class=\"chip\" id=\"unitBtn\"></button>\n  </header>\n\n  <main id=\"view\"><div class=\"loading\">読み込み中…</div></main>\n\n  <nav class=\"tabs\">\n    <button data-tab=\"today\">今日</button>\n    <button data-tab=\"workout\">トレ</button>\n    <button data-tab=\"meals\">食事</button>\n    <button data-tab=\"media\">写真</button>\n    <button data-tab=\"summary\">まとめ</button>\n  </nav>\n\n  <div id=\"toast\" class=\"toast\"></div>\n  <div id=\"sheet\" class=\"sheet hidden\"><div class=\"sheet-body\"></div></div>\n\n  <script>window.BOOT = <?!= bootstrap ?>;</script>\n  <?!= include('AppJs') ?>\n</body>\n</html>\n",
  "Styles": "<style>\n  :root {\n    --bg: #0f1115; --card: #181b22; --card2: #1f232c; --line: #2a2f3a; --text: #e8eaf0; --muted: #8b93a5;\n    --accent: #4f8cff; --ok: #35c46a; --warn: #f0b429; --bad: #ff5c5c; --pre: #f0b429;\n    --ss-a: #4f8cff; --ss-b: #b06cff; --ss-c: #35c46a; --ss-d: #ff8c42;\n    --radius: 12px; --safe-b: env(safe-area-inset-bottom, 0px);\n  }\n  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }\n  html, body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.45 -apple-system, BlinkMacSystemFont, \"Helvetica Neue\", \"Hiragino Sans\", \"Noto Sans JP\", sans-serif; }\n  body { padding-bottom: calc(64px + var(--safe-b)); }\n  button, input, select, textarea { font: inherit; color: inherit; }\n  button { cursor: pointer; }\n  .top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 6px; padding: 10px 12px; background: rgba(15,17,21,.95); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }\n  .top .date { flex: 1; text-align: center; font-weight: 600; }\n  .icon { background: none; border: 0; font-size: 26px; line-height: 1; padding: 0 10px; color: var(--text); }\n  .chip { background: var(--card2); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; font-size: 13px; color: var(--text); }\n  .chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }\n  main { padding: 12px; max-width: 640px; margin: 0 auto; }\n  .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; margin-bottom: 12px; }\n  .card h2 { margin: 0 0 8px; font-size: 15px; color: var(--muted); font-weight: 600; letter-spacing: .02em; }\n  .row { display: flex; align-items: center; gap: 8px; }\n  .row.wrap { flex-wrap: wrap; }\n  .grow { flex: 1; min-width: 0; }\n  .muted { color: var(--muted); font-size: 13px; }\n  .small { font-size: 13px; }\n  .big { font-size: 22px; font-weight: 700; }\n  input[type=number], input[type=text], input[type=url], select, textarea { width: 100%; background: var(--card2); border: 1px solid var(--line); border-radius: 8px; padding: 10px; color: var(--text); }\n  input[type=number] { text-align: center; }\n  textarea { min-height: 64px; resize: vertical; }\n  .btn { background: var(--card2); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; color: var(--text); white-space: nowrap; }\n  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }\n  .btn.ok { background: var(--ok); border-color: var(--ok); color: #0b1f12; font-weight: 600; }\n  .btn.danger { color: var(--bad); }\n  .btn.sm { padding: 6px 10px; font-size: 13px; border-radius: 8px; }\n  .btn.block { width: 100%; text-align: center; }\n  .btn:disabled { opacity: .5; }\n  .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }\n  .grid2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }\n  .dayhead { display: flex; align-items: center; justify-content: space-between; padding: 12px; border-radius: var(--radius); background: linear-gradient(135deg, #1d2a4a, #182033); border: 1px solid #2c3b63; margin-bottom: 12px; }\n  .dayhead .d { font-size: 20px; font-weight: 700; }\n  .dayhead .rest { color: var(--warn); }\n  .badge { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--card2); border: 1px solid var(--line); color: var(--muted); }\n  .badge.ok { background: rgba(53,196,106,.15); color: var(--ok); border-color: rgba(53,196,106,.4); }\n  .badge.warn { background: rgba(240,180,41,.15); color: var(--warn); border-color: rgba(240,180,41,.4); }\n  .badge.bad { background: rgba(255,92,92,.12); color: var(--bad); border-color: rgba(255,92,92,.4); }\n  .ind { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }\n  .check { display: flex; align-items: center; gap: 10px; padding: 10px 4px; border-bottom: 1px solid var(--line); }\n  .check:last-child { border-bottom: 0; }\n  .check .box { width: 28px; height: 28px; border-radius: 8px; border: 2px solid var(--line); display: flex; align-items: center; justify-content: center; font-size: 18px; flex: none; }\n  .check.on .box { background: var(--ok); border-color: var(--ok); color: #0b1f12; }\n  .check.on .name { color: var(--muted); text-decoration: line-through; }\n  .check .name { flex: 1; }\n  .timing { font-size: 12px; color: var(--muted); margin: 8px 0 2px; text-transform: uppercase; letter-spacing: .06em; }\n  .bar { height: 10px; background: var(--card2); border-radius: 999px; overflow: hidden; margin: 8px 0; }\n  .bar > div { height: 100%; background: var(--accent); transition: width .3s; }\n  .meal { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--line); }\n  .meal:last-child { border-bottom: 0; }\n  /* workout */\n  .ex { border-left: 4px solid transparent; }\n  .ex.pre { background: linear-gradient(90deg, rgba(240,180,41,.18), var(--card) 40%); }\n  .ex.ss-A { border-left-color: var(--ss-a); } .ex.ss-B { border-left-color: var(--ss-b); }\n  .ex.ss-C { border-left-color: var(--ss-c); } .ex.ss-D { border-left-color: var(--ss-d); }\n  .ex .title { font-weight: 700; font-size: 17px; }\n  .ex .howto { margin: 8px 0; padding: 10px; background: var(--card2); border-radius: 8px; font-size: 14px; }\n  .set { display: grid; grid-template-columns: 44px 44px 1fr 68px 60px 40px; gap: 6px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line); }\n  .set:last-of-type { border-bottom: 0; }\n  .set .type { font-size: 12px; font-weight: 700; color: var(--muted); }\n  .set .type.TOP { color: var(--warn); } .set .type.DROP { color: var(--bad); }\n  .set .target { font-size: 13px; color: var(--muted); }\n  .set .prev { font-size: 12px; color: var(--muted); text-align: right; opacity: .8; }\n  .set .prev.has { text-decoration: underline dotted; cursor: pointer; }\n  .set input { padding: 8px 4px; }\n  .set .ok { width: 40px; height: 40px; border-radius: 8px; border: 1px solid var(--line); background: var(--card2); font-size: 18px; }\n  .set.done .ok { background: var(--ok); border-color: var(--ok); color: #0b1f12; }\n  .set.done input { color: var(--muted); }\n  /* meals */\n  .foodlist { max-height: 240px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }\n  .food { padding: 8px 10px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: 8px; }\n  .food:last-child { border-bottom: 0; }\n  .food.sel { background: rgba(79,140,255,.18); }\n  .food .m { color: var(--muted); font-size: 12px; white-space: nowrap; }\n  .item { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 14px; }\n  .item:last-child { border-bottom: 0; }\n  .item.plan { color: var(--muted); }\n  .tot { display: grid; grid-template-columns: repeat(4, 1fr); text-align: center; gap: 6px; }\n  .tot .k { font-size: 12px; color: var(--muted); }\n  .tot .v { font-size: 18px; font-weight: 700; }\n  .tot .d { font-size: 12px; }\n  .d.plus { color: var(--warn); } .d.minus { color: var(--accent); }\n  /* media */\n  .gallery { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }\n  .thumb { position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: var(--card2); display: block; }\n  .thumb img { width: 100%; height: 100%; object-fit: cover; }\n  .thumb .cap { position: absolute; left: 0; right: 0; bottom: 0; font-size: 11px; padding: 2px 6px; background: rgba(0,0,0,.6); }\n  .thumb .del { position: absolute; top: 2px; right: 2px; background: rgba(0,0,0,.6); border: 0; color: #fff; border-radius: 6px; font-size: 12px; padding: 2px 6px; }\n  /* summary */\n  svg.chart { width: 100%; height: 180px; display: block; }\n  .chart .axis { stroke: var(--line); stroke-width: 1; }\n  .chart .lbl { fill: var(--muted); font-size: 10px; }\n  .chart .l1 { fill: none; stroke: var(--accent); stroke-width: 2; }\n  .chart .l2 { fill: none; stroke: var(--warn); stroke-width: 2; stroke-dasharray: 4 3; }\n  .chart .pt { fill: var(--accent); }\n  pre.report { white-space: pre-wrap; background: var(--card2); border-radius: 8px; padding: 10px; font-size: 13px; font-family: inherit; user-select: all; }\n  /* nav */\n  .tabs { position: fixed; left: 0; right: 0; bottom: 0; display: flex; background: rgba(15,17,21,.97); border-top: 1px solid var(--line); padding-bottom: var(--safe-b); z-index: 5; }\n  .tabs button { flex: 1; background: none; border: 0; padding: 12px 0 10px; color: var(--muted); font-size: 13px; font-weight: 600; }\n  .tabs button.on { color: var(--accent); }\n  .toast { position: fixed; left: 50%; bottom: calc(80px + var(--safe-b)); transform: translateX(-50%) translateY(20px); background: #2a2f3a; color: #fff; padding: 10px 16px; border-radius: 10px; font-size: 14px; opacity: 0; transition: .2s; pointer-events: none; z-index: 20; max-width: 90vw; }\n  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }\n  .toast.err { background: var(--bad); }\n  .sheet { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 10; display: flex; align-items: flex-end; }\n  .sheet.hidden { display: none; }\n  .sheet-body { background: var(--card); width: 100%; max-height: 85vh; overflow: auto; border-radius: 16px 16px 0 0; padding: 16px 16px calc(16px + var(--safe-b)); }\n  .loading { text-align: center; color: var(--muted); padding: 40px; }\n  .hidden { display: none !important; }\n  label.lbl { display: block; font-size: 12px; color: var(--muted); margin: 8px 0 4px; }\n</style>\n"
};
