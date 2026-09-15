/** Web アプリのエントリ。 */
function doGet(e) {
  var t = typeof BUNDLED_FILES !== 'undefined'
    ? HtmlService.createTemplate(BUNDLED_FILES.Index)
    : HtmlService.createTemplateFromFile('Index');
  t.bootstrap = JSON.stringify(bootstrap_());
  return t.evaluate()
    .setTitle('Training Log')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-status-bar-style', 'black-translucent')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** 単一ファイル版（dist/Code.gs）では BUNDLED_FILES から、通常はファイルから読む。 */
function include(name) {
  if (typeof BUNDLED_FILES !== 'undefined') return BUNDLED_FILES[name];
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function bootstrap_() {
  var s = getSettings();
  return { today: todayYmd_(), unit: s.unit, start_date: s.start_date, coach_name: s.coach_name, water_goal_ml: Number(s.water_goal_ml) || 5000 };
}

/** 画面共通: 今日の日付と単位を返す（日付切替時などに使用）。 */
function getBootstrap() {
  return bootstrap_();
}
