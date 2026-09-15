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
