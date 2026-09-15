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
