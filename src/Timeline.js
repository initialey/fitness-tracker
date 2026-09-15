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
