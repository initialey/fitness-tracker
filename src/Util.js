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

if (typeof module !== 'undefined') {
  module.exports = {
    parseYmd_: parseYmd_, addDays_: addDays_, diffDays_: diffDays_, calcDayNo_: calcDayNo_,
    calcWeekNo_: calcWeekNo_, weekRange_: weekRange_, kgToLb_: kgToLb_, lbToKg_: lbToKg_, toKg_: toKg_,
    parseSetScheme_: parseSetScheme_, parseItemsJson_: parseItemsJson_, calcMacros_: calcMacros_,
    movingAverage_: movingAverage_, pct_: pct_, fmtWeight_: fmtWeight_, shortRange_: shortRange_, round1_: round1_
  };
}
