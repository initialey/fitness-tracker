/** ⑤ メディア（写真・動画）API。Drive の TrainingLog/YYYY-MM/ に保存。 */
function monthFolder_(dateYmd) {
  var rootId = ensureDriveFolder_();
  var root = DriveApp.getFolderById(rootId);
  var name = String(dateYmd).slice(0, 7);
  var it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

/**
 * base64 でアップロード。GAS の 1 リクエスト上限（約 50MB）を超える場合はクライアント側で弾く。
 * meta: {date, category(body/form/meal), exercise_id, note}
 */
function uploadMedia(base64, mimeType, fileName, meta) {
  var date = meta.date || todayYmd_();
  var bytes = Utilities.base64Decode(base64);
  var blob = Utilities.newBlob(bytes, mimeType, date + '_' + (meta.category || 'misc') + '_' + fileName);
  var folder = monthFolder_(date);
  var file = folder.createFile(blob);
  var type = /^video\//.test(mimeType) ? 'video' : 'photo';
  var url = file.getUrl();
  withLock_(function () {
    appendRow_('log_media', { date: date, type: type, category: meta.category || 'body', drive_url: url, exercise_id: meta.exercise_id || '', note: meta.note || '' });
  });
  return { url: url, type: type, id: file.getId() };
}

/** Drive アプリで直接アップした URL を登録。 */
function addMediaUrl(meta) {
  if (!meta.drive_url) throw new Error('URL を入力してください');
  var type = meta.type || 'video';
  withLock_(function () {
    appendRow_('log_media', { date: meta.date || todayYmd_(), type: type, category: meta.category || 'form', drive_url: meta.drive_url, exercise_id: meta.exercise_id || '', note: meta.note || '' });
  });
  return { ok: true };
}

function listMedia(limit) {
  var rows = readRows_('log_media').sort(function (a, b) { return b.date.localeCompare(a.date) || b._row - a._row; });
  var exs = {};
  readRows_('plan_exercises').forEach(function (e) { exs[Number(e.id)] = e.name_ja; });
  return rows.slice(0, limit || 100).map(function (r) {
    var id = driveIdFromUrl_(r.drive_url);
    return { _row: r._row, date: r.date, type: r.type, category: r.category, drive_url: r.drive_url,
      thumb: id ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w400' : '',
      exercise: r.exercise_id !== '' ? (exs[Number(r.exercise_id)] || '') : '', note: r.note };
  });
}

function deleteMedia(rowIndex) {
  return withLock_(function () { deleteRow_('log_media', Number(rowIndex)); return { ok: true }; });
}

function driveIdFromUrl_(url) {
  var m = /\/d\/([A-Za-z0-9_-]+)/.exec(String(url)) || /[?&]id=([A-Za-z0-9_-]+)/.exec(String(url));
  return m ? m[1] : '';
}

/** 共有用: ファイルを「リンクを知っている全員（閲覧）」にする。 */
function shareMediaForCoach(url) {
  var id = driveIdFromUrl_(url);
  if (!id) throw new Error('Drive URL ではありません');
  var f = DriveApp.getFileById(id);
  f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { url: f.getUrl() };
}

function listExercisesForSelect() {
  return readRows_('plan_exercises').filter(function (e) { return e.active !== false; })
    .sort(function (a, b) { return Number(a.day_no) - Number(b.day_no) || Number(a.order) - Number(b.order); })
    .map(function (e) { return { id: Number(e.id), label: 'Day' + e.day_no + ' ' + e.name_ja }; });
}
