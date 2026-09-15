/**
 * シート読み書きの共通ヘルパー。
 * 日付列は 'YYYY-MM-DD' の文字列として扱う（TZ ずれ防止のため列書式は文字列）。
 */
function getSs_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name) {
  var sh = getSs_().getSheetByName(name);
  if (!sh) throw new Error('シートがありません: ' + name + ' （setupSheets を実行してください）');
  return sh;
}

/** ヘッダー行をキーにしたオブジェクト配列で返す。 */
function readRows_(name) {
  var sh = getSheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var header = SHEETS[name];
  var values = sh.getRange(2, 1, last - 1, header.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var empty = true;
    var obj = { _row: i + 2 };
    for (var j = 0; j < header.length; j++) {
      var v = row[j];
      if (v instanceof Date) v = normalizeCell_(header[j], v);
      if (v !== '' && v != null) empty = false;
      obj[header[j]] = v;
    }
    if (!empty) out.push(obj);
  }
  return out;
}

function normalizeCell_(col, v) {
  if (col === 'date' || col === 'start_date') return formatDate_(v, getTz_());
  if (col === 'time' || col === 'created_at') return Utilities.formatDate(v, getTz_(), 'HH:mm');
  return v;
}

function appendRow_(name, obj) {
  var header = SHEETS[name];
  var row = header.map(function (h) { return obj[h] == null ? '' : obj[h]; });
  getSheet_(name).appendRow(row);
  return row;
}

function appendRows_(name, objs) {
  if (!objs.length) return;
  var header = SHEETS[name];
  var rows = objs.map(function (obj) {
    return header.map(function (h) { return obj[h] == null ? '' : obj[h]; });
  });
  var sh = getSheet_(name);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
}

function updateRow_(name, rowIndex, obj) {
  var header = SHEETS[name];
  var sh = getSheet_(name);
  var cur = sh.getRange(rowIndex, 1, 1, header.length).getValues()[0];
  var row = header.map(function (h, i) { return obj.hasOwnProperty(h) ? (obj[h] == null ? '' : obj[h]) : cur[i]; });
  sh.getRange(rowIndex, 1, 1, header.length).setValues([row]);
}

function deleteRow_(name, rowIndex) {
  getSheet_(name).deleteRow(rowIndex);
}

/** 条件に一致する行を後ろから削除（行番号ズレ防止）。 */
function deleteRowsWhere_(name, pred) {
  var rows = readRows_(name).filter(pred);
  var sh = getSheet_(name);
  rows.sort(function (a, b) { return b._row - a._row; });
  rows.forEach(function (r) { sh.deleteRow(r._row); });
  return rows.length;
}

function findRows_(name, pred) {
  return readRows_(name).filter(pred);
}

function findRow_(name, pred) {
  var rows = findRows_(name, pred);
  return rows.length ? rows[0] : null;
}

function nextId_(name, idCol) {
  var rows = readRows_(name);
  var max = 0;
  rows.forEach(function (r) { var n = Number(r[idCol]); if (n > max) max = n; });
  return max + 1;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}
