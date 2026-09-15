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
