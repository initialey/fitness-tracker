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
  ai_model: 'claude-sonnet-4-6',
  // 1 日の流れのテンプレ時刻（実績時刻で上書き表示）
  time_weight: '06:40',
  time_morning: '06:45',
  time_meal1: '07:00',
  time_after_meal: '07:15',
  time_pre: '08:30',
  time_workout: '08:45',
  time_meal2: '10:30',
  time_meal3: '13:30',
  time_meal4: '16:30',
  time_meal5: '19:30',
  time_cardio: '21:00',
  time_night: '22:30',
  // タイマー（分）: 朝ルーティン→1食目、食後サプリ→食後ルーティン（サイリウム）
  timer_morning_min: '15',
  timer_after_meal_min: '15',
  // 休憩タイマー（秒）
  rest_top_sec: '150',
  rest_other_sec: '90',
  // 提案重量の増分（kg）: ダンベル / バー・マシン
  inc_db_kg: '1',
  inc_bar_kg: '2'
};

/** 自由入力の略称 → food_id（foods に存在するときだけ有効）。 */
var FOOD_ALIASES = {
  '米': 'rice_cooked', 'ご飯': 'rice_cooked', 'ごはん': 'rice_cooked', '白米': 'rice_cooked', 'rice': 'rice_cooked',
  '鶏': 'chicken_cooked', '鶏肉': 'chicken_cooked', '鶏胸': 'chicken_cooked', '鶏むね': 'chicken_cooked', 'chicken': 'chicken_cooked',
  '卵': 'egg_whole', 'たまご': 'egg_whole', 'egg': 'egg_whole', '牛': 'beef_lean_cooked', '牛肉': 'beef_lean_cooked', 'beef': 'beef_lean_cooked',
  '鮭': 'salmon', 'サーモン': 'salmon', 'pb': 'peanut_butter', 'ピーナッツバター': 'peanut_butter',
  'プロテイン': 'whey', 'ホエイ': 'whey', 'whey': 'whey', '豆': 'green_beans', 'インゲン': 'green_beans', 'オイル': 'olive_oil', '油': 'olive_oil'
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
