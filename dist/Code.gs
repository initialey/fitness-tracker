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

/**
 * 自由入力の食事テキストを foods に対応付ける。無い食品は 100g あたり栄養も返させる。
 * 戻り値: [{food_id|null, name_ja, name_en, amount, kcal, p, f, c, note}]
 */
function parseMealTextWithAi_(text, foods) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('スクリプトプロパティ ANTHROPIC_API_KEY が未設定です');
  var model = getSettings().ai_model || 'claude-sonnet-4-6';
  var catalog = Object.keys(foods).map(function (k) { var f = foods[k]; return k + ' | ' + f.name_ja + ' | ' + f.name_en + ' | per ' + f.per; }).join('\n');
  var system = [
    'You map a short Japanese/English meal note to items from a food catalog.',
    'Catalog (food_id | name_ja | name_en | unit):', catalog, '',
    'Rules: numbers are grams unless the catalog unit is 1pc/1scoop (then count). Plain "米"/"rice" means cooked white rice. "鶏" means cooked chicken breast.',
    'If an item is not in the catalog, set food_id null and give typical nutrition per 100 g edible portion.',
    'Respond with ONLY a JSON array, no prose, no code fence. Each element:',
    '{"food_id":string|null,"name_ja":string,"name_en":string,"amount":number,"kcal":number,"p":number,"f":number,"c":number,"note":string}',
    'For catalog items kcal/p/f/c may be 0.'
  ].join('\n');
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: model, max_tokens: 1024, system: system, messages: [{ role: 'user', content: String(text).trim() }] }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('Claude API エラー ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  var msg = JSON.parse(res.getContentText());
  if (msg.stop_reason === 'refusal') throw new Error('Claude API が応答を拒否しました');
  var txt = (msg.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  var m = /\[[\s\S]*\]/.exec(txt);
  if (!m) throw new Error('AI 応答を解釈できません: ' + txt.slice(0, 200));
  var arr = JSON.parse(m[0]);
  if (!Array.isArray(arr) || !arr.length) throw new Error('AI 応答が空です');
  return arr.map(function (p) {
    if (p.food_id && !foods[p.food_id]) p.food_id = null;
    ['kcal', 'p', 'f', 'c', 'amount'].forEach(function (k) { p[k] = Number(p[k]) || 0; });
    if (!p.amount) throw new Error('量が読み取れません: ' + (p.name_ja || ''));
    return p;
  });
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
  return { date: date, meals: meals, total: total, plan_total: planTotal, foods: listFoods_(), quick_subs: quickSubs_(foods) };
}

/** よく使う差替え（過去の log_meals status=sub から食品×量の頻度上位）。 */
function quickSubs_(foods) {
  var count = {};
  readRows_('log_meals').forEach(function (r) {
    if (r.status !== 'sub' || !r.food_id) return;
    var k = r.food_id + '|' + r.grams;
    count[k] = (count[k] || 0) + 1;
  });
  var keys = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; }).slice(0, 4);
  var out = keys.map(function (k) {
    var parts = k.split('|'); var f = foods[parts[0]];
    return { food_id: parts[0], grams: Number(parts[1]), label: (f ? f.name_ja.replace(/[（(].*$/, '') : parts[0]) + ' ' + parts[1] + (f && f.per === '100g' ? 'g' : ''), n: count[k] };
  });
  if (!out.length) out.push({ food_id: 'salmon', grams: 150, label: 'サーモン 150g', n: 0 });
  return out;
}

/** 「半分だけ」: プラン品目を 0.5 倍で sub として記録。 */
function mealHalf(dateYmd, mealNo) {
  var meal = findRow_('plan_meals', function (r) { return Number(r.meal_no) === Number(mealNo); });
  if (!meal) throw new Error('plan_meals に食事 ' + mealNo + ' がありません');
  var foods = foodMap_();
  var rows = parseItemsJson_(meal.default_items).map(function (it) {
    var f = foods[it.food_id]; if (!f) throw new Error('foods に ' + it.food_id + ' がありません');
    var g = round1_(Number(it.grams) / 2); var m = calcMacros_(f, g);
    return { date: dateYmd, meal_no: Number(mealNo), food_id: it.food_id, grams: g, kcal: m.kcal, p: m.p, f: m.f, c: m.c, status: 'sub', note: 'half' };
  });
  return withLock_(function () {
    deleteRowsWhere_('log_meals', function (r) { return r.date === dateYmd && Number(r.meal_no) === Number(mealNo); });
    appendRows_('log_meals', rows);
    return getMeals(dateYmd);
  });
}

/**
 * 自由入力（例「サーモン150 米150」）を記録。
 * foods に一致するものはそのまま、無いものは Claude API で 100g あたり栄養を推定して foods に追加（source=ai）。
 * API キー未設定時はローカル一致だけで処理し、未知の食品はエラーにする。
 */
function logMealText(dateYmd, mealNo, text, replace) {
  if (!text || !String(text).trim()) throw new Error('食べたものを入力してください');
  var foods = foodMap_();
  var items = parseMealText_(text, foods);
  var rows = items.map(function (it) {
    var f = foods[it.food_id];
    var m = calcMacros_(f, it.amount);
    return { date: dateYmd, meal_no: Number(mealNo), food_id: it.food_id, grams: it.amount, kcal: m.kcal, p: m.p, f: m.f, c: m.c, status: 'sub', note: 'text' };
  });
  return withLock_(function () {
    if (replace) deleteRowsWhere_('log_meals', function (r) { return r.date === dateYmd && Number(r.meal_no) === Number(mealNo); });
    else deleteRowsWhere_('log_meals', function (r) { return r.date === dateYmd && Number(r.meal_no) === Number(mealNo) && r.status === 'skip'; });
    appendRows_('log_meals', rows);
    return getMeals(dateYmd);
  });
}

/** テキスト → [{food_id, amount}]。foods は追加されることがある（引数のマップも更新）。 */
function parseMealText_(text, foods) {
  var tokens = tokenizeMealText_(text);
  var unknown = tokens.filter(function (t) { return !matchFood_(t.name, foods); });
  if (unknown.length) {
    if (!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY')) {
      throw new Error('foods に無い食品: ' + unknown.map(function (u) { return u.name; }).join(', ') + '（ANTHROPIC_API_KEY を設定すると AI で推定します）');
    }
    var parsed = parseMealTextWithAi_(text, foods);
    parsed.forEach(function (p) {
      if (!p.food_id) {
        var row = addFood({ name_ja: p.name_ja, name_en: p.name_en, per: '100g', kcal: p.kcal, p: p.p, f: p.f, c: p.c, source: 'ai', note: p.note || '' });
        foods[row.food_id] = row; p.food_id = row.food_id;
      }
    });
    return parsed.map(function (p) { return { food_id: p.food_id, amount: Number(p.amount) }; });
  }
  return tokens.map(function (t) { return { food_id: matchFood_(t.name, foods).food_id, amount: t.amount }; });
}

/** 「サーモン150 米150g, 卵2個」→ [{name, amount}] */
function tokenizeMealText_(text) {
  var out = [];
  var re = /([^\s,、，0-9０-９]+)\s*([0-9０-９]+(?:[.．][0-9０-９]+)?)\s*(g|グラム|個|枚|杯|scoop)?/g;
  var norm = String(text).replace(/[０-９．]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  var m;
  while ((m = re.exec(norm))) out.push({ name: m[1].trim(), amount: Number(m[2]) });
  if (!out.length) throw new Error('「食品名 量」の形式で入力してください（例: サーモン150 米150）');
  return out;
}

/** 食品名の一致: 完全一致 → 名前先頭一致 → 部分一致（短い名前を優先）。 */
function matchFood_(name, foods) {
  var q = String(name).toLowerCase();
  if (FOOD_ALIASES[q] && foods[FOOD_ALIASES[q]]) return foods[FOOD_ALIASES[q]];
  var list = Object.keys(foods).map(function (k) { return foods[k]; });
  var norm = function (s) { return String(s || '').toLowerCase().replace(/[（(].*?[）)]/g, ''); };
  var exact = list.filter(function (f) { return norm(f.name_ja) === q || norm(f.name_en) === q || String(f.food_id) === q; });
  if (exact.length) return exact[0];
  var pre = list.filter(function (f) { return norm(f.name_ja).indexOf(q) === 0 || norm(f.name_en).indexOf(q) === 0; });
  if (pre.length) return pre.sort(function (a, b) { return norm(a.name_ja).length - norm(b.name_ja).length; })[0];
  var part = list.filter(function (f) { return norm(f.name_ja).indexOf(q) >= 0 || norm(f.name_en).indexOf(q) >= 0; });
  if (part.length) return part.sort(function (a, b) { return norm(a.name_ja).length - norm(b.name_ja).length; })[0];
  return null;
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
    { meal_no: 1, label: '1食目', default_items: j([{ food_id: 'egg_whole', grams: 100 }, { food_id: 'egg_white', grams: 200 }, { food_id: 'rice_cooked', grams: 150 }]) },
    { meal_no: 2, label: '2食目', default_items: j([{ food_id: 'chicken_cooked', grams: 150 }, { food_id: 'rice_cooked', grams: 200 }, { food_id: 'green_beans', grams: 100 }, { food_id: 'olive_oil', grams: 5 }]) },
    { meal_no: 3, label: '3食目', default_items: j([{ food_id: 'whey', grams: 1 }, { food_id: 'rice_flour', grams: 50 }, { food_id: 'peanut_butter', grams: 15 }]) },
    { meal_no: 4, label: '4食目', default_items: j([{ food_id: 'beef_lean_cooked', grams: 150 }, { food_id: 'rice_cooked', grams: 200 }, { food_id: 'broccoli', grams: 100 }, { food_id: 'gummy', grams: 30 }]) },
    { meal_no: 5, label: '5食目', default_items: j([{ food_id: 'salmon', grams: 150 }, { food_id: 'broccoli', grams: 100 }, { food_id: 'olive_oil', grams: 5 }]) }
  ];
}

function seedPlanSupplements_() {
  var rows = [
    // 食後（1食目のあと）7 種 → 15 分後にサイリウム
    [1, 'マルチビタミン', 'after_meal'], [2, 'ビタミンD', 'after_meal'], [3, 'ビタミンC', 'after_meal'],
    [4, 'フィッシュオイル', 'after_meal'], [5, '亜鉛', 'after_meal'], [6, 'プロバイオティクス', 'after_meal'], [7, 'グルタミン', 'after_meal'],
    [8, 'クレアチン', 'pre'], [9, 'EAA', 'intra'], [10, 'マグネシウム', 'night']
  ];
  return rows.map(function (r, i) { return { id: r[0], name: r[1], dose: '', timing: r[2], order: i + 1, active: true }; });
}

function seedPlanRoutine_() {
  return [
    { id: 1, name: 'リンゴ酢 ＋ 水500ml', timing: 'morning', order: 1, active: true },
    { id: 2, name: 'サイリウム', timing: 'after_meal', order: 2, active: true },
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

  var todayW = wmap[today] === undefined ? null : wmap[today];
  var startW = weights.length ? weights[0].value : null;
  var waterRow = findRow_('log_routine', function (r) { return r.date === today && /^水/.test(String((findRow_('plan_routine', function (p) { return Number(p.id) === Number(r.item_id); }) || {}).name)); });
  var media = findRows_('log_media', function (r) { return r.date >= range.start && r.date <= range.end; })
    .map(function (r) { return { date: r.date, category: r.category, type: r.type, drive_url: r.drive_url, note: r.note }; });
  return {
    unit: s.unit, week_no: wk, current_week: curWeek, range: range,
    weights: weights, weights_ma7: ma, top_sets: topSeries,
    today_weight: todayW, start_weight: startW,
    water_today_ml: waterRow ? Number(waterRow.value) || 0 : 0, water_goal_ml: Number(s.water_goal_ml) || 5000,
    media: media,
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
  var waterId = (findRow_('plan_routine', function (r) { return /^水/.test(String(r.name)); }) || {}).id;
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

// ===== Timeline.js =====
/**
 * 1 日の流れ（タイムライン）と「いま」カードを生成する。
 * 時刻は settings の time_* テンプレ、完了済みは実績時刻で上書き。
 * タイマー: 朝ルーティン完了 → timer_morning_min 後に 1 食目、食後サプリ完了 → timer_after_meal_min 後に食後ルーティン。
 */
function hmToMin_(hm) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

function minToHm_(min) {
  min = ((min % 1440) + 1440) % 1440;
  return ('0' + Math.floor(min / 60)).slice(-2) + ':' + ('0' + (min % 60)).slice(-2);
}

function latestTime_(items) {
  var t = '';
  items.forEach(function (it) { if (it.time && it.time > t) t = it.time; });
  return t;
}

/** today: getToday() が組み立てた中間データ。 */
function buildTimeline_(s, today, workoutInfo) {
  var steps = [];
  var mealLabel = function (m) {
    var items = (m.plan_items || []).map(function (p) { return p.short; }).join('・');
    return m.label + (items ? '　' + items : '');
  };
  var suppGroup = function (timing, name, time) {
    var items = today.supplements.filter(function (x) { return x.timing === timing; });
    if (!items.length) return null;
    var done = items.every(function (x) { return x.done; });
    return { id: 'supp:' + timing, kind: 'supp_group', name: name || ('サプリ ' + items.length + '種'), time: time, done: done,
      actual_time: done ? latestTime_(items) : '', value: items.length + '種', items: items.map(function (x) { return { id: x.id, name: x.name, dose: x.dose, done: x.done }; }) };
  };
  var routineSteps = function (timing, time) {
    return today.routine.filter(function (x) { return x.timing === timing && !x.is_water; }).map(function (x) {
      return { id: 'routine:' + x.id, kind: 'routine', item_id: x.id, name: x.name, time: time, done: x.done, actual_time: x.done && /^\d\d:\d\d$/.test(x.time || '') ? x.time : '', value: '' };
    });
  };
  var mealStep = function (n) {
    var m = today.meals.filter(function (x) { return x.meal_no === n; })[0];
    if (!m) return null;
    return { id: 'meal:' + n, kind: 'meal', meal_no: n, name: mealLabel(m), time: s['time_meal' + n] || '', done: !!m.status,
      actual_time: '', value: m.status ? (m.status === 'skip' ? 'skip' : m.kcal + ' kcal') : (m.plan_kcal ? '約 ' + Math.round(m.plan_kcal) + ' kcal' : ''), status: m.status };
  };

  // 体重
  steps.push({ id: 'weight', kind: 'weight', name: '体重', time: s.time_weight, done: !!today.weight,
    actual_time: today.weight ? today.weight.time : '',
    value: today.weight ? fmtWeight_(today.weight.weight_kg, s.unit) + (today.prev_weight ? ' ' + deltaArrow_(today.weight.weight_kg - today.prev_weight.weight_kg, s.unit) : '') : '' });
  // 朝ルーティン → (タイマー) → 1食目
  var morning = routineSteps('morning', s.time_morning);
  morning.forEach(function (st) { steps.push(st); });
  var m1 = mealStep(1);
  if (m1) { if (morning.length) m1.after = { step: morning[morning.length - 1].id, wait_min: Number(s.timer_morning_min) || 0 }; steps.push(m1); }
  // 食後サプリ → (タイマー) → 食後ルーティン（サイリウム）
  var sg = suppGroup('after_meal', null, s.time_after_meal);
  if (sg) steps.push(sg);
  routineSteps('after_meal', s.time_after_meal).forEach(function (st) {
    if (sg) st.after = { step: sg.id, wait_min: Number(s.timer_after_meal_min) || 0 };
    steps.push(st);
  });
  // トレ前サプリ → 筋トレ → トレ中/後サプリ
  if (!today.is_rest) {
    var pre = suppGroup('pre', null, s.time_pre);
    if (pre) { pre.name = pre.items.map(function (x) { return x.name; }).join('・') + ' → 筋トレ'; steps.push(pre); }
    steps.push({ id: 'workout', kind: 'workout', name: '筋トレ Day' + today.day_no + ' ' + today.day_name, time: s.time_workout, done: workoutInfo.finished,
      actual_time: workoutInfo.finished_time || '', value: workoutInfo.exercise_count + '種目' + (workoutInfo.sets_done ? '・' + workoutInfo.sets_done + 'set' : '') });
    var intra = suppGroup('intra', null, s.time_workout); if (intra) steps.push(intra);
    var post = suppGroup('post', null, s.time_workout); if (post) steps.push(post);
  }
  [2, 3, 4, 5].forEach(function (n) { var m = mealStep(n); if (m) steps.push(m); });
  // 有酸素
  steps.push({ id: 'cardio', kind: 'cardio', name: '有酸素', time: s.time_cardio, done: today.cardio.length > 0, actual_time: '',
    value: today.cardio.length ? today.cardio.map(function (c) { return c.minutes + '分'; }).join('+') : '' });
  // 夜
  var night = suppGroup('night', null, s.time_night); if (night) steps.push(night);
  routineSteps('night', s.time_night).forEach(function (st) { steps.push(st); });
  // 水合計
  steps.push({ id: 'water', kind: 'water', name: '水 合計', time: s.time_night, done: today.water_ml >= today.water_goal_ml, actual_time: '',
    value: (today.water_ml / 1000).toFixed(1) + ' / ' + (today.water_goal_ml / 1000) + ' L' });

  // 表示時刻とタイマー解決
  var byId = {};
  steps.forEach(function (st) { byId[st.id] = st; });
  steps.forEach(function (st) {
    st.timer_until = '';
    if (st.done && st.actual_time) st.time = st.actual_time;
    if (!st.done && st.after) {
      var prev = byId[st.after.step];
      if (prev && prev.done && prev.actual_time && st.after.wait_min > 0) {
        var until = hmToMin_(prev.actual_time) + st.after.wait_min;
        st.time = minToHm_(until);
        st.timer_until = st.time;
      }
    }
  });
  var cur = steps.filter(function (st) { return !st.done; })[0] || null;
  steps.forEach(function (st) { st.state = st.done ? 'done' : (cur && st.id === cur.id ? 'cur' : 'future'); });
  return { steps: steps, now: cur ? nowCard_(cur, today) : { kind: 'done', title: '今日は完了', sub: 'おつかれさま。明日も同じ流れで。' } };
}

function deltaArrow_(diffKg, unit) {
  var d = unit === 'lb' ? kgToLb_(diffKg) : round1_(diffKg);
  if (!d) return '±0';
  return (d > 0 ? '▲' : '▼') + Math.abs(d);
}

function nowCard_(st, today) {
  var c = { kind: st.kind, step_id: st.id, title: st.name, sub: '', button: '完了', timer_until: st.timer_until || '', time: st.time };
  switch (st.kind) {
    case 'weight': c.title = '体重を測る'; c.sub = today.prev_weight ? '前回 ' + fmtWeight_(today.prev_weight.weight_kg, today.unit) + '（' + today.prev_weight.date.slice(5) + '）' : '起床後・トイレ後に'; c.button = '保存'; break;
    case 'routine': c.button = '飲んだ'; c.sub = st.after ? '' : (st.id === 'routine:1' && today.timer_morning_min ? '飲んだら' + today.timer_morning_min + '分タイマーが始まり、1食目の合図が出ます' : ''); c.item_id = st.item_id; break;
    case 'meal': c.meal_no = st.meal_no; c.title = st.meal_no + '食目を食べる'; c.sub = st.name.replace(/^\S+\s*/, ''); c.button = 'プラン通り食べた'; c.button2 = '変更';
      if (st.timer_until) { c.title = st.meal_no + '食目まで'; c.sub = '時間になったら' + st.meal_no + '食目の内容を表示します'; c.button = '食べる画面を開く'; delete c.button2; }
      break;
    case 'supp_group': c.title = st.name; c.sub = st.items.map(function (x) { return x.name + (x.dose ? ' ' + x.dose : ''); }).join('・'); c.button = '全部飲んだ'; c.items = st.items; break;
    case 'workout': c.title = st.name; c.sub = st.value + '。前回の重量を元に提案が入っています'; c.button = '筋トレを開始'; break;
    case 'cardio': c.title = '有酸素'; c.sub = '歩き・ジョグ・階段。分数を記録'; c.button = '記録する'; break;
    case 'water': c.title = '水 合計'; c.sub = st.value; c.button = '+500ml'; c.button2 = '+250ml'; break;
  }
  if (st.timer_until && st.kind !== 'meal') { c.title = st.name + 'まで'; c.sub = '時間になったら知らせます'; }
  return c;
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
      var isWater = /^水/.test(String(p.name));
      if (isWater && l) waterMl = Number(l.value) || 0;
      return { id: Number(p.id), name: p.name, timing: p.timing, done: !!(l && l.done), value: l ? l.value : '', is_water: isWater, time: !isWater && l && l.done ? String(l.value) : '' };
    });

  var mealLogs = findRows_('log_meals', function (r) { return r.date === date; });
  var foods = foodMap_();
  var meals = readRows_('plan_meals').sort(function (a, b) { return Number(a.meal_no) - Number(b.meal_no); }).map(function (m) {
    var logs = mealLogs.filter(function (r) { return Number(r.meal_no) === Number(m.meal_no); });
    var status = mealStatus_(logs);
    var planKcal = 0;
    var planItems = parseItemsJson_(m.default_items).map(function (it) {
      var f = foods[it.food_id];
      var mac = f ? calcMacros_(f, it.grams) : { kcal: 0 };
      planKcal += mac.kcal;
      var nm = f ? String(f.name_ja).replace(/[（(].*$/, '') : it.food_id;
      return { food_id: it.food_id, name: f ? f.name_ja : it.food_id, grams: it.grams, short: nm + it.grams + (f && f.per === '100g' ? '' : '') };
    });
    return { meal_no: Number(m.meal_no), label: m.label, status: status, items: logs.length, kcal: round1_(logs.reduce(function (a, r) { return a + (Number(r.kcal) || 0); }, 0)), plan_items: planItems, plan_kcal: round1_(planKcal) };
  });

  var wLogs = findRows_('log_workout', function (r) { return r.date === date; });
  var workoutSets = wLogs.filter(function (r) { return Number(r.set_no) > 0; }).length;
  var doneMarker = wLogs.filter(function (r) { return r.set_type === 'DONE'; })[0];
  var exCount = readRows_('plan_exercises').filter(function (e) { return Number(e.day_no) === dayNo && e.active !== false; }).length;
  var cardio = findRows_('log_cardio', function (r) { return r.date === date; });

  var base = {
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
    workout_finished: !!doneMarker,
    exercise_count: exCount,
    timer_morning_min: Number(s.timer_morning_min) || 0,
    timing_labels: TIMING_LABELS,
    days: readRows_('plan_days').map(function (d) { return { day_no: Number(d.day_no), name: d.name, is_rest: !!d.is_rest }; })
  };
  var tl = buildTimeline_(s, base, { finished: !!doneMarker, finished_time: doneMarker ? String(doneMarker.created_at).slice(11, 16) : '', exercise_count: exCount, sets_done: workoutSets });
  base.timeline = tl.steps;
  base.now = tl.now;
  var nextMeal = base.meals.filter(function (m) { return !m.status; })[0];
  base.next_meal_no = nextMeal ? nextMeal.meal_no : (base.meals.length ? base.meals[base.meals.length - 1].meal_no : 1);
  return base;
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

/** サプリを timing まとめてトグル（「全部飲んだ」）。 */
function toggleSupplementGroup(dateYmd, timing, done) {
  var ids = readRows_('plan_supplements').filter(function (r) { return r.active !== false && r.timing === timing; }).map(function (r) { return Number(r.id); });
  ids.forEach(function (id) { toggleSupplement(dateYmd, id, done); });
  return { done: !!done, count: ids.length, time: done ? nowHm_() : '' };
}

function toggleRoutine(dateYmd, itemId, done) {
  return withLock_(function () {
    var ex = findRow_('log_routine', function (r) { return r.date === dateYmd && Number(r.item_id) === Number(itemId); });
    // 水以外は value に完了時刻(HH:mm)を入れる（タイマー起点に使う）
    var obj = { date: dateYmd, item_id: Number(itemId), done: !!done, value: done ? nowHm_() : '' };
    if (ex) updateRow_('log_routine', ex._row, obj); else appendRow_('log_routine', obj);
    return { done: !!done, time: obj.value };
  });
}

/** 水を ml 追加（負値で減らす）。水ルーティン行の value に累計を保存。ゴール到達で done。 */
function addWater(dateYmd, deltaMl) {
  var s = getSettings();
  var goal = Number(s.water_goal_ml) || 5000;
  var water = findRow_('plan_routine', function (r) { return /^水/.test(String(r.name)); });
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

  var incDb = Number(s.inc_db_kg) || 1, incBar = Number(s.inc_bar_kg) || 2;
  var result = exercises.map(function (ex) {
    var exId = Number(ex.id);
    var isDb = /\b(DB|dumbbell)\b/i.test(String(ex.name_en)) || /ダンベル/.test(String(ex.name_ja));
    var inc = isDb ? incDb : incBar;
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
      is_db: isDb, inc_kg: inc,
      sets: suggestSets_(sets.map(function (p) {
        var l = logsForEx.filter(function (r) { return Number(r.set_no) === Number(p.set_no); }).pop();
        var pl = prevLogs.filter(function (r) { return Number(r.set_no) === Number(p.set_no); }).pop();
        return {
          set_no: Number(p.set_no), set_type: p.set_type,
          target_min: Number(p.target_reps_min), target_max: Number(p.target_reps_max),
          target: p.target_reps_min === p.target_reps_max ? String(p.target_reps_min) : p.target_reps_min + '-' + p.target_reps_max,
          weight_kg: l ? l.weight_kg : '', reps: l ? l.reps : '', done: !!l,
          prev_weight_kg: pl ? pl.weight_kg : '', prev_reps: pl ? pl.reps : ''
        };
      }), inc)
    };
  });
  var finished = todayLogs.some(function (r) { return r.set_type === 'DONE'; });

  var cardio = findRows_('log_cardio', function (r) { return r.date === date; });
  return { date: date, unit: s.unit, day_no: dayNo, day_name: day.name, is_rest: isRest, exercises: result, finished: finished,
    rest_top_sec: Number(s.rest_top_sec) || 150, rest_other_sec: Number(s.rest_other_sec) || 90,
    cardio: cardio.map(function (c) { return { type: c.type, minutes: Number(c.minutes), note: c.note, _row: c._row }; }) };
}

/**
 * 提案重量・回数を各セットに付ける（suggest_weight_kg / suggest_reps / suggest_reason）。
 *   TOP  = 前回 TOP 重量。前回が目標上限 reps に到達していれば +inc
 *   BO   = TOP × 0.85 を 1kg 丸め（今日の TOP 実績があればそれを基準）
 *   DROP = 直前セット × 0.7
 *   WU/MAIN = 前回同セット重量（上限到達なら +inc）。WU で前回が無ければ TOP 提案の半分
 * 回数: 重量を上げたら目標下限、そうでなければ前回回数（無ければ目標下限）
 */
function suggestSets_(sets, inc) {
  var topKg = '';
  var prevSetKg = '';
  sets.forEach(function (st) {
    var w = '', reps = '', reason = '';
    var prevW = st.prev_weight_kg === '' ? '' : Number(st.prev_weight_kg);
    var prevR = st.prev_reps === '' ? '' : Number(st.prev_reps);
    var bump = st.set_type !== 'WU' && prevW !== '' && prevR !== '' && prevR >= st.target_max;
    if (st.set_type === 'TOP' || st.set_type === 'MAIN' || st.set_type === 'WU') {
      if (prevW !== '') {
        w = bump ? round1_(prevW + inc) : prevW;
        reason = bump ? '前回 ' + prevW + '×' + prevR + ' で上限到達 → +' + inc + 'kg' : '前回 ' + prevW + '×' + prevR;
      } else if (st.set_type === 'WU' && topKg !== '') {
        w = Math.round(topKg * 0.5); reason = 'TOP の半分';
      }
      reps = bump || prevR === '' ? st.target_min : prevR;
    } else if (st.set_type === 'BO') {
      var base = topKg !== '' ? topKg : (prevW !== '' ? prevW / 0.85 : '');
      if (base !== '') { w = Math.round(base * 0.85); reason = 'TOP ' + round1_(base) + 'kg × 0.85'; }
      reps = prevR !== '' && !bump ? prevR : st.target_min;
    } else if (st.set_type === 'DROP') {
      if (prevSetKg !== '') { w = Math.round(prevSetKg * 0.7); reason = '直前 ' + prevSetKg + 'kg × 0.7'; }
      reps = st.target_min;
    }
    st.suggest_weight_kg = w;
    st.suggest_reps = reps;
    st.suggest_reason = reason;
    // 次セットの基準: 今日の実績を優先
    var effective = st.weight_kg !== '' ? Number(st.weight_kg) : w;
    if (st.set_type === 'TOP' && effective !== '') topKg = effective;
    if (effective !== '') prevSetKg = effective;
  });
  return sets;
}

/** 筋トレ完了マーカー（set_no=0, set_type=DONE）。 */
function finishWorkout(dateYmd) {
  var dayNo = effectiveDayNo_(dateYmd, undefined);
  return withLock_(function () {
    var ex = findRow_('log_workout', function (r) { return r.date === dateYmd && r.set_type === 'DONE'; });
    if (!ex) appendRow_('log_workout', { date: dateYmd, day_no: dayNo, exercise_id: 0, set_no: 0, set_type: 'DONE', weight_kg: '', reps: '', rpe: '', note: '', created_at: nowIso_() });
    return { finished: true };
  });
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
  "AppJs": "<script>\n(function () {\n  'use strict';\n  var LB = 0.45359237;\n  var S = { date: BOOT.today, unit: BOOT.unit, tab: 'today', today: null, workout: null, meals: null, summary: null, mealSel: null, wk: null };\n  var $ = function (s, el) { return (el || document).querySelector(s); };\n  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };\n  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>\"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]; }); };\n  var r1 = function (n) { return Math.round(n * 10) / 10; };\n  var view = $('#view');\n  var timers = [];\n  function clearTimers() { timers.forEach(clearInterval); timers = []; }\n  function every(fn, ms) { fn(); timers.push(setInterval(fn, ms)); }\n\n  // ---- server call: 1 操作 = 1 回 ----\n  function call(fn) {\n    var args = Array.prototype.slice.call(arguments, 1);\n    return new Promise(function (resolve, reject) {\n      var runner = google.script.run.withSuccessHandler(resolve).withFailureHandler(reject);\n      runner[fn].apply(runner, args);\n    });\n  }\n  var toastT;\n  function toast(msg, err) {\n    var t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');\n    clearTimeout(toastT); toastT = setTimeout(function () { t.className = 'toast'; }, err ? 3500 : 1500);\n  }\n  function fail(e) { toast((e && e.message) || String(e), true); }\n  function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p || 200); } catch (e) { /* ignore */ } }\n\n  // ---- units: 保存は kg / 表示は unit ----\n  function disp(kg) { if (kg === '' || kg == null || isNaN(Number(kg))) return ''; return S.unit === 'lb' ? r1(Number(kg) / LB) : r1(Number(kg)); }\n  function u() { return S.unit; }\n\n  // ---- sheet ----\n  function openSheet(html) { var s = $('#sheet'); $('.sheet-body', s).innerHTML = html; s.classList.remove('hidden'); return s; }\n  function closeSheet() { $('#sheet').classList.add('hidden'); }\n  $('#sheet').addEventListener('click', function (e) { if (e.target === this) closeSheet(); });\n\n  // ---- date ----\n  var WD = ['日', '月', '火', '水', '木', '金', '土'];\n  function dObj(ymd) { return new Date(ymd + 'T12:00:00Z'); }\n  function md(ymd) { var d = dObj(ymd); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); }\n  function wd(ymd) { return WD[dObj(ymd).getUTCDay()]; }\n  function shiftDate(n) { var d = dObj(S.date); d.setUTCDate(d.getUTCDate() + n); S.date = d.toISOString().slice(0, 10); S.today = S.workout = S.meals = null; S.wk = null; S.mealSel = null; render(); }\n  function dateLine(extra) {\n    return '<p class=\"date\"><button class=\"nav\" data-shift=\"-1\">‹</button><span>' + md(S.date) + ' <b>' + wd(S.date) + '</b>' + (S.date === BOOT.today ? '' : ' <span class=\"mute\" style=\"font-size:16px\">' + (S.date < BOOT.today ? '過去' : '未来') + '</span>') + '</span><button class=\"nav\" data-shift=\"1\">›</button>' + (extra || '') + '</p>';\n  }\n  function bindDate() { $$('[data-shift]').forEach(function (b) { b.onclick = function () { shiftDate(Number(b.dataset.shift)); }; }); }\n  function nowMin() { var d = new Date(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; }\n  function hmMin(hm) { var m = /^(\\d{1,2}):(\\d{2})$/.exec(hm || ''); return m ? +m[1] * 60 + +m[2] : null; }\n  function mmss(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2); }\n\n  // ---- tabs ----\n  $$('.tabs button').forEach(function (b) { b.onclick = function () { go(b.dataset.tab); }; });\n  function go(tab) { S.tab = tab; render(); window.scrollTo(0, 0); }\n  function render() {\n    clearTimers();\n    $$('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === S.tab); });\n    ({ today: renderToday, workout: renderWorkout, meals: renderMeals, summary: renderSummary })[S.tab]();\n  }\n  function updateTabs() {\n    if (S.today) {\n      $('#tabWorkout').textContent = 'Day ' + S.today.day_no;\n      $('#tabMeals').textContent = S.today.next_meal_no + '食目';\n    }\n  }\n  function loadToday() { return call('getToday', S.date).then(function (d) { S.today = d; updateTabs(); return d; }); }\n\n  // ======================= 今日 =======================\n  function renderToday() {\n    if (!S.today) { view.innerHTML = '<div class=\"loading\">読み込み中…</div>'; return loadToday().then(renderToday).catch(fail); }\n    var d = S.today, h = '';\n    h += '<h1 class=\"tap\" id=\"dayHead\">Day ' + d.day_no + ' ・ ' + esc(d.day_name) + (d.day_notes ? '（' + esc(d.day_notes) + '）' : '') + (d.is_rest ? ' ・ 休み' : '') + (d.day_override ? ' ・ 手動' : '') + ' ›</h1>';\n    h += dateLine();\n    h += '<div class=\"now' + (d.now.kind === 'done' ? ' done' : '') + '\" id=\"now\"></div>';\n    h += '<div class=\"tl\">';\n    d.timeline.forEach(function (st) {\n      h += '<div class=\"step ' + st.state + '\" data-step=\"' + esc(st.id) + '\"><div class=\"row\"><span class=\"tm\">' + esc(st.time || '') + '</span><span class=\"nm\" data-open=\"' + esc(st.id) + '\">' + esc(st.name) + '</span><span class=\"v\">' + esc(st.value || '') + '</span><button class=\"chk' + (st.done ? ' on' : '') + '\" data-chk=\"' + esc(st.id) + '\">' + (st.done ? '✓' : '') + '</button></div></div>';\n    });\n    h += '</div>';\n    h += '<div class=\"card\" style=\"margin-top:16px\"><div class=\"ttl small mute\">今日のメモ（週次レポートに載ります）</div><textarea class=\"txt\" id=\"dayComment\" placeholder=\"体調、違和感など\">' + esc(d.comment || '') + '</textarea></div>';\n    view.innerHTML = h;\n    bindDate();\n    $('#dayHead').onclick = openDayPicker;\n    renderNow();\n    $$('[data-chk]').forEach(function (b) { b.onclick = function () { stepAction(b.dataset.chk, true); }; });\n    $$('[data-open]').forEach(function (el) { el.onclick = function () { stepAction(el.dataset.open, false); }; });\n    var ta = $('#dayComment'); ta.onblur = function () { if (ta.value === (d.comment || '')) return; d.comment = ta.value; call('saveDailyComment', d.date, ta.value).then(function () { toast('メモを保存'); }).catch(fail); };\n  }\n\n  function stepById(id) { return S.today.timeline.filter(function (s) { return s.id === id; })[0]; }\n  function refreshToday() { S.today = null; S.meals = null; return loadToday().then(function () { if (S.tab === 'today') renderToday(); }).catch(fail); }\n\n  /** タイムラインの ✔ / 名前タップ。chk=true は「その場で完了」。 */\n  function stepAction(id, chk) {\n    var st = stepById(id), d = S.today;\n    if (!st) return;\n    switch (st.kind) {\n      case 'weight': openWeightSheet(); break;\n      case 'routine': optimisticStep(st, function (next) { return call('toggleRoutine', d.date, st.item_id, next); }); break;\n      case 'supp_group':\n        if (chk) optimisticStep(st, function (next) { return call('toggleSupplementGroup', d.date, st.id.split(':')[1], next); });\n        else openSuppSheet(st); break;\n      case 'meal':\n        if (chk && !st.done) { call('mealPlanDone', d.date, st.meal_no).then(function () { toast(st.meal_no + '食目 プラン通り'); refreshToday(); }).catch(fail); }\n        else { S.mealSel = st.meal_no; go('meals'); } break;\n      case 'workout': go('workout'); break;\n      case 'cardio': openCardioSheet(); break;\n      case 'water': openWaterSheet(); break;\n    }\n  }\n  function optimisticStep(st, fn) {\n    var next = !st.done;\n    var el = $('[data-step=\"' + st.id + '\"]'), chk = $('.chk', el);\n    el.className = 'step ' + (next ? 'done' : 'future'); chk.classList.toggle('on', next); chk.textContent = next ? '✓' : '';\n    fn(next).then(function () { refreshToday(); }).catch(function (e) { fail(e); refreshToday(); });\n  }\n\n  function renderNow() {\n    var d = S.today, n = d.now, el = $('#now');\n    if (!el) return;\n    var timerLeft = null;\n    if (n.timer_until) { var t = hmMin(n.timer_until); if (t != null) timerLeft = (t - nowMin()) * 60; if (timerLeft <= 0) timerLeft = null; }\n    var h = '<div class=\"k\">' + (n.kind === 'done' ? '完了' : 'いま') + (n.time ? '<span style=\"float:right\" class=\"num\">' + esc(n.time) + '</span>' : '') + '</div>';\n    var title = n.title, sub = n.sub, btn = n.button, btn2 = n.button2;\n    if (n.kind === 'meal' && n.timer_until && timerLeft == null) { title = n.meal_no + '食目を食べる'; btn = 'プラン通り食べた'; btn2 = '変更'; var ms = stepById(n.step_id); sub = ms ? ms.name.replace(/^\\S+\\s*/, '') : ''; }\n    if (n.kind !== 'meal' && n.timer_until && timerLeft == null) { title = n.title.replace(/まで$/, ''); sub = ''; }\n    h += '<div class=\"t\">' + esc(title) + '</div>';\n    if (timerLeft != null) h += '<div class=\"timer\" id=\"nowTimer\">' + mmss(timerLeft) + '</div>';\n    if (sub) h += '<div class=\"s\">' + esc(sub) + '</div>';\n    if (n.kind === 'weight') {\n      h += '<div class=\"w-in\"><input type=\"number\" step=\"0.1\" inputmode=\"decimal\" id=\"nowW\" placeholder=\"' + (d.prev_weight ? disp(d.prev_weight.weight_kg) : '0.0') + '\"><span class=\"u\">' + u() + '</span><input type=\"number\" step=\"0.1\" inputmode=\"decimal\" id=\"nowBf\" class=\"bf\" placeholder=\"体脂肪\"><span class=\"u\">%</span></div>';\n    }\n    if (n.kind !== 'done') h += '<div class=\"btns\"><button id=\"nowBtn\">' + esc(btn) + '</button>' + (btn2 ? '<button class=\"alt\" id=\"nowBtn2\">' + esc(btn2) + '</button>' : '') + '</div>';\n    el.innerHTML = h;\n    if (timerLeft != null) {\n      every(function () { var t = hmMin(n.timer_until); var left = (t - nowMin()) * 60; var te = $('#nowTimer'); if (!te) return; if (left <= 0) { vibrate([200, 100, 200]); renderNow(); } else te.textContent = mmss(left); }, 1000);\n    }\n    var b = $('#nowBtn'), b2 = $('#nowBtn2');\n    if (!b) return;\n    b.onclick = function () {\n      switch (n.kind) {\n        case 'weight': { var v = $('#nowW').value; if (!v) return toast('体重を入力', true); b.disabled = true; call('saveWeight', d.date, v, S.unit, $('#nowBf').value, '').then(function () { toast('体重を保存'); refreshToday(); }).catch(function (e) { b.disabled = false; fail(e); }); break; }\n        case 'routine': stepAction(n.step_id, true); break;\n        case 'supp_group': stepAction(n.step_id, true); break;\n        case 'meal': if (timerLeft != null) { S.mealSel = n.meal_no; go('meals'); } else stepAction(n.step_id, true); break;\n        case 'workout': go('workout'); break;\n        case 'cardio': openCardioSheet(); break;\n        case 'water': addWater(500); break;\n      }\n    };\n    if (b2) b2.onclick = function () { if (n.kind === 'meal') { S.mealSel = n.meal_no; go('meals'); } else if (n.kind === 'water') addWater(250); };\n  }\n\n  function addWater(delta) {\n    var d = S.today; d.water_ml = Math.max(0, d.water_ml + delta);\n    var wt = $('#waterTxt'); if (wt) wt.textContent = (d.water_ml / 1000).toFixed(2) + ' / ' + (d.water_goal_ml / 1000) + ' L';\n    call('addWater', d.date, delta).then(function (res) { d.water_ml = res.water_ml; if (!$('#waterTxt')) refreshToday(); else { wt.textContent = (res.water_ml / 1000).toFixed(2) + ' / ' + (d.water_goal_ml / 1000) + ' L'; } }).catch(function (e) { fail(e); refreshToday(); });\n  }\n  function openWaterSheet() {\n    var d = S.today;\n    var s = openSheet('<h3>水</h3><div class=\"date\" style=\"margin:0 0 10px\"><span id=\"waterTxt\">' + (d.water_ml / 1000).toFixed(2) + ' / ' + (d.water_goal_ml / 1000) + ' L</span></div><div class=\"btns\"><button class=\"b-yel\" data-w=\"250\">+250ml</button><button class=\"b-yel\" data-w=\"500\">+500ml</button><button class=\"b-ghost\" data-w=\"1000\">+1L</button><button class=\"b-ghost\" data-w=\"-250\">−250</button></div><button class=\"b b-sub\" style=\"width:100%;margin-top:10px\" id=\"wClose\">閉じる</button>');\n    $$('[data-w]', s).forEach(function (b) { b.onclick = function () { addWater(Number(b.dataset.w)); }; });\n    $('#wClose', s).onclick = function () { closeSheet(); refreshToday(); };\n  }\n  function openWeightSheet() {\n    var d = S.today;\n    var s = openSheet('<h3>体重</h3><div class=\"w-in\"><input type=\"number\" step=\"0.1\" inputmode=\"decimal\" id=\"shW\" value=\"' + (d.weight ? disp(d.weight.weight_kg) : '') + '\" placeholder=\"' + (d.prev_weight ? disp(d.prev_weight.weight_kg) : '0.0') + '\"><span class=\"u\">' + u() + '</span><input type=\"number\" step=\"0.1\" inputmode=\"decimal\" id=\"shBf\" class=\"bf\" value=\"' + (d.weight ? d.weight.body_fat_pct : '') + '\" placeholder=\"体脂肪\"><span class=\"u\">%</span></div>' + (d.prev_weight ? '<div class=\"mute small\" style=\"margin-top:6px\">前回 ' + disp(d.prev_weight.weight_kg) + u() + '（' + esc(d.prev_weight.date.slice(5)) + '）</div>' : '') + '<button class=\"b b-yel\" style=\"width:100%;margin-top:12px\" id=\"shSave\">保存</button>');\n    $('#shW', s).focus();\n    $('#shSave', s).onclick = function () { var v = $('#shW', s).value; if (!v) return toast('体重を入力', true); call('saveWeight', d.date, v, S.unit, $('#shBf', s).value, '').then(function () { closeSheet(); toast('体重を保存'); refreshToday(); }).catch(fail); };\n  }\n  function openSuppSheet(st) {\n    var d = S.today;\n    var s = openSheet('<h3>' + esc(st.name) + '</h3><div class=\"list\">' + st.items.map(function (it) { return '<div class=\"it\"><span>' + esc(it.name) + (it.dose ? ' <span class=\"mute small\">' + esc(it.dose) + '</span>' : '') + '</span><button class=\"chk' + (it.done ? ' on' : '') + '\" data-sid=\"' + it.id + '\">' + (it.done ? '✓' : '') + '</button></div>'; }).join('') + '</div><div class=\"btns\" style=\"margin-top:12px\"><button class=\"b-main\" id=\"suppAll\">全部飲んだ</button><button class=\"b-sub\" id=\"suppClose\">閉じる</button></div>');\n    $$('[data-sid]', s).forEach(function (b) {\n      b.onclick = function () { var it = st.items.filter(function (x) { return x.id === Number(b.dataset.sid); })[0]; it.done = !it.done; b.classList.toggle('on', it.done); b.textContent = it.done ? '✓' : ''; call('toggleSupplement', d.date, it.id, it.done).catch(fail); };\n    });\n    $('#suppAll', s).onclick = function () { call('toggleSupplementGroup', d.date, st.id.split(':')[1], true).then(function () { closeSheet(); refreshToday(); }).catch(fail); };\n    $('#suppClose', s).onclick = function () { closeSheet(); refreshToday(); };\n  }\n  function openDayPicker() {\n    var d = S.today;\n    var h = '<h3>Day を変更</h3><div class=\"mute small\" style=\"margin-bottom:8px\">予定変更で Day を入れ替えた日に。自動判定は Day ' + d.day_no + '</div><div class=\"chips\">';\n    d.days.forEach(function (x) { h += '<button' + (x.day_no === d.day_no ? ' class=\"on\"' : '') + ' data-day=\"' + x.day_no + '\">Day ' + x.day_no + ' ' + esc(x.name) + '</button>'; });\n    h += '</div><div class=\"btns\" style=\"margin-top:12px\"><button class=\"b-sub\" id=\"dayAuto\">自動判定に戻す</button><button class=\"b-sub\" id=\"restToggle\">' + (d.is_rest ? '休みを解除' : '今日を休みにする') + '</button></div>';\n    var s = openSheet(h);\n    var done = function () { closeSheet(); S.today = S.workout = null; render(); };\n    $$('[data-day]', s).forEach(function (b) { b.onclick = function () { call('setDayOverride', d.date, Number(b.dataset.day), null).then(done).catch(fail); }; });\n    $('#dayAuto', s).onclick = function () { call('setDayOverride', d.date, null, null).then(done).catch(fail); };\n    $('#restToggle', s).onclick = function () { call('setDayOverride', d.date, d.day_override ? d.day_no : null, !d.is_rest).then(done).catch(fail); };\n  }\n  function openCardioSheet(after) {\n    var s = openSheet('<h3>有酸素を記録</h3><div class=\"chips\" id=\"cType\"><button class=\"on\" data-t=\"walk\">歩き</button><button data-t=\"jog\">ジョグ</button><button data-t=\"stairs\">階段</button><button data-t=\"other\">その他</button></div><label class=\"lbl\">分数</label><div class=\"w-in\"><input type=\"number\" inputmode=\"numeric\" id=\"cMin\" placeholder=\"40\"><span class=\"u\">分</span></div><label class=\"lbl\">メモ</label><input type=\"text\" class=\"txt\" id=\"cNote\"><div class=\"btns\" style=\"margin-top:12px\"><button class=\"b-sub\" id=\"cSkip\">' + (after ? 'あとで' : 'キャンセル') + '</button><button class=\"b-yel\" id=\"cSave\">保存</button></div>');\n    var type = 'walk';\n    $$('#cType button', s).forEach(function (b) { b.onclick = function () { type = b.dataset.t; $$('#cType button', s).forEach(function (x) { x.classList.toggle('on', x === b); }); }; });\n    $('#cMin', s).focus();\n    $('#cSkip', s).onclick = function () { closeSheet(); if (after) after(); };\n    $('#cSave', s).onclick = function () { call('saveCardio', S.date, type, $('#cMin', s).value, $('#cNote', s).value).then(function () { toast('有酸素を保存'); closeSheet(); S.today = S.workout = null; if (after) after(); else render(); }).catch(fail); };\n  }\n  function openMediaSheet(category, exerciseId, onDone) {\n    var cat = category || 'body';\n    var s = openSheet('<h3>写真・動画</h3><div class=\"chips\" id=\"mCat\"><button data-c=\"body\"' + (cat === 'body' ? ' class=\"on\"' : '') + '>body 体の変化</button><button data-c=\"form\"' + (cat === 'form' ? ' class=\"on\"' : '') + '>form フォーム</button><button data-c=\"meal\"' + (cat === 'meal' ? ' class=\"on\"' : '') + '>meal</button></div><label class=\"lbl\">ファイル（50MB 目安）</label><input type=\"file\" id=\"mFile\" accept=\"image/*,video/*\" class=\"txt\"><label class=\"lbl\">メモ</label><input type=\"text\" class=\"txt\" id=\"mNote\"><div class=\"mute small\" id=\"mProg\" style=\"margin-top:6px\"></div><button class=\"b b-yel\" style=\"width:100%;margin-top:10px\" id=\"mUp\">アップロード → Drive/TrainingLog/' + S.date.slice(0, 7) + '</button><label class=\"lbl\">大きい動画は Drive アプリで直接アップして URL を貼る</label><div class=\"row2\"><input type=\"url\" class=\"txt\" id=\"mUrl\" placeholder=\"https://drive.google.com/…\"><button class=\"b b-sub\" style=\"flex:0 0 90px\" id=\"mUrlAdd\">登録</button></div>');\n    $$('#mCat button', s).forEach(function (b) { b.onclick = function () { cat = b.dataset.c; $$('#mCat button', s).forEach(function (x) { x.classList.toggle('on', x === b); }); }; });\n    $('#mUp', s).onclick = function () {\n      var f = $('#mFile', s).files[0]; if (!f) return toast('ファイルを選択', true);\n      if (f.size > 50 * 1024 * 1024) return toast('50MB 超。Drive アプリで直接アップして URL を登録してください', true);\n      $('#mUp', s).disabled = true; $('#mProg', s).textContent = '読み込み中… ' + (f.size / 1048576).toFixed(1) + 'MB';\n      var reader = new FileReader();\n      reader.onload = function () {\n        $('#mProg', s).textContent = 'アップロード中…';\n        call('uploadMedia', String(reader.result).split(',')[1], f.type || 'application/octet-stream', f.name, { date: S.date, category: cat, exercise_id: exerciseId || '', note: $('#mNote', s).value })\n          .then(function () { toast('アップロード完了'); closeSheet(); if (onDone) onDone(); }).catch(function (e) { $('#mUp', s).disabled = false; $('#mProg', s).textContent = ''; fail(e); });\n      };\n      reader.readAsDataURL(f);\n    };\n    $('#mUrlAdd', s).onclick = function () { call('addMediaUrl', { date: S.date, drive_url: $('#mUrl', s).value, category: cat, exercise_id: exerciseId || '', note: $('#mNote', s).value, type: 'video' }).then(function () { toast('登録しました'); closeSheet(); if (onDone) onDone(); }).catch(fail); };\n  }\n\n  // ======================= 筋トレ（1画面1セット） =======================\n  function firstUndone(d) {\n    for (var i = 0; i < d.exercises.length; i++) for (var j = 0; j < d.exercises[i].sets.length; j++) if (!d.exercises[i].sets[j].done) return { ex: i, set: j };\n    return null;\n  }\n  function renderWorkout() {\n    if (!S.workout) { view.innerHTML = '<div class=\"loading\">読み込み中…</div>'; return Promise.all([call('getWorkout', S.date), S.today ? Promise.resolve(S.today) : loadToday()]).then(function (r) { S.workout = r[0]; var p = firstUndone(r[0]); S.wk = p ? { ex: p.ex, set: p.set } : { ex: 0, set: 0 }; renderWorkout(); }).catch(fail); }\n    var d = S.workout, h = '';\n    if (d.is_rest || !d.exercises.length) {\n      h += '<h1>Day ' + d.day_no + ' ・ ' + esc(d.day_name) + '</h1>' + dateLine();\n      h += '<div class=\"now\"><div class=\"k\">今日</div><div class=\"t\">休み ・ 有酸素のみ</div><div class=\"s\">' + (d.cardio.length ? d.cardio.map(function (c) { return c.type + ' ' + c.minutes + '分'; }).join('・') + ' 記録済み' : '歩き・ジョグ・階段を 35〜40 分') + '</div><div class=\"btns\"><button id=\"rcardio\">有酸素を記録</button></div></div>';\n      view.innerHTML = h; bindDate();\n      $('#rcardio').onclick = function () { openCardioSheet(); };\n      return;\n    }\n    var ex = d.exercises[S.wk.ex], st = ex.sets[S.wk.set];\n    var allDone = d.exercises.every(function (e) { return e.sets.every(function (x) { return x.done; }); });\n    h += '<div class=\"ex-head\"><h1>Day ' + d.day_no + ' ・ ' + esc(d.day_name) + (S.date === BOOT.today ? '' : ' ・ ' + md(S.date)) + '</h1><span class=\"p\"><button data-ex=\"-1\">‹</button>種目 ' + (S.wk.ex + 1) + ' / ' + d.exercises.length + '<button data-ex=\"1\">›</button></span></div>';\n    if (ex.is_preexhaust) h += '<span class=\"tag\">事前疲労</span>';\n    else if (S.wk.ex > 0 && d.exercises[S.wk.ex - 1].is_preexhaust) h += '<span class=\"tag\">事前疲労のあと</span>';\n    if (ex.superset_group) h += '<span class=\"tag ss\">スーパーセット ' + esc(ex.superset_group) + '</span>';\n    if (ex.sub_name) h += '<span class=\"tag sub\">代替: ' + esc(ex.sub_name) + '</span>';\n    h += '<p class=\"ex-name\">' + esc(ex.sub_name || ex.name_ja) + '</p>';\n    h += '<p class=\"ex-en\">' + esc(ex.name_en) + ' ・ <a href=\"' + esc(ex.video_url) + '\" target=\"_blank\" rel=\"noopener\"><u>動画を見る</u></a>' + (ex.how_to ? ' ・ <u id=\"howtoBtn\">やり方</u>' : '') + '</p>';\n    if (ex.how_to) h += '<div class=\"howto hidden\" id=\"howto\">' + esc(ex.how_to) + '</div>';\n    h += '<div class=\"setlist\">' + ex.sets.map(function (x, i) { return '<div class=\"' + (i === S.wk.set ? 'on' : x.done ? 'ok' : '') + '\" data-set=\"' + i + '\">' + esc(x.set_type === 'WU' ? 'W' : x.set_type) + ' ' + esc(x.target) + (x.done ? ' ✓' : '') + '</div>'; }).join('') + '</div>';\n    var w0 = st.done ? disp(st.weight_kg) : (st.suggest_weight_kg !== '' ? disp(st.suggest_weight_kg) : (st.prev_weight_kg !== '' ? disp(st.prev_weight_kg) : ''));\n    var r0 = st.done ? st.reps : (st.suggest_reps !== '' ? st.suggest_reps : (st.prev_reps !== '' ? st.prev_reps : st.target_min));\n    h += '<div class=\"big\"><div class=\"cell\"><div class=\"lbl\"><span>重量</span><i>' + u() + '</i></div><div class=\"val' + (w0 === '' ? ' empty' : '') + '\" id=\"wv\" data-v=\"' + esc(w0) + '\">' + (w0 === '' ? '—' : esc(w0)) + '</div><div class=\"pm\"><button data-pm=\"w:-1\">−</button><button data-pm=\"w:1\">＋</button></div></div>' +\n      '<div class=\"cell\"><div class=\"lbl\"><span>回数</span><i>目標 ' + esc(st.target) + '</i></div><div class=\"val\" id=\"rv\" data-v=\"' + esc(r0) + '\">' + esc(r0) + '</div><div class=\"pm\"><button data-pm=\"r:-1\">−</button><button data-pm=\"r:1\">＋</button></div></div></div>';\n    var ghost = '';\n    if (st.done) ghost = '記録済み <b>' + disp(st.weight_kg) + ' ' + u() + ' × ' + esc(st.reps) + '</b>（変えて完了で上書き）';\n    else if (st.prev_weight_kg !== '') ghost = '前回 ' + esc((ex.prev_date || '').slice(5)) + '　<b>' + disp(st.prev_weight_kg) + ' ' + u() + ' × ' + esc(st.prev_reps) + '</b>' + (st.suggest_reason ? '　→ ' + esc(st.suggest_reason.replace(/^前回 [\\d.]+×\\d+\\s*/, '')) : '');\n    else if (st.suggest_reason) ghost = '提案: ' + esc(st.suggest_reason);\n    else ghost = '初回。重量を入れて完了';\n    h += '<div class=\"ghost\">' + ghost + '</div>';\n    h += '<button class=\"done-btn' + (allDone ? ' green' : '') + '\" id=\"setDone\">' + (allDone ? '筋トレ完了 → 有酸素へ' : 'このセット完了') + '</button>';\n    h += '<div class=\"rest hidden\" id=\"rest\"><div class=\"l\">休憩</div><div class=\"n\" id=\"rn\">0:00</div><div class=\"l\" id=\"rnext\"></div><button id=\"skipRest\">休憩を飛ばす</button></div>';\n    h += '<div class=\"mini\"><button id=\"subBtn\">代替種目で実施</button><button id=\"noteBtn\">違和感メモ' + (ex.note ? ' ●' : '') + '</button><button id=\"formBtn\">フォーム動画</button></div>';\n    if (allDone && !d.finished) h += '<div class=\"note\">全セット記録済み。上のボタンで筋トレを完了にして有酸素を入力します。</div>';\n    view.innerHTML = h;\n\n    $$('[data-ex]').forEach(function (b) { b.onclick = function () { var n = S.wk.ex + Number(b.dataset.ex); if (n < 0 || n >= d.exercises.length) return; S.wk = { ex: n, set: firstUndoneIn(d.exercises[n]) }; renderWorkout(); }; });\n    $$('[data-set]').forEach(function (el) { el.onclick = function () { S.wk.set = Number(el.dataset.set); renderWorkout(); }; });\n    var hb = $('#howtoBtn'); if (hb) hb.onclick = function () { $('#howto').classList.toggle('hidden'); };\n    var stepW = S.unit === 'kg' ? 1 : 2.5;\n    $$('[data-pm]').forEach(function (b) {\n      b.onclick = function () {\n        var p = b.dataset.pm.split(':'), id = p[0] === 'w' ? '#wv' : '#rv', el = $(id);\n        var cur = el.dataset.v === '' ? 0 : Number(el.dataset.v);\n        var next = Math.max(0, r1(cur + Number(p[1]) * (p[0] === 'w' ? stepW : 1)));\n        el.dataset.v = next; el.textContent = next; el.classList.remove('empty');\n      };\n    });\n    $('#wv').onclick = function () { var v = prompt('重量 (' + u() + ')', this.dataset.v); if (v === null || v === '' || isNaN(Number(v))) return; this.dataset.v = r1(Number(v)); this.textContent = this.dataset.v; this.classList.remove('empty'); };\n    $('#rv').onclick = function () { var v = prompt('回数', this.dataset.v); if (v === null || v === '' || isNaN(Number(v))) return; this.dataset.v = Math.round(Number(v)); this.textContent = this.dataset.v; };\n\n    $('#setDone').onclick = function () {\n      if (allDone) return finishAll();\n      var wv = $('#wv').dataset.v, rv = $('#rv').dataset.v;\n      if (wv === '' && rv === '') return toast('重量を入力', true);\n      var btn = this; btn.disabled = true;\n      st.done = true; st.weight_kg = S.unit === 'lb' ? r1(Number(wv) * LB) : Number(wv); st.reps = Number(rv);\n      call('saveSet', d.date, ex.id, st.set_no, st.set_type, wv, S.unit, rv, ex.sub_name || '').then(function (res) { st.weight_kg = res.weight_kg; S.today = null; }).catch(function (e) { st.done = false; fail(e); });\n      vibrate(80);\n      var nxt = nextSet(d);\n      if (!nxt) { S.workout = null; return renderWorkout(); }\n      startRest(st.set_type === 'TOP' ? d.rest_top_sec : d.rest_other_sec, nxt);\n    };\n    $('#subBtn').onclick = function () {\n      var name = prompt('代替種目名（空欄で解除）。マスタは変更しません。', ex.sub_name || ''); if (name === null) return;\n      ex.sub_name = name.trim();\n      call('saveExerciseMeta', d.date, ex.id, ex.note || '', ex.rpe || '', ex.sub_name).then(function () { renderWorkout(); }).catch(fail);\n    };\n    $('#noteBtn').onclick = function () {\n      var s = openSheet('<h3>' + esc(ex.name_ja) + '</h3><label class=\"lbl\">違和感メモ（週次レポートに載ります）</label><textarea class=\"txt\" id=\"exNote\">' + esc(ex.note || '') + '</textarea><label class=\"lbl\">RPE（任意）</label><div class=\"chips\" id=\"rpe\">' + [6, 7, 8, 9, 10].map(function (n) { return '<button data-r=\"' + n + '\"' + (ex.rpe === n ? ' class=\"on\"' : '') + '>' + n + '</button>'; }).join('') + '</div><button class=\"b b-yel\" style=\"width:100%;margin-top:12px\" id=\"exSave\">保存</button>');\n      var rpe = ex.rpe || '';\n      $$('#rpe button', s).forEach(function (b) { b.onclick = function () { rpe = rpe === Number(b.dataset.r) ? '' : Number(b.dataset.r); $$('#rpe button', s).forEach(function (x) { x.classList.toggle('on', Number(x.dataset.r) === rpe); }); }; });\n      $('#exSave', s).onclick = function () { ex.note = $('#exNote', s).value; ex.rpe = rpe; call('saveExerciseMeta', d.date, ex.id, ex.note, rpe, ex.sub_name || '').then(function () { closeSheet(); toast('保存しました'); renderWorkout(); }).catch(fail); };\n    };\n    $('#formBtn').onclick = function () { openMediaSheet('form', ex.id); };\n\n    function finishAll() {\n      call('finishWorkout', d.date).then(function () { d.finished = true; S.today = null; openCardioSheet(function () { go('today'); }); }).catch(fail);\n    }\n  }\n  function firstUndoneIn(ex) { for (var j = 0; j < ex.sets.length; j++) if (!ex.sets[j].done) return j; return 0; }\n  /** 次の未完了セット（同種目 → 次種目）。無ければ null。 */\n  function nextSet(d) {\n    for (var i = S.wk.ex; i < d.exercises.length; i++) {\n      var from = i === S.wk.ex ? S.wk.set + 1 : 0;\n      for (var j = from; j < d.exercises[i].sets.length; j++) if (!d.exercises[i].sets[j].done) return { ex: i, set: j };\n    }\n    var p = firstUndone(d);\n    return p;\n  }\n  function startRest(sec, nxt) {\n    var d = S.workout, nex = d.exercises[nxt.ex], nst = nex.sets[nxt.set];\n    var rest = $('#rest'); rest.classList.remove('hidden');\n    var sw = nst.suggest_weight_kg !== '' ? disp(nst.suggest_weight_kg) : (nst.prev_weight_kg !== '' ? disp(nst.prev_weight_kg) : '');\n    $('#rnext').textContent = '次：' + (nxt.ex !== S.wk.ex ? nex.name_ja + ' ' : '') + ({ WU: 'ウォームアップ', TOP: 'トップ', BO: 'バックオフ', DROP: 'ドロップ', MAIN: 'メイン' }[nst.set_type] || nst.set_type) + ' ' + nst.target + '回' + (sw ? ' ・ 提案 ' + sw + ' ' + u() : '');\n    $('#setDone').classList.add('hidden');\n    var end = Date.now() + sec * 1000;\n    var advance = function () { clearTimers(); S.wk = { ex: nxt.ex, set: nxt.set }; S.workout = null; renderWorkout(); };\n    every(function () { var left = (end - Date.now()) / 1000; if (left <= 0) { vibrate([300, 100, 300]); advance(); } else $('#rn').textContent = mmss(left); }, 250);\n    $('#skipRest').onclick = advance;\n    window.scrollTo(0, document.body.scrollHeight);\n  }\n\n  // ======================= 食事 =======================\n  function renderMeals() {\n    if (!S.meals || !S.today) { view.innerHTML = '<div class=\"loading\">読み込み中…</div>'; return Promise.all([call('getMeals', S.date), S.today ? Promise.resolve(S.today) : loadToday()]).then(function (r) { S.meals = r[0]; if (!S.mealSel) S.mealSel = S.today.next_meal_no; renderMeals(); }).catch(fail); }\n    var d = S.meals, t = S.today, h = '';\n    var m = d.meals.filter(function (x) { return x.meal_no === S.mealSel; })[0] || d.meals[0];\n    var step = t.timeline.filter(function (x) { return x.id === 'meal:' + m.meal_no; })[0] || {};\n    var pk = m.plan_items.reduce(function (a, p) { return a + (p.kcal || 0); }, 0);\n    h += '<h1>' + esc(m.label) + '</h1>' + dateLine('<span class=\"mute\" style=\"font-size:18px;margin-left:auto\">' + esc(step.time || '') + '</span>');\n    h += '<div class=\"chips\" style=\"margin-bottom:14px\">' + d.meals.map(function (x) { return '<button' + (x.meal_no === m.meal_no ? ' class=\"on\"' : x.status === 'plan' ? ' class=\"ok\"' : x.status === 'skip' ? ' class=\"skip\"' : '') + ' data-msel=\"' + x.meal_no + '\">' + x.meal_no + (x.status === 'plan' ? ' ✓' : x.status === 'sub' ? ' ↔' : x.status === 'skip' ? ' ×' : '') + '</button>'; }).join('') + '</div>';\n    h += '<div class=\"card\"><div class=\"ttl\">プランの内容</div><div class=\"items\">' + (m.plan_items.length ? m.plan_items.map(function (p) { return esc(p.name) + ' ' + p.grams + (p.per === '100g' ? 'g' : ''); }).join(' ・ ') : '（plan_meals 未設定）') + '<br><span class=\"num\" style=\"font-size:14px\">約 ' + Math.round(pk) + ' kcal</span></div>';\n    if (m.status) {\n      h += '<div class=\"badge ' + (m.status === 'plan' ? 'ok' : m.status === 'sub' ? 'warn' : 'bad') + '\">' + (m.status === 'plan' ? 'プラン通り 記録済み' : m.status === 'sub' ? '変更して記録済み' : 'スキップ') + '</div>';\n      if (m.items.length) h += '<div class=\"list\" style=\"margin-top:6px\">' + m.items.map(function (it) { return '<div class=\"it\"><span>' + esc(it.name) + ' <span class=\"mute\">' + it.grams + (it.per === '100g' ? 'g' : '') + '</span></span><span class=\"m\">' + it.kcal + ' kcal ・ P' + it.p + ' F' + it.f + ' C' + it.c + '</span><button class=\"x\" data-del=\"' + it._row + '\">×</button></div>'; }).join('') + '</div>';\n      h += '<div class=\"btns\" style=\"margin-top:10px\"><button class=\"b-sub\" id=\"mChange\">変更・追加</button></div>';\n    } else {\n      h += '<div class=\"btns\"><button class=\"b-main\" id=\"mPlan\">プラン通り食べた</button><button class=\"b-sub\" id=\"mChange\">変更して記録</button></div>';\n    }\n    h += '<div id=\"sub\" class=\"hidden\" style=\"margin-top:12px;border-top:1px solid var(--line);padding-top:12px\"><div class=\"mute small\" style=\"margin-bottom:6px\">よく使う差替え</div><div class=\"chips\">' +\n      d.quick_subs.map(function (q, i) { return '<button data-q=\"' + i + '\">' + esc(q.label) + '</button>'; }).join('') + '<button data-half=\"1\">半分だけ</button><button class=\"skip\" data-skip=\"1\">スキップ</button></div>' +\n      '<div class=\"row2\" style=\"margin-top:10px\"><input class=\"txt\" id=\"freeTxt\" placeholder=\"食べたものを書く（例：サーモン150 米150）\"><button class=\"b b-yel\" style=\"flex:0 0 96px\" id=\"freeBtn\">AI 計算</button></div><div class=\"mute small\" style=\"margin-top:4px\">foods に無い食品は AI が 100g あたりの栄養を推定して追加します</div></div>';\n    h += '</div>';\n    var dv = function (k) { var x = Math.round(d.total[k] - d.plan_total[k]); return '<span style=\"color:' + (x > 0 ? 'var(--yellow)' : x < 0 ? 'var(--mute)' : 'var(--done)') + '\">' + (x > 0 ? '+' : '') + x + '</span>'; };\n    h += '<div class=\"card\"><div class=\"ttl small mute\">1日合計 ・ プラン比</div><div class=\"stat\" style=\"margin:8px 0 0\"><div><div class=\"n\">' + Math.round(d.total.kcal) + '<span> kcal</span></div><div class=\"l num\">プラン ' + Math.round(d.plan_total.kcal) + ' ・ ' + dv('kcal') + '</div></div><div><div class=\"n\">P ' + Math.round(d.total.p) + '<span> g</span></div><div class=\"l num\">プラン ' + Math.round(d.plan_total.p) + ' ・ ' + dv('p') + '</div></div><div><div class=\"n\">F ' + Math.round(d.total.f) + '<span> g</span></div><div class=\"l num\">プラン ' + Math.round(d.plan_total.f) + ' ・ ' + dv('f') + '</div></div><div><div class=\"n\">C ' + Math.round(d.total.c) + '<span> g</span></div><div class=\"l num\">プラン ' + Math.round(d.plan_total.c) + ' ・ ' + dv('c') + '</div></div></div></div>';\n    view.innerHTML = h; bindDate();\n    var reload = function (res) { if (res && res.meals) S.meals = res; else S.meals = null; S.today = null; loadToday().then(renderMeals).catch(fail); };\n    $$('[data-msel]').forEach(function (b) { b.onclick = function () { S.mealSel = Number(b.dataset.msel); renderMeals(); }; });\n    var mp = $('#mPlan'); if (mp) mp.onclick = function () { mp.disabled = true; call('mealPlanDone', d.date, m.meal_no).then(function () { toast(m.meal_no + '食目 プラン通り'); S.mealSel = null; reload(); }).catch(function (e) { mp.disabled = false; fail(e); }); };\n    $('#mChange').onclick = function () { $('#sub').classList.toggle('hidden'); };\n    $$('[data-del]').forEach(function (b) { b.onclick = function () { call('deleteMealItem', d.date, Number(b.dataset.del)).then(reload).catch(fail); }; });\n    $$('[data-q]').forEach(function (b) { b.onclick = function () { var q = d.quick_subs[Number(b.dataset.q)]; call('addMealItem', d.date, m.meal_no, q.food_id, q.grams, 'sub', '').then(function (res) { toast(q.label + ' を記録'); reload(res); }).catch(fail); }; });\n    $('[data-half]').onclick = function () { call('mealHalf', d.date, m.meal_no).then(function (res) { toast('半分で記録'); reload(res); }).catch(fail); };\n    $('[data-skip]').onclick = function () { call('mealSkip', d.date, m.meal_no).then(function () { toast('スキップ'); reload(); }).catch(fail); };\n    $('#freeBtn').onclick = function () {\n      var txt = $('#freeTxt').value.trim(); if (!txt) return toast('食べたものを入力', true);\n      var b = this; b.disabled = true; toast('計算中…');\n      call('logMealText', d.date, m.meal_no, txt, !m.items.length || m.status === 'plan').then(function (res) { toast('記録しました'); reload(res); }).catch(function (e) { b.disabled = false; fail(e); });\n    };\n    $('#freeTxt').onkeydown = function (e) { if (e.key === 'Enter') $('#freeBtn').click(); };\n  }\n\n  // ======================= 週 =======================\n  function renderSummary() {\n    if (!S.summary) { view.innerHTML = '<div class=\"loading\">読み込み中…</div>'; return call('getSummary', S.summaryWeek || null).then(function (d) { S.summary = d; S.summaryWeek = d.week_no; renderSummary(); }).catch(fail); }\n    var d = S.summary, a = d.adherence, h = '';\n    h += '<h1>' + (d.week_no === d.current_week ? '今週' : 'Week ' + d.week_no) + '</h1>';\n    h += '<p class=\"date\"><button class=\"nav\" id=\"wkPrev\">‹</button><span>Week <b>' + d.week_no + '</b> ・ <span style=\"font-size:22px\">' + md(d.range.start) + '–' + md(d.range.end) + '</span></span><button class=\"nav\" id=\"wkNext\">›</button></p>';\n    var wDelta = d.today_weight != null && d.start_weight != null ? r1(d.today_weight - d.start_weight) : null;\n    h += '<div class=\"stat\">' +\n      '<div><div class=\"n\">' + (d.today_weight != null ? disp(d.today_weight) : '—') + '<span> ' + u() + '</span></div><div class=\"l\">今朝' + (wDelta != null ? ' ・ 開始から ' + (wDelta > 0 ? '+' : '') + disp(wDelta) : '') + '</div></div>' +\n      '<div><div class=\"n\">' + a.workouts.done + '<span> / ' + a.workouts.planned + '</span></div><div class=\"l\">筋トレ完了</div></div>' +\n      '<div><div class=\"n\">' + a.meals.on_plan + '<span> / ' + a.meals.planned + '</span></div><div class=\"l\">食事 プラン通り' + (a.meals.subs ? '（差替え ' + a.meals.subs + '）' : '') + '</div></div>' +\n      '<div><div class=\"n\">' + (d.water_today_ml / 1000).toFixed(1) + '<span> / ' + (d.water_goal_ml / 1000) + ' L</span></div><div class=\"l\">水 今日 ・ 週 ' + a.water.ok + '/' + a.water.days + ' 日達成</div></div>' +\n      '</div>';\n    h += '<div class=\"spark\"><div class=\"h\"><span>体重（30日）</span><span class=\"num\">有酸素 ' + a.cardio.done + '/' + a.cardio.planned + ' ・ サプリ ' + a.supplements.pct + '%</span></div>' + spark(d.weights.slice(-30), d.weights_ma7.slice(-30)) + '</div>';\n    h += '<div class=\"spark\"><div class=\"h\"><span>トップセット重量（種目別）</span></div>' + (d.top_sets.length ? d.top_sets.map(function (t) {\n      var pts = t.points, last = pts[pts.length - 1], prev = pts.length > 1 ? pts[pts.length - 2] : null;\n      var up = prev && last.value > prev.value;\n      return '<div class=\"r' + (up ? ' up' : '') + '\"><span>' + esc(t.name) + '</span><span>' + (prev ? disp(prev.value) + ' → ' : '') + disp(last.value) + ' ' + u() + ' × ' + last.reps + '</span></div>';\n    }).join('') : '<div class=\"r mute\"><span>まだ記録なし</span><span>—</span></div>') + '</div>';\n    h += '<div class=\"card\"><div class=\"ttl\" style=\"margin-bottom:8px\">コーチに送る</div><div class=\"report\" id=\"repText\">生成中…</div>' +\n      '<label class=\"opt\"><input type=\"checkbox\" id=\"optShare\"> 写真・動画を「リンクを知っている全員」に共有してから URL を載せる</label><label class=\"opt\"><input type=\"checkbox\" id=\"optMsgr\"> フォーム動画は Messenger で送った（sent via Messenger）</label>' +\n      '<div class=\"btns\" style=\"margin-top:10px\"><button class=\"b-yel\" id=\"copyRep\">レポートをコピー</button><button class=\"b-sub\" id=\"addMedia\">写真・動画を追加</button></div>' +\n      (d.media.length ? '<div class=\"gallery\">' + d.media.map(function (m) { var id = /\\/d\\/([\\w-]+)/.exec(m.drive_url); return '<a class=\"thumb\" href=\"' + esc(m.drive_url) + '\" target=\"_blank\" rel=\"noopener\">' + (id ? '<img src=\"https://drive.google.com/thumbnail?id=' + id[1] + '&sz=w300\" loading=\"lazy\" alt=\"\">' : '') + '<div class=\"cap\">' + esc(m.date.slice(5)) + ' ' + esc(m.category) + (m.type === 'video' ? ' ▶' : '') + '</div></a>'; }).join('') + '</div>' : '') + '</div>';\n    h += '<div class=\"card\"><div class=\"ttl small mute\">設定</div><div class=\"btns\" style=\"margin-top:8px\"><button class=\"b-sub\" id=\"unitBtn\">単位: ' + u() + ' → ' + (S.unit === 'kg' ? 'lb' : 'kg') + '</button></div><div class=\"mute small\" style=\"margin-top:6px\">保存は常に kg。時刻テンプレ・休憩秒数・提案の増分はシート settings で変更</div></div>';\n    view.innerHTML = h;\n    $('#wkPrev').onclick = function () { S.summaryWeek = d.week_no - 1; S.summary = null; renderSummary(); };\n    $('#wkNext').onclick = function () { S.summaryWeek = d.week_no + 1; S.summary = null; renderSummary(); };\n    $('#addMedia').onclick = function () { openMediaSheet('body', '', function () { S.summary = null; renderSummary(); }); };\n    $('#unitBtn').onclick = function () { S.unit = S.unit === 'kg' ? 'lb' : 'kg'; call('saveUnit', S.unit).catch(fail); S.today = S.workout = null; renderSummary(); };\n    var gen = function () { $('#repText').textContent = '生成中…'; call('generateWeeklyReport', d.week_no, { share_links: $('#optShare').checked, form_via_messenger: $('#optMsgr').checked }).then(function (r) { var el = $('#repText'); if (el) el.textContent = r.text; }).catch(fail); };\n    gen();\n    $('#optShare').onchange = gen; $('#optMsgr').onchange = gen;\n    $('#copyRep').onclick = function () {\n      var txt = $('#repText').textContent;\n      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(function () { toast('コピーしました'); }).catch(function () { var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('コピーしました'); });\n    };\n  }\n  /** 依存なしスパークライン。 */\n  function spark(s1, s2) {\n    if (!s1.length) return '<div class=\"mute small\">データなし</div>';\n    var W = 300, H = 80, ys = s1.concat(s2 || []).map(function (p) { return p.value; });\n    var mn = Math.min.apply(null, ys), mx = Math.max.apply(null, ys); if (mx === mn) { mx += 0.5; mn -= 0.5; }\n    var n = s1.length, X = function (i) { return n === 1 ? W / 2 : W * i / (n - 1); }, Y = function (v) { return 6 + (H - 12) * (1 - (v - mn) / (mx - mn)); };\n    var pts = function (s) { return s.map(function (p, i) { return X(i).toFixed(1) + ',' + Y(p.value).toFixed(1); }).join(' '); };\n    return '<svg viewBox=\"0 0 ' + W + ' ' + H + '\" preserveAspectRatio=\"none\">' + (s2 && s2.length ? '<polyline fill=\"none\" stroke=\"#6FCF8A\" stroke-width=\"1.5\" stroke-dasharray=\"3 3\" points=\"' + pts(s2) + '\"/>' : '') + '<polyline fill=\"none\" stroke=\"#F2C300\" stroke-width=\"2\" points=\"' + pts(s1) + '\"/></svg>' +\n      '<div class=\"r mute\" style=\"font-size:12px\"><span>' + esc(s1[0].date.slice(5)) + ' ' + disp(s1[0].value) + '</span><span>' + esc(s1[n - 1].date.slice(5)) + ' ' + disp(s1[n - 1].value) + ' ' + u() + '</span></div>';\n  }\n\n  render();\n})();\n</script>\n",
  "Index": "<!DOCTYPE html>\n<html lang=\"ja\">\n<head>\n  <meta charset=\"utf-8\">\n  <base target=\"_top\">\n  <title>トレログ</title>\n  <link href=\"https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;700&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap\" rel=\"stylesheet\">\n  <?!= include('Styles') ?>\n</head>\n<body>\n<div class=\"phone\">\n  <main id=\"view\"><div class=\"loading\">読み込み中…</div></main>\n\n  <nav class=\"tabs\">\n    <button data-tab=\"today\"><span class=\"ic\">今日</span><span class=\"sub\" id=\"tabToday\">流れ</span></button>\n    <button data-tab=\"workout\"><span class=\"ic\">筋トレ</span><span class=\"sub\" id=\"tabWorkout\">Day</span></button>\n    <button data-tab=\"meals\"><span class=\"ic\">食事</span><span class=\"sub\" id=\"tabMeals\">食事</span></button>\n    <button data-tab=\"summary\"><span class=\"ic\">週</span><span class=\"sub\">まとめ</span></button>\n  </nav>\n\n  <div id=\"toast\" class=\"toast\"></div>\n  <div id=\"sheet\" class=\"sheet hidden\"><div class=\"sheet-body\"></div></div>\n</div>\n<script>window.BOOT = <?!= bootstrap ?>;</script>\n<?!= include('AppJs') ?>\n</body>\n</html>\n",
  "Styles": "<style>\n:root{\n  --bg:#15171A; --floor:#1C1F23; --card:#23272C; --card2:#2B3036;\n  --ink:#F2F1EC; --mute:#8D949D; --line:#33393F;\n  --yellow:#F2C300; --yellow-ink:#1A1600; --done:#6FCF8A; --warn:#E5534B;\n  --num:\"Barlow Condensed\",\"Zen Kaku Gothic New\",sans-serif;\n  --jp:\"Zen Kaku Gothic New\",\"Hiragino Sans\",\"Noto Sans JP\",sans-serif;\n  --safe-b:env(safe-area-inset-bottom,0px);\n}\n*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}\nhtml,body{margin:0;background:#0E0F11;color:var(--ink);font-family:var(--jp);font-size:15px;line-height:1.5}\nbody{display:flex;justify-content:center;min-height:100vh}\nbutton,input,select,textarea{font:inherit;color:inherit}\nbutton{cursor:pointer}\n.phone{width:100%;max-width:420px;min-height:100vh;background:var(--bg);position:relative;\n  background-image:radial-gradient(rgba(255,255,255,.055) .7px,transparent .8px);background-size:7px 7px}\nmain{padding:18px 16px calc(120px + var(--safe-b))}\nh1{font:700 15px var(--jp);color:var(--mute);margin:0 0 2px}\nh1.tap{cursor:pointer}\nh2{font:700 13px var(--jp);color:var(--mute);margin:18px 0 8px}\n.date{font:700 34px/1 var(--num);letter-spacing:.01em;margin:0 0 18px;display:flex;align-items:center;gap:8px}\n.date b{color:var(--yellow);font-weight:700}\n.date .nav{background:transparent;border:0;color:var(--mute);font:500 26px var(--num);padding:0 6px;line-height:1}\n.mute{color:var(--mute)}.small{font-size:13px}.num{font-family:var(--num)}\n.hidden{display:none!important}\n.loading{text-align:center;color:var(--mute);padding:40px}\n\n/* NOW card */\n.now{background:var(--yellow);color:var(--yellow-ink);border-radius:14px;padding:18px 18px 16px;margin-bottom:22px;position:relative;overflow:hidden}\n.now.done{background:var(--done);color:#10281A}\n.now .k{font-size:13px;font-weight:700;opacity:.75}\n.now .t{font:700 26px/1.15 var(--jp);margin:6px 0 4px}\n.now .s{font-size:14px;opacity:.85}\n.now .timer{font:700 54px/1 var(--num);margin:10px 0 4px;letter-spacing:.02em}\n.now .btns{display:flex;gap:8px;margin-top:12px}\n.now button{width:100%;border:0;border-radius:10px;padding:14px;background:var(--yellow-ink);color:var(--yellow);font:700 17px var(--jp)}\n.now.done button{background:#10281A;color:var(--done)}\n.now button.alt{background:rgba(26,22,0,.15);color:var(--yellow-ink);flex:0 0 34%}\n.now .w-in{background:rgba(26,22,0,.12);margin-top:10px}\n.now .w-in input{color:var(--yellow-ink)}\n.now .w-in .u{color:rgba(26,22,0,.6)}\n\n/* timeline */\n.tl{position:relative;padding-left:26px}\n.tl:before{content:\"\";position:absolute;left:8px;top:6px;bottom:6px;width:2px;background:var(--line)}\n.step{position:relative;margin-bottom:12px}\n.step:before{content:\"\";position:absolute;left:-23px;top:9px;width:12px;height:12px;border-radius:50%;background:var(--card2);border:2px solid var(--line)}\n.step.done:before{background:var(--done);border-color:var(--done)}\n.step.cur:before{background:var(--yellow);border-color:var(--yellow);box-shadow:0 0 0 4px rgba(242,195,0,.25)}\n.step .row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:var(--card)}\n.step.done .row{background:transparent;color:var(--mute)}\n.step.done .row .v{color:var(--done)}\n.step .tm{font:500 14px var(--num);color:var(--mute);min-width:44px}\n.step .nm{flex:1;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.step .v{font:700 16px var(--num);color:var(--mute);white-space:nowrap}\n.step.future .row{opacity:.55}\n.chk{width:30px;height:30px;border-radius:50%;border:2px solid var(--line);background:transparent;color:transparent;font-size:16px;flex:none;padding:0}\n.chk.on{background:var(--done);border-color:var(--done);color:#10281A}\n\n/* weight input */\n.w-in{display:flex;align-items:baseline;gap:8px;background:var(--card);border-radius:10px;padding:10px 12px}\n.w-in input{background:transparent;border:0;color:var(--ink);font:700 34px var(--num);width:120px;outline:none;padding:0}\n.w-in input.bf{width:84px;font-size:22px}\n.w-in input::placeholder{color:var(--mute);opacity:.7}\n.w-in .u{color:var(--mute)}\n.w-in .d{margin-left:auto;font:500 14px var(--num);color:var(--done)}\n\n/* cards & buttons */\n.card{background:var(--card);border-radius:10px;padding:12px;margin-bottom:12px}\n.card .ttl{font-weight:700}\n.items{color:var(--mute);font-size:13px;margin:4px 0 10px}\n.btns{display:flex;gap:8px}\n.btns button,.b{flex:1;border:0;border-radius:9px;padding:12px;font:700 15px var(--jp)}\n.b-main{background:var(--done);color:#10281A}\n.b-sub{background:var(--card2);color:var(--ink)}\n.b-yel{background:var(--yellow);color:var(--yellow-ink)}\n.b-warn{background:transparent;color:var(--warn);border:1px solid var(--line)}\n.b-ghost{background:transparent;color:var(--mute);border:1px solid var(--line)}\n.chips{display:flex;flex-wrap:wrap;gap:6px}\n.chips button{flex:none;padding:8px 12px;font-size:13px;border:0;border-radius:9px;background:var(--card2);color:var(--ink);font-weight:700}\n.chips button.on{background:var(--yellow);color:var(--yellow-ink)}\n.chips button.ok{color:var(--done)}\n.chips button.skip{color:var(--warn)}\ninput.txt,select.txt,textarea.txt{width:100%;padding:12px;border-radius:9px;border:1px solid var(--line);background:var(--card2);color:var(--ink);font:400 14px var(--jp);outline:none}\ntextarea.txt{min-height:60px}\n.row2{display:flex;gap:8px;align-items:center}\n.row2 > *{flex:1}\n.list .it{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:14px}\n.list .it:last-child{border-bottom:0}\n.list .it .m{color:var(--mute);font:500 13px var(--num);white-space:nowrap}\n.list .it .x{background:transparent;border:0;color:var(--warn);font-size:18px;padding:0 6px}\n.badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;background:var(--card2);color:var(--mute)}\n.badge.ok{background:rgba(111,207,138,.18);color:var(--done)}\n.badge.warn{background:rgba(242,195,0,.18);color:var(--yellow)}\n.badge.bad{background:rgba(229,83,75,.18);color:var(--warn)}\n\n/* workout */\n.ex-head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:6px}\n.ex-head .p{font:500 13px var(--num);color:var(--mute)}\n.ex-head .p button{background:transparent;border:0;color:var(--mute);font:700 18px var(--num);padding:0 8px}\n.ex-name{font:700 24px/1.2 var(--jp);margin:0 0 2px}\n.ex-en{color:var(--mute);font-size:13px;margin-bottom:14px}\n.ex-en a,.ex-en u{color:var(--mute);cursor:pointer}\n.tag{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;background:var(--yellow);color:var(--yellow-ink);margin:0 6px 8px 0}\n.tag.ss{background:var(--card2);color:var(--ink)}\n.tag.sub{background:var(--warn);color:#fff}\n.howto{background:var(--card);border-radius:10px;padding:10px 12px;font-size:13px;color:var(--mute);margin-bottom:12px}\n.setlist{display:flex;gap:6px;margin-bottom:16px}\n.setlist div{flex:1;text-align:center;padding:7px 0;border-radius:8px;background:var(--card);font:600 13px var(--num);color:var(--mute);cursor:pointer}\n.setlist .on{background:var(--yellow);color:var(--yellow-ink)}\n.setlist .ok{background:var(--card2);color:var(--done)}\n.big{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}\n.big .cell{background:var(--card);border-radius:14px;padding:12px 10px;text-align:center}\n.big .lbl{font-size:12px;color:var(--mute);display:flex;justify-content:space-between;padding:0 4px}\n.big .lbl i{font-style:normal;color:var(--mute)}\n.big .val{font:700 56px/1 var(--num);margin:8px 0;cursor:pointer}\n.big .val small{font-size:20px;color:var(--mute)}\n.big .val.empty{color:var(--mute)}\n.big .pm{display:flex;gap:8px}\n.big .pm button{flex:1;border:0;border-radius:10px;padding:14px 0;background:var(--card2);color:var(--ink);font:700 24px var(--num)}\n.ghost{color:var(--mute);font-size:13px;text-align:center;margin:-4px 0 14px}\n.ghost b{color:var(--ink);font-family:var(--num);font-size:15px}\n.done-btn{width:100%;border:0;border-radius:12px;padding:18px;background:var(--yellow);color:var(--yellow-ink);font:700 20px var(--jp)}\n.done-btn.green{background:var(--done);color:#10281A}\n.rest{background:var(--card);border-radius:14px;padding:16px;text-align:center;margin-top:12px}\n.rest .n{font:700 64px/1 var(--num);color:var(--yellow)}\n.rest .l{color:var(--mute);font-size:13px}\n.rest button{margin-top:10px;background:transparent;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:8px 16px;font:600 14px var(--jp)}\n.mini{display:flex;gap:8px;margin-top:14px}\n.mini button{flex:1;background:transparent;border:1px solid var(--line);color:var(--mute);border-radius:8px;padding:10px;font:500 13px var(--jp)}\n.exnav{display:flex;justify-content:space-between;margin-top:10px}\n.exnav button{background:transparent;border:0;color:var(--mute);font:500 13px var(--jp);padding:6px}\n\n/* summary */\n.stat{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}\n.stat div{background:var(--card);border-radius:10px;padding:12px}\n.stat .n{font:700 30px/1 var(--num)}\n.stat .n span{font-size:16px;color:var(--mute)}\n.stat .l{font-size:12px;color:var(--mute);margin-top:4px}\n.spark{background:var(--card);border-radius:10px;padding:12px;margin-bottom:14px}\n.spark .h{font-size:13px;color:var(--mute);margin-bottom:6px;display:flex;justify-content:space-between}\n.spark svg{width:100%;height:80px;display:block}\n.spark .r{display:flex;justify-content:space-between;font:600 14px var(--num);padding:3px 0}\n.spark .r.up span:last-child{color:var(--done)}\n.spark .r.mute{color:var(--mute)}\n.report{background:var(--card2);border-radius:10px;padding:12px;font:500 12px/1.6 ui-monospace,Menlo,monospace;color:var(--mute);white-space:pre-wrap;user-select:all}\n.opt{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--mute);margin:6px 0}\n.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}\n.thumb{position:relative;aspect-ratio:1;border-radius:8px;overflow:hidden;background:var(--card2);display:block}\n.thumb img{width:100%;height:100%;object-fit:cover}\n.thumb .cap{position:absolute;left:0;right:0;bottom:0;font:500 11px var(--num);padding:2px 6px;background:rgba(0,0,0,.6);color:#fff}\n\n/* tabs */\n.tabs{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:420px;display:flex;background:#0E0F11;border-top:1px solid var(--line);padding:8px 6px calc(10px + var(--safe-b));z-index:5}\n.tabs button{flex:1;background:transparent;border:0;color:var(--mute);font:600 12px var(--jp);padding:6px 0}\n.tabs button.on{color:var(--yellow)}\n.tabs button .ic{display:block;font:700 18px var(--num);margin-bottom:2px}\n.tabs button .sub{display:block;opacity:.8}\n\n/* toast & sheet */\n.toast{position:fixed;left:50%;bottom:calc(90px + var(--safe-b));transform:translateX(-50%) translateY(20px);background:var(--card2);color:var(--ink);padding:10px 16px;border-radius:10px;font-size:14px;opacity:0;transition:.2s;pointer-events:none;z-index:20;max-width:90vw}\n.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}\n.toast.err{background:var(--warn);color:#fff}\n.sheet{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10;display:flex;align-items:flex-end;justify-content:center}\n.sheet.hidden{display:none}\n.sheet-body{background:var(--card);width:100%;max-width:420px;max-height:85vh;overflow:auto;border-radius:16px 16px 0 0;padding:16px 16px calc(16px + var(--safe-b))}\n.sheet-body h3{margin:0 0 10px;font:700 17px var(--jp)}\n.lbl{display:block;font-size:12px;color:var(--mute);margin:10px 0 4px}\n.note{font-size:12px;color:var(--mute);margin-top:18px;padding:10px 12px;border:1px dashed var(--line);border-radius:8px}\n</style>\n"
};
