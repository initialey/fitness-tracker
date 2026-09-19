'use strict';
/**
 * Artifact 版の全体テスト: node test/artifact-e2e.js
 *  - mock モード: window.claude なし（メモリ上で動く）
 *  - db モード : window.claude.use を疑似ランタイムで注入（db は Node 側に永続、assets/sample/downloads も模擬）
 * 結果を artifact/TEST.md に書き出す。スクリーンショットは test/screens/。
 */
const path = require('path');
const fs = require('fs');
let playwright; try { playwright = require('playwright'); } catch (e) { playwright = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); }
const FILE = 'file://' + path.join(__dirname, '..', 'artifact', 'index.html');
const OUT = path.join(__dirname, 'screens'); fs.mkdirSync(OUT, { recursive: true });
const T0 = '2026-09-16T06:50:00+08:00';

/* ---------------- 疑似ランタイム（Node 側ストア） ---------------- */
function makeRuntime() {
  const DB = {}, assets = [], downloads = [], sampleCalls = [];
  const rt = { DB, assets, downloads, sampleCalls,
    op(op, a) {
      switch (op) {
        case 'get': return { exists: !!(DB[a.coll] && DB[a.coll][a.id]), data: DB[a.coll] && DB[a.coll][a.id] || null };
        case 'set': (DB[a.coll] = DB[a.coll] || {})[a.id] = JSON.parse(JSON.stringify(a.data)); return null;
        case 'del': if (DB[a.coll]) delete DB[a.coll][a.id]; return null;
        case 'list': return Object.entries(DB[a.coll] || {}).map(([id, data]) => ({ id, data }));
        case 'asset': assets.push(a); return null;
        case 'download': downloads.push(a); return null;
        case 'sample': sampleCalls.push(a); return null;
      }
    } };
  return rt;
}
// ページ側に注入するシム（db/assets/sample/downloads）
const SHIM = `(() => {
  const call = (op, a) => window.__rt(op, a);
  // 自分の書き込みは即スナップショットに反映（実 db の latency compensation を模す）
  const PENDING = {};
  const snap = (id, d) => ({ id, exists: !!d, data: () => d || undefined, metadata: { fromCache: false, hasPendingWrites: false } });
  const merge = (coll, rows) => { const p = PENDING[coll] || {}; const map = {}; rows.forEach(r => { map[r.id] = r.data; }); Object.keys(p).forEach(id => { if (JSON.stringify(map[id] || null) === JSON.stringify(p[id])) delete p[id]; else if (p[id] === null) delete map[id]; else map[id] = p[id]; }); return Object.keys(map).sort().map(id => ({ id, data: map[id] })); };
  const mkColl = (coll) => ({ path: coll,
    doc: (id) => ({ id, path: coll + '/' + id,
      get: async () => { const r = await call('get', { coll, id }); return snap(id, r.exists ? r.data : null); },
      set: async (data) => { (PENDING[coll] = PENDING[coll] || {})[id] = JSON.parse(JSON.stringify(data)); await call('set', { coll, id, data }); },
      update: async (data) => { const r = await call('get', { coll, id }); if (!r.exists) throw { code: 'invalid_argument', message: 'no doc' }; await call('set', { coll, id, data: Object.assign({}, r.data, data) }); },
      delete: async () => { (PENDING[coll] = PENDING[coll] || {})[id] = null; await call('del', { coll, id }); } }),
    onSnapshot: (next, err) => { let last = null, alive = true;
      const tick = async () => { if (!alive) return; const rows = merge(coll, await call('list', { coll })); const j = JSON.stringify(rows); if (j !== last) { last = j; next({ docs: rows.map(r => snap(r.id, r.data)), size: rows.length, empty: !rows.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } }); } };
      tick(); const h = setInterval(tick, 150); return () => { alive = false; clearInterval(h); }; } });
  const db = { collection: mkColl, doc: (p) => { const seg = p.split('/'); return mkColl(seg.slice(0, -1).join('/')).doc(seg[seg.length - 1]); } };
  const OPTS = window.__rtOpts || {};
  const assets = { upload: async (blob) => { const id = ('a' + Math.random().toString(36).slice(2)).padEnd(32, '0').slice(0, 32); await call('asset', { id, type: blob.type, size: blob.size }); return { id, url: '/_blob/' + id, sizeBytes: blob.size, contentType: blob.type }; }, list: async () => ({ assets: [], usage: {} }), delete: async () => ({ deleted: true }) };
  const sample = Object.assign(async (input) => ({ text: 'ok', truncated: false, modelTierApplied: 'quick' }), {
    json: async (input, opts) => { opts = opts || {}; const img = opts.images ? (Array.isArray(opts.images) ? opts.images[0] : opts.images) : null; await call('sample', { prompt: String(input).slice(0, 80), hasImage: !!img, imageSize: img ? img.size : 0, imageType: img ? img.type : '', tier: opts.modelTier || '' });
      if (img && OPTS.noImages) { const e = new Error('images not supported in this view'); e.code = 'images_unavailable'; throw e; }
      if (img) { if (/BAD/.test(input)) return { oops: 'not the shape' }; return { items: [{ name_ja: '白ご飯', name_en: 'White rice', grams: 200, kcal: 312, p: 5, f: 1, c: 69 }, { name_ja: '鶏の唐揚げ', name_en: 'Fried chicken', grams: 120, kcal: 340, p: 20, f: 22, c: 12 }], total: { kcal: 652, p: 25, f: 23, c: 81 }, confidence: 'medium', note: '皿の大きさから推定' }; }
      if (/meal note/.test(input)) return [{ foodId: 'salmon', nameJa: 'サーモン', nameEn: 'Salmon', amount: 150, kcal: 0, p: 0, f: 0, c: 0, note: '' }, { foodId: null, nameJa: '納豆', nameEn: 'Natto', amount: 45, kcal: 190, p: 16.5, f: 10, c: 12.1, note: '1 pack' }];
      return { nameJa: '納豆', nameEn: 'Natto', kcal: 190, p: 16.5, f: 10, c: 12.1, note: '1 pack' }; },
    limits: async () => (OPTS.noImages ? { maxPromptBytes: 65536 } : { maxPromptBytes: 65536, images: { maxCount: 1, maxInputBytes: 20000000, mediaTypes: ['image/jpeg', 'image/png', 'image/webp'] } }) });
  const downloads = { save: async (req) => { await call('download', { filename: req.filename, size: String(req.data).length, head: String(req.data).slice(0, 200) }); return { status: 'saved' }; } };
  window.claude = { use: async (name) => ({ db, assets: OPTS.noAssets ? null : assets, sample, downloads })[name] || null };
})();`;

/* ---------------- テスト実行 ---------------- */
const results = []; // {group, name, mock, db, note}
function rec(group, name, mode, ok, note) { let r = results.find(x => x.group === group && x.name === name); if (!r) { r = { group, name, mock: '—', db: '—', note: '' }; results.push(r); } r[mode] = ok ? '✓' : '✗'; if (note) r.note = (r.note ? r.note + ' / ' : '') + note; }
async function run(mode) {
  const rt = makeRuntime();
  const browser = await playwright.chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: 'Asia/Manila' });
  const errors = [];
  const newPage = async (opts) => {
    const page = await ctx.newPage();
    if (opts) await page.addInitScript('window.__rtOpts = ' + JSON.stringify(opts) + ';');
    page.setDefaultTimeout(8000);
    await page.clock.setFixedTime(new Date(T0));
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/fonts.googleapis|ERR_/.test(m.text())) errors.push('console: ' + m.text()); });
    page.on('dialog', d => d.accept(d.type() === 'prompt' ? (d.message().includes('代替') ? 'フロアプレス' : d.message().includes('理由') ? '時間がない' : '25') : undefined));
    await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    if (mode === 'db') { await page.exposeFunction('__rt', (op, a) => rt.op(op, a)); await page.addInitScript(SHIM); }
    await page.goto(FILE);
    await page.waitForFunction(() => !document.querySelector('#view .loading'), null, { timeout: 15000 });
    return page;
  };
  // 前回値（9/9 = Day1）を db に仕込む: インクライン トップ 22×8（上限到達）, サイドレイズ メイン 10×12（上限到達）
  if (mode === 'db') rt.op('set', { coll: 'log_workout', id: '2026-09-09', data: { date: '2026-09-09', sets: { '2_2': { exerciseId: 2, setNo: 2, setType: 'TOP', weightKg: 22, reps: 8 }, '5_1': { exerciseId: 5, setNo: 1, setType: 'MAIN', weightKg: 10, reps: 12 }, '1_1': { exerciseId: 1, setNo: 1, setType: 'MAIN', weightKg: 8, reps: 12 } }, meta: {}, warmup: { done: '08:40' } } });
  let page = await newPage();
  const text = async (sel) => (await page.locator(sel).first().textContent()).trim();
  const has = async (sel) => !!(await page.$(sel));
  const shot = async (n) => { await page.waitForTimeout(150); await page.screenshot({ path: path.join(OUT, 'art-' + mode + '-' + n + '.png'), fullPage: true }); };
  const cleanup = async () => { try { await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.className = 'toast'; }); if (await has('#dlg:not([hidden])')) { await page.click('#dlg', { position: { x: 5, y: 5 } }); await page.waitForTimeout(80); } if (await has('#sheet:not([hidden])')) { await page.click('#sheet', { position: { x: 5, y: 5 } }); await page.waitForSelector('#sheet', { state: 'hidden' }); } if (await has('#rest:not([hidden])')) { await page.click('#skipRest'); } await page.waitForTimeout(100); } catch (e) { /* ignore */ } };
  const T = async (group, name, fn) => { try { const note = await fn(); rec(group, name, mode, true, typeof note === 'string' ? note : ''); console.log('ok   [' + mode + '] ' + name); } catch (e) { rec(group, name, mode, false, e.message); console.error('FAIL [' + mode + '] ' + name + ': ' + e.message); } await cleanup(); };
  const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
  const setTime = async (iso) => { await page.clock.setFixedTime(new Date(iso)); };
  const goTab = async (tab) => { await page.click('.tabs [data-tab="' + tab + '"]'); await page.waitForTimeout(120); };
  const closeSheet = async () => { if (await has('#sheet:not([hidden])')) { await page.click('#sheet', { position: { x: 5, y: 5 } }); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(150); } };
  const gotoEx = async (i) => { for (let g = 0; g < 12; g++) { if (await has('#rest:not([hidden])')) { await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden])'); } const m = /種目 (\d+)\//.exec(await text('.ex-head .p')); const cur = Number(m[1]) - 1; if (cur === i) return; await page.click('[data-ex="' + (cur < i ? 1 : -1) + '"]'); await page.waitForTimeout(60); } throw new Error('gotoEx ' + i); };
  const dlgOk = async (fillText) => { await page.waitForSelector('#dlg:not([hidden])'); if (fillText != null) { await page.fill('#dlgIn', fillText); } await page.click('#dlgOk'); await page.waitForSelector('#dlg', { state: 'hidden' }); await page.waitForTimeout(120); };
  const mark = async (id) => page.$eval('[data-step="' + id + '"]', e => e.dataset.mark + '|' + e.querySelector('.chk').className + '|' + e.querySelector('.chk').textContent);
  const pickReason = async (label) => { await page.waitForSelector('[data-reason]'); await page.click('[data-reason="' + label + '"]'); await page.waitForFunction(() => document.querySelector('#dlg').hidden || !document.querySelector('[data-reason]')); await page.waitForTimeout(80); };
  const G = { today: '今日画面', missed: '欠測・できなかった', workout: '筋トレ画面', meal: '食事シート', week: '週画面', common: '共通' };

  // ============ 共通（先に） ============
  await T(G.common, 'db が null でもモックモードで動き「保存されていません」の帯が出る', async () => { if (mode === 'mock') assert((await text('.mode')).includes('保存されていません'), 'banner'); else assert(!(await has('.mode')), 'no banner in db'); });
  await T(G.common, 'タブは 今日・筋トレ・水・週 の 4 つ', async () => { const tabs = await page.$$eval('.tabs button', els => els.map(e => e.dataset.tab)); assert(JSON.stringify(tabs) === '["today","workout","water","summary"]', tabs.join()); const labels = await page.$$eval('.tabs button .ic', els => els.map(e => e.textContent)); assert(labels.join(',') === '今日,筋トレ,水,週', labels.join(',')); });
  await T(G.common, '375〜430px で横スクロールなし・下タブが safe-area にかぶらない', async () => { for (const w of [375, 390, 430]) { await page.setViewportSize({ width: w, height: 844 }); await page.waitForTimeout(60); const sw = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1); assert(sw, 'hscroll at ' + w); } await page.setViewportSize({ width: 390, height: 844 }); const pb = await page.$eval('.tabs', e => getComputedStyle(e).paddingBottom); return 'tabs padding-bottom=' + pb + '（env(safe-area-inset-bottom) 加算）'; });

  // ============ 今日画面 ============
  await T(G.today, '日付 ‹ › で前日・翌日へ移動し、今日に戻れる', async () => { await page.click('[data-shift="1"]'); assert((await text('.date')).includes('9/17'), 'next'); await page.click('[data-shift="-1"]'); await page.click('[data-shift="-1"]'); assert((await text('.date')).includes('9/15'), 'prev'); await page.click('[data-shift="1"]'); assert((await text('.date')).includes('9/16') && !(await text('.date')).includes('過去'), 'back to today'); });
  await T(G.today, 'Day 判定: 9/16=Day1 … 9/22=Day7 → 9/23=Day1', async () => { const want = ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7', 'Day 1']; for (let i = 0; i < 8; i++) { assert((await text('h1')).startsWith(want[i]), '9/' + (16 + i) + ' → ' + (await text('h1'))); if (i < 7) await page.click('[data-shift="1"]'); } for (let i = 0; i < 7; i++) await page.click('[data-shift="-1"]'); assert((await text('h1')).startsWith('Day 1'), 'back'); });
  await T(G.today, '全行で「…」省略なし。サプリ名・食材が全部表示', async () => { const rows = await page.$$eval('.step', els => els.map(e => e.textContent)); assert(!rows.some(r => r.includes('…')), 'ellipsis'); assert(rows.some(r => r.includes('経口サプリ') && r.includes('B12＋D3') && r.includes('ベルベリン') && r.includes('フィッシュオイル') && r.includes('亜鉛') && !r.includes('クレアチン')), 'oral supp names, no creatine'); assert(rows.some(r => r.includes('トレ前') && r.includes('クレアチン') && r.includes('タイミング確認中')), 'creatine on its own pre-workout row'); assert(rows.some(r => r.includes('マグネシウム グリシネート 400mg 就寝前') && r.includes('アシュワガンダ 300mg 就寝前')), 'night supps with dose'); assert(rows.some(r => r.includes('腹筋（最終種目のあと') && r.includes('コーチ確認中')), 'abs row after workout'); assert(rows.some(r => r.includes('ウォームアップ') && r.includes('各10回×2セット')), 'warm-up 2 sets'); assert(rows.some(r => r.includes('全卵4個・卵白150g・塩1g')), 'meal1 items'); assert(rows.some(r => r.includes('ケーブルフライ（座位・ミッド角度）または ペックデッキ（事前疲労）・インクラインダンベルプレス・マシン インクラインプレス') && r.includes('ほか5種目') && !r.includes('アンダーハンド')), 'exercises: first 3 + ほか5種目'); });
  await T(G.today, '朝の順番: 体重 → リンゴ酢 → 1食目 → 経口サプリ → サイリウム。サプリ 07:05・サイリウム 07:20（15分後）、説明に「ゆっくり」「水500ml以上」「水1L以上」', async () => { const ids = await page.$$eval('.step', els => els.map(e => e.dataset.step)); const want = ['weight', 'routine:1', 'meal:1', 'supp:after_meal', 'routine:2']; assert(JSON.stringify(ids.slice(0, 5)) === JSON.stringify(want), 'order: ' + ids.slice(0, 6).join(',')); const tm = async id => text('[data-step="' + id + '"] .tm'); assert((await tm('weight')).includes('06:40') && (await tm('routine:1')).includes('06:45') && (await tm('meal:1')).includes('07:00') && (await tm('supp:after_meal')).includes('07:05') && (await tm('routine:2')).includes('07:20'), 'times: ' + [await tm('weight'), await tm('routine:1'), await tm('meal:1'), await tm('supp:after_meal'), await tm('routine:2')].join(' | ')); const r1 = await text('[data-step="routine:1"]'), r2 = await text('[data-step="routine:2"]'); assert(r1.includes('大さじ1') && r1.includes('水500ml以上') && r1.includes('ゆっくり飲む') && r1.includes('食事の15分前'), 'acv row: ' + r1); assert(r2.includes('サイリウムハスク 大さじ1') && r2.includes('水1L以上') && r2.includes('ゆっくり') && r2.includes('15分後'), 'psyllium row: ' + r2); assert((await text('[data-step="supp:night"]')).includes('就寝前サプリ') && (await tm('supp:night')).includes('22:30'), 'night 22:30'); const u = await page.evaluate(() => [window.__tl.warmupMinutesText(289), window.__tl.warmupMinutesText(12), window.__tl.warmupMinutesText(0)]); assert(u[0] === '完了' && u[1] === '完了 12分' && u[2] === '完了', 'warm-up minutes guard: ' + u.join(',')); });
  await T(G.today, '体重 kg⇄lb 切替で換算が正しく、保存は kg', async () => { await goTab('summary'); await page.click('#unitBtn'); await page.waitForTimeout(100); await goTab('today'); assert((await text('#now .w-in .u')) === 'lb', 'unit lb'); await page.fill('#nowW', '160'); await page.click('#nowBtn'); await page.waitForFunction(() => document.querySelector('[data-step="weight"]').className.includes('done')); const row = await text('[data-step="weight"]'); assert(row.includes('160.1lb') || row.includes('160lb'), 'lb display: ' + row); if (mode === 'db') { await page.waitForTimeout(200); assert(rt.DB.log_weight['2026-09-16'].weightKg === 72.6, 'stored kg=' + rt.DB.log_weight['2026-09-16'].weightKg); } await goTab('summary'); await page.click('#unitBtn'); await page.waitForTimeout(100); await goTab('today'); assert((await text('[data-step="weight"]')).includes('72.6kg'), 'kg display'); return '160lb → 72.6kg 保存'; });
  await T(G.today, 'リンゴ酢✓ → 15分タイマー → 「いま」が1食目に変わる', async () => { await page.click('[data-chk="routine:1"]'); await page.waitForSelector('#nowTimer'); assert((await text('#now .t')) === '1食目まで', 'timer title'); assert((await text('#nowTimer')) === '15:00', 'timer 15:00'); assert((await text('[data-step="meal:1"] .tm')).includes('07:05') && (await text('[data-step="meal:1"] .tm')).includes('タイマー'), 'row shows timer end 07:05');
    if (mode === 'db') { await page.waitForTimeout(250); await setTime('2026-09-16T06:55:30+08:00'); await page.reload(); await page.waitForFunction(() => !document.querySelector('#view .loading')); await goTab('today'); await page.waitForSelector('#nowTimer'); const left = await text('#nowTimer'); assert(/^9:(2|3)\d$/.test(left), 'after reload remaining ~9:30: ' + left); } await setTime('2026-09-16T07:06:00+08:00'); await goTab('workout'); await goTab('today'); assert((await text('#now .t')) === '1食目を食べる', 'after 15min: ' + (await text('#now .t'))); });
  await T(G.today, '✓の付け外しが即反映、再読み込み後も残る（db）', async () => { await page.click('[data-chk="meal:1"]'); await page.waitForFunction(() => document.querySelector('[data-step="meal:1"]').className.includes('done')); await page.click('[data-chk="routine:1"]'); await page.waitForFunction(() => !document.querySelector('[data-step="routine:1"]').className.includes('done')); await page.click('[data-chk="routine:1"]'); await page.waitForFunction(() => document.querySelector('[data-step="routine:1"]').className.includes('done'));
    if (mode === 'db') { await page.waitForTimeout(300); await page.reload(); await page.waitForFunction(() => !document.querySelector('#view .loading')); await goTab('today'); assert((await page.$eval('[data-step="meal:1"]', e => e.className)).includes('done'), 'meal1 after reload'); assert((await page.$eval('[data-step="weight"]', e => e.className)).includes('done'), 'weight after reload'); return '再読み込み後も維持'; } return 'モックは再読み込み対象外'; });
  await T(G.today, 'サプリ✓ → 15分後にサイリウムが「いま」になる', async () => { await setTime('2026-09-16T07:20:00+08:00'); await goTab('workout'); await goTab('today'); await page.click('[data-chk="supp:after_meal"]'); await page.waitForFunction(() => document.querySelector('[data-step="supp:after_meal"]').className.includes('done')); assert(/^サイリウム.*まで$/.test(await text('#now .t')), 'timer to psyllium: ' + (await text('#now .t'))); await setTime('2026-09-16T07:36:00+08:00'); await goTab('workout'); await goTab('today'); assert(/^サイリウム/.test(await text('#now .t')) && !/まで$/.test(await text('#now .t')), 'now psyllium: ' + (await text('#now .t'))); await page.click('#nowBtn'); await page.waitForFunction(() => document.querySelector('[data-step="routine:2"]').className.includes('done')); });
  await T(G.today, '水タブ: 目標 5.0L・大数字・+500/+350/−500・達成で緑「5L 達成！」・log_daily.waterMl に保存', async () => { await page.click('[data-open="water"]'); await page.waitForSelector('#waterBig'); assert((await page.$eval('.tabs .on', e => e.dataset.tab)) === 'water', 'row tap opens water tab'); assert((await text('.card .ttl')).includes('目標 5.0 L'), 'goal'); await page.click('[data-w="500"]'); await page.click('[data-w="350"]'); await page.waitForFunction(() => document.querySelector('#waterBig').textContent.startsWith('0.85')); assert((await text('#waterStat')).includes('あと 4.15 L'), 'left'); await page.click('[data-w="-500"]'); await page.waitForFunction(() => document.querySelector('#waterBig').textContent.startsWith('0.35')); for (let i = 0; i < 10; i++) await page.click('[data-w="500"]'); await page.waitForFunction(() => document.querySelector('#waterBig').textContent.startsWith('5.35')); assert((await text('#waterStat')) === '5L 達成！' && (await page.$eval('#waterStat', e => getComputedStyle(e).color)) === (await page.$eval('#waterBig', e => getComputedStyle(e).color)), 'achieved in green'); assert(/^5\.[34] L$/.test(await text('#tabWater')), 'tab sub: ' + (await text('#tabWater'))); if (mode === 'db') { await page.waitForTimeout(200); assert(rt.DB.log_daily['2026-09-16'].waterMl === 5350, 'log_daily.waterMl: ' + JSON.stringify(rt.DB.log_daily['2026-09-16'])); } await goTab('today'); const row = await text('[data-step="water"]'); assert(row.includes('達成'), 'water row: ' + row); assert((await page.$eval('[data-step="water"]', e => e.className)).includes('done'), 'done'); });
  await T(G.today, '1日合計 kcal/PFC が記録と一致（1食目を手計算で検算）', async () => { const t = await text('.card .ttl'); assert(t.includes('1日合計'), 'block'); const body = await page.$eval('.card', e => e.textContent); // 1食目: 全卵200g=286kcal P25.2 F19 C1.4 + 卵白150g=78 P16.35 F0.3 C1.05 + 塩0 → 364 / P41.6 F19.3 C2.45
    assert(body.includes('カロリー 364'), 'kcal 364: ' + body.slice(0, 120)); assert(body.includes('タンパク質 42'), 'P 42'); assert(body.includes('脂質 19'), 'F 19'); assert(body.includes('炭水化物 2 '), 'C 2'); return '1食目 = 364kcal / P41.6 F19.3 C2.45 と一致'; });
  await shot('01-home');

  // ============ 食事シート ============
  await T(G.meal, '「プラン通り食べた」で今日の✓が付き合計に反映', async () => { await page.click('[data-open="meal:2"]'); await page.waitForSelector('#mPlan'); await page.click('#mPlan'); await page.waitForSelector('#sheet', { state: 'hidden' }); assert((await page.$eval('[data-step="meal:2"]', e => e.className)).includes('done'), 'done'); const body = await page.$eval('.card', e => e.textContent); assert(body.includes('カロリー 968'), 'total 364+604=968: ' + body.slice(0, 80)); });
  await T(G.meal, 'ソフト削除・↩戻す・元に戻すトースト・1つ戻す・プランに戻す', async () => {
    await page.click('[data-open="meal:2"]'); await page.waitForSelector('#mChange'); await page.click('#mChange'); await page.click('[data-q]:has-text("サーモン")'); await page.waitForSelector('#pendOk');
    assert((await text('.pending')).includes('サーモン150g を追加'), 'pending add'); await page.click('#pendOk'); await page.waitForSelector('.toast.act'); assert((await text('#toast')).includes('サーモン150g を追加しました'), 'toast'); await page.waitForSelector('[data-del]');
    await page.click('[data-del]'); await page.waitForSelector('[data-undel]'); assert(await has('.list .it.del'), 'soft deleted (strike)'); assert((await text('#toast')).includes('削除しました'), 'del toast');
    await page.click('[data-undel]'); await page.waitForSelector('[data-del]'); assert(!(await has('.list .it.del')), 'restored');
    await page.click('[data-del]'); await page.waitForSelector('[data-undel]'); await page.click('#toast button'); await page.waitForSelector('[data-del]'); assert(!(await has('.list .it.del')), 'toast undo restored');
    await page.click('#mUndo'); await page.waitForTimeout(150); assert(!(await has('[data-del]')), '1つ戻す → 追加前'); 
    await page.click('[data-eat="0"]'); await page.waitForFunction(() => !document.querySelector('[data-eat="0"]').classList.contains('on')); assert((await text('.sheet-body .badge')).includes('変更して記録済み'), 'uncheck → sub');
    await page.click('#mReset'); await dlgOk(); assert((await text('.sheet-body .badge')).includes('プラン通り 記録済み'), 'プランの内容に戻す → プラン通り: ' + (await text('.sheet-body .badge'))); await closeSheet(); });
  await T(G.meal, '差替えチップの置き換え/追加が意図通り。サーモンがプラン本体に混入しない', async () => { await page.click('[data-open="meal:3"]'); await page.waitForSelector('#mPlan'); const plan = await text('.sheet-body .items'); assert(!plan.includes('サーモン150g'), 'salmon 150g not in plan (170g swap option only)'); await page.click('#mChange'); const chips = await page.$$eval('[data-q]', els => els.map(e => e.textContent)); assert(chips.some(c => c.includes('サーモン 150g')), 'salmon chip'); await page.click('[data-half]'); await page.waitForSelector('#pendOk'); assert((await text('.pending')).includes('半分の量に置き換え'), 'half pending'); await page.click('#pendOk'); await page.waitForTimeout(200); assert((await text('.sheet-body .list')).includes('（プラン 150）'), 'grams replaced with plan note'); assert((await text('.sheet-body .badge')).includes('変更して記録済み'), 'sub'); await closeSheet(); });
  await T(G.meal, '自由入力→AI計算→foods に source:"ai" 追加→再利用。sample が null なら手入力に切替', async () => { await page.click('[data-open="meal:5"]'); await page.waitForSelector('#mChange'); await page.click('#mChange');
    if (mode === 'mock') { assert((await text('#freeBtn')) === '記録', 'no AI → 記録'); assert(await has('#manualBtn'), 'manual link'); await page.fill('#freeTxt', 'サーモン150 米150'); await page.click('#freeBtn'); await page.waitForSelector('.toast.act'); assert((await text('#toast')).includes('サーモン150g を追加、白米150g（炊飯後基準） を追加'), 'local match: ' + (await text('#toast'))); await closeSheet(); return 'sample null → 手入力／ローカル一致のみ'; }
    assert((await text('#freeBtn')) === 'AI 計算', 'AI button'); await page.fill('#freeTxt', 'サーモン150 納豆45'); await page.click('#freeBtn'); await page.waitForSelector('.toast.act'); assert((await text('#toast')).includes('納豆45g を追加'), 'ai added: ' + (await text('#toast'))); await page.waitForTimeout(200); assert(rt.DB.foods.natto && rt.DB.foods.natto.source === 'ai', 'foods natto source=ai'); const n1 = rt.sampleCalls.length;
    await page.fill('#freeTxt', '納豆45'); await page.click('#freeBtn'); await page.waitForSelector('.toast.act'); await page.waitForTimeout(200); assert(rt.sampleCalls.length === n1, 'reuse without AI call'); await closeSheet(); return 'AI 呼び出し ' + rt.sampleCalls.length + ' 回（2 回目はローカル一致で 0 回）'; });
  await T(G.meal, '4食目の代替案（白米150・鶏100・全卵1）を選べる', async () => { await page.click('[data-open="meal:4"]'); await page.waitForSelector('#mAlt'); assert((await text('#mAlt')).includes('白米150g・鶏胸肉100g・全卵1個'), 'alt label'); await page.click('#mAlt'); await page.waitForSelector('#sheet', { state: 'hidden' }); assert((await text('[data-step="meal:4"]')).includes('代替案で記録'), 'alt logged'); });
  await T(G.meal, '米の基準（生/炊飯後）表示が settings に連動', async () => { assert((await text('[data-step="meal:3"]')).includes('炊飯後基準'), 'cooked default'); await goTab('summary'); await page.click('#riceBtn'); await page.waitForTimeout(150); await goTab('today'); assert((await text('[data-step="meal:2"]')).includes('生米基準'), 'raw after toggle'); assert((await text('.card .ttl')).includes('生米基準'), 'totals note'); await goTab('summary'); await page.click('#riceBtn'); await page.waitForTimeout(150); await goTab('today'); });
  await T(G.meal, '状態4種の表示: 未記録○ / プラン通り緑✓ / 変更あり黄✓ / スキップ赤−', async () => { await page.click('[data-open="meal:3"]'); await page.waitForSelector('#mChange'); await page.click('#mChange'); await page.click('[data-skip]'); await pickReason('外食'); await page.waitForSelector('#pendOk'); assert((await text('.pending')).includes('外食'), 'pending shows reason'); await page.click('#pendOk'); await page.waitForTimeout(150); await closeSheet();
    let m = await mark('meal:3'); assert((await text('[data-step="meal:3"]')).includes('スキップ（外食）'), 'row shows skip reason'); assert(m.startsWith('skip|chk skip|−'), 'skip mark: ' + m); assert((await text('[data-step="meal:3"] .lbl-sub')) === 'スキップ', 'skip label'); assert(!(await page.$('[data-step="meal:3"] .chk.on')), 'no green check on skip');
    await page.click('[data-open="meal:2"]'); await page.waitForSelector('#mChange'); m = await mark('meal:2'); await closeSheet(); assert(m.startsWith('ok|chk on|✓'), 'plan mark: ' + m);
    await page.click('[data-open="meal:4"]'); await page.waitForSelector('#mChange'); await page.click('#mChange'); await page.click('[data-q]:has-text("サーモン")'); await page.waitForSelector('#pendOk'); await page.click('#pendOk'); await page.waitForTimeout(150); await closeSheet(); m = await mark('meal:4'); assert(m.startsWith('sub|chk sub|✓'), 'sub mark: ' + m); assert((await text('[data-step="meal:4"] .lbl-sub')) === '変更あり', 'sub label');
    // 5食目は前のテストで変更ありになっているので、✓再タップで取り消して未記録○を確認
    await page.click('[data-chk="meal:5"]'); await page.waitForFunction(() => document.querySelector('[data-step="meal:5"]').dataset.mark === ''); m = await mark('meal:5'); assert(m.startsWith('|chk|'), 'unlogged mark: ' + m); });
  await T(G.meal, 'スキップ→取り消し→プラン通り→取り消し→変更→取り消し: 毎回 未記録に戻り合計が0', async () => {
    // 5食目で往復。合計は 5食目分だけ見る（他の食事は記録済みなので差分で確認）
    const total = async () => Number((await page.$eval('.card', e => e.textContent)).match(/カロリー ([\d,]+)/)[1].replace(/,/g, ''));
    const base = await total();
    const cancelViaSheet = async () => { await page.click('[data-open="meal:5"]'); await page.waitForSelector('#mCancel'); await page.click('#mCancel'); await dlgOk(); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(150); assert((await mark('meal:5')).startsWith('|chk|'), 'back to unlogged'); assert((await total()) === base, 'total back to base ' + base + ': ' + (await total())); if (mode === 'db') assert(!(rt.DB.log_meals['2026-09-16'].meals || {})[5], 'db doc removed'); };
    await page.click('[data-open="meal:5"]'); await page.waitForSelector('#mChange'); await page.click('#mChange'); await page.click('[data-skip]'); await pickReason('時間なし'); await page.waitForSelector('#pendOk'); await page.click('#pendOk'); await page.waitForTimeout(150); await closeSheet(); assert((await mark('meal:5')).startsWith('skip|'), 'skip'); await cancelViaSheet();
    await page.click('[data-chk="meal:5"]'); await page.waitForFunction(() => document.querySelector('[data-step="meal:5"]').dataset.mark === 'ok'); assert((await total()) > base, 'plan adds kcal'); await cancelViaSheet();
    await page.click('[data-open="meal:5"]'); await page.waitForSelector('#mChange'); await page.click('#mChange'); await page.click('[data-half]'); await page.waitForSelector('#pendOk'); await page.click('#pendOk'); await page.waitForTimeout(150); await closeSheet(); assert((await mark('meal:5')).startsWith('sub|'), 'sub'); 
    // 今日画面の✓再タップでも取り消し（トースト＋元に戻す）
    await page.click('[data-chk="meal:5"]'); await page.waitForFunction(() => document.querySelector('[data-step="meal:5"]').dataset.mark === ''); assert((await text('#toast')).includes('5食目の記録を取り消しました'), 'toast'); assert((await total()) === base, 'total base after chk cancel'); await page.click('#toast button'); await page.waitForFunction(() => document.querySelector('[data-step="meal:5"]').dataset.mark === 'sub'); assert((await total()) > base, 'undo restored'); await page.click('[data-chk="meal:5"]'); await page.waitForFunction(() => document.querySelector('[data-step="meal:5"]').dataset.mark === ''); return 'base=' + base + ' kcal に毎回戻る'; });
  await T(G.today, '実績時刻: 記録済みは太字＋「予定」、未記録は「予定」薄字、60分以上ズレは黄色', async () => { const w = await page.$eval('[data-step="weight"] .tm', e => ({ b: e.querySelector('b') && e.querySelector('b').textContent, s: e.querySelector('small') && e.querySelector('small').textContent, late: !!e.querySelector('b.late') })); assert(w.b === '06:50' && w.s === '予定 06:40' && !w.late, 'weight tm ' + JSON.stringify(w));
    const m2 = await page.$eval('[data-step="meal:2"] .tm', e => ({ b: e.querySelector('b') && e.querySelector('b').textContent, late: !!e.querySelector('b.late') })); assert(m2.b === '07:36' && m2.late, 'meal2 logged 07:36 vs plan 10:30 → late: ' + JSON.stringify(m2));
    const un = await text('[data-step="meal:5"] .tm'); assert(un.includes('19:30') && un.includes('予定') && !(await page.$('[data-step="meal:5"] .tm b')), 'unlogged shows planned: ' + un); });
  await T(G.today, '記録済み時刻をタップして手修正できる（時刻ピッカー）', async () => { await page.click('[data-time="meal:2"]'); await page.waitForSelector('#dlgTime'); await page.fill('#dlgTime', '10:40'); await page.click('#dlgOk'); await page.waitForSelector('#dlg', { state: 'hidden' }); await page.waitForTimeout(150); const m2 = await page.$eval('[data-step="meal:2"] .tm', e => ({ b: e.querySelector('b').textContent, late: !!e.querySelector('b.late') })); assert(m2.b === '10:40' && !m2.late, 'edited: ' + JSON.stringify(m2)); if (mode === 'db') { await page.waitForTimeout(200); assert(/T10:40/.test(rt.DB.log_meals['2026-09-16'].meals[2].loggedAt), 'loggedAt saved ' + rt.DB.log_meals['2026-09-16'].meals[2].loggedAt); } await page.click('[data-open="meal:2"]'); await page.waitForSelector('#mTime'); assert((await text('.sheet-body h3')).includes('予定 10:30') && (await text('.sheet-body h3')).includes('記録 10:40'), 'sheet header: ' + (await text('.sheet-body h3'))); await closeSheet(); });
  await T(G.today, '「いま」カード右上は現在時刻（1分ごと更新）、予定時刻は別表示', async () => { assert((await text('#nowClock')) === '07:36', 'clock ' + (await text('#nowClock'))); await setTime('2026-09-16T07:41:00+08:00'); await page.waitForFunction(() => document.querySelector('#nowClock').textContent === '07:41', null, { timeout: 70000 }); assert((await text('#now .k')).includes('予定'), 'planned shown separately'); });
  await shot('02-meal');
  // 5食目は直前のテストで毎回「未記録」に戻して終わっている。共有 page（9/16・体重記録済み）上で
  // そのまま検証する（新しい日付・別ページを使うと clock.setFixedTime がブラウザコンテキスト全体
  // ＝共有 page にも効いてしまい、後続テストを壊すため使わない）
  await T(G.meal, 'カロリーを手で入力: kcalだけで記録→PFCから計算→合計と脂肪の塊に反映→食事シートにも同じ入口→取り消しで合計から消える', async () => {
    const total = async () => Number((await page.$eval('.card', e => e.textContent)).match(/カロリー ([\d,]+)/)[1].replace(/,/g, ''));
    const base = await total();
    // 食事シートの「変更・追加」欄にも同じ入口があることを確認（存在チェックのみ。実際の記録は今日画面のボタンから行う）
    await page.click('[data-open="meal:5"]'); await page.waitForSelector('#mChange'); await page.click('#mChange'); await page.waitForSelector('#mcBtn');
    assert(await page.$('#mcBtn'), '食事シートの「変更・追加」欄に「カロリーを手で入力」の入口がある');
    await closeSheet();
    // kcal だけで記録（今日画面のボタンから）。5食目は未記録なのでデフォルトで選ばれる
    await page.click('#manualCalBtn'); await page.waitForSelector('#mcMeal');
    assert(await page.$('#mcMeal button[data-meal="5"].on'), '未記録の5食目がデフォルトで選ばれている');
    await page.fill('#mcK', '450'); await page.click('#mcSave'); await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.waitForFunction((t) => { const m = document.querySelector('.card').textContent.match(/カロリー (\d[\d,]*)/); return m && Number(m[1].replace(/,/g, '')) === t; }, base + 450, { timeout: 20000 });
    assert((await text('[data-step="meal:5"]')).includes('✏️'), '手入力のラベル（✏️）が今日画面に出る');
    assert((await total()) === base + 450, 'kcalだけで記録できる: +450: ' + (await total()) + ' (base ' + base + ')');
    // PFC から kcal を計算（同じ今日画面のボタンから、2件目として追加）
    await page.click('#manualCalBtn'); await page.waitForSelector('#mcMeal'); await page.click('#mcMeal button[data-meal="5"]');
    await page.fill('#mcName', 'コンビニ弁当'); await page.fill('#mcP', '20'); await page.fill('#mcF', '15'); await page.fill('#mcC', '60'); await page.click('#mcCalc');
    assert((await page.$eval('#mcK', e => e.value)) === '455', 'PFCから計算(20×4+15×9+60×4=455): ' + (await page.$eval('#mcK', e => e.value)));
    await page.click('#mcSave'); await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.waitForFunction((t) => { const m = document.querySelector('.card').textContent.match(/カロリー (\d[\d,]*)/); return m && Number(m[1].replace(/,/g, '')) === t; }, base + 905, { timeout: 20000 });
    assert((await total()) === base + 905, '1日合計に反映(+450+455=+905): ' + (await total()) + ' (base ' + base + ')');
    const bal = await page.evaluate(() => window.__tl.dayCalorieBalance('2026-09-16'));
    assert(bal && Math.round(bal.intake) === (await total()), '脂肪の塊の計算(dayCalorieBalance)にも反映: intake=' + (bal && bal.intake) + ' / 合計=' + (await total()));
    // 名前を付けた食品が foods に入り、次回検索（同じ名前）で呼び出せる
    const matched = await page.evaluate(() => { const f = window.__tl.matchFood('コンビニ弁当'); return f && { nameJa: f.nameJa, source: f.source, kcal: f.kcal, p: f.p }; });
    assert(matched && matched.source === 'manual' && matched.kcal === 455 && matched.p === 20, '名前を付けた食品が foods に入り、次回検索で呼び出せる: ' + JSON.stringify(matched));
    // 取り消しで合計から消える（他の記録と同じ × ソフト削除）
    await page.click('[data-open="meal:5"]'); await page.waitForSelector('.list .it .x'); await page.click('.list .it .x'); await page.waitForTimeout(200);
    assert((await total()) === base + 455, '取り消しで合計から消える(+905-450=+455): ' + (await total()) + ' (base ' + base + ')');
    await closeSheet();
    // 5食目を未記録に戻して後続テストに影響しないようにする
    await page.click('[data-open="meal:5"]'); await page.waitForSelector('#mCancel'); await page.click('#mCancel'); await dlgOk(); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(150);
    assert((await total()) === base, '後片付け: 5食目を未記録に戻し合計を base に戻す: ' + (await total()));
    return 'kcalだけで記録・PFCから計算・合計と脂肪の塊への反映・食事シートの入口・食品の再利用・取り消しを確認';
  });

  // ============ 筋トレ ============
  await T(G.workout, '必ずウォームアップから始まり、6種が完了扱いになるまで「筋トレを始める」が押せない', async () => { await goTab('workout'); await page.waitForSelector('#wuStart'); assert((await text('.cur-set .n')).includes('ウォームアップ 6種'), 'warmup first'); assert((await text('#wuProg')).includes('6種中 0種 完了'), 'progress'); await page.click('#wuStart'); await page.waitForTimeout(100); assert(await has('#wuStart'), 'still warmup'); assert((await text('#toast')).includes('ウォームアップがまだです'), 'blocked toast'); });
  await T(G.workout, 'アニメーション・3ステップ・動画リンク・セットカウンターが6種すべてで動く', async () => { const n = await page.$$eval('.wu', els => els.length); assert(n === 6, '6 cards'); const anims = await page.$$eval('.wu svg.anim', els => els.map(e => e.className.baseVal)); assert(anims.length === 6 && new Set(anims).size === 6, 'six distinct animations: ' + anims.join(',')); const running = await page.$$eval('.wu svg .armL, .wu svg .pelvis, .wu svg .upper', els => els.map(e => getComputedStyle(e).animationName).filter(a => a && a !== 'none').length); assert(running >= 6, 'css animations running: ' + running); const steps = await page.$$eval('.wu ol', els => els.map(e => e.querySelectorAll('li').length)); assert(steps.every(x => x === 3), '3 steps each'); const links = await page.$$eval('.wu .vid a', els => els.map(e => e.href)); assert(links.length === 6 && links.every(l => l.includes('youtube.com/results') && l.includes('warm')), 'video links');
    for (let id = 1; id <= 6; id++) { await page.click('[data-wuset="' + id + '"]'); await page.waitForFunction(i => document.querySelector('#wu' + i + ' .sc').textContent.includes('1/2'), id); await page.click('[data-wuset="' + id + '"]'); await page.waitForFunction(i => document.querySelector('#wu' + i + ' .sc').textContent.includes('2/2'), id); }
    assert((await text('#wuProg')).includes('6種中 6種 完了'), '2/2 = done'); assert(await page.$eval('#wu1 .sc', e => e.classList.contains('ok')), 'green at 2/2'); assert(await page.$eval('[data-wuset="1"]', e => e.disabled), '2/2 disables'); await page.click('[data-wuundo="1"]'); await page.waitForFunction(() => document.querySelector('#wu1 .sc').textContent.includes('1/2')); assert((await text('#wuProg')).includes('6種中 5種 完了'), 'undo → 5'); await page.click('#wuStart'); await page.waitForTimeout(100); assert(await has('#wuStart') && (await text('#toast')).includes('ウォームアップがまだです'), 'blocked at 5/6'); await page.click('[data-wuset="1"]'); await page.waitForFunction(() => document.querySelector('#wu1 .sc').textContent.includes('2/2')); await shot('03-warmup'); await page.click('#wuStart'); await page.waitForSelector('#setDone'); if (mode === 'db') { await page.waitForTimeout(200); const w = rt.DB.log_workout['2026-09-16'].warmup; assert(w.done && w.minutes >= 1, 'warmup minutes saved: ' + JSON.stringify(w)); return 'minutes=' + w.minutes; } });
  await T(G.workout, 'セット一覧（完了=実績値、現在=黄、未=薄）、タップで前セットに戻れる', async () => { assert((await text('.setrows .sr.cur')).includes('← いまここ'), 'cur'); assert((await text('.ghost')).includes(mode === 'db' ? '前回' : '初回です'), 'ghost'); if (mode === 'mock') await page.click('[data-qk="10"]'); await page.click('#setDone'); await page.waitForSelector('#rest:not([hidden])'); { const rw = await text('#rn'); assert(rw === '2:00' || rw === '1:59', 'pre-exhaust main rest 120s: ' + rw); } await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden])'); const done = await text('.setrows .sr.done .rv'); assert(/kg×1\d/.test(done), 'done row actual: ' + done); assert((await text('.setrows .sr.cur .nm')).includes('2セット目'), 'moved to set2'); await page.click('[data-set="0"]'); await page.waitForTimeout(100); assert((await text('.setrows .sr.cur .nm')).includes('1セット目'), 'back to set1'); assert(!/0kg×0|kg×0\b/.test(await text('.setrows')), 'no 0kg×0'); assert((await text('.ghost')).includes('記録済み'), 'shows recorded'); await page.click('[data-set="1"]'); });
  await T(G.workout, '前回値なし→クイック重量ボタン。前回値あり→提案（トップ 上限到達で +5%／ダンベルは +1kg、バックオフ トップ×0.85、ドロップ 直前×0.7）', async () => { await gotoEx(1); assert((await text('.ex-name')).includes('インクライン'), 'ex2');
    if (mode === 'mock') { assert(await has('[data-qk]'), 'quick buttons'); return '前回値なし → クイック重量'; }
    await page.click('[data-set="1"]'); await page.waitForTimeout(80); const g = await text('.ghost'); assert(g.includes('前回 9/9（7日前）') && g.includes('22kg×8') && g.includes('23kg') && g.includes('上限到達'), 'TOP suggest: ' + g); assert((await text('#wv')) === '23', 'wv 23');
    await page.click('[data-set="2"]'); await page.waitForTimeout(80); assert((await text('.cur-set .n')).includes('バックオフ'), 'back-off set'); assert((await text('#wv')) === '20', 'BO 23×0.85=20: ' + (await text('#wv'))); assert((await text('.cur-set .p')).includes('トップより軽くして') && (await text('.cur-set .p')).includes('目安 20kg'), 'BO purpose: ' + (await text('.cur-set .p')));
    await gotoEx(5); assert((await text('.ex-name')).includes('サイドレイズ'), 'ex5'); await page.click('[data-set="0"]'); await page.waitForTimeout(80); assert((await text('#wv')) === '11', 'MAIN 10×12(上限)→11: ' + (await text('#wv'))); await page.click('[data-set="1"]'); await page.waitForTimeout(80); assert((await text('#wv')) === '12' && (await text('.ghost')).includes('プログレッシブ'), 'progressive set2 11→12: ' + (await text('.ghost'))); await page.click('[data-set="3"]'); await page.waitForTimeout(80); assert((await text('.cur-set .n')).includes('ドロップセット'), 'drop set'); assert((await text('#wv')) === '9', 'DROP 直前 13(12×1.05)×0.7=9: ' + (await text('#wv'))); assert((await text('.cur-set .p')).includes('休憩なし') && (await text('.cur-set .p')).includes('−30%') && (await text('.cur-set .p')).includes('目安 9kg'), 'DROP purpose: ' + (await text('.cur-set .p'))); assert((await text('.dropfig')).includes('→（休まず）→') && (await text('.dropfig')).includes('9kg'), 'drop figure: ' + (await text('.dropfig'))); const bk = await page.evaluate(() => [window.__tl.bumpKg(40, false, 2), window.__tl.bumpKg(10, false, 2), window.__tl.bumpKg(22, true, 1)]); assert(bk[0] === 42 && bk[1] === 11 && bk[2] === 23, 'bump +5%/+1kg: ' + bk.join(',')); await gotoEx(0); return 'ダンベル トップ 22×8(上限)→23kg / バックオフ 23×0.85=20kg / メイン 10×12(上限)→11kg → プログレッシブ 12kg・13kg / ドロップ 13×0.7=9kg / バー 40kg→42kg(+5%)'; });
  await T(G.workout, 'Day1 確定版: 8種目＋腹筋、スーパーセットは ①→②→休憩→①→② の順、プログレッシブ説明、ドロップは休憩なしで即開始', async () => { assert((await text('.ex-head .p')).includes('/9'), '8 exercises + abs'); const names = []; for (let k = 0; k < 9; k++) { await gotoEx(k); names.push(await text('.ex-name')); } assert(names[0].includes('事前疲労') && names[2].includes('マシン インクラインプレス') && names[4].includes('スーパーセット') && names[7].includes('アンダーハンド') && names[8].includes('腹筋') && names[8].includes('コーチ確認中'), 'names: ' + names.join(' / '));
    await gotoEx(4); assert((await text('.tag.ss')).includes('スーパーセット') && (await text('.tag.ss')).includes('休憩なし'), 'superset tag'); assert((await page.$$eval('.tag', els => els.map(e => e.textContent).join('|'))).includes('プログレッシブ ・ セットごとに少しずつ重くする（目安 +5%）'), 'progressive tag'); assert((await text('.tag.ss')).includes('休憩なし') && (await text('.tag.ss')).includes('①ペックデッキ → ②プレート'), 'pair names in tag'); const heads = await page.$$eval('.setrows .sr-head', els => els.map(e => e.textContent)); assert(heads.length === 3 && heads[0].includes('1セット目') && heads[1].includes('2セット目') && heads[2].includes('3セット目'), 'set groups: ' + heads.join(','));
    const rows = await page.$$eval('.setrows .sr .nm', els => els.map(e => e.textContent)); assert(rows.length === 6 && rows[0].includes('① ペックデッキ') && rows[0].includes('8〜12回') && rows[1].includes('② プレート') && !rows.some(r => /セット\d-\d/.test(r)), 'pairs: ' + rows.join(','));
    // 1-1 完了 → 休憩なしで 1-2 へ。1-2 完了 → 休憩
    await page.click('[data-set="0"]'); await page.waitForTimeout(60); if ((await text('#wv')) === '—') await page.click('[data-qk]'); await page.click('#setDone'); await page.waitForTimeout(100); assert(!(await has('#rest:not([hidden])')), 'no rest between pair'); assert((await text('.cur-set .pair-row.cur .nm')).includes('② プレート'), 'moved to ②: ' + (await text('.cur-set .pair-row.cur .nm'))); assert((await text('#toast')).includes('スーパーセット'), 'superset toast'); assert((await text('.cur-set .p')).includes('直後、休まずに'), 'pair purpose'); if ((await text('#wv')) === '—') await page.click('[data-qk]'); await page.click('#setDone'); await page.waitForSelector('#rest:not([hidden])'); assert((await text('#rnext')).includes('2セット目 ① ペックデッキ'), 'rest then next pair: ' + (await text('#rnext'))); await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden])');
    await gotoEx(5); assert(!(await has('.tag.ss')), 'no superset tag'); assert((await page.$$eval('.tag', els => els.map(e => e.textContent).join('|'))).includes('プログレッシブ'), 'progressive on side raise'); assert((await page.$$eval('.setrows .sr .nm', els => els.map(e => e.textContent))).length === 4, '3 main + drop');
    // 3セット目の完了 → 休憩なしでドロップセットへ
    for (let k = 0; k < 3; k++) { await page.click('[data-set="' + k + '"]'); await page.waitForTimeout(60); if ((await text('#wv')) === '—') await page.click('[data-qk="8"]'); await page.click('#setDone'); await page.waitForTimeout(80); if (await has('#rest:not([hidden])')) { assert(k < 2, 'no rest before drop'); await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden])'); } }
    assert((await text('.cur-set .n')).includes('ドロップセット'), 'now on drop set'); assert((await text('#toast')).includes('休まずすぐ開始'), 'drop toast'); assert(!(await has('#rest:not([hidden])')), 'no rest timer'); await gotoEx(0); });  await T(G.workout, '完了→休憩タイマー（トップ 180秒／他 120秒）→自動で次セット。「飛ばす」で即次へ', async () => { await gotoEx(1); await page.click('[data-set="1"]'); await page.waitForTimeout(80); assert((await text('.cur-set .n')).includes('トップセット'), 'on TOP set'); if ((await text('#wv')) === '—') await page.click('[data-qk="20"]'); await setTime('2026-09-16T07:41:10+08:00'); await page.click('#setDone'); await page.waitForSelector('#rest:not([hidden])'); const rn = await text('#rn'); assert(rn === '3:00' || rn === '2:59', 'TOP rest 180s: ' + rn); assert((await text('#rnext')).includes('3セット目 バックオフ'), 'next: ' + (await text('#rnext')));
    if (mode === 'db') { await page.waitForTimeout(250); await setTime('2026-09-16T07:42:00+08:00'); await page.reload(); await page.waitForFunction(() => !document.querySelector('#view .loading')); await goTab('workout'); await page.waitForSelector('#rest:not([hidden])'); const rl = await text('#rn'); assert(/^2:(0|1)\d$/.test(rl), 'rest continues after reload ~2:10: ' + rl); }
    await setTime('2026-09-16T08:40:00+08:00'); await page.waitForSelector('#setDone:not([hidden])', { timeout: 5000 }); assert((await text('.setrows .sr.cur .nm')).includes('3セット目'), 'auto advance to set3'); await page.click('#setDone'); await page.waitForSelector('#rest:not([hidden])'); const r2 = await text('#rn'); assert(r2 === '2:00' || r2 === '1:59', 'BO rest 120s: ' + r2); assert(/マシン インクラインプレス.*1セット目 メイン/.test(await text('#rnext')), 'next exercise: ' + (await text('#rnext'))); await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden])'); });
  await T(G.workout, '代替種目名の上書きが保存され、マスタ名は不変', async () => { await gotoEx(2); assert((await text('.ex-name')).includes('マシン インクラインプレス'), 'ex3'); await page.click('#subBtn'); await dlgOk('フロアプレス'); assert((await text('.ex-name')) === 'フロアプレス', 'sub name shown'); assert((await text('.tag.sub')).includes('代替'), 'tag'); if (mode === 'db') { await page.waitForTimeout(200); const ex = await page.$eval('.ex-en', e => e.textContent); assert(rt.DB.plan_exercises['31'].nameJa.startsWith('マシン インクラインプレス'), 'master unchanged'); assert(rt.DB.log_workout['2026-09-16'].meta['31'].subName === 'フロアプレス', 'meta saved'); } });
  await T(G.workout, '違和感メモ・RPE が保存', async () => { await page.click('#noteBtn'); await page.waitForSelector('#exNote'); await page.fill('#exNote', 'right shoulder slight discomfort'); await page.click('[data-r="8"]'); await page.click('#exSave'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(100); assert((await text('#noteBtn')).includes('●'), 'note marker'); if (mode === 'db') { await page.waitForTimeout(200); const m = rt.DB.log_workout['2026-09-16'].meta['31']; assert(m.note === 'right shoulder slight discomfort' && m.rpe === 8, 'meta ' + JSON.stringify(m)); } });
  await T(G.workout, 'フォーム動画アップロード（assets）と一覧。assets が null ならボタン非表示', async () => { if (mode === 'mock') { assert(!(await page.$eval('#formBtn', e => !e.hidden)), 'form button hidden'); return 'assets null → 非表示'; } assert(await page.$eval('#formBtn', e => !e.hidden), 'form button visible'); await page.click('#formBtn'); await page.waitForSelector('#mFile'); await page.setInputFiles('#mFile', { name: 'form.mp4', mimeType: 'video/mp4', buffer: Buffer.from('0123456789') }); await page.click('#mUp'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(200); assert(rt.assets.length === 1 && rt.assets[0].type === 'video/mp4', 'uploaded'); const media = Object.values(rt.DB.log_media); assert(media.length === 1 && media[0].category === 'form' && media[0].assetId === rt.assets[0].id, 'log_media'); await goTab('summary'); assert(await has('.gallery .thumb video'), 'gallery shows video'); await goTab('workout'); return 'assets.upload → log_media.assetId → 一覧'; });
  await T(G.workout, '途中で閉じて再開すると同じ種目・セットから続けられる', async () => { await gotoEx(2); const before = await text('.ex-head .p'); if (mode === 'db') { await page.waitForTimeout(300); await page.reload(); await page.waitForFunction(() => !document.querySelector('#view .loading')); await goTab('workout'); } else { await goTab('today'); await goTab('workout'); } if (await has('#rest:not([hidden])')) { await page.click('#skipRest'); } await page.waitForSelector('#setDone:not([hidden])'); const after = await text('.ex-head .p'); assert(!(await has('#wuStart')), 'warmup not repeated'); assert(after.includes('種目 3/9'), 'resume at ex3: ' + after + ' (before ' + before + ')'); });
  await T(G.workout, '最終種目（腹筋）→完了画面: 所要時間・やった内容・有酸素記録・報告テキスト生成→コピー→今日へ戻る', async () => { await gotoEx(8); assert((await text('.ex-name')).includes('腹筋'), 'ex 9 is abs'); assert(await page.$$eval('.tag', els => els.some(e => e.textContent.includes('コーチ確認中'))), 'pending tag'); for (let k = 0; k < 3; k++) { await page.click('[data-set="' + k + '"]'); await page.waitForTimeout(60); await page.click('[data-pm="r:1"]'); await page.click('[data-pm="r:1"]'); await page.click('#setDone'); await page.waitForTimeout(80); if (await has('#rest:not([hidden])')) { await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden])'); } } await gotoEx(8); { const rv = await page.$$eval('.setrows .sr .rv', els => els.map(e => e.textContent)); assert(rv.length === 3 && rv.every(t => t === '自重×2'), 'abs bodyweight rows: ' + rv.join(',')); } await gotoEx(0);
    for (let guard = 0; guard < 40; guard++) { if ((await text('#setDone')).includes('筋トレ完了')) break; if ((await text('#wv')) === '—') { const q = await page.$('[data-qk]'); if (q) await q.click(); else { await page.click('[data-pm="w:1"]'); } } await page.click('#setDone'); if (await has('#rest:not([hidden])')) { await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden])'); } await page.waitForTimeout(40); }
    assert((await text('#setDone')).includes('筋トレ完了'), 'all done'); await page.click('#setDone'); await page.waitForSelector('#repDay');
    const body = await text('#view'); assert(body.includes('Day 1 Push 完了') && body.includes('所要'), 'complete header'); assert(body.includes('やった内容') && body.includes('インクラインダンベルプレス') && body.includes('自重×2'), 'list with bodyweight abs: ' + body.slice(0, 200)); assert(!/0kg×0|kg×0(?!\d)/.test(body), 'no 0kg×0');
    await page.click('#cmpCardio'); await page.waitForSelector('#cMin'); assert((await page.$eval('#cType .on', e => e.textContent)) === '傾斜歩き', 'default incline walk'); await page.fill('#cMin', '40'); await page.fill('#cHr', '128'); await page.click('#cSave'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForSelector('#repDay'); assert((await text('#view')).includes('傾斜歩き 40分 ・ 心拍 128'), 'cardio recorded on complete screen');
    const rep = await page.$eval('#repDay', e => e.value); assert(rep.startsWith('Day 1 Push — Sep 16 (Wed)') && rep.includes('Duration:') && rep.includes('Warm-up: done (6 moves x 2 sets') && rep.includes('Pre-exhaust: Cable fly') && /1\. Incline DB press — .*\(top\).*\(back-off\)/.test(rep) && /4\. Pec deck — [\d.]+x\d+/.test(rep) && /\n {3}\(superset with\) plate shoulder front raise — [\d.]+x\d+/.test(rep) && /5\. DB lateral raise.* \+ drop [\d.]+x\d+/.test(rep) && rep.includes('Abs: bodyweight x2, bodyweight x2, bodyweight x2') && rep.includes('Cardio: incline walk 40 min @ 128 bpm') && rep.includes('Notes:'), 'report: ' + rep); assert(!/\b0x0\b|0kg/.test(rep), 'report has no 0x0');
    await page.fill('#repDay', rep + '\nextra'); await page.click('#repCopy'); await page.waitForFunction(() => /コピー/.test(document.querySelector('#toast').textContent), null, { timeout: 5000 }); assert((await text('#toast')).includes('コピー'), 'copy toast'); await page.click('#cmpBack'); await page.waitForTimeout(150); assert((await page.$eval('.tabs .on', e => e.dataset.tab)) === 'today', 'back to today'); assert((await page.$eval('[data-step="workout"]', e => e.className)).includes('done'), 'workout done'); assert((await text('[data-step="workout"]')).includes('全22セット中 22セット完了'), 'set count with denominator (superset = 1): ' + (await text('[data-step="workout"]'))); assert((await text('[data-step="cardio"]')).includes('傾斜歩き 40分'), 'cardio row'); { const bg = await page.$eval('.step.done .row', e => getComputedStyle(e).backgroundColor); assert(bg !== 'rgba(0, 0, 0, 0)' && bg !== 'rgb(0, 0, 0)', 'done row not black: ' + bg); const tmCss = await page.$eval('.step.done .tm', e => [getComputedStyle(e).display, getComputedStyle(e).alignItems, !!e.querySelector('small')]); assert(tmCss[0] === 'flex' && tmCss[1] === 'flex-end' && tmCss[2], 'time column right-aligned with planned below: ' + tmCss.join(',')); } assert((await mark('accessory')).startsWith('ok|') && (await text('[data-step="accessory"]')).includes('自重×2'), 'abs row done: ' + (await text('[data-step="accessory"]'))); await goTab('workout'); await page.waitForSelector('#repDay'); assert((await page.$eval('#repDay', e => e.value)).endsWith('extra'), 'edited report kept while open'); await page.click('#cmpReview'); await page.waitForSelector('#setDone'); await goTab('today'); });
  await shot('04-workout-done');
  await T(G.workout, 'Day3・Day7 は休み（有酸素のみ）: ウォームアップ画面を出さず有酸素の記録画面へ直行。記録すると完了画面に進む', async () => {
    await goTab('today'); await page.click('[data-shift="1"]'); await page.click('[data-shift="1"]'); assert((await text('h1')).startsWith('Day 3'), 'day3');
    const rows = await page.$$eval('.step', els => els.map(e => e.dataset.step));
    assert(!rows.includes('workout') && !rows.includes('accessory') && !rows.includes('warmup') && rows.includes('cardio'), '今日画面: 筋トレ・腹筋/カーフ・ウォームアップの行が無く、有酸素の行だけある: ' + rows.join(','));
    assert((await text('#tabWorkoutIc')) === '有酸素', '下部タブのアイコンが「有酸素」に変わる: ' + (await text('#tabWorkoutIc')));
    assert((await text('#tabWorkout')) === 'Day 3 休み', '下部タブのサブテキスト: ' + (await text('#tabWorkout')));
    await goTab('workout'); await page.waitForSelector('#rcType');
    assert(!(await page.$('#wuStart')), 'ウォームアップ画面が出ない（#wuStart が無い）');
    assert((await text('h1')) === 'Day 3 ・ 休み（有酸素のみ）', 'title: ' + (await text('h1')));
    await page.fill('#rcMin', '38'); await page.click('#rcSave');
    await page.waitForSelector('.ex-head h1');
    assert((await text('.ex-head h1')).includes('完了'), '有酸素の記録だけで完了画面に進める: ' + (await text('.ex-head h1')));
    const viewTxt = await page.locator('#view').textContent();
    assert(viewTxt.includes('傾斜歩き') && viewTxt.includes('38分'), '記録した有酸素の内容が完了画面に出る: ' + viewTxt);
    assert(!(await page.$('#cmpReview')), '休みの日は「セットを見直す」を出さない');
    await page.click('#cmpBack'); await page.waitForTimeout(150);
    assert((await page.$eval('.tabs .on', e => e.dataset.tab)) === 'today', 'back to today');
    assert(!(await page.$('[data-step="warmup"]')), '今日画面にウォームアップ行が出ない');
    assert((await text('[data-step="cardio"]')).includes('傾斜歩き 38分'), '今日画面の有酸素行に反映: ' + (await text('[data-step="cardio"]')));
    await page.click('[data-shift="-1"]'); await page.click('[data-shift="-1"]');
  });
  await T(G.week, '週まとめの遵守率: ウォームアップの分母は筋トレの日（Day1・2・4・5・6）だけ。休みの日（Day3・7）は対象外', async () => { if (mode === 'mock') return 'db のみ（weekAdherence は window.__tl 経由）';
    const days = { day1: '2026-12-02', day2: '2026-12-03', day4: '2026-12-05', day5: '2026-12-06', day6: '2026-12-07', day7end: '2026-12-08' };
    const range = { start: days.day1, end: days.day7end };
    const targets = [days.day1, days.day2, days.day4, days.day5, days.day6];
    const saved = {}; targets.forEach(d => { if (rt.DB.log_workout[d]) saved[d] = rt.DB.log_workout[d]; });
    try {
      [days.day1, days.day2, days.day4].forEach(d => rt.op('set', { coll: 'log_workout', id: d, data: { date: d, sets: {}, warmup: { done: '08:00', completed: true } } }));
      const p = await newPage(); await p.clock.setFixedTime(new Date(days.day7end + 'T20:00:00+08:00')); await p.reload(); await p.waitForFunction(() => !document.querySelector('#view .loading'));
      const a = await p.evaluate((r) => window.__tl.weekAdherence(r), range);
      assert(a.warmup.planned === 5, 'ウォームアップの分母は筋トレの日5日だけ（休みの日2日は含めない）: ' + a.warmup.planned);
      assert(a.warmup.done === 3, 'ウォームアップ完了は3/5: ' + a.warmup.done);
      await p.click('.tabs [data-tab="summary"]'); await p.waitForSelector('.stat');
      const statTxt = await p.locator('.stat').textContent();
      assert(/ウォームアップ 3\/5/.test(statTxt), '週まとめに「ウォームアップ 3/5」と出る: ' + statTxt);
      await p.close();
      return 'ウォームアップの分母が筋トレの日5日のみになり「3/5」と表示されることを確認';
    } finally { targets.forEach(d => { if (saved[d]) rt.op('set', { coll: 'log_workout', id: d, data: saved[d] }); else rt.op('del', { coll: 'log_workout', id: d }); }); }
  });
  await T(G.workout, 'その日の Day（部位）を変更できる: 今日だけ差し替え／ここから順番をずらす／記録済み警告／連続日の注意／休みの日への変更／週まとめとレポートへの反映／元に戻す', async () => {
    const D = { 1: '2027-02-10', 2: '2027-02-11', 3: '2027-02-12', 4: '2027-02-13', 5: '2027-02-14', 6: '2027-02-15', 7: '2027-02-16' };
    const p2 = await newPage(); p2.setDefaultTimeout(25000);
    // tl.tab は localStorage 保存（同一コンテキストの全ページで共有）。直前のテストが today タブ以外で終わっていると
    // reload 直後の最初の描画がそのタブ（例: 筋トレ）になり、ウォームアップ画面の自動 startedAt 記録が
    // 今日タブへ切り替える前に走ってしまう（後の「記録済み警告」判定を誤って true にする）。
    // reload は window.beforeunload で「今のページの UI.tab」を localStorage に書き戻すため、
    // localStorage を直接書き換えても reload 時に上書きされてしまう。reload 前に実際に today タブをクリックしておく
    await p2.click('.tabs [data-tab="today"]');
    await p2.clock.setFixedTime(new Date(D[4] + 'T06:50:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
    await p2.click('.tabs [data-tab="today"]'); await p2.waitForSelector('#dayHead');
    const dlgOk2 = async () => { await p2.waitForSelector('#dlg:not([hidden])'); await p2.click('#dlgOk'); await p2.waitForSelector('#dlg', { state: 'hidden' }); await p2.waitForTimeout(120); };
    const dlgNo2 = async () => { await p2.waitForSelector('#dlg:not([hidden])'); await p2.click('#dlgNo'); await p2.waitForSelector('#dlg', { state: 'hidden' }); await p2.waitForTimeout(120); };
    const closeSheetP2 = async () => { if (await p2.$('#sheet:not([hidden])')) { await p2.click('#sheet', { position: { x: 5, y: 5 } }); await p2.waitForSelector('#sheet', { state: 'hidden' }); } };
    try {
      // 1. 前回やった日の表示（Day1=3日前、Day5=まだ）
      assert((await p2.locator('#dayHead').textContent()).startsWith('Day 4'), '今日はDay4: ' + (await p2.locator('#dayHead').textContent()));
      await p2.click('#dayHead'); await p2.waitForSelector('[data-pickday="1"]');
      const day1Txt = await p2.$eval('[data-pickday="1"]', e => e.textContent);
      assert(day1Txt.includes('前回') && day1Txt.includes('2/10') && day1Txt.includes('3日前'), 'Day1の前回表示（3日前）: ' + day1Txt);
      const day5Txt = await p2.$eval('[data-pickday="5"]', e => e.textContent);
      assert(day5Txt.includes('前回') && day5Txt.includes('2/7') && day5Txt.includes('6日前'), '7日周期なので前の週のDay5（6日前）が前回になる: ' + day5Txt);
      // 2. 休みの日（Day3）に「今日だけ」変更 → 筋トレ画面が有酸素だけになる。元に戻すで復帰
      await p2.click('[data-pickday="3"]'); await p2.waitForSelector('#dcSave'); await p2.click('#dcSave'); await p2.waitForSelector('#sheet', { state: 'hidden' });
      await p2.click('.tabs [data-tab="workout"]'); await p2.waitForSelector('#rcType');
      assert(!(await p2.$('#wuStart')), '休みの日（Day3）に変更→有酸素だけの画面（ウォームアップ無し）');
      await p2.click('#wkDayHead'); await p2.waitForSelector('#dayReset'); await p2.click('#dayReset'); await p2.waitForSelector('#sheet', { state: 'hidden' });
      await p2.waitForSelector('#wuStart');
      assert((await p2.locator('#wkDayHead').textContent()).startsWith('Day 4'), '予定どおりに戻すとDay4に戻る');
      // 3. 記録済み（ウォームアップ画面を開くと自動で開始扱いになる）なら警告。「やめる」で変更されない、「変更する」で確定
      await p2.click('#wkDayHead'); await p2.waitForSelector('[data-pickday="1"]');
      await p2.click('[data-pickday="1"]'); await p2.waitForSelector('#dcSave'); await p2.click('#dcSave');
      await dlgNo2(); await closeSheetP2();
      assert((await p2.locator('#wkDayHead').textContent()).startsWith('Day 4'), '警告で「やめる」→変更されない');
      await p2.click('#wkDayHead'); await p2.waitForSelector('[data-pickday="1"]');
      await p2.click('[data-pickday="1"]'); await p2.waitForSelector('#dcSave'); await p2.click('#dcSave');
      await dlgOk2();
      await p2.waitForFunction(() => document.querySelector('#wkDayHead').textContent.startsWith('Day 1'));
      assert((await p2.locator('#wkDayHead').textContent()).includes('Push'), '変更後、筋トレ画面に選んだDayの種目が出る（Push）: ' + (await p2.locator('#wkDayHead').textContent()));
      // 4. 「今日だけ」なので明日（2/14）は元の予定（Day5）のまま
      let dno = await p2.evaluate(ds => window.__tl.dayNoFor(ds), D[5]);
      assert(dno === 5, '今日だけ変更なので明日はDay5のまま: ' + dno);
      await p2.click('#wkDayHead'); await p2.waitForSelector('#dayReset'); await p2.click('#dayReset'); await p2.waitForSelector('#sheet', { state: 'hidden' });
      await p2.waitForFunction(() => document.querySelector('#wkDayHead').textContent.startsWith('Day 4'));
      // 5. 「ここから順番をずらす」。以降の日はこの選択から数え直す。基準日より前の日付は変わらない
      await p2.click('#wkDayHead'); await p2.waitForSelector('[data-pickday="1"]');
      await p2.click('[data-pickday="1"]'); await p2.waitForSelector('#dcMode');
      await p2.click('#dcMode button[data-mode="shift"]'); await p2.click('#dcSave');
      await dlgOk2(); // 直前の警告確認で既にウォームアップ開始済みのため、この変更でも記録警告が出る
      await p2.waitForFunction(() => document.querySelector('#wkDayHead').textContent.startsWith('Day 1'));
      const after = await p2.evaluate((ds) => ({ d5: window.__tl.dayNoFor(ds.d5), d6: window.__tl.dayNoFor(ds.d6), d3: window.__tl.dayNoFor(ds.d3) }), { d5: D[5], d6: D[6], d3: D[3] });
      assert(after.d5 === 2, 'ここからずらす→明日はDay2: ' + after.d5);
      assert(after.d6 === 3, 'ここからずらす→明後日はDay3: ' + after.d6);
      assert(after.d3 === 3, '基準日より前の日付は変わらない: ' + after.d3);
      // 6. 前日と同じ部位を選ぶと注意が出る（変更はしない）
      await p2.click('.tabs [data-tab="today"]'); await p2.click('[data-shift="-1"]'); await p2.click('[data-shift="-1"]');
      assert((await p2.locator('.date').textContent()).includes('2/11'), '2/11に移動');
      await p2.click('#dayHead'); await p2.waitForSelector('[data-pickday="1"]');
      await p2.click('[data-pickday="1"]'); await p2.waitForSelector('#dcMode');
      const warnTxt = await p2.locator('#sheet .sheet-body').textContent();
      assert(warnTxt.includes('連続') && warnTxt.includes('昨日'), '前日と同じ部位を選ぶと注意が出る: ' + warnTxt);
      await closeSheetP2();
      await p2.click('[data-shift="1"]'); await p2.click('[data-shift="1"]');
      // 7. 週まとめとコーチ向けレポートに変更履歴が出る
      await p2.click('.tabs [data-tab="summary"]'); await p2.waitForSelector('#dayChangeBlock');
      const blockTxt = await p2.locator('#dayChangeBlock').textContent();
      assert(blockTxt.includes('2/13') && blockTxt.includes('Day4') && blockTxt.includes('Day1') && blockTxt.includes('ここから'), '週まとめに変更履歴: ' + blockTxt);
      const rep = await p2.locator('#repText').textContent();
      assert(rep.includes('swapped Day 4') && rep.includes('Day 1 (Push)'), 'コーチ向けレポートに変更履歴: ' + rep);
      // 8. 「予定どおりに戻す」で元の順番に戻る（ここからずらすは確認が必要）
      await p2.click('.tabs [data-tab="today"]'); await p2.click('#dayHead'); await p2.waitForSelector('#dayReset'); await p2.click('#dayReset');
      await dlgOk2();
      await p2.waitForFunction(ds => window.__tl.dayNoFor(ds) === 5, D[5]);
      const afterReset = await p2.evaluate((ds) => ({ d4: window.__tl.dayNoFor(ds.d4), d5: window.__tl.dayNoFor(ds.d5) }), { d4: D[4], d5: D[5] });
      assert(afterReset.d4 === 4 && afterReset.d5 === 5, '元に戻すと元の順番（Day4・Day5）に戻る: ' + JSON.stringify(afterReset));
      await p2.close();
      return '今日だけ差し替え・ここから順番をずらす・記録済み警告・連続日の注意・休みの日への変更・週まとめ/レポートへの反映・元に戻す、すべて確認';
    } finally { Object.values(D).forEach(d => { rt.op('del', { coll: 'log_daily', id: d }); rt.op('del', { coll: 'log_workout', id: d }); rt.op('del', { coll: 'log_cardio', id: d }); }); }
  });
  await T(G.meal, '追加した2品（Selecta Adult Active・Soya Protein Hoops）が「よく使う差替え」チップに常時表示され、単品・セットどちらも正しい量とカロリーで追加できる', async () => {
    // clock.setFixedTime はブラウザコンテキスト全体（共有 page 含む）の時計を変えるため、
    // 壁時計に依存するテスト（「いま」カード等）より後ろに置く
    const D = '2027-03-01';
    const p2 = await newPage(); p2.setDefaultTimeout(25000);
    await p2.clock.setFixedTime(new Date(D + 'T09:00:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
    await p2.click('.tabs [data-tab="today"]');
    const dlgOk2 = async () => { await p2.waitForSelector('#dlg:not([hidden])'); await p2.click('#dlgOk'); await p2.waitForSelector('#dlg', { state: 'hidden' }); await p2.waitForTimeout(120); };
    try {
      await p2.click('[data-open="meal:1"]'); await p2.waitForSelector('#mChange'); await p2.click('#mChange'); await p2.waitForSelector('[data-q]');
      const chips = await p2.$$eval('[data-q]', els => els.map(e => ({ idx: e.dataset.q, txt: e.textContent })));
      const findIdx = label => { const c = chips.find(x => x.txt === label); assert(c, 'チップが無い: ' + label + ' / 実際: ' + JSON.stringify(chips.map(x => x.txt))); return c.idx; };
      const iSelecta = findIdx('Selecta Adult 150ml'), iSoya = findIdx('Soya Hoops 80g'), iCombo = findIdx('Selecta 150ml + Soya Hoops 80g');
      // 単品: Selecta Adult 150ml → 91.5kcal・P3・F5.6・C4.9（100mlあたり61kcal/P2.0/F3.7/C3.3 の1.5倍）
      await p2.click('[data-q="' + iSelecta + '"]'); await p2.waitForSelector('#pendOk');
      assert((await p2.locator('.pending').textContent()).includes('セレクタ アダルト アクティブ150ml を追加'), 'selecta pending');
      await p2.click('#pendOk'); await p2.waitForTimeout(150);
      let list = await p2.locator('.sheet-body .list').textContent();
      assert(list.includes('セレクタ アダルト アクティブ') && list.includes('150ml') && list.includes('91.5 kcal ・ P3 F5.6 C4.9'), 'selecta 追加時の量とカロリーが正しい: ' + list);
      // 単品: Soya Hoops 80g → 298.4kcal・P30.6・F9.1・C27.4（100gあたり373kcal/P38.2/F11.4/C34.3 の0.8倍）
      await p2.click('[data-q="' + iSoya + '"]'); await p2.waitForSelector('#pendOk');
      assert((await p2.locator('.pending').textContent()).includes('ソヤ プロテイン フープス80g を追加'), 'soya pending');
      await p2.click('#pendOk'); await p2.waitForTimeout(150);
      list = await p2.locator('.sheet-body .list').textContent();
      assert(list.includes('ソヤ プロテイン フープス') && list.includes('80g') && list.includes('298.4 kcal ・ P30.6 F9.1 C27.4'), 'soya 追加時の量とカロリーが正しい: ' + list);
      // プランに戻してからセット（Selecta 150ml + Soya Hoops 80g・約390kcal）を1回で追加
      // 「変更・追加」欄はプランに戻したあとも開いたまま（sub 状態が維持される）なので #mChange は再度押さない
      await p2.click('#mReset'); await dlgOk2(); await p2.waitForSelector('[data-q]');
      await p2.click('[data-q="' + iCombo + '"]'); await p2.waitForSelector('#pendOk');
      const comboPend = await p2.locator('.pending').textContent();
      assert(comboPend.includes('セレクタ アダルト アクティブ150ml を追加') && comboPend.includes('ソヤ プロテイン フープス80g を追加'), 'セットは2品まとめて追加される: ' + comboPend);
      await p2.click('#pendOk'); await p2.waitForTimeout(150);
      list = await p2.locator('.sheet-body .list').textContent();
      assert(list.includes('セレクタ アダルト アクティブ') && list.includes('ソヤ プロテイン フープス'), 'セットで2品とも追加された: ' + list);
      await p2.close();
      return 'Selecta Adult Active（100mlあたり61kcal）・Soya Protein Hoops（100gあたり373kcal）をチップから単品・セットで追加、macrosが一致（セット合計 約390kcal）';
    } finally { rt.op('del', { coll: 'log_meals', id: D }); }
  });
  await T(G.workout, 'スーパーセットの①②は重量・提案・休憩・記録を完全に別々に管理する（Day5 ダンベルショルダープレス＋フロントレイズ）', async () => {
    const D = '2027-05-09'; // Day5
    const p2 = await newPage(); p2.setDefaultTimeout(20000);
    await p2.click('.tabs [data-tab="today"]');
    await p2.clock.setFixedTime(new Date(D + 'T06:50:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
    const dlgOk2 = async (fillText) => { await p2.waitForSelector('#dlg:not([hidden])'); if (fillText != null) await p2.fill('#dlgIn', fillText); await p2.click('#dlgOk'); await p2.waitForSelector('#dlg', { state: 'hidden' }); await p2.waitForTimeout(120); };
    try {
      await p2.click('.tabs [data-tab="workout"]'); await p2.waitForSelector('#wuStart');
      for (let id = 1; id <= 6; id++) { await p2.click('[data-wuset="' + id + '"]'); await p2.click('[data-wuset="' + id + '"]'); }
      await p2.click('#wuStart'); await p2.waitForSelector('#setDone');
      // 種目1（WU扱いの単独種目）・2（ショルダープレス単独）を飛ばし、種目3＝①②のペアへ
      await p2.click('[data-ex="1"]'); await p2.click('[data-ex="1"]');
      assert((await p2.locator('.ex-name').textContent()).includes('ダンベル シーテッド ショルダープレス'), '種目3はペアの①から開始: ' + (await p2.locator('.ex-name').textContent()));
      assert((await p2.locator('.tag.ss').first().textContent()).includes('①ダンベル シーテッド ショルダープレス') && (await p2.locator('.tag.ss').first().textContent()).includes('②ダンベル オーバーハンド フロントレイズ'), 'ペア種目タグに①②両方の名前');
      // セット一覧は①②の入れ子（2セット分＝2グループ）
      let groups = await p2.$$('.setrows.pair .sr-group'); assert(groups.length === 2, 'セット一覧は①②を入れ子にした2グループ: ' + groups.length);
      let g1children = await p2.$$eval('.setrows.pair .sr-group', gs => gs[0].querySelectorAll('.sr').length); assert(g1children === 2, '各グループに①②の2行: ' + g1children);

      // --- 1セット目 ①: 初回なので目安なし。7kg×10 を記録 ---
      assert(await p2.$('#noHint'), '①1セット目は初回で目安なし');
      await p2.click('#wv'); await dlgOk2('7'); await p2.click('#rv'); await dlgOk2('10');
      await p2.click('#setDone');
      // ①→②は休憩なしで自動遷移。カードに①（実績7kg×10）②（いまここ）が並ぶ
      assert(!(await p2.$('#rest:not([hidden])')), '①→②の間は休憩タイマーが出ない');
      const curTxt1 = await p2.locator('.cur-set').textContent();
      assert(curTxt1.includes('① ダンベル シーテッド ショルダープレス') && curTxt1.includes('7kg×10') && curTxt1.includes('② ダンベル オーバーハンド フロントレイズ'), 'カードに①（実績あり）②（いまここ）が並んで出る: ' + curTxt1);
      // ②の初期値が①の7kgを引きずっていない（②も初回なので目安なし・空欄）
      assert(await p2.$('#noHint'), '②も初回は目安なし（①の値を引きずらない）');
      const w0b = await p2.$eval('#wv', e => e.dataset.v); assert(w0b === '', '②の入力初期値が空（①の7kgではない）: ' + JSON.stringify(w0b));

      // --- 1セット目 ②: 5kg×10 を記録 ---
      await p2.click('#wv'); await dlgOk2('5'); await p2.click('#rv'); await dlgOk2('10');
      await p2.click('#setDone');
      // ②のあとだけ休憩タイマーが出て、「次」に2セット目①の名前と提案重量が正しく出る（見切れない）
      await p2.waitForSelector('#rest:not([hidden])');
      const rnextTxt = await p2.locator('#rnext').textContent();
      assert(rnextTxt.includes('①') && rnextTxt.includes('ダンベル シーテッド ショルダープレス') && rnextTxt.includes('提案 8'), '②のあとの休憩「次」に2セット目①・提案8kgが正しく出る: ' + rnextTxt);
      await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden])');

      // --- 2セット目 ①: ①自身の直前（7kg）からのプログレッシブ提案（+5%目安=8kg）。②の5kgを引きずらない ---
      const ghost1 = await p2.locator('.ghost').textContent();
      assert(ghost1.includes('プログレッシブ') && ghost1.includes('直前 7kg'), '2セット目①の提案根拠は①自身の直前セット（7kg）: ' + ghost1);
      const w0c = await p2.$eval('#wv', e => e.dataset.v); assert(w0c === '8', '2セット目①の提案重量=8kg（②の5kgではない）: ' + w0c);
      await p2.click('#setDone'); // 提案どおり 8kg×8 で記録
      assert(!(await p2.$('#rest:not([hidden])')), '2セット目も①→②は休憩なし');

      // --- 2セット目 ②: ②自身の直前（5kg）からのプログレッシブ提案（+5%目安=6kg）。①の7kg/8kgを引きずらない ---
      const ghost2 = await p2.locator('.ghost').textContent();
      assert(ghost2.includes('プログレッシブ') && ghost2.includes('直前 5kg'), '2セット目②の提案根拠は②自身の直前セット（5kg、①の7kg/8kgではない）: ' + ghost2);
      const w0d = await p2.$eval('#wv', e => e.dataset.v); assert(w0d === '6', '2セット目②の提案重量=6kg（①の8kgではない）: ' + w0d);
      await p2.click('#setDone'); // 提案どおり 6kg×8 で記録
      await p2.waitForSelector('#rest:not([hidden])'); await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden])');

      // 残りの種目をクイック重量/提案どおりに進めて完了画面まで到達
      for (let guard = 0; guard < 60; guard++) {
        const doneLabel = await p2.locator('#setDone').textContent();
        if (doneLabel.includes('完了画面へ')) { await p2.click('#setDone'); break; }
        if ((await p2.locator('#wv').textContent()) === '—') { const q = await p2.$('[data-qk]'); if (q) await q.click(); else await p2.click('[data-pm="w:1"]'); }
        await p2.click('#setDone');
        if (await p2.$('#rest:not([hidden])')) { await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden])'); }
        await p2.waitForTimeout(30);
      }
      await p2.waitForSelector('.rep-ta');
      // 完了画面「やった内容」: ①②が別々の行（実績が混ざらない）
      const cmpTxt = await p2.locator('.card').first().textContent();
      assert(cmpTxt.includes('ダンベル シーテッド ショルダープレス') && cmpTxt.includes('7kg×10、8kg×8') && cmpTxt.includes('とスーパーセット') && cmpTxt.includes('5kg×10、6kg×8'), '完了画面で①②が別行・別実績: ' + cmpTxt);
      // コーチ報告テキスト: 「3. DB seated shoulder press — 7x10, 8x8」「   (superset with) DB overhand front raise — 5x10, 6x8」の2行
      const repTxt = await p2.locator('#repDay').inputValue();
      assert(repTxt.includes('3. DB seated shoulder press — 7x10, 8x8') && repTxt.includes('(superset with) DB overhand front raise — 5x10, 6x8'), 'レポートで①②が別行: ' + repTxt);
      await p2.close();
      return '①7kg×10,8kg×8 ・ ②5kg×10,6kg×8 が完全に独立（保存・提案・休憩・一覧・完了画面・レポートすべて確認）';
    } finally { rt.op('del', { coll: 'log_workout', id: D }); rt.op('del', { coll: 'log_daily', id: D }); rt.op('del', { coll: 'log_cardio', id: D }); }
  });
  await T(G.workout, 'パデルを有酸素の選択肢に追加：30分単位・強度3段階・kcal自動計算・Zone2とは別枠で今日画面/脂肪計算/週まとめに反映', async () => {
    const D = '2027-06-01';
    const p2 = await newPage(); p2.setDefaultTimeout(20000);
    await p2.click('.tabs [data-tab="today"]');
    await p2.clock.setFixedTime(new Date(D + 'T06:50:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
    await p2.click('.tabs [data-tab="today"]');
    try {
      // 体重72kgを記録（パデルのkcal計算の基準）
      await p2.click('[data-open="weight"]'); await p2.waitForSelector('#shSave');
      await p2.fill('#shW', '72'); await p2.click('#shSave'); await p2.waitForFunction(() => document.querySelector('[data-step="weight"]').className.includes('done'));
      await p2.click('[data-open="cardio"]'); await p2.waitForSelector('#cType');
      const chips = await p2.$$eval('#cType button', els => els.map(e => e.textContent));
      assert(chips.includes('パデル'), '有酸素の選択肢にパデルがある: ' + chips.join(','));
      assert(await p2.$eval('#cPadelBlock', e => e.hidden), 'デフォルト（傾斜歩き）ではパデル専用欄は隠れている');
      await p2.click('#cType [data-t="padel"]');
      assert(!(await p2.$eval('#cPadelBlock', e => e.hidden)), 'パデルを選ぶと時間プリセット・強度・kcalプレビューが出る');
      // 30分単位のボタンで時間が入る
      await p2.click('#cPadelMin [data-pmin="60"]');
      assert((await p2.$eval('#cMin', e => e.value)) === '60', '60分ボタンで分数が入る');
      assert((await p2.locator('#cKcalPreview').textContent()) === '約 504 kcal', '体重72kg・ふつう(METs7.0)・60分 → 504kcal: ' + (await p2.locator('#cKcalPreview').textContent()));
      // 「+30分」ボタンで加算
      await p2.click('#cPadelMin [data-pmin="+30"]');
      assert((await p2.$eval('#cMin', e => e.value)) === '90', '+30分ボタンで加算される');
      assert((await p2.locator('#cKcalPreview').textContent()) === '約 756 kcal', '90分 → 756kcal: ' + (await p2.locator('#cKcalPreview').textContent()));
      // 強度3段階で数値が変わる（激しめ METs8.5）
      await p2.click('#cIntensity [data-int="hard"]');
      assert((await p2.locator('#cKcalPreview').textContent()) === '約 918 kcal', '強度「激しめ」(8.5)で90分 → 918kcal: ' + (await p2.locator('#cKcalPreview').textContent()));
      // 自由入力（分）でも再計算される（軽め METs5.5・120分）
      await p2.click('#cIntensity [data-int="light"]'); await p2.fill('#cMin', '120');
      assert((await p2.locator('#cKcalPreview').textContent()) === '約 792 kcal', '自由入力120分・軽め(5.5) → 792kcal: ' + (await p2.locator('#cKcalPreview').textContent()));
      // ふつう・90分で保存
      await p2.click('#cIntensity [data-int="normal"]'); await p2.fill('#cMin', '90');
      await p2.click('#cSave'); await p2.waitForTimeout(200);
      // 今日画面: 「パデル 90分 ・ 約756 kcal」＋ Zone2とは別物の注意書き。予定は達成扱い
      const cardioRow = await p2.locator('[data-step="cardio"]').textContent();
      assert(cardioRow.includes('パデル 90分') && cardioRow.includes('約756 kcal') && cardioRow.includes('Zone 2 とは別物です') && cardioRow.includes('コーチに伝えておく'), '今日画面にパデル記録とZone2の注意書き: ' + cardioRow);
      assert((await p2.$eval('[data-step="cardio"]', e => e.dataset.mark)) === 'ok', '有酸素の予定は達成扱い');
      // 脂肪の計算（TDEEの運動分）に反映される
      const exVal = await p2.evaluate(ds => window.__tl.exerciseKcalFor(ds, 72), D);
      assert(Math.round(exVal) === 756, '脂肪の計算に使う運動消費kcalにパデルが反映される（756kcal）: ' + exVal);
      // 週まとめ・コーチ向けレポートに Zone 2 とは分けて出る
      const wa = await p2.evaluate(ds => window.__tl.weekAdherence({ start: ds, end: ds }).cardio, D);
      assert(wa.padel.count === 1 && wa.padel.minutes === 90 && wa.zone2.count === 0, 'weekAdherence でパデルと Zone 2 が分離: ' + JSON.stringify(wa));
      const rep = await p2.evaluate(() => window.__tl.weeklyReport());
      assert(rep.includes('Cardio:') && rep.includes('Padel x1 (90 min)') && !rep.includes('Zone 2'), 'コーチ向けレポートにパデルが Zone 2 と分けて出る（この週は Zone 2 の記録が無い）: ' + rep);
      await p2.close();
      return 'パデル追加：30分単位・強度3段階(5.5/7.0/8.5)・kcal自動計算・今日画面/脂肪計算/週まとめでZone2と分離、すべて確認';
    } finally { rt.op('del', { coll: 'log_weight', id: D }); rt.op('del', { coll: 'log_cardio', id: D }); rt.op('del', { coll: 'log_daily', id: D }); }
  });
  await T(G.workout, '前回の重量を全種目で必ず表示する：日付・何日前・直近3回の履歴・セット種類ごとの分離・代替種目名の履歴・セット一覧の未実施行', async () => {
    // Day5 の3回（7日おき）に分けて種目2（id42・マシンショルダープレス、TOP→BO×2）の履歴を仕込み、4回目に検証する
    const dates = ['2027-05-16', '2027-05-23', '2027-05-30', '2027-06-06'];
    const [D1, D2, D3, D4] = dates;
    // 4日分（毎回ウォームアップ完了込み）を通しで行う重いテストなので db モードの累積待ちに余裕を持たせる
    const p2 = await newPage(); p2.setDefaultTimeout(30000);
    const dlgOk2 = async (fillText) => { await p2.waitForSelector('#dlg:not([hidden])'); if (fillText != null) await p2.fill('#dlgIn', fillText); await p2.click('#dlgOk'); await p2.waitForSelector('#dlg', { state: 'hidden' }); await p2.waitForTimeout(120); };
    const enterDay = async (date) => {
      await p2.click('.tabs [data-tab="today"]');
      await p2.clock.setFixedTime(new Date(date + 'T06:50:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
      await p2.click('.tabs [data-tab="workout"]'); await p2.waitForSelector('#wuStart');
      for (let id = 1; id <= 6; id++) { await p2.click('[data-wuset="' + id + '"]'); await p2.click('[data-wuset="' + id + '"]'); }
      await p2.click('#wuStart'); await p2.waitForSelector('#setDone');
      await p2.click('[data-ex="1"]'); // 種目2 = id42（TOP→BO×2 のソロ種目）
      assert((await p2.locator('.ex-name').textContent()).includes('ショルダープレス'), '種目2はソロのショルダープレス: ' + (await p2.locator('.ex-name').textContent()));
    };
    const setWeight = async (w, r) => { await p2.click('#wv'); await dlgOk2(String(w)); await p2.click('#rv'); await dlgOk2(String(r)); };
    const recordTopBo = async (topW, topR, boW, boR) => {
      await p2.click('[data-set="0"]'); await setWeight(topW, topR); await p2.click('#setDone');
      if (await p2.$('#rest:not([hidden])')) await p2.click('#skipRest');
      await p2.waitForSelector('#setDone:not([hidden])');
      await p2.click('[data-set="1"]'); await setWeight(boW, boR); await p2.click('#setDone');
      if (await p2.$('#rest:not([hidden])')) await p2.click('#skipRest');
      await p2.waitForSelector('#setDone:not([hidden])');
    };
    try {
      if (mode === 'mock') {
        // mock モードは reload をまたいだ永続化が無い（window.claude が無く、ページ内メモリのみ）ため、
        // 複数日にまたがる履歴の検証は db モードのみで行う。ここでは履歴が無いセットの初回表示だけ確認する
        await enterDay(D4);
        await p2.click('[data-set="0"]');
        assert((await p2.locator('#noHint').textContent()).includes('初回です'), 'mock: 履歴が無いセットは初回です表示: ' + (await p2.locator('#noHint').textContent()));
        await p2.close();
        return 'mock は reload 間の永続化が無いため初回表示のみ確認（複数日の履歴は db モードで検証）';
      }
      // セットアップ1（5/16）: 記録前は完全に初回（履歴なし）→「初回です」＋クイック重量ボタン
      await enterDay(D1);
      await p2.click('[data-set="0"]');
      assert((await p2.locator('#noHint').textContent()).includes('初回です'), '履歴が全く無いセットは初回表示: ' + (await p2.locator('#noHint').textContent()));
      assert(await p2.$('[data-qk]'), 'クイック重量ボタンが出る');
      // TOP 20kg×8・BO 16kg×10 を記録。代替種目名「マシンプレス改」で実施
      await p2.click('#subBtn'); await dlgOk2('マシンプレス改');
      await recordTopBo(20, 8, 16, 10);
      // セットアップ2（5/23）: TOP 21kg×8・BO 17kg×9（代替名なし＝マスタ名で実施）
      await enterDay(D2); await recordTopBo(21, 8, 17, 9);
      // セットアップ3（5/30）: TOP 22kg×8・BO 18kg×9
      await enterDay(D3); await recordTopBo(22, 8, 18, 9);

      // --- テスト日（6/6） ---
      await enterDay(D4);
      // 1セット目（TOP）: 前回・何日前・履歴3件
      await p2.click('[data-set="0"]');
      const ghostTop = await p2.locator('.ghost').textContent();
      assert(ghostTop.includes('前回 5/30（7日前）') && ghostTop.includes('22kg×8'), 'TOPの前回表示（日付・何日前・重量×回数）: ' + ghostTop);
      const histTop = await p2.locator('#histStrip').textContent();
      assert(histTop.includes('履歴') && histTop.includes('5/30 22kg×8') && histTop.includes('5/23 21kg×8') && histTop.includes('5/16 20kg×8'), '直近3回の履歴が横に並ぶ: ' + histTop);
      // タップで全履歴（グラフ付き）を開ける。代替種目名で実施した回も出る
      await p2.click('#histStrip'); await p2.waitForSelector('.spark svg');
      const histSheet = await p2.locator('#sheet .sheet-body').textContent();
      assert(histSheet.includes('マシンプレス改で実施') && histSheet.includes('20kg×8'), '全履歴に代替種目名で実施した回も出る（グラフ付き）: ' + histSheet);
      await p2.click('#histClose'); await p2.waitForSelector('#sheet', { state: 'hidden' });
      // 2セット目（BO）: TOPとは別の履歴（混ざらない）
      await p2.click('[data-set="1"]');
      const ghostBo = await p2.locator('.ghost').textContent();
      assert(ghostBo.includes('前回 5/30（7日前）') && ghostBo.includes('18kg×9') && !ghostBo.includes('22kg'), 'バックオフはTOPと混ざらない別の履歴を引く: ' + ghostBo);
      // セット一覧: 未実施行（3セット目＝2つ目のBO、まだ一度も記録していない）には前回値なし、1セット目（TOP・現在は未選択）には薄く前回値
      const rowsTxt = await p2.$$eval('.setrows .sr .rv', els => els.map(e => e.textContent));
      assert(rowsTxt[0].includes('22kg×8'), 'セット一覧の未実施行（TOP）にも前回値が薄く出る: ' + JSON.stringify(rowsTxt));
      assert(rowsTxt[1] === '← いまここ', 'いま選んでいるBOの行は「いまここ」: ' + JSON.stringify(rowsTxt));
      assert(rowsTxt[2] === '', '一度も記録していない3セット目は前回値なし: ' + JSON.stringify(rowsTxt));
      // 3セット目（2つ目のBO、setNo=3）: このセット自体の記録は一度も無いが、バックオフはトップの重量から目安を出すので「初回です」にはならない
      await p2.click('[data-set="2"]');
      assert(!(await p2.$('#noHint')), '2つ目のバックオフはトップからの目安があるので初回表示にはならない');
      const ghostBo2 = await p2.locator('.ghost').textContent();
      assert(ghostBo2.includes('目安') && !ghostBo2.includes('前回'), 'このセット自体の前回記録は無いので「前回」ではなく「目安」表示: ' + ghostBo2);
      await p2.close();
      return '全種目で前回値（日付・何日前・直近3回の履歴・タップで全履歴グラフ）を表示。TOP/BOで別々の履歴、代替種目名の履歴も拾う、未記録は初回表示、セット一覧の未実施行にも前回値';
    } finally { dates.forEach(d => { rt.op('del', { coll: 'log_workout', id: d }); rt.op('del', { coll: 'log_daily', id: d }); rt.op('del', { coll: 'log_cardio', id: d }); }); }
  });
  await T(G.workout, '全7日確定版: Day2 Pull 8種目＋カーフ / Day4 Legs 8種目＋腹筋 / Day5 Shoulder & Arms 8種目＋カーフ / Day6 Pull 8種目＋腹筋。ドロップ「限界まで」とスーパーセットの組展開', async () => { await goTab('today'); const wk = async () => text('[data-step="workout"]'); try {
    await page.click('[data-shift="1"]'); assert((await text('[data-step="accessory"]')).includes('カーフ: スミス カーフレイズ'), 'Day2 calves'); assert((await text('h1')).startsWith('Day 2') && (await wk()).includes('Pull ・ 8種目') && (await wk()).includes('Vバー ロウ（事前疲労）・ベントオーバーロウ') && (await wk()).includes('ほか5種目') && !(await wk()).includes('ラックプル'), 'Day2: ' + (await wk()));
    await page.click('[data-shift="1"]'); await page.click('[data-shift="1"]'); assert((await text('[data-step="accessory"]')).includes('腹筋'), 'Day4 abs'); assert((await text('h1')).startsWith('Day 4') && (await wk()).includes('Legs ・ 8種目') && (await wk()).includes('ダンベル RDL（事前疲労）・自重スクワット（事前疲労）') && (await wk()).includes('ほか5種目'), 'Day4: ' + (await wk()));
    await page.click('[data-shift="1"]'); assert((await text('[data-step="accessory"]')).includes('カーフ'), 'Day5 calves'); assert((await text('h1')).startsWith('Day 5') && (await wk()).includes('Shoulder & Arms ・ 8種目') && (await wk()).includes('ウォームアップ: フロントレイズ') && (await wk()).includes('ほか5種目'), 'Day5: ' + (await wk()));
    await page.click('[data-shift="1"]'); assert((await text('[data-step="accessory"]')).includes('腹筋'), 'Day6 abs'); assert((await text('h1')).startsWith('Day 6') && (await wk()).includes('Pull ・ 8種目') && (await wk()).includes('ストレートアーム ラットエクステンション（事前疲労）') && (await wk()).includes('ホリゾンタルロウ ＋ フェイスプル（スーパーセット）') && (await wk()).includes('ほか5種目'), 'Day6: ' + (await wk()));
    } finally { for (let k = 0; k < 8 && !(await text('.date')).includes('9/16'); k++) await page.click('[data-shift="-1"]'); } assert((await text('h1')).startsWith('Day 1'), 'back to Day1');
    const r = await page.evaluate(() => { const t = window.__tl; const d = t.parseSetScheme('MAIN10-15x3,DROP*'); const p = t.expandPairSets(t.parseSetScheme('MAIN8,MAIN10,MAIN12'), ['A動作', 'B動作']); return { n: d.length, last: d[3], lastTxt: t.repsText(d[3]), pn: p.length, labels: p.map(x => t.setLabel(x)), moves: p.map(x => x.move).join('') }; });
    assert(r.n === 4 && r.last.setType === 'DROP' && r.last.min === 0 && r.lastTxt === '限界まで', 'DROP*: ' + JSON.stringify(r)); assert(r.pn === 6 && r.moves === 'ababab' && r.labels[0] === '1セット目 ① A動作' && r.labels[5] === '3セット目 ② B動作', 'pairs: ' + JSON.stringify(r.labels)); return 'Day2/4/5/6 の種目数と代表種目、DROP*=限界まで、スーパーセット 3組→6セット'; });
  await T(G.workout, '不具合修正: 最終種目（Day2 カーフ）に自然に到達しても、1セット目は「このセット完了」。最終セットまで進んで初めて「筋トレ完了」になる。遷移のたびに最上部へスクロール', async () => {
    const p2 = await newPage(); await p2.click('.tabs [data-tab="today"]'); await p2.click('[data-shift="1"]'); assert((await p2.locator('.date').textContent()).includes('9/17'), 'on 9/17 = Day2');
    await p2.click('.tabs [data-tab="workout"]'); await p2.waitForSelector('#wuStart');
    for (let id = 1; id <= 6; id++) { await p2.click('[data-wuset="' + id + '"]'); await p2.click('[data-wuset="' + id + '"]'); }
    await p2.click('#wuStart'); await p2.waitForSelector('#setDone');
    const p2text = async sel => (await p2.locator(sel).first().textContent()).trim();
    for (let guard = 0; guard < 60; guard++) {
      if ((await p2text('.ex-head .p')).includes('種目 9/9')) break;
      if ((await p2text('#wv')) === '—') { const q = await p2.$('[data-qk]'); if (q) await q.click(); else await p2.click('[data-pm="w:1"]'); }
      await p2.click('#setDone'); if (await p2.$('#rest:not([hidden])')) { await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden])'); } await p2.waitForTimeout(40);
    }
    // ここが今回の不具合の核心: 8種目すべて終えて9種目目（カーフ、1セット目）に自然到達した瞬間
    assert((await p2text('.ex-head .p')).includes('種目 9/9 ・ セット 1/3'), '9番目のセット1/3に到達: ' + (await p2text('.ex-head .p')));
    assert((await p2text('.ex-name')).includes('カーフ'), 'exercise name in view: ' + (await p2text('.ex-name')));
    assert((await p2text('#setDone')) === 'このセット完了', '1セット目はまだ「このセット完了」（筋トレ完了になってはいけない）: ' + (await p2text('#setDone')));
    assert(await p2.evaluate(() => window.scrollY) === 0, '種目が変わったら最上部へスクロール（種目名が見切れない）');
    // セット1完了 → まだ「このセット完了」・セット2/3
    if ((await p2text('#wv')) === '—') { const q = await p2.$('[data-qk]'); if (q) await q.click(); }
    await p2.click('#setDone'); if (await p2.$('#rest:not([hidden])')) { await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden])'); }
    assert((await p2text('.ex-head .p')).includes('セット 2/3'), 'now on set 2/3: ' + (await p2text('.ex-head .p')));
    assert((await p2text('#setDone')) === 'このセット完了', 'セット2/3でもまだ「このセット完了」: ' + (await p2text('#setDone')));
    // セット2完了 → まだ「このセット完了」・セット3/3
    if ((await p2text('#wv')) === '—') { const q = await p2.$('[data-qk]'); if (q) await q.click(); }
    await p2.click('#setDone'); if (await p2.$('#rest:not([hidden])')) { await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden])'); }
    assert((await p2text('.ex-head .p')).includes('セット 3/3'), 'now on set 3/3: ' + (await p2text('.ex-head .p')));
    assert((await p2text('#setDone')) === 'このセット完了', 'セット3/3（最終セット）に入った直後はまだ「このセット完了」（未記録のまま完了画面に飛ばない）: ' + (await p2text('#setDone')));
    // 最終セットを完了して初めて「筋トレ完了」
    if ((await p2text('#wv')) === '—') { const q = await p2.$('[data-qk]'); if (q) await q.click(); }
    await p2.click('#setDone'); if (await p2.$('#rest:not([hidden])')) { await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden])'); }
    assert((await p2text('#setDone')).includes('筋トレ完了'), '最終種目・最終セットを終えて初めて「筋トレ完了」: ' + (await p2text('#setDone')));
    const rv = await p2.$$eval('.setrows .sr .rv', els => els.map(e => e.textContent)); assert(rv.length === 3 && rv.every(t => t !== '未記録' && t !== ''), '3セットとも記録済み: ' + rv.join(','));
    await p2.click('#setDone'); await p2.waitForSelector('#repDay'); const body = await p2.locator('#view').innerText(); assert(!/未記録|0kg×0/.test(body.split('コーチ報告用テキスト')[0]), '完了画面のやった内容に未記録が残っていない');
    await p2.close();
  });


  // ============ 週 ============
  await goTab('summary'); await page.waitForSelector('#repText');
  await T(G.week, '体重グラフ（実測＋7日平均）。データ1日でも壊れない', async () => { assert(await has('#weightSpark30 svg'), 'svg'); const pt = await page.$$eval('#weightSpark30 svg .pt', els => els.length), ma = await page.$$eval('#weightSpark30 svg .mapt', els => els.length); assert(pt === 1 && ma === 1, '1 measured point + 1 ma point: ' + pt + '/' + ma); assert((await page.$$eval('#weightSpark30 svg polyline', els => els.length)) === 0, 'single day → no line'); assert(!errors.length, 'no errors'); });
  await T(G.week, '遵守率にウォームアップ・筋トレ・有酸素・食事・サプリ・水が含まれる', async () => { const st = await page.$eval('.stat', e => e.textContent); assert(st.includes('筋トレ') && st.includes('ウォームアップ 1/1') && st.includes('食事') && st.includes('有酸素') && st.includes('サプリ 50%') && st.includes('水 1/1'), st); const hist = await text('.hist'); assert(hist.includes('Day1') && hist.includes('ウォームアップ') && hist.includes('遅れ'), 'history table with 遅れ'); assert(await has('details .hist'), 'per-day planned/logged table'); });
  await T(G.week, 'コーチ向けレポート生成→コピーが実データと一致', async () => { const rep = await text('#repText'); assert(rep.startsWith('Week 1 (Sep 16–22) Report'), 'header'); assert(rep.includes('Weight: 72.6 → 72.6 kg (avg 72.6, 1/1 days measured)'), 'weight line: ' + rep.split('\n')[1]); assert(rep.includes('Workouts: 1/1 done, Warm-up: 1/1, Cardio: 1/1 (40 min)'), 'workouts line: ' + rep.split('\n')[2]); assert(rep.includes('Machine or Smith incline press: right shoulder slight discomfort') && rep.includes('meal 3 missed (eating out)'), 'notes: ' + rep); assert(rep.includes('Supplements: 50%') && rep.includes('Water: 1/1 days'), 'supp/water: ' + rep); assert(/Timing: \d+\/\d+ logged within 60 min of plan/.test(rep), 'timing line: ' + rep); await page.click('#copyRep'); await page.waitForTimeout(100); assert((await text('#toast')).includes('コピー'), 'copy toast'); });
  await T(G.week, 'CSV エクスポート。downloads が null ならボタン非表示', async () => { if (mode === 'mock') { assert(!(await page.$eval('#csvBtn', e => !e.hidden)), 'hidden'); return 'downloads null → 非表示'; } await page.click('#csvBtn'); await page.waitForTimeout(200); assert(rt.downloads.length === 1 && rt.downloads[0].filename === 'training-log-2026-09-16.csv' && rt.downloads[0].size > 200, 'saved ' + JSON.stringify(rt.downloads[0])); assert(rt.downloads[0].head.includes('"plannedAt","loggedAt"') && rt.downloads[0].head.includes('"times"'), 'csv has planned/logged columns: ' + rt.downloads[0].head.slice(0, 120)); return rt.downloads[0].filename + ' (' + rt.downloads[0].size + ' bytes)'; });
  await shot('05-summary');

  // ============ 落ちた脂肪（週タブの一番上） ============
  await T(G.week, '「落ちた脂肪」の計算式: BMR(Mifflin-St Jeor)・脂肪1kg=1.1L・体積相当の直径・500mlボトル換算', async () => {
    const r = await page.evaluate(() => { const t = window.__tl; return { bmrVal: t.bmr(72.4, 170, 31, 'male'), fv: t.fatVisual(2.3), kgFrom16560: Math.round((16560 / 7200) * 10) / 10 }; });
    assert(r.bmrVal === 1636.5, 'BMR 72.4kg/170cm/31歳/男性 = 10W+6.25H-5A+5: ' + r.bmrVal);
    assert(r.fv.volumeL === 2.5, '2.3kg×1.1=2.53L → 小数1桁で 2.5L: ' + r.fv.volumeL);
    assert(r.fv.bottles === 5, '2.53L ÷ 0.5L ≈ 約5本分: ' + r.fv.bottles);
    assert(r.fv.diameterMm > 160 && r.fv.diameterMm < 175, '2.53L 相当の球の直径 ≈169mm: ' + r.fv.diameterMm);
    assert(r.kgFrom16560 === 2.3, '累積 −16,560kcal ÷ 7200 = 2.3kg（塊のサイズはこの体積から計算）');
    return 'BMR=' + r.bmrVal + 'kcal（コーチ資料の「約1,690kcal」は計算し直すと1,636.5kcalが正しい値です）・2.3kg→' + r.fv.volumeL + 'L・直径' + r.fv.diameterMm + 'mm・ボトル' + r.fv.bottles + '本分'; });
  await T(G.week, 'TDEE内訳（BMR×活動レベル＋運動）と収支（摂取−TDEE）が仕様の式どおりに出る', async () => { if (mode === 'mock') return 'db のみ（day 単位の状態が要る）';
    const date = '2026-06-08'; // 他のテストと重ならない日付。後片付けして共有 DB を汚さない
    rt.op('set', { coll: 'log_weight', id: date, data: { date, value: 72.4, unit: 'kg', weightKg: 72.4, skipped: false, loggedAt: date + 'T06:40:00+08:00' } });
    rt.op('set', { coll: 'log_workout', id: date, data: { date, sets: {}, meta: {}, warmup: { startedAtIso: date + 'T08:00:00+08:00' }, finished: '09:00', finishedAt: date + 'T09:00:00+08:00' } });
    rt.op('set', { coll: 'log_cardio', id: date, data: { date, entries: [{ type: 'incline', minutes: 40, at: '20:00', loggedAt: date + 'T20:00:00+08:00' }] } });
    rt.op('set', { coll: 'log_meals', id: date, data: { date, meals: { 1: { status: 'substitute', variant: '', photo: null, items: [{ foodId: 'egg_whole', grams: 0, kcal: 2632, p: 0, f: 0, c: 0, origin: 'add', eaten: true, deleted: false, planGrams: '' }], loggedAt: date + 'T07:00:00+08:00', photoId: '', reason: '' } } } });
    try {
      const p2 = await newPage(); await p2.click('.tabs [data-tab="water"]'); // 軽いページ遷移で ST が最新の db 内容を持っていることを保証
      const r = await p2.evaluate((d) => { const t = window.__tl; const b = t.dayCalorieBalance(d);
        const expEx = 6 * 72.4 * 1 /* 60分の筋トレ */ + 6.5 * 72.4 * (40 / 60) /* 傾斜歩き40分 */;
        const expTdee = 1636.5 * 1.35 + expEx; const expBalance = 2632 - expTdee;
        return { b, expEx: Math.round(expEx * 10) / 10, expTdee: Math.round(expTdee * 10) / 10, expBalance: Math.round(expBalance * 10) / 10 }; }, date);
      assert(r.b, 'balance computed'); assert(Math.abs(r.b.exVal - r.expEx) < 0.2, '運動消費 = 筋トレ60分×6METs + 有酸素40分×6.5METs: ' + r.b.exVal + ' vs ' + r.expEx);
      assert(Math.abs(r.b.tdee - r.expTdee) < 0.2, 'TDEE = BMR×活動レベル + 運動: ' + r.b.tdee + ' vs ' + r.expTdee);
      assert(Math.abs(r.b.balance - r.expBalance) < 0.2, '収支 = 摂取2,632kcal − TDEE: ' + r.b.balance + ' vs ' + r.expBalance);
      await p2.close(); return 'TDEE=' + r.b.tdee + 'kcal（運動+' + r.b.exVal + 'kcal）・ 収支=' + r.b.balance + 'kcal';
    } finally { ['log_weight', 'log_workout', 'log_cardio', 'log_meals'].forEach(coll => rt.op('del', { coll, id: date })); } });
  await T(G.week, '「落ちた脂肪」ブロックの表示配線: fatModel() の値がそのまま塊のkg・ボトル本数・実測/予測グラフに使われる。定規スライダーの倍率が保存され、再読み込み後も保持される', async () => { if (mode === 'mock') return 'db のみ';
    const dstart = new Date('2026-06-01T00:00:00+08:00'); const dates = []; // 他のテストと重ならない範囲。後片付けして共有 DB を汚さない
    for (let i = 0; i < 5; i++) { const dt = new Date(dstart.getTime() + i * 86400000); dates.push(dt.toISOString().slice(0, 10)); }
    const savedSettings = Object.assign({}, rt.DB.settings.main);
    dates.forEach(date => {
      rt.op('set', { coll: 'log_weight', id: date, data: { date, value: 72.4, unit: 'kg', weightKg: 72.4, skipped: false, loggedAt: date + 'T06:40:00+08:00' } });
      rt.op('set', { coll: 'log_meals', id: date, data: { date, meals: { 1: { status: 'substitute', variant: '', photo: null, items: [{ foodId: 'egg_whole', grams: 0, kcal: 1400, p: 0, f: 0, c: 0, origin: 'add', eaten: true, deleted: false, planGrams: '' }], loggedAt: date + 'T07:00:00+08:00', photoId: '', reason: '' } } } });
    });
    rt.op('set', { coll: 'settings', id: 'main', data: Object.assign({}, rt.DB.settings.main, { startDate: dates[0] }) });
    try {
      const p2 = await newPage(); await p2.clock.setFixedTime(new Date('2026-06-06T06:50:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
      const fm = await p2.evaluate(() => window.__tl.fatModel());
      assert(fm.available && fm.mealDayCount >= 5, '5日分の食事記録を拾えている: ' + fm.mealDayCount);
      assert(fm.fatKg > 0 && !fm.netGain, '5日連続の赤字 → 塊を表示する側（fatKg>0）: ' + fm.fatKg);
      const fv = await p2.evaluate(kg => window.__tl.fatVisual(kg), fm.fatKg);
      await p2.click('.tabs [data-tab="summary"]'); await p2.waitForSelector('.fat-card');
      assert(await p2.$('.fat-blob svg'), '塊の SVG が描かれる'); const numTxt = await p2.locator('.fat-num').textContent();
      assert(numTxt.includes(String(fm.fatKg)) && numTxt.includes('kg'), 'これまでに落ちた脂肪の数字が fatModel().fatKg と一致: ' + numTxt + ' vs ' + fm.fatKg);
      assert((await p2.locator('.fat-cmp').textContent()).includes('約' + fv.bottles + '本分'), 'ボトル換算が fatVisual().bottles と一致: ' + fv.bottles);
      const legend = await p2.locator('#fatSpark').textContent(); assert(legend.includes('実測') && legend.includes('計算上の予測'), '凡例 実測／計算上の予測: ' + legend);
      assert(await p2.$('#fatSpark svg .pt'), '実測の点がある'); assert(await p2.$('#fatSpark svg .mapt'), '予測の点（連続線）がある');
      await p2.click('.fat-ruler summary'); await p2.waitForSelector('#rulerSlider');
      await p2.$eval('#rulerSlider', e => { e.value = '1.4'; e.dispatchEvent(new Event('input')); }); await p2.waitForTimeout(80);
      const scaled = await p2.$eval('.fat-real', e => getComputedStyle(e).transform); assert(scaled !== 'none' && scaled !== 'matrix(1, 0, 0, 1, 0, 0)', '倍率が画面に反映される: ' + scaled);
      await p2.$eval('#rulerSlider', e => { e.value = '1.4'; e.dispatchEvent(new Event('change')); }); await p2.waitForTimeout(200);
      assert(rt.DB.settings.main.rulerScale === 1.4, '較正倍率が設定に保存される: ' + rt.DB.settings.main.rulerScale);
      await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading')); await p2.click('.tabs [data-tab="summary"]'); await p2.waitForSelector('.fat-blob');
      const afterReload = await p2.$eval('.fat-real', e => getComputedStyle(e).transform); assert(afterReload === scaled, '再読み込み後も倍率が保持される');
      await p2.close(); return 'fatKg=' + fm.fatKg + 'kg・ボトル' + fv.bottles + '本分・較正スライダーの保存を確認';
    } finally { dates.forEach(date => { rt.op('del', { coll: 'log_weight', id: date }); rt.op('del', { coll: 'log_meals', id: date }); }); rt.op('set', { coll: 'settings', id: 'main', data: savedSettings }); } });
  await T(G.today, '今日画面の下部の小さい版: 記録0件は「まだ記録がありません」→ 食事を1つ記録した時点で塊と数字が出る → 追加のたびに数字が更新される', async () => {
    const date2 = '2026-04-10';
    // db モードは log_weight がグローバルなので、他テストが記録済みの体重を一時退避して「体重0件」の状態を作る
    const savedWeights = mode === 'db' ? Object.assign({}, rt.DB.log_weight) : {};
    if (mode === 'db') Object.keys(savedWeights).forEach(id => rt.op('del', { coll: 'log_weight', id }));
    try {
      const p2 = await newPage(); await p2.clock.setFixedTime(new Date(date2 + 'T06:50:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
      await p2.click('.tabs [data-tab="today"]'); await p2.waitForSelector('.fat-mini');
      const t2 = async () => (await p2.locator('.fat-mini').textContent()).trim();
      assert((await t2()).includes('体重を記録すると表示されます'), '体重も食事も無い → 体重の案内');
      await p2.fill('#nowW', '72.4'); await p2.click('#nowBtn'); await p2.waitForFunction(() => document.querySelector('[data-step="weight"]').classList.contains('done'));
      assert((await t2()).includes('まだ記録がありません'), '体重はあるが食事が無い → まだ記録がありません（1日目でも「データが足りません」ではない）');
      await p2.click('[data-open="meal:1"]'); await p2.waitForSelector('#mPlan'); await p2.click('#mPlan'); await p2.waitForSelector('#sheet', { state: 'hidden' });
      assert(await p2.$('.fat-mini .fat-blob-mini svg'), '食事を1つ記録した時点で小さい塊が出る（待たせない）');
      const after1 = await t2(); assert(/今日 −[\d,]+ kcal → 脂肪 \d+g/.test(after1), '「今日 −N kcal → 脂肪 Ng」の書式: ' + after1); assert(after1.includes('これまで合計'), 'これまでの合計kgも出る: ' + after1);
      await p2.click('[data-open="meal:2"]'); await p2.waitForSelector('#mPlan'); await p2.click('#mPlan'); await p2.waitForSelector('#sheet', { state: 'hidden' });
      const after2 = await t2(); assert(after2 !== after1, '食事を追加するたびに今日の数字が更新される: ' + after1 + ' → ' + after2);
      await p2.click('.tabs [data-tab="summary"]'); await p2.waitForSelector('.fat-card'); assert(await p2.$('.fat-blob svg'), '週タブにも同じ日の塊が出る（今日画面と週タブの両方）');
      await p2.close(); return '記録0件→まだ記録がありません、1食目でただちに塊表示、2食目で数字が更新、今日画面と週タブ両方に表示';
    } finally { rt.op('del', { coll: 'log_weight', id: date2 }); rt.op('del', { coll: 'log_meals', id: date2 }); Object.entries(savedWeights).forEach(([id, data]) => rt.op('set', { coll: 'log_weight', id, data })); } });
  await T(G.week, 'データ不足時のフォールバック: 体重0件→非表示メッセージ／記録0件→「まだ記録がありません」／1日でもあれば塊を表示／今週プラス→「今週は +Xkg」', async () => { if (mode === 'mock') return 'db のみ';
    // 体重が1件も無い状態を一時的に作る（既存の log_weight を退避 → 空にして確認 → 元に戻す）
    const savedWeights = Object.assign({}, rt.DB.log_weight);
    Object.keys(savedWeights).forEach(id => rt.op('del', { coll: 'log_weight', id }));
    try { const pw = await newPage(); await pw.click('.tabs [data-tab="today"]'); await pw.waitForSelector('.fat-mini');
      assert((await pw.locator('.fat-mini').textContent()).includes('体重を記録すると表示されます'), '今日画面の小さい版: 体重0件 → 案内文');
      await pw.click('.tabs [data-tab="summary"]'); await pw.waitForSelector('.fat-card');
      assert((await pw.locator('.fat-card').textContent()).includes('体重を記録すると表示されます'), '週タブ: 体重0件 → 案内文'); assert(!(await pw.$('.fat-blob')) && !(await pw.$('.fat-card .spark')), '塊もグラフも出さない');
      await pw.close();
    } finally { Object.entries(savedWeights).forEach(([id, data]) => rt.op('set', { coll: 'log_weight', id, data })); }
    // 他のテストと重ならない範囲（6月）。後片付けして共有 DB を汚さない
    const savedSettings = Object.assign({}, rt.DB.settings.main);
    const gainDate1 = '2026-06-11', gainDate2 = '2026-06-12', gainDate3 = '2026-06-13';
    try {
      rt.op('set', { coll: 'log_weight', id: gainDate1, data: { date: gainDate1, value: 72.4, unit: 'kg', weightKg: 72.4, skipped: false, loggedAt: gainDate1 + 'T06:40:00+08:00' } });
      rt.op('set', { coll: 'settings', id: 'main', data: Object.assign({}, rt.DB.settings.main, { startDate: gainDate1 }) });
      const p3a = await newPage(); await p3a.clock.setFixedTime(new Date(gainDate1 + 'T20:00:00+08:00')); await p3a.reload(); await p3a.waitForFunction(() => !document.querySelector('#view .loading')); await p3a.click('.tabs [data-tab="summary"]'); await p3a.waitForSelector('.fat-card');
      assert((await p3a.locator('.fat-card').textContent()).includes('まだ記録がありません'), '体重はあるが食事0件 → まだ記録がありません'); await p3a.close();
      rt.op('set', { coll: 'log_meals', id: gainDate1, data: { date: gainDate1, meals: { 1: { status: 'substitute', variant: '', photo: null, items: [{ foodId: 'egg_whole', grams: 0, kcal: 1600, p: 0, f: 0, c: 0, origin: 'add', eaten: true, deleted: false, planGrams: '' }], loggedAt: gainDate1 + 'T07:00:00+08:00', photoId: '', reason: '' } } } });
      const p3 = await newPage(); await p3.clock.setFixedTime(new Date(gainDate1 + 'T20:00:00+08:00')); await p3.reload(); await p3.waitForFunction(() => !document.querySelector('#view .loading')); await p3.click('.tabs [data-tab="summary"]'); await p3.waitForSelector('.fat-card');
      assert(await p3.$('.fat-blob svg'), '1日目・食事1件だけでも塊を表示する（待たせない）');
      await p3.close();
      // 累積がプラス（3日とも記録・大幅な過食）→「今週は +Xkg」
      [gainDate2, gainDate3].forEach(date => rt.op('set', { coll: 'log_weight', id: date, data: { date, value: 72.4, unit: 'kg', weightKg: 72.4, skipped: false, loggedAt: date + 'T06:40:00+08:00' } }));
      const gd = [gainDate1, gainDate2, gainDate3];
      gd.forEach(date => rt.op('set', { coll: 'log_meals', id: date, data: { date, meals: { 1: { status: 'substitute', variant: '', photo: null, items: [{ foodId: 'egg_whole', grams: 0, kcal: 6000, p: 0, f: 0, c: 0, origin: 'add', eaten: true, deleted: false, planGrams: '' }], loggedAt: date + 'T07:00:00+08:00', photoId: '', reason: '' } } } }));
      const p4 = await newPage(); await p4.clock.setFixedTime(new Date('2026-06-14T06:50:00+08:00')); await p4.reload(); await p4.waitForFunction(() => !document.querySelector('#view .loading'));
      const fm4 = await p4.evaluate(() => window.__tl.fatModel()); assert(fm4.netGain, '大幅な過食3日 → 累積プラス（netGain）: ' + JSON.stringify(fm4.fatKg));
      await p4.click('.tabs [data-tab="summary"]'); await p4.waitForSelector('.fat-card'); const gainTxt = await p4.locator('.fat-gain').textContent(); assert(/^今週は \+/.test(gainTxt.trim()), '「今週は +Xkg」（責めない表現・塊は出さない）: ' + gainTxt); assert(!(await p4.$('.fat-blob')), '増えている週は塊を出さない');
      await p4.close();
      return '体重のみ→記録なしメッセージ・食事1件で即塊表示・累積プラスの3つのフォールバックを確認';
    } finally { [gainDate1, gainDate2, gainDate3].forEach(date => { rt.op('del', { coll: 'log_weight', id: date }); rt.op('del', { coll: 'log_meals', id: date }); }); rt.op('set', { coll: 'settings', id: 'main', data: savedSettings }); } });

  // ============ 欠測・できなかった ============
  await T(G.missed, '体重「測れなかった」→ 灰色「−」・理由表示・「いま」は次へ進む', async () => { await setTime('2026-09-17T06:45:00+08:00'); await goTab('today'); await page.click('[data-shift="1"]'); assert((await text('.date')).includes('9/17'), 'on 9/17'); await page.click('[data-open="weight"]'); await page.waitForSelector('#shNA'); await page.click('#shNA'); await pickReason('外泊・旅行'); await page.waitForTimeout(150);
    const m = await mark('weight'); assert(m.startsWith('na|chk na|−'), 'weight mark: ' + m); assert((await text('[data-step="weight"]')).includes('測れなかった（外泊・旅行）'), 'row text'); assert(!(await page.$('[data-step="weight"] .chk.on')), 'no green'); assert((await text('#now .t')).includes('リンゴ酢'), 'now moved on: ' + (await text('#now .t'))); if (mode === 'db') { await page.waitForTimeout(200); const w = rt.DB.log_weight['2026-09-17']; assert(w.skipped === true && w.reason === '外泊・旅行' && w.loggedAt, 'db ' + JSON.stringify(w)); } });
  await T(G.missed, '測れなかった → 翌日通常記録 → グラフは欠測日をつながず・平均は実測のみ・週まとめ/レポート/CSV が正しい', async () => { await setTime('2026-09-18T06:45:00+08:00'); await goTab('today'); await page.click('[data-shift="1"]'); assert((await text('.date')).includes('9/18'), 'on 9/18'); await page.fill('#nowW', '72.0'); await page.click('#nowBtn'); await page.waitForFunction(() => document.querySelector('[data-step="weight"]').dataset.mark === 'ok');
    await goTab('summary'); await page.waitForSelector('#repText'); const pts = await page.$$eval('#weightSpark30 svg .pt', els => els.map(e => e.dataset.date + '=' + e.dataset.v)); assert(pts.join(',') === '2026-09-16=72.6,2026-09-18=72', 'points ' + pts.join(',')); assert((await page.$$eval('#weightSpark30 svg polyline', els => els.length)) === 0, '2 non-adjacent days → no connecting line'); const ma = await page.$$eval('#weightSpark30 svg .mapt', els => els.map(e => e.dataset.date + '=' + e.dataset.v)); assert(ma.includes('2026-09-18=72.3'), '7日平均は実測 (72.6+72.0)/2=72.3: ' + ma.join(','));
    assert((await page.$eval('.stat', e => e.textContent)).includes('体重 2/3 日 測定'), 'measured days'); const rep = await text('#repText'); assert(rep.includes('Weight: 72.6 → 72 kg (avg 72.3, 2/3 days measured, skipped: travel×1)'), 'report weight line: ' + rep.split('\n')[1]); assert(rep.includes('09/17 weight missed (travel)'), 'notes auto: ' + rep); assert((await text('#missedBlock')).includes('9/17') && (await text('#missedBlock')).includes('外泊・旅行'), 'missed block');
    if (mode === 'db') { await page.click('#csvBtn'); await page.waitForTimeout(200); const dl = rt.downloads[rt.downloads.length - 1]; assert(dl.head.includes('"skipped","reason"'), 'csv columns: ' + dl.head.slice(0, 100)); assert(dl.size > 0); } return 'points=' + pts.join(',') + ' / ma(9/18)=72.3'; });
  await T(G.missed, 'あとで測れたら数値保存で skipped 解除。「記録を取り消す」で未記録に戻る', async () => { await goTab('today'); await page.click('[data-shift="-1"]'); assert((await text('.date')).includes('9/17'), 'on 9/17'); await page.click('[data-open="weight"]'); await page.waitForSelector('#shSave'); await page.fill('#shW', '72.3'); await page.click('#shSave'); await page.waitForFunction(() => document.querySelector('[data-step="weight"]').dataset.mark === 'ok'); assert((await text('[data-step="weight"]')).includes('72.3kg'), 'measured later'); if (mode === 'db') { await page.waitForTimeout(150); assert(!rt.DB.log_weight['2026-09-17'].skipped, 'skipped cleared'); }
    await page.click('[data-chk="weight"]'); await page.waitForFunction(() => document.querySelector('[data-step="weight"]').dataset.mark === ''); assert((await text('#toast')).includes('取り消しました'), 'cancel toast'); await page.click('#toast button'); await page.waitForFunction(() => document.querySelector('[data-step="weight"]').dataset.mark === 'ok'); await page.click('[data-open="weight"]'); await page.waitForSelector('#shCancel'); await page.click('#shCancel'); await dlgOk(); await page.waitForFunction(() => document.querySelector('[data-step="weight"]').dataset.mark === ''); if (mode === 'db') { await page.waitForTimeout(150); assert(!rt.DB.log_weight['2026-09-17'], 'db doc removed'); } });
  await T(G.missed, 'サプリ「今日はなし（理由）」→ 灰色−・理由表示。再タップで取り消し', async () => { await page.click('[data-open="supp:after_meal"]'); await page.waitForSelector('#suppNA'); await page.click('#suppNA'); await pickReason('切れていた'); await page.waitForTimeout(150); const m = await mark('supp:after_meal'); assert(m.startsWith('na|chk na|−'), 'supp mark ' + m); assert((await text('[data-step="supp:after_meal"]')).includes('今日はなし（切れていた）'), 'reason line'); await page.click('[data-chk="supp:after_meal"]'); await page.waitForFunction(() => document.querySelector('[data-step="supp:after_meal"]').dataset.mark === ''); assert((await text('#toast')).includes('取り消しました'), 'undo toast');
    // ルーティンは長押し
    await page.dispatchEvent('[data-chk="routine:1"]', 'pointerdown'); await page.waitForTimeout(700); await page.dispatchEvent('[data-chk="routine:1"]', 'pointerup'); await pickReason('忘れた'); await page.waitForTimeout(150); assert((await mark('routine:1')).startsWith('na|'), 'routine long-press NA'); assert((await text('[data-step="routine:1"]')).includes('今日はなし（忘れた）'), 'routine reason'); });
  await T(G.missed, '筋トレ「できなかった（理由）」→ Day をずらすと翌日以降の Day が 1 つ戻る。取り消しで元に戻る', async () => { await setTime('2026-09-19T08:00:00+08:00'); await page.click('[data-shift="1"]'); await page.click('[data-shift="1"]'); assert((await text('h1')).startsWith('Day 4'), '9/19 = Day4'); await page.click('[data-chk="workout"]'); await page.waitForSelector('[data-choice="1"]'); await page.click('[data-choice="1"]'); await pickReason('仕事'); await page.waitForSelector('[data-choice="0"]'); await page.click('[data-choice="0"]'); await page.waitForTimeout(150);
    assert((await mark('workout')).startsWith('na|chk na|−'), 'workout na'); assert((await text('[data-step="workout"]')).includes('できなかった（仕事）') && (await text('[data-step="workout"]')).includes('Day をずらす'), 'row'); if (mode === 'db') { await page.waitForTimeout(150); const dd = rt.DB.log_daily['2026-09-19']; assert(dd.workoutMissed && dd.workoutMissed.shift === true && dd.workoutMissed.reason === '仕事', 'log_daily ' + JSON.stringify(dd.workoutMissed)); }
    await page.click('[data-shift="1"]'); assert((await text('h1')).startsWith('Day 4'), '9/20 → Day4 (shifted)'); await page.click('[data-shift="1"]'); assert((await text('h1')).startsWith('Day 5'), '9/21 → Day5'); await page.click('[data-shift="-1"]'); await page.click('[data-shift="-1"]');
    await page.click('[data-chk="workout"]'); await page.waitForFunction(() => document.querySelector('[data-step="workout"]').dataset.mark === ''); await page.click('[data-shift="1"]'); assert((await text('h1')).startsWith('Day 5'), '取り消し後 9/20 → Day5'); await page.click('[data-shift="-1"]');
    await page.click('[data-chk="cardio"]'); await page.waitForSelector('[data-choice="1"]'); await page.click('[data-choice="1"]'); await pickReason('体調不良'); await page.waitForTimeout(150); assert((await text('[data-step="cardio"]')).includes('できなかった（体調不良）'), 'cardio missed');
    await goTab('summary'); await page.waitForSelector('#missedBlock'); const mb = await text('#missedBlock'); assert(mb.includes('有酸素') && mb.includes('体調不良') && mb.includes('忘れた') && !mb.includes('切れていた'), 'missed block lists cardio + routine (cancelled supp NA excluded): ' + mb); assert((await text('#repText')).includes('cardio missed (sick)'), 'report notes cardio'); for (let i = 0; i < 3; i++) { await goTab('today'); await page.click('[data-shift="-1"]'); } await setTime('2026-09-16T08:40:00+08:00'); });

  await T(G.common, 'db スキーマ: log_weight{value,unit,skipped,skipReason,loggedAt} / warmup{completed,minutes,loggedAt} / meals{status: plan|substitute|skip|photo, photoId, reason} / log_daily{dayNo,dayName,notes,skippedItems[]}', async () => { if (mode === 'mock') return 'db のみ';
    const w = rt.DB.log_weight['2026-09-16']; assert(w.value === 72.6 && w.unit === 'kg' && w.skipped === false && w.loggedAt, 'weight ' + JSON.stringify(w));
    const wu = rt.DB.log_workout['2026-09-16'].warmup; assert(wu.completed === true && wu.minutes >= 1 && wu.loggedAt, 'warmup ' + JSON.stringify(wu));
    const meals = rt.DB.log_meals['2026-09-16'].meals; const sts = Object.values(meals).map(m => m.status); assert(sts.every(x => ['plan', 'substitute', 'skip', 'photo'].includes(x)), 'statuses ' + sts.join(',')); assert(Object.values(meals).every(m => 'photoId' in m && 'reason' in m && m.loggedAt), 'photoId/reason/loggedAt'); const sk = Object.values(meals).find(m => m.status === 'skip'); if (sk) assert(sk.reason, 'skip reason persisted');
    const dd = rt.DB.log_daily['2026-09-17']; assert(dd && dd.dayName === 'Pull' && Array.isArray(dd.skippedItems) && 'notes' in dd, 'daily ' + JSON.stringify(dd)); const dd16 = rt.DB.log_daily['2026-09-16']; assert(dd16 && dd16.skippedItems.some(x => x.item === 'meal 3'), 'skippedItems lists meal 3: ' + JSON.stringify(dd16 && dd16.skippedItems)); return 'statuses=' + sts.join(',') + ' / 9/16 skippedItems=' + dd16.skippedItems.map(x => x.item).join('|'); });

  // ============ 写真で記録 ============
  const G2 = '写真で記録';
  const makeImageFile = (w, h, noise) => page.evaluate(([w, h, noise]) => new Promise(res => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const ctx = cv.getContext('2d'); if (noise) { const id = ctx.createImageData(w, h); const a = id.data; for (let i = 0; i < a.length; i += 4) { a[i] = Math.random() * 255; a[i + 1] = Math.random() * 255; a[i + 2] = Math.random() * 255; a[i + 3] = 255; } ctx.putImageData(id, 0, 0); } else { const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#c33'); g.addColorStop(1, '#3c3'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); } cv.toBlob(b => { window.__img = new File([b], 'meal.' + (noise ? 'png' : 'jpg'), { type: b.type }); res({ size: b.size, type: b.type }); }, noise ? 'image/png' : 'image/jpeg', 0.95); }), [w, h, noise]);
  const setPhoto = () => page.evaluate(() => { const inp = document.querySelector('#phFile'); const dt = new DataTransfer(); dt.items.add(window.__img); inp.files = dt.files; inp.dispatchEvent(new Event('change')); });
  await T(G2, '写真→推定→修正→記録→合計に反映→取り消し→合計から消える', async () => { await goTab('today'); assert((await text('.date')).includes('9/16'), 'on 9/16');
    if (mode === 'mock') { await page.click('[data-open="meal:5"]'); await page.waitForSelector('#mChange'); assert(!(await has('#mPhoto')), 'sample null → 写真ボタン非表示'); await closeSheet(); return 'sample null → 写真ボタン非表示（テキスト入力のみ）'; }
    const total = async () => Number((await page.$eval('.card', e => e.textContent)).match(/カロリー ([\d,]+)/)[1].replace(/,/g, ''));
    const base = await total(); const nAssets = rt.assets.length;
    await page.click('[data-open="meal:5"]'); await page.waitForSelector('#mPhoto'); await page.click('#mPhoto'); await page.waitForSelector('#phFile');
    await makeImageFile(3000, 2000, false); await setPhoto(); await page.waitForSelector('#phEst'); const dim = await text('#photoPanel .num'); assert(dim.startsWith('1280×853'), 'resized to 1280×853: ' + dim);
    await page.fill('#phNote', 'ご飯は少なめ'); await page.click('#phEst'); await page.waitForSelector('#phSave', { timeout: 15000 });
    const sc = rt.sampleCalls[rt.sampleCalls.length - 1]; assert(sc.hasImage && sc.imageType === 'image/jpeg' && sc.imageSize < 1000000 && sc.tier === 'default', 'sample got resized jpeg on default tier: ' + JSON.stringify(sc)); assert(sc.prompt.length > 0);
    assert((await page.$$eval('.photo .est .it', els => els.length)) === 2, 'two item rows'); assert((await text('.photo .conf')).includes('推定の確度: 中'), 'confidence'); assert((await text('.photo .row2')).includes('合計 652kcal※'), 'total 652※');
    await page.click('[data-phg="0:10"]'); await page.waitForSelector('#phSave'); assert((await text('.photo .est .it')).includes('210g'), 'grams +10'); await page.click('[data-phoff="1"]'); await page.waitForSelector('#phSave'); assert((await text('.photo .row2')).includes('合計 328kcal※'), 'exclude item → 328: ' + (await text('.photo .row2')));
    await page.click('#phSave'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(250);
    const row = await text('[data-step="meal:5"]'); assert(row.includes('📷') && row.includes('白ご飯210g') && /約328kcal※/.test(row), 'row: ' + row); assert((await total()) === base + 328, 'total +328: ' + (await total()) + ' vs ' + base);
    assert(rt.assets.length === nAssets + 1 && rt.assets[nAssets].type === 'image/jpeg', 'photo uploaded to assets'); const med = Object.values(rt.DB.log_media).find(m => m.category === 'meal'); assert(med && med.mealNo === 5 && med.assetId === rt.assets[nAssets].id, 'log_media meal link'); const fd = Object.values(rt.DB.foods).find(f => f.source === 'ai_photo'); assert(fd && fd.nameJa === '白ご飯' && Math.round(fd.kcal) === 156, 'foods ai_photo per100g: ' + JSON.stringify(fd)); assert(rt.DB.log_meals['2026-09-16'].meals[5].photo.assetId === med.assetId, 'meal photo ref');
    await page.click('[data-photo="5"]'); await page.waitForSelector('#dlg img.thumb'); assert((await page.$eval('#dlg img.thumb', e => e.getAttribute('src'))).startsWith('/_blob/'), 'thumbnail from assets'); await page.click('#dlgNo'); await page.waitForSelector('#dlg', { state: 'hidden' });
    await page.click('[data-chk="meal:5"]'); await page.waitForFunction(() => document.querySelector('[data-step="meal:5"]').dataset.mark === ''); assert((await total()) === base, 'cancel → total back');
    await goTab('summary'); await page.waitForSelector('#repText'); await goTab('today'); return '1280×853 JPEG ' + Math.round(sc.imageSize / 1024) + 'KB を送信 / 白ご飯 210g=328kcal※ を記録'; });
  await T(G2, '今日画面の「📷 食べたものを写真で記録」→ 間食（プラン外）として記録 → タイムラインに時刻順で挿入 → 合計に反映 → 取り消しで消える', async () => { await goTab('today'); if (mode === 'mock') { assert(!(await has('#photoBtn')), 'sample null → ボタン非表示'); return 'sample null → ボタン非表示'; }
    await setTime('2026-09-16T15:00:00+08:00'); await goTab('workout'); await goTab('today'); assert(await has('#photoBtn') && (await text('#photoBtn')).includes('写真で記録'), 'button under now card'); assert(await page.$eval('#photoFile', e => e.getAttribute('accept') === 'image/*' && e.getAttribute('capture') === null), 'gallery picker: no capture attribute so camera and library both offered');
    const total = async () => Number((await page.$eval('.card', e => e.textContent)).match(/カロリー ([\d,]+)/)[1].replace(/,/g, '')); const base = await total();
    const pick = () => page.evaluate(() => { const inp = document.querySelector('#photoFile'); const dt = new DataTransfer(); dt.items.add(window.__img); inp.files = dt.files; inp.dispatchEvent(new Event('change')); });
    await makeImageFile(1600, 1200, false); await pick(); await page.waitForSelector('#dlg:not([hidden]) [data-choice]'); const labels = await page.$$eval('#dlg [data-choice]', els => els.map(e => e.textContent)); assert(labels.length === 6 && labels[0].startsWith('1食目') && labels[5].includes('間食（プラン外）'), 'meal choices: ' + labels.join(' | ')); await page.click('#dlg [data-choice="5"]');
    await page.waitForSelector('#phEst'); assert((await text('#sheet h3')).includes('間食'), 'snack sheet'); assert(!(await has('#mPlan')) && !(await has('#mReset')), 'no plan buttons for snack'); await page.click('#phEst'); await page.waitForSelector('#phSave', { timeout: 15000 }); await page.click('#phSave'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForSelector('[data-step="meal:snack_1"]');
    const ids = await page.$$eval('.step', els => els.map(e => e.dataset.step)); const ix = k => ids.indexOf(k); assert(ix('meal:snack_1') > ix('meal:4') && ix('meal:snack_1') < ix('meal:5'), 'inserted by time (15:00 between logged meal4 and planned meal5 19:30): ' + ids.join(','));
    const row = await text('[data-step="meal:snack_1"]'); assert(row.includes('間食') && row.includes('プラン外') && row.includes('kcal※') && row.includes('15:00'), 'snack row: ' + row); assert(await has('[data-step="meal:snack_1"] .cam'), '📷 icon'); assert((await mark('meal:snack_1')).startsWith('ok|'), 'snack mark'); assert((await total()) === base + 652, 'total +652: ' + (await total()) + ' vs ' + base);
    await page.waitForTimeout(200); const doc = rt.DB.log_meals['2026-09-16'].meals.snack_1; assert(doc && doc.status === 'photo' && doc.items.length === 2 && doc.items.every(i => i.estimated) && doc.photoId, 'db snack_1: ' + JSON.stringify(doc).slice(0, 200)); assert(Object.values(rt.DB.foods).some(f => f.source === 'ai_photo'), 'foods ai_photo');
    await page.click('[data-chk="meal:snack_1"]'); await page.waitForFunction(() => !document.querySelector('[data-step="meal:snack_1"]')); assert((await total()) === base, 'total back after cancel'); assert((await text('#toast')).includes('間食の記録を取り消しました'), 'undo toast'); await page.waitForTimeout(200); assert(!rt.DB.log_meals['2026-09-16'].meals.snack_1, 'db doc removed'); return '間食 snack_1 → 652kcal※ 加算 → 取り消しで 0'; });
  await T(G2, '今日画面の写真ボタンで記録済みの食事を選ぶと「追加／置き換え」を選べる', async () => { if (mode === 'mock') return 'db のみ'; await goTab('today'); const total = async () => Number((await page.$eval('.card', e => e.textContent)).match(/カロリー ([\d,]+)/)[1].replace(/,/g, ''));
    const pick = () => page.evaluate(() => { const inp = document.querySelector('#photoFile'); const dt = new DataTransfer(); dt.items.add(window.__img); inp.files = dt.files; inp.dispatchEvent(new Event('change')); });
    const m2 = rt.DB.log_meals['2026-09-16'].meals[2]; assert(m2 && m2.status !== 'skip', 'meal 2 is logged'); const before = await total(); const m2kcal = Math.round(m2.items.filter(i => !i.deleted && i.eaten !== false).reduce((a, i) => a + Number(i.kcal), 0));
    await pick(); await page.waitForSelector('#dlg:not([hidden]) [data-choice]'); assert((await text('#dlg [data-choice="1"]')).includes('記録済み'), '2食目 marked as logged'); await page.click('#dlg [data-choice="1"]'); await page.waitForSelector('#dlg:not([hidden]) [data-choice="1"]'); assert((await text('#dlg h3')).includes('記録済み') && (await text('#dlg [data-choice="0"]')).includes('追加') && (await text('#dlg [data-choice="1"]')).includes('置き換え'), 'add/replace dialog'); await page.click('#dlg [data-choice="1"]');
    await page.waitForSelector('#phEst'); assert((await text('#sheet h3')).includes('2食目'), 'meal 2 sheet'); await page.click('#phEst'); await page.waitForSelector('#phSave', { timeout: 15000 }); await page.click('#phSave'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(250);
    const after = rt.DB.log_meals['2026-09-16'].meals[2]; assert(after.status === 'photo' && after.items.length === 2 && after.items.every(i => i.estimated), 'replaced: ' + JSON.stringify(after.items.map(i => i.foodId))); assert((await total()) === before - m2kcal + 652, 'total replaced: ' + (await total()) + ' = ' + before + ' - ' + m2kcal + ' + 652');
    await pick(); await page.waitForSelector('#dlg:not([hidden]) [data-choice]'); await page.click('#dlg [data-choice="1"]'); await page.waitForSelector('#dlg:not([hidden]) [data-choice="1"]'); await page.click('#dlg [data-choice="0"]'); await page.waitForSelector('#phEst'); await page.click('#phEst'); await page.waitForSelector('#phSave', { timeout: 15000 }); await page.click('#phSave'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(250);
    const added = rt.DB.log_meals['2026-09-16'].meals[2]; assert(added.items.length === 4, 'added: ' + added.items.length); assert((await total()) === before - m2kcal + 652 * 2, 'total added'); await page.click('[data-open="meal:2"]'); await page.waitForSelector('#mCancel'); await page.click('#mCancel'); await dlgOk(); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(200); assert(!rt.DB.log_meals['2026-09-16'].meals[2], 'meal 2 cancelled'); return '置き換え → 2品目 / 追加 → 4品目 / 取り消し'; });
  await T(G2, '推定 JSON の parse 失敗時にアプリが落ちず、手入力に切替できる', async () => { if (mode === 'mock') return '写真ボタン非表示のため対象外'; await page.click('[data-open="meal:5"]'); await page.waitForSelector('#mPhoto'); await page.click('#mPhoto'); await page.waitForSelector('#phFile'); await makeImageFile(800, 600, false); await setPhoto(); await page.waitForSelector('#phEst'); await page.fill('#phNote', 'BAD'); await page.click('#phEst'); await page.waitForSelector('#phManual', { timeout: 15000 }); assert((await text('.photo .pending')).includes('推定結果を読み取れませんでした'), 'error line: ' + (await text('.photo .pending'))); await page.click('#phManual'); await page.waitForSelector('#freeTxt'); assert(!(await has('#photoPanel')) && !(await page.$eval('#sub', e => e.hidden)), 'switched to manual'); assert(!errors.length, 'no page errors'); await closeSheet(); });
  await T(G2, '画像非対応（limits.images 無し）でも写真ボタンと「AIで推定」は出る（sample があれば、limits() を信じず実際に呼んで判断）。失敗したら案内→手入力に切替、写真はメモとして残る', async () => { if (mode === 'mock') return 'sample null で非表示（上で確認）'; const p2 = await newPage({ noImages: true }); await p2.waitForTimeout(600); await p2.click('.tabs [data-tab="today"]');
    assert(await p2.$('#photoBtn'), 'today screen button still shown (sample present)');
    await p2.click('[data-open="meal:5"]'); await p2.waitForSelector('#mChange'); assert(await p2.$('#mPhoto'), 'photo button shown despite limits().images missing'); await p2.click('#mPhoto'); await p2.waitForSelector('#phFile');
    await p2.evaluate(() => new Promise(res => { const cv = document.createElement('canvas'); cv.width = 600; cv.height = 400; cv.getContext('2d').fillStyle = '#c93'; cv.getContext('2d').fillRect(0, 0, 600, 400); cv.toBlob(b => { const inp = document.querySelector('#phFile'); const dt = new DataTransfer(); dt.items.add(new File([b], 'm.jpg', { type: 'image/jpeg' })); inp.files = dt.files; inp.dispatchEvent(new Event('change')); res(); }, 'image/jpeg', 0.9); }));
    await p2.waitForSelector('#phEst'); await p2.click('#phEst'); await p2.waitForSelector('#photoPanel .pending', { timeout: 15000 });
    assert((await p2.locator('#photoPanel').textContent()).includes('解析ができない環境です'), 'real rejection (images_unavailable) surfaced, not a pre-emptive guess'); assert(await p2.$('#phManual'), 'manual switch offered');
    await p2.click('#phManual'); await p2.waitForSelector('#freeTxt'); assert(!(await p2.$('#photoPanel')), 'back to normal add flow'); await p2.close(); });
  await T(G2, 'assets null で推定だけ動く（写真はメモリ保持、記録は保存）', async () => { if (mode === 'mock') return 'db のみ'; const p2 = await newPage({ noAssets: true }); await p2.waitForTimeout(600); await p2.click('.tabs [data-tab="today"]'); const nAssets = rt.assets.length; await p2.click('[data-open="meal:5"]'); await p2.waitForSelector('#mPhoto'); await p2.click('#mPhoto'); await p2.waitForSelector('#phFile');
    await p2.evaluate(() => new Promise(res => { const cv = document.createElement('canvas'); cv.width = 600; cv.height = 400; cv.getContext('2d').fillStyle = '#c93'; cv.getContext('2d').fillRect(0, 0, 600, 400); cv.toBlob(b => { const inp = document.querySelector('#phFile'); const dt = new DataTransfer(); dt.items.add(new File([b], 'm.jpg', { type: 'image/jpeg' })); inp.files = dt.files; inp.dispatchEvent(new Event('change')); res(); }, 'image/jpeg', 0.9); }));
    await p2.waitForSelector('#phEst'); await p2.click('#phEst'); await p2.waitForSelector('#phSave', { timeout: 15000 }); await p2.click('#phSave'); await p2.waitForSelector('#sheet', { state: 'hidden' }); await p2.waitForTimeout(250);
    assert(rt.assets.length === nAssets, 'no upload'); const meal = rt.DB.log_meals['2026-09-16'].meals[5]; assert(meal && meal.photo && !meal.photo.assetId && meal.items.length === 2, 'recorded without assetId'); assert((await p2.locator('[data-step="meal:5"]').textContent()).includes('📷'), 'camera icon'); await p2.click('[data-photo="5"]'); await p2.waitForSelector('#dlg:not([hidden])'); assert((await p2.$eval('#dlg', e => e.textContent)).includes('保存されていません') || await p2.$('#dlg img.thumb'), 'photo dialog'); await p2.close();
    // 後始末: メインページで取り消し
    await page.reload(); await page.waitForFunction(() => !document.querySelector('#view .loading')); await goTab('today'); await page.click('[data-chk="meal:5"]'); await page.waitForFunction(() => document.querySelector('[data-step="meal:5"]').dataset.mark === ''); });
  await T(G2, '縦長・横長・大きい写真（10MB超）で送信前にリサイズ（長辺1280px、JPEG 0.8）して成功する', async () => { const r = await page.evaluate(async () => { const mk = (w, h, noise) => new Promise(res => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const ctx = cv.getContext('2d'); if (noise) { const id = ctx.createImageData(w, h); const a = id.data; for (let i = 0; i < a.length; i += 4) { a[i] = Math.random() * 255; a[i + 1] = Math.random() * 255; a[i + 2] = Math.random() * 255; a[i + 3] = 255; } ctx.putImageData(id, 0, 0); } else { ctx.fillStyle = '#48c'; ctx.fillRect(0, 0, w, h); } cv.toBlob(b => res(new File([b], 'x', { type: b.type })), noise ? 'image/png' : 'image/jpeg', 0.95); });
    const out = {}; const big = await mk(3200, 2400, true); const rb = await window.__tl.resizeImage(big, 1280, 0.8); out.big = { inSize: big.size, w: rb.width, h: rb.height, type: rb.blob.type, outSize: rb.blob.size };
    const land = await mk(4000, 2000, false); const rl = await window.__tl.resizeImage(land); out.land = { w: rl.width, h: rl.height }; const port = await mk(1500, 3000, false); const rp = await window.__tl.resizeImage(port); out.port = { w: rp.width, h: rp.height }; const small = await mk(640, 480, false); const rs = await window.__tl.resizeImage(small); out.small = { w: rs.width, h: rs.height }; return out; });
    assert(r.big.inSize > 10 * 1024 * 1024, 'noise png > 10MB: ' + r.big.inSize); assert(r.big.w === 1280 && r.big.h === 960 && r.big.type === 'image/jpeg' && r.big.outSize < 1.5 * 1024 * 1024, 'big → ' + JSON.stringify(r.big)); assert(r.land.w === 1280 && r.land.h === 640, 'landscape ' + JSON.stringify(r.land)); assert(r.port.w === 640 && r.port.h === 1280, 'portrait ' + JSON.stringify(r.port)); assert(r.small.w === 640 && r.small.h === 480, 'small unchanged'); return (r.big.inSize / 1048576).toFixed(1) + 'MB PNG → ' + (r.big.outSize / 1024).toFixed(0) + 'KB JPEG 1280×960'; });

  // ============ 共通（後で） ============
  await T(G.common, '英略語（W/MAIN/TOP/BO/DROP/PRE/FINAL）がUIに出ない', async () => { const re = /(^|[^A-Za-z])(WU|W|MAIN|TOP|BO|DROP|PRE|FINAL)([^A-Za-z]|$)/; for (const tab of ['today', 'workout', 'summary']) { await goTab(tab); const txt = await page.$eval('#view', e => e.innerText); const m = re.exec(txt); assert(!m, tab + ': ' + (m && m[0])); } });
  await T(G.common, '数だけの表示（7種、1種）がない', async () => { for (const tab of ['today', 'workout', 'summary']) { await goTab(tab); const txt = await page.$eval('#view', e => e.innerText); const bad = txt.split('\n').filter(l => /サプリ\s*\d+種/.test(l) || /^\s*\d+種(目)?\s*$/.test(l)); assert(!bad.length, tab + ': ' + bad.join(' | ')); } });
  await T(G.common, '同日に2回開いても二重保存されない', async () => { if (mode === 'mock') return 'db のみ'; const before = JSON.stringify(rt.DB); const p2 = await newPage(); await p2.waitForTimeout(800); assert(!(await p2.$('#view .loading')), 'second page rendered'); const after = JSON.stringify(rt.DB); assert(before === after, 'second open changed db'); const counts = Object.fromEntries(Object.entries(rt.DB).map(([k, v]) => [k, Object.keys(v).length])); assert(counts.plan_days === 7 && counts.plan_exercises === 45 && counts.plan_supplements === 8 && counts.plan_warmup === 6, JSON.stringify(counts)); await p2.close(); return 'docs: ' + JSON.stringify(counts); });
  await browser.close();
  return errors;
}
(async () => {
  const errs = {};
  for (const mode of ['mock', 'db']) { errs[mode] = await run(mode); if (errs[mode].length) console.error('[' + mode + '] page errors:\n' + errs[mode].join('\n')); }
  // ---- TEST.md ----
  const groups = [...new Set(results.map(r => r.group))];
  let md = '# テスト結果（自動生成: `npm run e2e:artifact`）\n\n実行日: ' + new Date().toISOString().slice(0, 10) + ' ／ 固定時刻 2026-09-16 06:50 (Asia/Manila) ／ Chromium 390×844\n\n';
  md += '- **mock**: `window.claude` なし → メモリ上のモックモード\n- **db**: `claude.use("db"/"assets"/"sample"/"downloads")` を疑似ランタイムで注入（db は Node 側に永続し、再読み込み・二重オープンを再現。実際の claude.ai ランタイムではなく API 形状を模したもの）\n\n';
  const fails = results.filter(r => r.mock === '✗' || r.db === '✗').length;
  md += '合計 ' + results.length + ' 項目 ／ NG ' + fails + ' 件 ／ ページエラー mock ' + errs.mock.length + ' 件・db ' + errs.db.length + ' 件\n\n';
  groups.forEach(g => { md += '## ' + g + '\n\n| 項目 | mock | db | 備考 |\n|---|:-:|:-:|---|\n'; results.filter(r => r.group === g).forEach(r => { md += '| ' + r.name + ' | ' + r.mock + ' | ' + r.db + ' | ' + r.note.replace(/\|/g, '/') + ' |\n'; }); md += '\n'; });
  md += `## テスト中に見つけて修正した内容

| # | 症状 | 原因 | 修正 |
|---|---|---|---|
| 1 | db モードで読み込み直後に「foods に egg_whole がありません」 | 全コレクションが揃う前の中間スナップショットで描画していた | \`store.ready\` が立つまで描画しない。さらに \`planToItems\` は foods 欠損でも例外を出さず栄養 0 で仮置き、\`render()\` は例外を捕まえて「表示エラー／再読み込み」カードを出す |
| 2 | 食事を「半分」「変更」で記録すると白米の基準（炊飯後/生米）表示が消える | 記録品目の短縮名生成で括弧内を落としていた | \`itemShort\` が rice_cooked / rice_raw に「（炊飯後基準）」「（生米基準）」を付ける |
| 3 | 途中で閉じて再開すると最初の未完了セットに戻る（前の種目へ飛ぶ） | 再開位置を保持していなかった | 日付ごとの現在位置を localStorage（軽い用途）に保持し、同じ種目・セットから再開 |
| 4 | ウォームアップで 6 つ目を ✓ した瞬間に筋トレ画面へ遷移し「始める」を押せない（前版） | 完了判定で即遷移していた | 「始める」を押すまでウォームアップ画面に留まる。セットカウンター方式に変更 |
| 5 | 提案重量 TOP が「TOP の半分」等の英略語を含む | 文言の残り | 「トップの半分」に統一。UI 全体を英略語なしで検証 |
| 6 | 実機で「取り消し」「プランに戻す」「代替種目」「飛ばす」が反応しない | claude.ai のアーティファクトは sandbox iframe で \`confirm()\` / \`prompt()\` が無効（常に false / null）。テスト環境では自動承認されていて気づけなかった | ページ内ダイアログ（askConfirm / askText / askTime）に全面置換。テストもダイアログを実際に操作する方式に変更 |
| 7 | スキップにすると緑✓とスキップ表示が同時に出る | 「記録あり」を一律 done 扱いにしていた | 状態を 未記録○ / プラン通り緑✓ / 変更あり黄✓ / スキップ赤− の 4 種に統一。緑✓はプラン通りのみ |
| 8 | 行の時刻がプランの予定時刻のままで実績が残らない | time(HH:mm) だけ保存し予定と区別していなかった | すべての記録に loggedAt(ISO 8601) を保存。行は実績を太字＋予定を小さく、60 分以上ズレは黄色。タップで時刻修正。タイマー（15 分・休憩）は loggedAt からの時刻差で算出し、再読み込み後も残り時間が続く |
| 9 | 体重を測れない日の扱いが無く、欠測日も直線でつながっていた | 欠測の概念が無かった | log_weight に skipped/reason を保存。行は灰色「−」、「いま」は次へ進む。グラフは隣り合う日だけ線で結び、7 日平均は暦 7 日窓の実測のみ。週まとめ「体重 N/M 日 測定」、レポート「(N/M days measured, skipped: travel×2)」、CSV に skipped/reason 列。食事・サプリ・ルーティン・筋トレ・有酸素にも理由つきの「できなかった」を追加し、週まとめのブロックとレポート Notes に自動集計 |
| 10 | 写真からの推定（新機能） | — | 送信前に長辺 1280px / JPEG 0.8 に縮小、\`sample.limits().images\` が無い環境では写真ボタンを隠す、assets が無ければ写真はメモリ保持で推定・記録のみ、推定 JSON の検証に失敗しても落ちずに「手入力に切替」できることを確認 |
| 11 | コーチ回答の反映で食事シートの補足（「筋トレ後の食事 ・ 必ず摂る」）が状態バッジと同じ見た目になり、テストでも状態バッジと取り違えた | 補足を badge クラスで描画していた | 補足は薄字の注記に変更。種目・セット構成（全セット10〜12回・最終セット −30%）・食事・サプリ・腹筋ルーティン・db スキーマ（log_weight value/unit/skipped、warmup.completed、meals.status、log_daily.skippedItems）を SEED_VERSION 4 で差し替え、休みの日は ウォームアップ→腹筋→有酸素 の順に |
| 12 | Day 1 Push 確定版: ドロップセットの前に休憩タイマーが出て「直後にすぐ」ができない。スーパーセット・プログレッシブの意味が画面に無い | セット種類ごとの休憩・説明が無かった | 次がドロップセットなら休憩なしで即開始（トースト「休まずすぐ開始」）、目安は直前 ×0.7。種目に「スーパーセット ・ 同時に2種目」「プログレッシブ ・ セットごとに回数を増やす」タグ。SEED_VERSION 5 で Day 1 を 8 種目（事前疲労＋7）に差し替え |
| 13 | スーパーセットが 1 種目 1 重量の扱いで、2 動作目を休憩なしで続ける流れが無い。水の記録がルーティン行の中に埋もれる。腹筋・カーフの置き場所が無い | 種目=1 動作の前提だった | pair を持つ種目は各セットを「1-1（A）→ 1-2（B）」に展開し、1-1 の後は休憩なし（トースト）。水タブ（+500/+350/−500、達成で緑、log_daily.waterMl）。トレーニング日はウォームアップ直後に 腹筋・カーフ 画面（コーチ確認待ち、完了チェックのみ）。全 7 日を SEED_VERSION 6 に差し替え、DROP* = 限界まで |
| 14 | 統合版: スーパーセットの表記「セット3-2」が分かりにくい。腹筋・カーフの置き場所と自由入力。完了画面・コーチ報告テキストが無い。未入力が 0kg×0 になり得る。休憩が 150/90 秒 | 仕様の統合前 | 「3セット目 ②プレートフロントレイズ」表記、①→②→休憩の順。腹筋（Day 1・4・6）／カーフ（Day 2・5）を最終種目のあとの枠（accessory、コーチ確認中、自由入力）に移動。「筋トレ完了」→ 完了画面（所要時間・やった内容・有酸素・報告テキスト＋コピー）。未入力は「未記録」「自重×N」。休憩 180/120 秒、トップ +5%、プログレッシブ +5% 提案、ドロップの図。サプリ 8 種（用量タップ入力）、3 食目サーモン 170g 置換。ダイアログを開くと操作トーストを消す（ボタンが押せなくなる不具合） |
| 15 | 朝のサプリとサイリウムが両方 07:15、クレアチンが朝のサプリ行に混在。ウォームアップ所要が 289 分。筋トレ行の「37セット記録済み」に分母が無くスーパーセットを二重カウント。種目一覧が長すぎる。実績時刻と予定が詰まる。完了行の背景が真っ黒。サプリ行の途中切れ | 予定時刻が同じ／startedAt が朝に開いた時刻のまま／セット単位の定義が無かった／CSS | 経口サプリ 07:05 → 15 分 → サイリウム 07:20（loggedAt 基準のタイマー）。クレアチンは「サプリ トレ前（クレアチンはタイミング確認中）」の別行。開いたまま 3 時間超なら startedAt を取り直し、180 分超は「完了」だけ表示。「全22セット中 5セット完了」（①＋② で 1 セット）。種目は最初の 3 つ＋「ほか5種目」。実績時刻は右寄せ縦並び（予定は下に小さく）、完了行は --card に薄字、✓ だけ緑、全行折り返し |
| 16 | プランにない間食・外食をその場で記録する入口が無い。ダイアログのボタンを「元に戻す」トーストが覆う（db モードで再発） | 写真記録が食事シート内だけだった／トーストが画面下に固定 | 今日画面の「いま」カード直下に「📷 食べたものを写真で記録」を常設。撮影 → 縮小 → どの食事か選ぶ（記録済みなら 追加／置き換え）→ 推定 → 記録。間食は log_meals.meals.snack_N（status photo）に保存し合計に加算、タイムラインは実績時刻の位置に挿入、✓ 再タップで取り消し。ダイアログ／シートが開いている間はトーストを画面上部に移動 |
| 17 | 写真ボタンが \`sample.limits().images\` に依存し、この環境（sample は使えるが images 非対応）で完全に隠れて見つからない | 画像非対応を「機能ごと隠す」にしていた | ボタンは \`sample\` があれば常に表示。images 非対応の環境では「AIで推定」だけ出さず「この環境は写真からの自動計算に対応していません」と案内して手入力に切替（写真はメモとして残せる） |
| 18 | 写真ボタンに \`capture=\"environment\"\` が付いていて、カメラに直行しギャラリーから選べない端末がある | capture 属性がカメラ限定になる | 両方の写真入力から \`capture\` を外し、ネイティブの選択肢（撮影 ／ ギャラリーから選ぶ）を両方出す |
| 19 | \`sample.limits().images\` が無いという理由だけで「AIで推定」ボタン自体を隠していたため、実際には画像に対応している環境でも試せず「対応していません」と誤案内していた可能性 | limits() の事前申告だけで判断し、実際に呼んでいなかった | 「AIで推定」は常に表示し、実際に画像付きで呼んで結果で判断する。失敗（images_unavailable 等）した時だけ案内＋手入力に切替を出す |
| 20 | 最終種目（例: Day2 カーフ）に到達した時点で、その種目の 1 セット目でも「筋トレ完了」ボタンになり、未記録のまま完了画面に飛べてしまう。種目が変わっても画面が最上部にスクロールされず、種目名や進捗が見切れる。「初回なので目安なし」のヒントがクイック選択後も残って前回値と誤解されうる | ボタンの判定が「最終種目かどうか」だけで、\`e === ex\`（今の種目を見ているだけ）で最終セットかどうかを見ていなかった。遷移時に scrollTo が無かった | 「筋トレ完了」は全種目・全セットが記録済みの時だけ出すよう判定を単純化。種目・セットが変わる遷移（前後の種目、セット完了、休憩明けの自動進行）すべてで最上部へスクロール。クイック重量を選んだらヒント文を「選んだ重さ」に差し替え |
| 21 | 「落ちた脂肪」の追加で、既存の30日体重グラフと新しい実測/予測グラフの CSS クラスが衝突し点の数が二重にカウントされる。テストが seed した過去の体重/食事/設定（startDate）を後片付けせず、共有 DB を経由して他のテスト（Day 判定・週次レポートなど）まで壊す | 2つの \`.spark\` をページ全体セレクタで区別できていなかった。DB を直接 seed するテストに後片付けが無かった | 30日グラフに \`#weightSpark30\`、脂肪の実測/予測グラフに \`#fatSpark\` の id を付けて区別。DB を直接書き換えるテストはすべて try/finally で seed した日付を削除し settings を元に戻すようにした |
| 22 | 「食事の記録が3日未満なら塊を出さない」設計が、モチベーション維持という目的に反して「待たせる」ことになっていた | 塊を出す条件が mealDayCount>=3 のゲートになっていた | 1日でも記録があれば初日から塊と数字を表示するよう変更。今日画面にも小さい版（高さ約100px）を追加し「今日 −Nkcal → 脂肪 Ng」「これまで合計 Xkg」を食事記録のたびにリアルタイム更新。累積がプラスの日は塊を出さず「今日 +Nkcal」とだけ表示 |
| 23 | 休みの日（Day 3・7）でも、有酸素だけの日にウォームアップ6種の画面が必須表示され、待たされる。今日画面にもウォームアップ行が出る。遵守率のウォームアップ分母が休みの日も含めて7になっていた | ウォームアップ画面の判定が isRest を見ていなかった。今日画面のタイムラインと週まとめの分母が休みの日を筋トレの日と同列に数えていた | 休みの日はウォームアップを出さず、筋トレタブを開いたらいきなり有酸素の記録画面（種類・時間・心拍数・記録する／今日はやらない）にした。記録（または「今日はやらない」）で完了画面に進む。今日画面のタイムラインからウォームアップ行を削除。遵守率のウォームアップ分母は筋トレの日（Day1・2・4・5・6）だけを数え「5回中」になる |
| 24 | 「カロリーを手で入力」テストが mock/db 両方で断続的にタイムアウトし、後片付け前に落ちて次の食事系テストを巻き込んで壊す | (1) 新しい newPage に clock.setFixedTime を使うと、ブラウザコンテキスト全体（共有 page 含む）の時計が変わってしまう。(2) 特定の行のテキスト更新を待つ waitForFunction が、テスト後半（状態が積み上がった時点）でデフォルト8秒に収まらないことがあった。(3) dayCalorieBalance() は r1（小数1桁）、画面表示は Math.round の整数なので、端数のある日は intake と表示値が一致しないことがある | 日付をまたぐ検証はせず、共有 page 上の未記録の食事（5食目）で完結させるよう作り直し。行のテキストではなく合計カードの数値を待つ waitForFunction に変え、タイムアウトを20秒に緩和。dayCalorieBalance との比較は Math.round で揃える |
| 25 | Day 変更のテストで、db モードだけ新規ページ（newPage + reload）後の \`#dayHead\` 待ちが毎回同じ箇所でタイムアウトする。スタンドアロンの再現スクリプトでは発生せず、一度は「深いテストスイート特有の環境要因」と誤診断しかけた。その場しのぎに today タブへ切り替えるだけでは直らず、今度は「今日だけ変更」の直後に想定していない「記録済み警告」ダイアログが出て \`#sheet\` が閉じないタイムアウトに化けた。ほかに \`.sheet-body\` セレクタが非表示の \`#dlg\` にもヒットして strict mode 違反、7日周期のスケジュールでは「前回」が「まだ」にはならない箇所をテストの期待値の方で誤って「まだ」としていた | \`localStorage.tl.tab\`（アクティブタブ）は同一ブラウザコンテキストの全ページで共有される。直前のテストが today タブ以外（例: 筋トレ）で終わっていると、reload した新規ページも最初の描画からそのタブで復元される。today タブにしか無い \`#dayHead\` はそのままでは永遠に現れない上、筋トレタブの最初の描画でウォームアップ画面の「開いたら自動で startedAt を記録する」処理が今日の日付に対して走ってしまい、あとから today タブへ切り替えても「今日の記録が残っています」警告が誤って出るようになる（見かけ上はタイムアウトの再現性が低く見えるが、実際はテスト実行順に依存した決定的なバグだった）。\`.sheet-body\` は \`#sheet\` と \`#dlg\` の両方に常在する。\`dayNoFor\` は開始日から7日周期で巡回するため離れた日付でも「前回」は必ずどこかで一致する | reload する前に \`localStorage.setItem('tl.tab','today')\` を直接呼んでも、reload 時に旧ページの \`window.beforeunload\`（「今のページの \`UI.tab\`」を localStorage に書き戻す処理）に上書きされて効果が無かった。reload 前に実際に \`.tabs [data-tab="today"]\` をクリックして \`UI.tab\` 自体を today にしてから reload することで解決。reload 後も念のため today タブへ切り替えてから \`#dayHead\` を待つ。\`.sheet-body\` は \`#sheet .sheet-body\` に絞った。「前回」の期待値を実際の周期計算に合わせて修正 |
| 26 | 差替えチップの追加テストで、\`#mReset\`（プランの内容に戻す）のあとにもう一度 \`#mChange\` を押すと、逆に「変更・追加」欄が閉じてチップが消え \`[data-q]\` 待ちがタイムアウトする | \`UI.sheetMeal.sub\`（欄の開閉状態）はシートを開いたままの操作では保持されるため、\`#mReset\` 後も欄は開いたまま再描画される。そこへ \`#mChange\` をもう一度押すとトグルが反転して閉じてしまう（アプリの仕様どおりで、テスト側の押しすぎが原因） | \`#mReset\` のあとは \`#mChange\` を押し直さず、そのまま \`[data-q]\` を待つようにテストを修正 |
| 27 | スーパーセット①②の重量・前回値・提案が種目内で共有された rolling state（topKg/prevSetKg/heaviest）を通じて混ざっていた。①で記録した重量が②のプログレッシブ提案の元になってしまう、②の入力欄初期値が①の値を引きずる、など | \`suggestSets()\` が①②を区別せず1つの state で提案を計算していた。セット一覧・いまのセットカード・コーチ報告テキストも①②を1行に結合していて、どちらの実績か読み取りにくかった | \`suggestSets()\` の rolling state を move（①/②、無ければ共通）ごとに分離。いまのセットカードとセット一覧を①②を色分けして入れ子表示するUIに変更（\`setLabel\` に①/②のあとの半角スペースを追加）。完了画面とコーチ報告テキスト（\`pairEnNames()\` で nameEn を \`A + B (superset)\` から分解）も①②を別行に分離。既存テスト（Day1確定版・完了画面レポート・pure function の setLabel）は旧フォーマット（結合1行・スペース無し）を前提にしていたため新フォーマットに合わせて更新 |
| 28 | 「前回の重量」テストを書く過程で3つのテスト側の思い違いに気づいた: (1) \`weeklyReport()\` は行配列ではなく \`.join('\n')\` 済みの1本の文字列を返す（\`repLines.some\`/\`.v.some\` が関数ではないエラー）。(2) mock モードは \`window.claude\` が無くページ内メモリのみで動くため、reload をまたいだ複数日ぶんの記録の永続化を前提にしたテストは mock では原理的に成立しない。(3) バックオフ種目は自分自身の前回記録が無くても、同じ種目のトップセットの重量から目安を出す（\`suggestSets()\` の既存仕様）ため、一度も記録していないバックオフのセットに「初回です」を期待するのは誤り | (1) 関数の戻り値を確認せずに配列だと決め打った。(2) mock/db のデータ永続化の仕組みの違いを見落としていた。(3) バックオフの提案が \`S.topKg\`（同種目のトップの実効重量）を優先し、自分の \`prevWeightKg\` は「前回」表示にしか使われないことを把握していなかった | (1) \`weeklyReport()\` の戻り値をそのまま文字列として \`.includes()\` で検証するよう修正。(2) mock モードでは reload 間の永続化が無い前提の軽い検証（初回表示の確認のみ）に切り替え、複数日の履歴検証は db モードのみで行うようにした。(3) 「初回です」の検証はセット自体に一切の記録・提案根拠が無いトップセットの初回セット（このテストでは日1の記録前）で行い、トップから目安が出るバックオフのセットは「前回は無いが目安は出る」ことを検証するよう修正 |

## 実行方法

\`\`\`
npm run e2e:artifact   # Playwright + Chromium。mock → db の順に実行し、この TEST.md を上書き
\`\`\`

db モードの「疑似ランタイム」は \`claude.use()\` の API 形状（db.collection/doc/get/set/delete/onSnapshot、assets.upload、sample.json、downloads.save）を模したもので、実際の claude.ai ランタイムでの動作確認は公開版を開いて行う。
`;
  fs.writeFileSync(path.join(__dirname, '..', 'artifact', 'TEST.md'), md);
  console.log('\n' + results.length + ' items, ' + fails + ' NG. → artifact/TEST.md');
  if (fails || errs.mock.length || errs.db.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
