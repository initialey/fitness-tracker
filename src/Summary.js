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
