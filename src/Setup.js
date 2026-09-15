/**
 * ① シート生成 + 初期データ投入。
 * スクリプトエディタから setupSheets() を 1 回実行する。
 * 既存シートは残し、足りないシート・ヘッダーだけ作る。ログシートは触らない。
 */
function setupSheets() {
  var ss = getSs_();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var header = SHEETS[name];
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // 日付/時刻列は文字列として保存する
    header.forEach(function (h, i) {
      if (['date', 'time', 'created_at', 'value', 'start_date'].indexOf(h) >= 0 || name === 'settings') {
        sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
      }
    });
  });
  var s = ss.getSheetByName('Sheet1') || ss.getSheetByName('シート1');
  if (s && ss.getSheets().length > 1) ss.deleteSheet(s);
  seedIfEmpty_();
  ensureDriveFolder_();
  return 'OK: ' + Object.keys(SHEETS).length + ' sheets';
}

/** マスタ系が空のときだけ初期データを投入。 */
function seedIfEmpty_() {
  if (readRows_('settings').length === 0) appendRows_('settings', seedSettings_());
  if (readRows_('plan_days').length === 0) appendRows_('plan_days', seedPlanDays_());
  if (readRows_('plan_exercises').length === 0) appendRows_('plan_exercises', seedPlanExercises_());
  if (readRows_('plan_meals').length === 0) appendRows_('plan_meals', seedPlanMeals_());
  if (readRows_('plan_supplements').length === 0) appendRows_('plan_supplements', seedPlanSupplements_());
  if (readRows_('plan_routine').length === 0) appendRows_('plan_routine', seedPlanRoutine_());
  if (readRows_('foods').length === 0) appendRows_('foods', seedFoods_());
  if (readRows_('plan_sets').length === 0) rebuildPlanSets();
  getSettings._cache = null;
}

/**
 * plan_exercises.set_scheme を plan_sets に展開し直す。
 * コーチ回答で set_scheme を編集したあとに手動実行する。
 */
function rebuildPlanSets() {
  var exercises = readRows_('plan_exercises');
  var rows = [];
  exercises.forEach(function (ex) {
    parseSetScheme_(ex.set_scheme).forEach(function (s) {
      rows.push({ exercise_id: ex.id, set_no: s.set_no, set_type: s.set_type, target_reps_min: s.target_reps_min, target_reps_max: s.target_reps_max, note: '' });
    });
  });
  var sh = getSheet_('plan_sets');
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, SHEETS.plan_sets.length).clearContent();
  appendRows_('plan_sets', rows);
  return rows.length + ' sets';
}

/** Drive の TrainingLog ルートフォルダを作成し settings.drive_folder_id に保存。 */
function ensureDriveFolder_() {
  var s = getSettings();
  if (s.drive_folder_id) {
    try { DriveApp.getFolderById(s.drive_folder_id); return s.drive_folder_id; } catch (e) { /* recreate */ }
  }
  var it = DriveApp.getFoldersByName('TrainingLog');
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder('TrainingLog');
  setSetting('drive_folder_id', folder.getId());
  return folder.getId();
}

/** 全ログを削除して初期状態に戻す（マスタは維持）。テスト用。 */
function resetLogs() {
  Object.keys(SHEETS).forEach(function (name) {
    if (name.indexOf('log_') !== 0) return;
    var sh = getSheet_(name);
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, SHEETS[name].length).clearContent();
  });
  return 'logs cleared';
}
