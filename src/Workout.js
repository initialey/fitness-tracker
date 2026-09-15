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
