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
