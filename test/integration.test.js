'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeContext } = require('./gas-mock');
// vm コンテキスト由来の配列は Array プロトタイプが異なるため JSON 往復で比較する
const deq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);

function fresh(opts) {
  const ctx = makeContext(opts);
  ctx.setupSheets();
  return ctx;
}

test('setupSheets: 全シート + 初期データ + plan_sets 展開 + Drive フォルダ', () => {
  const g = fresh();
  const names = g._ss.getSheets().map(s => s.name);
  Object.keys(g.SHEETS).forEach(n => assert.ok(names.includes(n), n));
  assert.ok(!names.includes('Sheet1'));
  assert.equal(g.readRows_('plan_days').length, 7);
  assert.equal(g.readRows_('plan_exercises').length, 30);
  assert.equal(g.readRows_('foods').length, 15);
  assert.equal(g.readRows_('plan_meals').length, 5);
  const sets = g.readRows_('plan_sets');
  assert.ok(sets.length > 60);
  const incline = sets.filter(s => Number(s.exercise_id) === 2).map(s => s.set_type);
  deq(incline, ['WU', 'TOP', 'BO']);
  assert.ok(g.getSettings().drive_folder_id.startsWith('folder_'));
  assert.equal(g.getSettings().start_date, '2026-09-16');
  // 2 回目は冪等（重複投入しない）
  g.setupSheets();
  assert.equal(g.readRows_('plan_days').length, 7);
  assert.equal(g.readRows_('plan_sets').length, sets.length);
});

test('getToday: Day 自動判定、休日、未入力インジケータ', () => {
  const g = fresh(); // now = 2026-09-18 → Day3 (Rest)
  const t = g.getToday();
  assert.equal(t.date, '2026-09-18');
  assert.equal(t.day_no, 3);
  assert.equal(t.is_rest, true);
  assert.equal(t.week_no, 1);
  assert.equal(t.weight, null);
  assert.equal(t.supplements.length, 8);
  assert.equal(t.routine.filter(r => r.is_water).length, 1);
  assert.equal(t.water_goal_ml, 5000);
  const t1 = g.getToday('2026-09-16');
  assert.equal(t1.day_no, 1);
  assert.equal(t1.day_name, 'Push');
  assert.equal(t1.is_rest, false);
});

test('Day 手動上書きと休み上書き', () => {
  const g = fresh();
  g.setDayOverride('2026-09-18', 4, null);
  const t = g.getToday('2026-09-18');
  assert.equal(t.day_no, 4);
  assert.equal(t.day_override, true);
  assert.equal(t.is_rest, false);
  g.setDayOverride('2026-09-18', null, true);
  const t2 = g.getToday('2026-09-18');
  assert.equal(t2.day_no, 3);
  assert.equal(t2.is_rest, true);
});

test('saveWeight: lb 入力を kg で保存、同日上書き、前日比', () => {
  const g = fresh();
  g.saveWeight('2026-09-16', '160', 'lb', '', '');
  assert.equal(g.readRows_('log_weight')[0].weight_kg, 72.6);
  g.saveWeight('2026-09-16', '72.4', 'kg', '15.2', '');
  assert.equal(g.readRows_('log_weight').length, 1);
  assert.equal(g.readRows_('log_weight')[0].weight_kg, 72.4);
  const r = g.saveWeight('2026-09-17', '72.0', 'kg', '', '');
  assert.equal(r.prev_weight.weight_kg, 72.4);
  const t = g.getToday('2026-09-17');
  assert.equal(t.weight.weight_kg, 72);
  assert.equal(t.prev_weight.date, '2026-09-16');
});

test('サプリ・ルーティン・水', () => {
  const g = fresh();
  const s = g.toggleSupplement('2026-09-16', 1, true);
  assert.equal(s.done, true);
  assert.match(s.time, /^\d\d:\d\d$/);
  g.toggleSupplement('2026-09-16', 1, false);
  assert.equal(g.readRows_('log_supplements').length, 1);
  assert.equal(g.getToday('2026-09-16').supplements[0].done, false);
  g.addWater('2026-09-16', 500);
  g.addWater('2026-09-16', 250);
  let t = g.getToday('2026-09-16');
  assert.equal(t.water_ml, 750);
  assert.equal(t.routine.find(r => r.is_water).done, false);
  g.addWater('2026-09-16', 5000);
  t = g.getToday('2026-09-16');
  assert.equal(t.water_ml, 5750);
  assert.equal(t.routine.find(r => r.is_water).done, true);
  g.addWater('2026-09-16', -9999);
  assert.equal(g.getToday('2026-09-16').water_ml, 0);
});

test('食事: プラン通り展開 / 差替え追加 / スキップ / 合計と差', () => {
  const g = fresh();
  const r = g.mealPlanDone('2026-09-16', 2);
  assert.equal(r.status, 'plan');
  assert.equal(r.items, 4);
  const logs = g.readRows_('log_meals');
  assert.equal(logs.length, 4);
  const chicken = logs.find(l => l.food_id === 'chicken_cooked');
  assert.equal(chicken.grams, 150);
  assert.equal(chicken.kcal, 247.5);
  assert.equal(chicken.p, 46.5);
  // 2 回押しても重複しない
  g.mealPlanDone('2026-09-16', 2);
  assert.equal(g.readRows_('log_meals').length, 4);
  // 差替え
  const m = g.addMealItem('2026-09-16', 5, 'salmon', 150, 'sub', '');
  assert.equal(m.meals[4].status, 'sub');
  assert.equal(m.meals[4].items[0].kcal, 312);
  assert.equal(m.total.kcal, 312 + r.kcal);
  assert.ok(m.plan_total.kcal > 2000);
  // スキップ→追加で skip 行が消える
  g.mealSkip('2026-09-16', 1);
  assert.equal(g.getToday('2026-09-16').meals[0].status, 'skip');
  g.addMealItem('2026-09-16', 1, 'egg_whole', 100, 'sub', '');
  const m1 = g.getMeals('2026-09-16').meals[0];
  assert.equal(m1.status, 'sub');
  assert.equal(m1.items.length, 1);
  // 削除
  const del = g.deleteMealItem('2026-09-16', m1.items[0]._row);
  assert.equal(del.meals[0].items.length, 0);
});

test('ワークアウト: 前回値、セット保存(lb→kg)、上書き、メタ、代替名', () => {
  const g = fresh();
  let w = g.getWorkout('2026-09-16');
  assert.equal(w.day_no, 1);
  assert.equal(w.is_rest, false);
  assert.equal(w.exercises.length, 6);
  const incline = w.exercises[1];
  assert.equal(incline.name_en, 'Incline DB press');
  deq(incline.sets.map(s => s.set_type), ['WU', 'TOP', 'BO']);
  assert.match(incline.video_url, /youtube\.com\/results\?search_query=/);
  assert.equal(w.exercises[0].is_preexhaust, true);
  assert.equal(w.exercises[4].superset_group, 'A');

  g.saveSet('2026-09-16', 2, 2, 'TOP', '50', 'lb', 7, '');
  let row = g.readRows_('log_workout')[0];
  assert.equal(row.weight_kg, 22.7);
  assert.equal(row.reps, 7);
  assert.equal(row.day_no, 1);
  g.saveSet('2026-09-16', 2, 2, 'TOP', '24', 'kg', 8, '');
  assert.equal(g.readRows_('log_workout').length, 1);
  assert.equal(g.readRows_('log_workout')[0].weight_kg, 24);

  g.saveExerciseMeta('2026-09-16', 5, 'right shoulder slight discomfort', 8, '');
  g.saveExerciseMeta('2026-09-16', 3, '', '', 'Floor press');
  w = g.getWorkout('2026-09-16');
  assert.equal(w.exercises[4].note, 'right shoulder slight discomfort');
  assert.equal(w.exercises[4].rpe, 8);
  assert.equal(w.exercises[2].sub_name, 'Floor press');
  assert.equal(w.exercises[1].sets[1].done, true);
  assert.equal(w.exercises[1].sets[1].weight_kg, 24);

  // 翌週 Day1 で「前回」が出る
  const w2 = g.getWorkout('2026-09-23');
  assert.equal(w2.exercises[1].prev_date, '2026-09-16');
  assert.equal(w2.exercises[1].sets[1].prev_weight_kg, 24);
  assert.equal(w2.exercises[1].sets[1].prev_reps, 8);
  assert.equal(w2.exercises[1].sets[0].prev_weight_kg, '');

  g.deleteSet('2026-09-16', 2, 2);
  assert.equal(g.getWorkout('2026-09-16').exercises[1].sets[1].done, false);

  // 休みの日
  const rest = g.getWorkout('2026-09-18');
  assert.equal(rest.is_rest, true);
  g.saveCardio('2026-09-18', 'walk', 40, '');
  assert.equal(g.getToday('2026-09-18').cardio[0].minutes, 40);
  assert.throws(() => g.saveCardio('2026-09-18', 'walk', '', ''), /分数/);
});

test('メディア: アップロードで当月フォルダに保存、一覧は日付降順', () => {
  const g = fresh();
  const up = g.uploadMedia(Buffer.from('abc').toString('base64'), 'video/mp4', 'squat.mp4', { date: '2026-09-17', category: 'form', exercise_id: 14, note: '' });
  assert.equal(up.type, 'video');
  g.uploadMedia(Buffer.from('x').toString('base64'), 'image/jpeg', 'body.jpg', { date: '2026-09-20', category: 'body' });
  g.addMediaUrl({ date: '2026-09-16', drive_url: 'https://drive.google.com/file/d/ZZZ/view', category: 'form', type: 'video' });
  const root = g.DriveApp.getFolderById(g.getSettings().drive_folder_id);
  assert.equal(root.folders.length, 1);
  assert.equal(root.folders[0].name, '2026-09');
  assert.equal(root.folders[0].files.length, 2);
  assert.ok(root.folders[0].files[0].blob.name.startsWith('2026-09-17_form_'));
  const list = g.listMedia();
  deq(list.map(m => m.date), ['2026-09-20', '2026-09-17', '2026-09-16']);
  assert.equal(list[1].exercise, 'スクワット');
  assert.match(list[0].thumb, /thumbnail\?id=file_/);
});

test('サマリー / 週次レポート', () => {
  const g = fresh({ now: new Date('2026-09-22T20:00:00+08:00') });
  ['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22'].forEach((d, i) => {
    g.saveWeight(d, String(72.4 - i * 0.1), 'kg', '', '');
    g.saveCardio(d, 'walk', 30, '');
    for (let m = 1; m <= 5; m++) g.mealPlanDone(d, m);
    for (let s = 1; s <= 8; s++) g.toggleSupplement(d, s, s !== 8);
    g.addWater(d, 5000);
  });
  g.addMealItem('2026-09-19', 5, 'salmon', 150, 'sub', '');
  g.saveSet('2026-09-16', 2, 2, 'TOP', 22, 'kg', 7, '');
  g.saveSet('2026-09-16', 3, 1, 'MAIN', 40, 'kg', 10, '');
  g.saveSet('2026-09-17', 8, 2, 'TOP', 60, 'kg', 8, '');
  g.saveSet('2026-09-19', 14, 3, 'TOP', 60, 'kg', 7, '');
  g.saveSet('2026-09-20', 19, 2, 'TOP', 24, 'kg', 7, '');
  g.saveExerciseMeta('2026-09-16', 5, 'right shoulder slight discomfort on lateral raise', '', '');
  g.saveDailyComment('2026-09-18', 'slept badly');
  g.uploadMedia('YQ==', 'video/mp4', 'row.mp4', { date: '2026-09-17', category: 'form', exercise_id: 8 });
  g.uploadMedia('YQ==', 'image/jpeg', 'front.jpg', { date: '2026-09-22', category: 'body' });

  const s = g.getSummary();
  assert.equal(s.week_no, 1);
  assert.equal(s.weights.length, 7);
  assert.equal(s.weights_ma7[6].value, 72.1);
  assert.equal(s.adherence.workouts.planned, 5);
  assert.equal(s.adherence.workouts.done, 4);
  assert.equal(s.adherence.cardio.done, 7);
  assert.equal(s.adherence.meals.on_plan, 35);
  assert.equal(s.adherence.meals.subs, 1);
  assert.equal(s.adherence.supplements.pct, 88);
  assert.equal(s.adherence.water.ok, 7);
  assert.ok(s.top_sets.find(t => t.name === 'Incline DB press').points.length === 2);

  const rep = g.generateWeeklyReport(1, { share_links: true, form_via_messenger: false });
  const lines = rep.text.split('\n');
  assert.equal(lines[0], 'Week 1 (Sep 16–22) Report');
  assert.equal(lines[1], 'Weight: 72.4 → 71.8 kg (avg 72.1)');
  assert.equal(lines[2], 'Workouts: 4/5 done, Cardio: 7/7 (210 min)');
  assert.match(lines[3], /^Top sets: .*Incline DB press 24kg×7/);
  assert.match(lines[3], /Squat 60kg×7/);
  assert.equal(lines[4], 'Meals: 35/35 on plan (1 subs: Salmon x1)');
  assert.equal(lines[5], 'Supplements: 88%');
  assert.equal(lines[6], 'Water: 7/7 days ≥ 5L');
  assert.match(lines[7], /^Notes: slept badly; Lateral raise: right shoulder/);
  assert.match(lines[8], /^Form check videos: https:\/\/drive\.google\.com\/file\/d\/file_0/);
  assert.match(lines[9], /^Body photos: https:\/\/drive\.google\.com/);
  const rep2 = g.generateWeeklyReport(1, { form_via_messenger: true });
  assert.equal(rep2.text.split('\n')[8], 'Form check videos: sent via Messenger');

  // 2 週目: 前週→今週の TOP 表示
  g.saveSet('2026-09-23', 2, 2, 'TOP', 26, 'kg', 6, '');
  const rep3 = g.generateWeeklyReport(2, {});
  assert.match(rep3.text.split('\n')[3], /Incline DB press 22→26kg×6/);
});

test('AI 推定: Claude API のレスポンスを foods に source=ai で追加', () => {
  let captured;
  const g = fresh({
    fetch: (url, opt) => {
      captured = { url, opt };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"name_ja":"納豆","name_en":"Natto","kcal":190,"p":16.5,"f":10,"c":12.1,"note":"1 pack ≈ 45g"}' }] }) };
    }
  });
  assert.throws(() => g.estimateFoodWithAi('納豆'), /ANTHROPIC_API_KEY/);
  g._props.ANTHROPIC_API_KEY = 'sk-test';
  const f = g.estimateFoodWithAi('納豆');
  assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
  const body = JSON.parse(captured.opt.payload);
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.equal(captured.opt.headers['x-api-key'], 'sk-test');
  assert.equal(f.source, 'ai');
  assert.equal(f.kcal, 190);
  assert.equal(f.food_id, 'natto');
  assert.ok(g.readRows_('foods').find(x => x.food_id === 'natto'));
  // 同名 2 回目は id が衝突しない
  const f2 = g.estimateFoodWithAi('納豆');
  assert.notEqual(f2.food_id, 'natto');
});
