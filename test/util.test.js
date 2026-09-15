'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
global.LB_TO_KG = 0.45359237;
const U = require('../src/Util.js');

test('calcDayNo_: 7日周期で Day1〜7、開始日前も成立', () => {
  assert.equal(U.calcDayNo_('2026-09-16', '2026-09-16'), 1);
  assert.equal(U.calcDayNo_('2026-09-16', '2026-09-18'), 3);
  assert.equal(U.calcDayNo_('2026-09-16', '2026-09-22'), 7);
  assert.equal(U.calcDayNo_('2026-09-16', '2026-09-23'), 1);
  assert.equal(U.calcDayNo_('2026-09-16', '2026-09-15'), 7);
});

test('calcWeekNo_ / weekRange_', () => {
  assert.equal(U.calcWeekNo_('2026-09-16', '2026-09-16'), 1);
  assert.equal(U.calcWeekNo_('2026-09-16', '2026-09-22'), 1);
  assert.equal(U.calcWeekNo_('2026-09-16', '2026-09-23'), 2);
  assert.deepEqual(U.weekRange_('2026-09-16', 1), { start: '2026-09-16', end: '2026-09-22' });
  assert.deepEqual(U.weekRange_('2026-09-16', 3), { start: '2026-09-30', end: '2026-10-06' });
});

test('単位換算: 保存は kg、小数1桁', () => {
  assert.equal(U.lbToKg_(100), 45.4);
  assert.equal(U.kgToLb_(72.4), 159.6);
  assert.equal(U.toKg_('160', 'lb'), 72.6);
  assert.equal(U.toKg_('72.44', 'kg'), 72.4);
  assert.equal(U.toKg_('', 'kg'), '');
  assert.equal(U.toKg_('abc', 'kg'), '');
});

test('parseSetScheme_: WU/TOP/BO と MAINx3,DROP', () => {
  assert.deepEqual(U.parseSetScheme_('WU10-12,TOP6-8,BO10-12'), [
    { set_no: 1, set_type: 'WU', target_reps_min: 10, target_reps_max: 12 },
    { set_no: 2, set_type: 'TOP', target_reps_min: 6, target_reps_max: 8 },
    { set_no: 3, set_type: 'BO', target_reps_min: 10, target_reps_max: 12 }
  ]);
  const m = U.parseSetScheme_('MAIN10-12x3,DROP10-12');
  assert.equal(m.length, 4);
  assert.deepEqual(m.map(s => s.set_type), ['MAIN', 'MAIN', 'MAIN', 'DROP']);
  assert.deepEqual(m.map(s => s.set_no), [1, 2, 3, 4]);
  assert.deepEqual(U.parseSetScheme_('MAIN8'), [{ set_no: 1, set_type: 'MAIN', target_reps_min: 8, target_reps_max: 8 }]);
  assert.deepEqual(U.parseSetScheme_(''), []);
  assert.throws(() => U.parseSetScheme_('BAD'), /記法が不正/);
});

test('calcMacros_: 100g とスクープ', () => {
  assert.deepEqual(U.calcMacros_({ per: '100g', kcal: 165, p: 31, f: 3.6, c: 0 }, 150), { kcal: 247.5, p: 46.5, f: 5.4, c: 0 });
  assert.deepEqual(U.calcMacros_({ per: '1scoop', kcal: 120, p: 24, f: 1.5, c: 3 }, 2), { kcal: 240, p: 48, f: 3, c: 6 });
});

test('movingAverage_ 7日', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8].map((x, i) => ({ date: 'd' + i, value: x }));
  const ma = U.movingAverage_(v, 7);
  assert.equal(ma[0].value, 1);
  assert.equal(ma[6].value, 4);
  assert.equal(ma[7].value, 5);
});

test('shortRange_ / parseItemsJson_', () => {
  assert.equal(U.shortRange_('2026-09-16', '2026-09-22'), 'Sep 16–22');
  assert.equal(U.shortRange_('2026-09-30', '2026-10-06'), 'Sep 30–Oct 6');
  assert.deepEqual(U.parseItemsJson_('[{"food_id":"a","grams":1}]'), [{ food_id: 'a', grams: 1 }]);
  assert.deepEqual(U.parseItemsJson_('nope'), []);
});

test('parseAiJson_: コードフェンス混じりでも JSON を拾う', () => {
  const { parseAiJson_ } = require('../src/Ai.js');
  const r = parseAiJson_('```json\n{"name_ja":"納豆","name_en":"Natto","kcal":190,"p":16.5,"f":10,"c":12.1,"note":"x"}\n```');
  assert.equal(r.kcal, 190);
  assert.throws(() => parseAiJson_('{"kcal":"?"}'), /数値ではありません/);
});
