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
