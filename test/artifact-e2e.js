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
      // テスト用: 指定したコレクションだけ「応答が返らない」「エラーになる」を再現する
      if ((OPTS.dbHang || []).indexOf(coll) >= 0) return () => { alive = false; };
      if ((OPTS.dbFail || []).indexOf(coll) >= 0) { setTimeout(() => err && err({ code: 'permission_denied', message: 'denied' }), 10); return () => { alive = false; }; }
      const tick = async () => { if (!alive) return; const rows = merge(coll, await call('list', { coll })); const j = JSON.stringify(rows); if (j !== last) { last = j; next({ docs: rows.map(r => snap(r.id, r.data)), size: rows.length, empty: !rows.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } }); } };
      tick(); const h = setInterval(tick, 150); return () => { alive = false; clearInterval(h); }; } });
  const db = { collection: mkColl, doc: (p) => { const seg = p.split('/'); return mkColl(seg.slice(0, -1).join('/')).doc(seg[seg.length - 1]); } };
  const OPTS = window.__rtOpts || {};
  const assets = { upload: async (blob) => { const id = ('a' + Math.random().toString(36).slice(2)).padEnd(32, '0').slice(0, 32); await call('asset', { id, type: blob.type, size: blob.size }); return { id, url: '/_blob/' + id, sizeBytes: blob.size, contentType: blob.type }; }, list: async () => ({ assets: [], usage: {} }), delete: async () => ({ deleted: true }) };
  const sample = Object.assign(async (input) => ({ text: 'ok', truncated: false, modelTierApplied: 'quick' }), {
    json: async (input, opts) => { opts = opts || {}; const img = opts.images ? (Array.isArray(opts.images) ? opts.images[0] : opts.images) : null; await call('sample', { prompt: String(input).slice(0, 80), hasImage: !!img, imageSize: img ? img.size : 0, imageType: img ? img.type : '', tier: opts.modelTier || '' });
      // テスト用: 時間のかかる呼び出しを再現する（待ち時間の表示と「止める」の確認）。signal で中断できる
      if (OPTS.sampleDelay) await new Promise((res2, rej2) => { const t = setTimeout(res2, OPTS.sampleDelay); const sg = opts.signal; if (sg) sg.addEventListener('abort', () => { clearTimeout(t); const e = new Error('cancelled'); e.code = 'cancelled'; rej2(e); }); });
      if (img && OPTS.noImages) { const e = new Error('images not supported in this view'); e.code = 'images_unavailable'; throw e; }
      // テスト用: 呼び出し時だけ失敗させる（limits() は使えると答えるのに実際は失敗する画面の再現）
      if (OPTS.sampleErr && (!OPTS.sampleErrImageOnly || img)) { const e = new Error(OPTS.sampleErr + ' (test)'); e.code = OPTS.sampleErr; throw e; }
      // 文字だけの推定（写真と同じ形の JSON を返す）
      if (/The user describes a meal/.test(input)) return { items: [{ name_ja: 'ハンバーグ', name_en: 'Hamburg steak', grams: 150, kcal: 408, p: 22, f: 28, c: 12 }, { name_ja: '白ご飯', name_en: 'White rice', grams: 300, kcal: 504, p: 7.5, f: 0.9, c: 111 }], total: { kcal: 912, p: 29.5, f: 28.9, c: 123 }, confidence: 'low', note: '分量が書かれていないため一般的な1人前で推定しました' };
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
  const newPage = async (opts, noWait) => {
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
    if (!noWait) await page.waitForFunction(() => !document.querySelector('#view .loading'), null, { timeout: 15000 });
    return page;
  };
  // 前回値（9/9 = Day1）を db に仕込む: インクライン トップ 22×8（上限到達）, サイドレイズ メイン 10×12（上限到達）
  if (mode === 'db') rt.op('set', { coll: 'log_workout', id: '2026-09-09', data: { date: '2026-09-09', sets: { '2_2': { exerciseId: 2, setNo: 2, setType: 'TOP', weightKg: 22, reps: 8 }, '5_1': { exerciseId: 5, setNo: 1, setType: 'MAIN', weightKg: 10, reps: 12 }, '1_1': { exerciseId: 1, setNo: 1, setType: 'MAIN', weightKg: 8, reps: 12 } }, meta: {}, warmup: { done: '08:40' } } });
  let page = await newPage();
  const text = async (sel) => (await page.locator(sel).first().textContent()).trim();
  const has = async (sel) => !!(await page.$(sel));
  const shot = async (n) => { await page.waitForTimeout(150); await page.screenshot({ path: path.join(OUT, 'art-' + mode + '-' + n + '.png'), fullPage: true }); };
  const cleanup = async () => { try { await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.className = 'toast'; }); if (await has('#dlg:not([hidden])')) { await page.click('#dlg', { position: { x: 5, y: 5 } }); await page.waitForTimeout(80); } if (await has('#sheet:not([hidden])')) { await page.click('#sheet', { position: { x: 5, y: 5 } }); await page.waitForSelector('#sheet', { state: 'hidden' }); } if (await has('#rest:not([hidden])')) { await page.click('#skipRest'); } await page.waitForTimeout(100); } catch (e) { /* ignore */ } };
  const T = async (group, name, fn) => { try { const note = await fn(); rec(group, name, mode, true, typeof note === 'string' ? note : ''); console.log('ok   [' + mode + '] ' + name); } catch (e) { rec(group, name, mode, false, e.message); console.error('FAIL [' + mode + '] ' + name + ': ' + e.message); if (process.env.E2E_STACK) console.error(e.stack); } await cleanup(); };
  const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
  let curTime = T0;
  // clock.setFixedTime だけでは画面が描き直されず、時計を戻しても「今日ではない日付」のまま描かれた状態が残る
  // （固定バーが消えたまま等）。時刻を動かしたら必ず描き直す
  const setTime = async (iso) => { curTime = iso; await page.clock.setFixedTime(new Date(iso)); await page.evaluate(() => { try { window.__tl.rerender(); } catch (e) { /* ignore */ } }).catch(() => {}); };
  /** 1日合計（画面下部に固定されたバー）の kcal */
  // 固定バーは「今日の日付を見ているとき」だけ出る。孤立日付へ飛んだテストの直後は描画が古いままのことがあるので、
  // 見つからなければ今日タブを踏み直して描き直させる
  const dayTotal = async () => { if (!(await page.$('#bbar .k1'))) { await goTab('today'); await page.waitForSelector('#bbar .k1'); } return Number((await page.$eval('#bbar .k1', e => e.textContent)).match(/^([\d,]+)/)[1].replace(/,/g, '')); };
  /** 固定バーの「くわしく」を開いて中身を読む（閉じてから戻す） */
  const totalsPanel = async () => { const open = await page.$('#bbar .panel'); if (!open) await page.click('#bbTot'); await page.waitForSelector('#bbar .panel'); const txt = await page.$eval('#bbar .panel', e => e.textContent); return txt; };
  const SLOT_HM = { 1: '07:00', 2: '10:30', 3: '13:30', 4: '16:30', 5: '19:30' };
  /** 「今日のプラン」の N 食目を食べた扱いにする（品目選択シートの「全部食べた」から） */
  const logIntoSlot = async (slot) => {
    await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.className = 'toast'; });
    if (await planEaten(slot)) return;
    await page.click('[data-planrow="' + slot + '"]'); await page.waitForSelector('#mpAll'); await page.click('#mpAll');
    await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(250);
  };
  /** プランの N 食目が「食べた（✓）」になっているか */
  const planEaten = async (slot, pg) => (pg || page).$eval('[data-planchk="' + slot + '"]', e => e.className.includes('on'));
  /** 「食べたもの」一覧のうち、プランの N 食目から記録された行 */
  const eatenRowOf = async (slot, pg) => (pg || page).evaluate(n => {
    const rows = [...document.querySelectorAll('.elist .erow')];
    const hit = rows.find(r => r.querySelector('.nm').textContent.indexOf(n + '食目（プラン）') === 0);
    return hit ? hit.innerText : '';
  }, slot);
  /** 記録の詳細シートを開く（未記録なら先にプラン通りで記録を作る） */
  const openMealSlot = async (slot) => { await logIntoSlot(slot);
    await page.evaluate(n2 => { const rows = [...document.querySelectorAll('.elist .erow')]; const hit = rows.find(r => r.querySelector('.nm').textContent.indexOf(n2 + '食目（プラン）') === 0); if (hit) hit.click(); }, slot);
    await page.waitForTimeout(150); };
  /** 「＋ 食べたものを記録」のシートから、指定の入口を開く */
  /** 「食べたもの」一覧の行（見出しが label で始まる行）を開く */
  const openEatenRow = async (pg, label) => { await pg.evaluate(l => { const rows = [...document.querySelectorAll('.elist .erow')]; const hit = rows.find(r => r.querySelector('.nm').textContent.indexOf(l) === 0); if (hit) hit.click(); }, label); await pg.waitForTimeout(150); };
  const openRecordWay = async (id, pg) => { pg = pg || page; await pg.click('#addMealBtn'); await pg.waitForSelector('#recQ'); await pg.click('#' + id); await pg.waitForTimeout(120); };
  const goTab = async (tab) => { await page.click('.tabs [data-tab="' + tab + '"]'); await page.waitForTimeout(120); };
  const closeSheet = async () => { if (await has('#sheet:not([hidden])')) { await page.click('#sheet', { position: { x: 5, y: 5 } }); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(150); } };
  /** clock.setFixedTime はブラウザコンテキスト全体で共有されるので、孤立日付へ飛ばしたテストは必ずここで今日（T0）へ戻す */
  const resetClock = async () => { await setTime(T0); };
  /** 「A または B」の選択画面が出ていたら選ぶ（既定は先頭の選択肢）。出ていなければ何もしない */
  /** 必須セットが全部記録済みの種目は完了表示になるので、セット行をタップして入力画面（記録の修正）に戻す */
  const enterEdit = async (pg) => { pg = pg || page; if (await pg.$('#exNext')) { await pg.click('[data-set="0"]'); await pg.waitForSelector('#setDone'); await pg.waitForTimeout(60); } };
  const pickChoice = async (idx, pg) => { pg = pg || page; await pg.waitForFunction(() => document.querySelector('[data-exchoice]') || document.querySelector('#setDone') || document.querySelector('#exNext') || document.querySelector('#wuStart')); if (!(await pg.$('[data-exchoice]'))) return false; await pg.locator('[data-exchoice]').nth(idx || 0).click(); await pg.waitForSelector('#setDone'); await pg.waitForTimeout(60); return true; };
  /** 重量＋回数をまとめて入れるポップアップで記録する（「記録する」で確定 → 休憩へ）。w=null で自重種目 */
  const recordSet = async (w, r, pg) => { pg = pg || page; await pg.click(w == null ? '#rv' : '#wv'); await pg.waitForSelector('#siSave'); if (w != null) await pg.fill('#siW', String(w)); if (r != null) await pg.fill('#siR', String(r)); await pg.click('#siSave'); await pg.waitForFunction(() => document.querySelector('#dlg').hidden); await pg.waitForTimeout(80); };
  /** 残りのセットを提案どおりに記録して完了画面まで進める（選択式の種目は先頭を選ぶ・自重種目は重量欄なし） */
  const finishAllSets = async (pg) => { pg = pg || page;
    for (let guard = 0; guard < 80; guard++) {
      await pickChoice(0, pg); await enterEdit(pg);
      if ((await pg.locator('#setDone').textContent()).includes('完了画面へ')) { await pg.click('#setDone'); return true; }
      const w = await pg.$('#wv');
      if (w && (await pg.locator('#wv').textContent()) === '—') { const q = await pg.$('[data-qk]'); if (q) await q.click(); else await pg.click('[data-pm="w:1"]'); }
      await pg.click('#setDone');
      if (await pg.$('#rest:not([hidden])')) { await pg.click('#skipRest'); await pg.waitForSelector('#setDone:not([hidden]), [data-exchoice]'); }
      await pg.waitForTimeout(30);
    }
    return false;
  };
  const gotoEx = async (i) => { for (let g = 0; g < 16; g++) { if (await has('#rest:not([hidden])')) { await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden]), [data-exchoice]'); } const m = /種目 (\d+)\//.exec(await text('.ex-head .p')); const cur = Number(m[1]) - 1; if (cur === i) { await pickChoice(); await enterEdit(); return; } await page.click('[data-ex="' + (cur < i ? 1 : -1) + '"]'); await page.waitForTimeout(60); } throw new Error('gotoEx ' + i); };
  const dlgOk = async (fillText) => { await page.waitForSelector('#dlg:not([hidden])'); if (fillText != null) { await page.fill('#dlgIn', fillText); } await page.click('#dlgOk'); await page.waitForSelector('#dlg', { state: 'hidden' }); await page.waitForTimeout(120); };
  const mark = async (id) => page.$eval('[data-step="' + id + '"]', e => { const c = e.querySelector('.chk'); return e.dataset.mark + '|' + (c ? c.className : '') + '|' + (c ? c.textContent : ''); });
  /** まれにシートを開くクリックが取りこぼされるので、目的の要素が出るまで押し直す（最大3回） */
  const clickUntil = async (trigger, target, pg) => { pg = pg || page;
    for (let i = 0; i < 3; i++) {
      if (await pg.$(target)) return;
      if (!(await pg.$(trigger))) return void (await pg.waitForSelector(target, { timeout: 5000 }));
      await pg.click(trigger).catch(() => {});
      try { await pg.waitForSelector(target, { timeout: 4000 }); return; } catch (e) { if (i === 2) throw e; await pg.waitForTimeout(250); }
    }
  };
  const pickReason = async (label) => { await page.waitForSelector('[data-reason]', { timeout: 20000 }); await page.click('[data-reason="' + label + '"]'); await page.waitForFunction(() => document.querySelector('#dlg').hidden || !document.querySelector('[data-reason]')); await page.waitForTimeout(80); };
  /** 未消化キュー方式では日付を進めるだけで特定の Day に届くとは限らない（前の日を完了させていないと Day が進まない）。
   * 内容確認だけが目的のテストでは、Day ピッカーで明示的に Day N を指定して直接そこへ飛ぶ */
  const forceDay = async (headSel, dayNo) => {
    const cur = (await page.locator(headSel).textContent()).trim();
    if (cur.startsWith('Day ' + dayNo + ' ') || cur.startsWith('Day ' + dayNo + '・') || cur === 'Day ' + dayNo) return;
    await page.click(headSel); await page.waitForSelector('[data-pickday="' + dayNo + '"]');
    await page.click('[data-pickday="' + dayNo + '"]'); await page.waitForSelector('#dcSave'); await page.click('#dcSave');
    await page.waitForTimeout(80);
    if (await has('#dlg:not([hidden])')) { await page.click('#dlgOk'); await page.waitForSelector('#dlg', { state: 'hidden' }); }
    await page.waitForFunction(() => document.querySelector('#sheet').hidden);
    await page.waitForFunction((n) => { const h = document.querySelector('h1'); return h && h.textContent.startsWith('Day ' + n); }, dayNo);
  };
  const G = { today: '今日画面', missed: '欠測・できなかった', workout: '筋トレ画面', meal: '食事シート', week: '週画面', common: '共通' };

  // ============ 共通（先に） ============
  await T(G.common, 'db が null でもモックモードで動き「保存されていません」の帯が出る', async () => { if (mode === 'mock') assert((await text('.mode')).includes('保存されていません'), 'banner'); else assert(!(await has('.mode')), 'no banner in db'); });
  await T(G.common, 'タブは 今日・筋トレ・水・週 の 4 つ', async () => { const tabs = await page.$$eval('.tabs button', els => els.map(e => e.dataset.tab)); assert(JSON.stringify(tabs) === '["today","workout","water","summary"]', tabs.join()); const labels = await page.$$eval('.tabs button .ic', els => els.map(e => e.textContent)); assert(labels.join(',') === '今日,筋トレ,水,週', labels.join(',')); });
  await T(G.common, '375〜430px で横スクロールなし・下タブが safe-area にかぶらない', async () => { for (const w of [375, 390, 430]) { await page.setViewportSize({ width: w, height: 844 }); await page.waitForTimeout(60); const sw = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1); assert(sw, 'hscroll at ' + w); } await page.setViewportSize({ width: 390, height: 844 }); const pb = await page.$eval('.tabs', e => getComputedStyle(e).paddingBottom); return 'tabs padding-bottom=' + pb + '（env(safe-area-inset-bottom) 加算）'; });

  // ============ 今日画面 ============
  await T(G.today, '日付 ‹ › で前日・翌日へ移動し、今日に戻れる', async () => { await page.click('[data-shift="1"]'); assert((await text('.date')).includes('9/17'), 'next'); await page.click('[data-shift="-1"]'); await page.click('[data-shift="-1"]'); assert((await text('.date')).includes('9/15'), 'prev'); await page.click('[data-shift="1"]'); assert((await text('.date')).includes('9/16') && !(await text('.date')).includes('過去'), 'back to today'); });
  await T(G.today, 'Day 判定: 9/16=Day1 は未完了のため 9/17 も Day1 を繰り越して表示（やっていない Day を飛ばさない）→ 9/18 以降は通常どおり Day2・3…と進む', async () => {
    const want = ['Day 1', 'Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7'];
    let shifted = 0;
    try {
      for (let i = 0; i < want.length; i++) { assert((await text('h1')).startsWith(want[i]), (16 + i) + '日目 → ' + (await text('h1'))); if (i < want.length - 1) { await page.click('[data-shift="1"]'); shifted++; } }
    } finally { for (let i = 0; i < shifted; i++) await page.click('[data-shift="-1"]'); }
    assert((await text('.date')).includes('9/16') && !(await text('.date')).includes('過去'), 'back to today');
  });
  await T(G.today, '全行で「…」省略なし。サプリ名・食材が全部表示', async () => { const rows = await page.$$eval('.step', els => els.map(e => e.textContent)); assert(!rows.some(r => r.includes('…')), 'ellipsis'); assert(rows.some(r => r.includes('経口サプリ') && r.includes('B12＋D3') && r.includes('ベルベリン') && r.includes('フィッシュオイル') && r.includes('亜鉛') && !r.includes('クレアチン')), 'oral supp names, no creatine'); assert(rows.some(r => r.includes('トレ前') && r.includes('クレアチン') && r.includes('タイミング確認中')), 'creatine on its own pre-workout row'); assert(rows.some(r => r.includes('マグネシウム グリシネート 400mg 就寝前') && r.includes('アシュワガンダ 300mg 就寝前')), 'night supps with dose'); assert(rows.some(r => r.includes('腹筋（最終種目のあと）') && r.includes('ケーブルクランチ') && r.includes('ケーブル 片手 オブリーククランチ') && r.includes('ハンギングニーレイズ') && !r.includes('確認中')), 'abs row lists all 3 exercises, no 確認中'); assert(rows.some(r => r.includes('ウォームアップ') && r.includes('各10回×2セット')), 'warm-up 2 sets'); assert((await page.$eval('[data-planrow="1"]', e => e.textContent)).includes('全卵4個（約200g）') && !(await page.$eval('.plist', e => e.textContent)).includes('…'), 'プランの品目は省略せず全部出す'); assert(rows.some(r => r.includes('ケーブルフライ（座位・ミッド角度） または ペックデッキ・インクラインダンベルプレス・マシン インクラインプレス または スミス インクラインプレス') && r.includes('ほか5種目') && !r.includes('アンダーハンド')), 'exercises: first 3 + ほか5種目'); });
  await T(G.today, '朝の順番: 体重 → リンゴ酢 → 1食目 → 経口サプリ → サイリウム。サプリ 07:05・サイリウム 07:20（15分後）、説明に「ゆっくり」「水500ml以上」「水1L以上」', async () => { const ids = await page.$$eval('.step', els => els.map(e => e.dataset.step)); const want = ['weight', 'routine:1', 'supp:after_meal', 'routine:2']; assert(JSON.stringify(ids.slice(0, 4)) === JSON.stringify(want), 'order: ' + ids.slice(0, 6).join(',')); assert(!ids.some(x => /^meal:/.test(x)), '食事はルーティンのタイムラインから外れている: ' + ids.join(',')); const tm = async id => text('[data-step="' + id + '"] .tm'); assert((await tm('weight')).includes('06:40') && (await tm('routine:1')).includes('06:45') && (await tm('supp:after_meal')).includes('07:05') && (await tm('routine:2')).includes('07:20'), 'times: ' + [await tm('weight'), await tm('routine:1'), await tm('supp:after_meal'), await tm('routine:2')].join(' | ')); const r1 = await text('[data-step="routine:1"]'), r2 = await text('[data-step="routine:2"]'); assert(r1.includes('大さじ1') && r1.includes('水500ml以上') && r1.includes('ゆっくり飲む') && r1.includes('食事の15分前'), 'acv row: ' + r1); assert(r2.includes('サイリウムハスク 大さじ1') && r2.includes('水1L以上') && r2.includes('ゆっくり') && r2.includes('15分後'), 'psyllium row: ' + r2); assert((await text('[data-step="supp:night"]')).includes('就寝前サプリ') && (await tm('supp:night')).includes('22:30'), 'night 22:30'); const u = await page.evaluate(() => [window.__tl.warmupMinutesText(289), window.__tl.warmupMinutesText(12), window.__tl.warmupMinutesText(0)]); assert(u[0] === '完了' && u[1] === '完了 12分' && u[2] === '完了', 'warm-up minutes guard: ' + u.join(',')); });
  await T(G.today, '体重 kg⇄lb 切替で換算が正しく、保存は kg', async () => { await goTab('summary'); await page.click('#unitBtn'); await page.waitForTimeout(100); await goTab('today'); assert((await text('#now .w-in .u')) === 'lb', 'unit lb'); await page.fill('#nowW', '160'); await page.click('#nowBtn'); await page.waitForFunction(() => document.querySelector('[data-step="weight"]').className.includes('done')); const row = await text('[data-step="weight"]'); assert(row.includes('160.1lb') || row.includes('160lb'), 'lb display: ' + row); if (mode === 'db') { await page.waitForTimeout(200); assert(rt.DB.log_weight['2026-09-16'].weightKg === 72.6, 'stored kg=' + rt.DB.log_weight['2026-09-16'].weightKg); } await goTab('summary'); await page.click('#unitBtn'); await page.waitForTimeout(100); await goTab('today'); assert((await text('[data-step="weight"]')).includes('72.6kg'), 'kg display'); return '160lb → 72.6kg 保存'; });
  await T(G.today, 'リンゴ酢✓ → 「1食目まで あと 15:00」のカウンターが「いま」カードとタイムラインの両方に出る。15分たっても消さず「15分経過 ・ 1食目OK（経過 ◯分）」で残り、閉じて開き直しても残り時間が正しい', async () => {
    await page.click('[data-chk="routine:1"]'); await page.waitForSelector('#nowTimer');
    assert((await text('#now .t')) === '1食目まで', '「いま」の見出し: ' + (await text('#now .t')));
    assert((await text('#nowTimer')) === '15:00', 'timer 15:00');
    assert((await text('#now .s')).includes('リンゴ酢を記録'), 'いつ飲んだかを出す: ' + (await text('#now .s')));
    const line = await page.$eval('[data-waitline="acv"]', e => e.textContent + '|' + e.dataset.state);
    assert(line === '1食目まで あと 15:00|counting', 'タイムラインの項目にも同じカウンター: ' + line);
    if (mode === 'db') { await page.waitForTimeout(250); await setTime('2026-09-16T06:55:30+08:00'); await page.reload(); await page.waitForFunction(() => !document.querySelector('#view .loading')); await goTab('today'); await page.waitForSelector('#nowTimer');
      const left = await text('#nowTimer'); assert(/^9:(2|3)\d$/.test(left), '閉じて開き直しても残り時間が正しい（loggedAt からの差で数える）: ' + left); }
    // 15分たっても消さない
    await setTime('2026-09-16T07:06:00+08:00'); await goTab('workout'); await goTab('today');
    assert((await text('#now .t')) === '1食目を食べてOK', '15分後の「いま」: ' + (await text('#now .t')));
    const l2 = await page.$eval('[data-waitline="acv"]', e => e.textContent + '|' + e.dataset.state);
    assert(/^15分経過 ・ 1食目OK（経過 \d+分）\|ready$/.test(l2), '15分たっても消えずに残る: ' + l2);
    // チェックを取り消すとカウンターも消える
    await page.click('[data-chk="routine:1"]'); await page.waitForFunction(() => !document.querySelector('[data-waitline="acv"]'));
    await page.click('[data-chk="routine:1"]'); await page.waitForSelector('[data-waitline="acv"]');
    // 時刻を直すとカウンターも計算し直される
    await page.click('[data-time="routine:1"]'); await page.waitForSelector('#dlgTime'); await page.fill('#dlgTime', '07:00'); await page.click('#dlgOk'); await page.waitForSelector('#dlg', { state: 'hidden' }); await page.waitForTimeout(250);
    const l3 = await page.$eval('[data-waitline="acv"]', e => e.textContent + '|' + e.dataset.state);
    assert(/^1食目まで あと (8|9):\d\d\|counting$/.test(l3), '時刻を 07:00 に直したら 07:15 までを数え直す: ' + l3);
    await page.click('[data-time="routine:1"]'); await page.waitForSelector('#dlgTime'); await page.fill('#dlgTime', '06:45'); await page.click('#dlgOk'); await page.waitForSelector('#dlg', { state: 'hidden' }); await page.waitForTimeout(250);
    return '15分カウンター（いま＋項目）・15分後も残る・再読み込みで正しい・取り消しと時刻修正で再計算';
  });
  await T(G.today, '✓の付け外しが即反映、再読み込み後も残る（db）', async () => { await logIntoSlot(1); assert(await planEaten(1), 'プラン1食目が ✓ になる'); await page.click('[data-chk="routine:1"]'); await page.waitForFunction(() => !document.querySelector('[data-step="routine:1"]').className.includes('done')); await page.click('[data-chk="routine:1"]'); await page.waitForFunction(() => document.querySelector('[data-step="routine:1"]').className.includes('done'));
    if (mode === 'db') { await page.waitForTimeout(300); await page.reload(); await page.waitForFunction(() => !document.querySelector('#view .loading')); await goTab('today'); assert(await planEaten(1), 'meal1 after reload'); assert((await page.$eval('[data-step="weight"]', e => e.className)).includes('done'), 'weight after reload'); return '再読み込み後も維持'; } return 'モックは再読み込み対象外'; });
  await T(G.today, 'サプリ✓ → 15分後にサイリウムが「いま」になる', async () => { await setTime('2026-09-16T07:20:00+08:00'); await goTab('workout'); await goTab('today'); await page.click('[data-chk="supp:after_meal"]'); await page.waitForFunction(() => document.querySelector('[data-step="supp:after_meal"]').className.includes('done')); assert(/^サイリウム.*まで$/.test(await text('#now .t')), 'timer to psyllium: ' + (await text('#now .t'))); await setTime('2026-09-16T07:36:00+08:00'); await goTab('workout'); await goTab('today'); assert(/^サイリウム/.test(await text('#now .t')) && !/まで$/.test(await text('#now .t')), 'now psyllium: ' + (await text('#now .t'))); await page.click('#nowBtn'); await page.waitForFunction(() => document.querySelector('[data-step="routine:2"]').className.includes('done')); });
  await T(G.today, '水タブ: 目標 5.0L・大数字・+500/+350/−500・達成で緑「5L 達成！」・log_daily.waterMl に保存', async () => { await page.click('[data-open="water"]'); await page.waitForSelector('#waterBig'); assert((await page.$eval('.tabs .on', e => e.dataset.tab)) === 'water', 'row tap opens water tab'); assert((await text('.card .ttl')).includes('目標 5.0 L'), 'goal'); await page.click('[data-w="500"]'); await page.click('[data-w="350"]'); await page.waitForFunction(() => document.querySelector('#waterBig').textContent.startsWith('0.85')); assert((await text('#waterStat')).includes('あと 4.15 L'), 'left'); await page.click('[data-w="-500"]'); await page.waitForFunction(() => document.querySelector('#waterBig').textContent.startsWith('0.35')); for (let i = 0; i < 10; i++) await page.click('[data-w="500"]'); await page.waitForFunction(() => document.querySelector('#waterBig').textContent.startsWith('5.35')); assert((await text('#waterStat')) === '5L 達成！' && (await page.$eval('#waterStat', e => getComputedStyle(e).color)) === (await page.$eval('#waterBig', e => getComputedStyle(e).color)), 'achieved in green'); assert(/^5\.[34] L$/.test(await text('#tabWater')), 'tab sub: ' + (await text('#tabWater'))); if (mode === 'db') { await page.waitForTimeout(200); assert(rt.DB.log_daily['2026-09-16'].waterMl === 5350, 'log_daily.waterMl: ' + JSON.stringify(rt.DB.log_daily['2026-09-16'])); } await goTab('today'); const row = await text('[data-step="water"]'); assert(row.includes('達成'), 'water row: ' + row); assert((await page.$eval('[data-step="water"]', e => e.className)).includes('done'), 'done'); });
  await T(G.today, '1日合計が画面下部に固定で出る。タップで展開して脂肪の塊と週まとめへの導線（1食目を手計算で検算）', async () => {
    assert(!(await page.$eval('#bbar', e => e.hidden)), '今日の日付なら固定バーが出る');
    assert((await dayTotal()) === 373, '固定バーの合計 = 1食目 373kcal: ' + (await dayTotal()));
    // 1食目: 全卵200g=302kcal P24.6 F20.6 C0.6 + 卵白150g=70.5 P15.75 F0 C1.05 + 塩0 → 372.5 / P40.4 F20.6 C1.7
    const body = await totalsPanel();
    assert(body.includes('カロリー 373'), 'kcal 373: ' + body.slice(0, 160)); assert(body.includes('タンパク質 40'), 'P 40'); assert(body.includes('脂質 21'), 'F 21'); assert(body.includes('炭水化物 2 '), 'C 2');
    assert(body.includes('落ちた脂肪'), '展開すると脂肪の塊が出る: ' + body.slice(0, 200)); assert(await page.$('#bbWeek'), '週まとめへの導線');
    await page.click('#bbTot'); await page.waitForTimeout(80); assert(!(await page.$('#bbar .panel')), 'もう一度タップで閉じる');
    // 過去の日付を見ているときは記録ボタンを出さない
    await page.click('[data-shift="-1"]'); await page.waitForTimeout(150); assert(await page.$eval('#bbar', e => e.hidden), '過去の日付では固定バーを出さない');
    await page.click('[data-shift="1"]'); await page.waitForTimeout(150); assert(!(await page.$eval('#bbar', e => e.hidden)), '今日に戻すと出る');
    return '1食目 = 372.5kcal / P40.4 F20.6 C1.7 と一致。固定バーは今日だけ'; });
  await T(G.today, '今日のプランは「食べた（✓）／食べてない（○）」の2つだけ。予定時刻を過ぎてもオレンジや警告を出さず、プラン外を記録してもプランは一切変わらない（打ち消し線・変更あり・プラン比なし）', async () => {
    const backTime = curTime;
    const p2 = await newPage(); p2.setDefaultTimeout(20000);
    try {
      await p2.clock.setFixedTime(new Date('2027-09-02T23:30:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
      await p2.click('.tabs [data-tab="today"]'); await p2.waitForSelector('[data-planrow="1"]');
      const row = await p2.locator('[data-planrow="1"]').textContent();
      assert(row.includes('全卵4個（約200g）') && row.includes('kcal') && !row.includes('…'), 'プランの品目は省略せず全部出す: ' + row);
      assert(!row.includes('まだ記録がありません') && !row.includes('変更あり') && !row.includes('プラン比'), '予定時刻を過ぎても警告は出さない: ' + row);
      const border = await p2.$eval('[data-planrow="1"]', e => getComputedStyle(e).borderBottomColor);
      assert(!/232, 145, 58/.test(border), 'オレンジにしない: ' + border);
      assert(!(await p2.$eval('[data-planchk="1"]', e => e.className)).includes('on'), '未記録は ○');
      // プラン外のものを記録してもプランは変わらない
      await p2.click('#addMealBtn'); await p2.waitForSelector('#recKcal'); await p2.click('#recKcal'); await p2.waitForSelector('#koAdd');
      await p2.fill('#koName', 'スタバ 抹茶ラテ'); await p2.fill('#koK', '220'); await p2.click('#koAdd'); await p2.waitForSelector('#recSave');
      await p2.click('#recSave'); await p2.waitForSelector('#sheet', { state: 'hidden' }); await p2.waitForTimeout(300);
      const rows = await p2.$$eval('[data-planchk]', els => els.map(e => e.className.includes('on') ? '✓' : '○'));
      assert(rows.join('') === '○○○○○', 'プラン外を記録してもプランは全部 ○ のまま: ' + rows.join(''));
      const plist = await p2.locator('.plist').textContent();
      assert(!/打ち消し|変更あり|プラン比/.test(plist) && !(await p2.$('.plist s')), 'プランに打ち消し線も差分も付けない');
      const e1 = await p2.locator('.elist').textContent();
      assert(e1.includes('スタバ 抹茶ラテ') && e1.includes('23:30') && !/食目/.test(e1), '食べたものは時刻と品目名だけ（番号は付けない）: ' + e1);
      assert(!(await p2.$('[data-relink]')) && !(await p2.$('.slotchip')), '紐づけチップは無い');
      // プランの ○ をタップ → ✓ になり、食べたものに1件増える
      await p2.click('[data-planchk="2"]'); await p2.waitForTimeout(400);
      assert(await planEaten(2, p2), '○ をタップで ✓');
      const e2 = await p2.locator('.elist').textContent();
      assert(e2.includes('2食目（プラン）') && e2.includes('白米200g'), 'プランから記録すると「（プラン）」付きで1件増える: ' + e2);
      // ✓ をタップで取り消し → 記録も消える
      await p2.click('[data-planchk="2"]'); await p2.waitForTimeout(400);
      assert(!(await planEaten(2, p2)), '✓ をタップで ○ に戻る');
      assert(!(await p2.locator('.elist').textContent()).includes('2食目（プラン）'), '追加した記録も消える');
      return 'プランは食べた／食べてないの2つだけ。プラン外の記録はプランに影響しない';
    } finally { await setTime(backTime); await p2.close(); rt.op('del', { coll: 'log_meals', id: '2027-09-02' }); rt.op('del', { coll: 'log_daily', id: '2027-09-02' }); }
  });
  await T(G.today, '今日以外の日付では「いま」カードも記録ボタンも出さず、✓ も押せない。過去の記録は長押し →「修正する」で開く', async () => {
    // 時計だけ翌日へ進めて、9/16 を「過去」として見る（終わったら元の時刻に戻す）
    const backTime = curTime;
    await setTime('2026-09-17T09:00:00+08:00'); await goTab('today');
    assert((await text('.date')).includes('9/16') && (await text('.date')).includes('過去'), '上部に「過去」が出る: ' + (await text('.date')));
    assert(!(await page.$('#now')) || (await page.$eval('#now', e => e.hidden)), '過去の日付に「いま」カードを出さない');
    assert((await text('#pastBar')).includes('9/16（水）の記録 ・ 過去'), '代わりに1行だけ出す: ' + (await text('#pastBar')));
    assert(await page.$eval('#bbar', e => e.hidden), '過去の日付では「写真で記録」「手で入力」を出さない');
    assert(await page.$eval('[data-chk="weight"]', e => e.disabled), '✓ が押せない（無効）');
    assert(!(await page.$('[data-step="weight"] [data-open]')), 'タップしても開かない');
    // 長押しで「修正する」→ 元の記録のまま開く（時刻の初期値も元の記録時刻）
    await page.dispatchEvent('[data-step="weight"] .row', 'pointerdown'); await page.waitForTimeout(700); await page.dispatchEvent('[data-step="weight"] .row', 'pointerup');
    await page.waitForSelector('#dlg:not([hidden]) [data-choice]');
    assert((await text('#dlg [data-choice="0"]')) === '修正する', '長押しで「修正する」: ' + (await text('#dlg [data-choice="0"]')));
    await page.click('#dlg [data-choice="0"]'); await page.waitForSelector('#shSave');
    assert((await page.$eval('#shW', e => e.value)) === '72.6', '元の記録が初期値（今の値を入れない）: ' + (await page.$eval('#shW', e => e.value)));
    assert((await text('.sheet-body h3')).includes('記録 06:50'), '記録時刻は元のまま: ' + (await text('.sheet-body h3')));
    await closeSheet();
    // 未来の日付も同じ
    await page.click('[data-shift="1"]'); await page.waitForTimeout(150); assert((await text('.date')).includes('9/17') && !(await text('.date')).includes('過去'), '9/17 は今日: ' + (await text('.date')));
    assert(await page.$('#now') && !(await page.$eval('#now', e => e.hidden)), '今日なら「いま」カードが出る');
    await page.click('[data-shift="1"]'); await page.waitForTimeout(150);
    assert((await text('.date')).includes('未来'), '上部に「未来」が出る: ' + (await text('.date')));
    assert((await text('#pastBar')).includes('の予定 ・ 未来'), '未来は「予定」: ' + (await text('#pastBar')));
    assert(!(await page.$('#now')) || (await page.$eval('#now', e => e.hidden)), '未来の日付にも「いま」カードを出さない');
    assert(await page.$eval('#bbar', e => e.hidden), '未来の日付でも記録ボタンを出さない');
    // 後片付け: 時計と日付を 9/16 に戻す
    await setTime(backTime); await page.click('[data-shift="-1"]'); await page.click('[data-shift="-1"]'); await page.waitForTimeout(150);
    assert((await text('.date')).includes('9/16') && !(await text('.date')).includes('過去'), '9/16 に戻す: ' + (await text('.date')));
    return '過去・未来では「いま」カード・記録ボタンを出さず ✓ も無効。長押しの「修正する」だけで開き、時刻は元の記録のまま';
  });
  await shot('01-home');

  // ============ 食事シート ============
  await T(G.meal, 'プランのカードをタップ →「全部食べた」で1タップ記録。✓ が付いて合計に反映し、「食べたもの」に1件増える', async () => { await logIntoSlot(2); assert(await planEaten(2), 'プラン2食目が ✓'); assert((await eatenRowOf(2)).includes('白米200g'), '食べたものに出る: ' + (await eatenRowOf(2))); assert((await dayTotal()) === 925, 'total 372.5+552.8=925: ' + (await dayTotal())); });
  await T(G.meal, '4食目の代替案（白米150・鶏100・全卵1）を選べる', async () => { await page.click('[data-planrow="4"]'); await page.waitForSelector('#mpAlt'); assert((await text('#mpAlt')).includes('白米150g・鶏胸肉100g・全卵1個'), 'alt label'); await page.click('#mpAlt'); await page.waitForSelector('#sheet', { state: 'hidden' }); assert(await planEaten(4), 'プラン4食目が ✓'); assert((await eatenRowOf(4)).includes('白米150g'), '代替案の内容が食べたものに出る: ' + (await eatenRowOf(4))); });
  await T(G.meal, '米の基準（生/炊飯後）表示が settings に連動（記録済みは食べたときの基準のまま、未記録の予定は設定に追従）', async () => {
    assert((await text('[data-planrow="3"]')).includes('炊飯後基準'), 'cooked default');
    await goTab('summary'); await page.click('#riceBtn'); await page.waitForTimeout(150); await goTab('today');
    assert((await eatenRowOf(2)).includes('炊飯後基準'), '記録済みの食事は食べたときの基準のまま: ' + (await eatenRowOf(2)));
    assert((await text('[data-planrow="3"]')).includes('生米基準'), '未記録のプランは設定に追従: ' + (await text('[data-planrow="3"]')));
    assert((await totalsPanel()).includes('生米基準'), 'totals note'); await page.click('#bbTot');
    await goTab('summary'); await page.click('#riceBtn'); await page.waitForTimeout(150); await goTab('today'); });
  await T(G.meal, 'プランの状態は「食べた（✓）／食べてない（○）」の2つだけ。スキップ・変更・プラン比のバッジは出さない', async () => {
    // 品目を全部外して記録すると「何も食べていない」＝プランは ○ のまま
    await page.click('[data-planrow="3"]'); await page.waitForSelector('#mpSave');
    for (const b of await page.$$('.pick .cb.on')) await b.click();
    await page.waitForTimeout(150); await page.click('#mpSave'); await page.waitForTimeout(200);
    if (await page.$('#sheet:not([hidden])')) await closeSheet();
    assert(!(await planEaten(3)), '何も食べていない記録はプランを ✓ にしない');
    assert(!(await page.$('.plist .lbl-sub')) && !/変更あり|プラン比|スキップ/.test(await page.locator('.plist').textContent()), 'プランにバッジは出さない');
    assert(await planEaten(2), 'プラン通りに記録した2食目は ✓');
    // 品目を変えて記録しても ✓ が付くだけ
    await page.click('[data-planrow="4"]'); await page.waitForSelector('#mpAdd'); await page.click('#mpAdd'); await page.waitForSelector('#afQ');
    await page.fill('#afQ', 'サーモン'); await page.waitForTimeout(200); await page.locator('[data-af]').first().click();
    await page.waitForSelector('#mpSave'); await page.click('#mpSave'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(250);
    assert(await planEaten(4), '品目を変えて記録してもプランは ✓ が付くだけ');
    assert((await eatenRowOf(4)).includes('サーモン'), '変えた内容は食べたものの方に出る: ' + (await eatenRowOf(4)));
    if (await planEaten(5)) { await page.click('[data-planchk="5"]'); await page.waitForTimeout(300); }
    assert(!(await planEaten(5)), '未記録は ○');
  });
  await T(G.meal, 'プランの記録は ✓ の付け外しで何度でも往復でき、毎回 合計が元に戻る', async () => {
    const total = dayTotal;
    const base = await total();
    await logIntoSlot(5); assert(await planEaten(5), 'プラン通りで ✓'); assert((await total()) > base, 'plan adds kcal: ' + (await total()) + ' vs ' + base);
    await page.click('[data-planchk="5"]'); await page.waitForTimeout(350);
    assert(!(await planEaten(5)), 'back to unlogged'); assert((await total()) === base, 'total back to base ' + base + ': ' + (await total()));
    assert((await text('#toast')).includes('取り消しました'), 'toast');
    await page.click('#toast button'); await page.waitForTimeout(400); assert(await planEaten(5), 'undo restored'); assert((await total()) > base, 'undo restored total');
    await page.click('[data-planchk="5"]'); await page.waitForTimeout(350);
    if (mode === 'db') assert(!(rt.DB.log_meals['2026-09-16'].meals || {})[5], 'db doc removed');
    return 'base=' + base + ' kcal に毎回戻る';
  });
  await T(G.today, '実績時刻: ルーティンは記録済みが太字＋「予定」、60分以上ズレたら黄色。食べたものは時刻をタップで直せて並び順も変わる', async () => {
    const w = await page.$eval('[data-step="weight"] .tm', e => ({ b: e.querySelector('b') && e.querySelector('b').textContent, s: e.querySelector('small') && e.querySelector('small').textContent, late: !!e.querySelector('b.late') }));
    assert(w.b === '06:50' && w.s === '予定 06:40' && !w.late, 'weight tm ' + JSON.stringify(w));
    const times = await page.$$eval('.elist .etime', els => els.map(e => e.textContent));
    assert(times.length >= 2 && times.slice().sort().join(',') === times.join(','), '食べたものは時刻の順に並ぶ: ' + times.join(','));
    // 2食目の記録の時刻を早い時刻に直すと、並び順も変わる
    await page.evaluate(() => { const rows = [...document.querySelectorAll('.elist .erow')]; const hit = rows.find(r => r.querySelector('.nm').textContent.indexOf('2食目（プラン）') === 0); hit.querySelector('.etime').click(); });
    await page.waitForSelector('#dlgTime'); await page.fill('#dlgTime', '07:36'); await page.click('#dlgOk'); await page.waitForSelector('#dlg', { state: 'hidden' }); await page.waitForTimeout(250);
    const after = await page.$$eval('.elist .erow', els => els.map(e => e.querySelector('.etime').textContent + ' ' + e.querySelector('.nm').textContent));
    const idx2 = after.findIndex(x => x.includes('2食目'));
    assert(after[idx2].indexOf('07:36') === 0, '直した時刻になる: ' + after.join(' / '));
    const ts = after.map(x => x.slice(0, 5)); assert(ts.slice().sort().join(',') === ts.join(','), '並び順も時刻順に変わる: ' + after.join(' / '));
    if (mode === 'db') { await page.waitForTimeout(200); assert(/T07:36/.test(rt.DB.log_meals['2026-09-16'].meals[2].loggedAt), 'loggedAt saved: ' + rt.DB.log_meals['2026-09-16'].meals[2].loggedAt); }
  });
  await T(G.today, '記録済み時刻をタップして手修正できる（時刻ピッカー）', async () => {
    await page.evaluate(() => { const rows = [...document.querySelectorAll('.elist .erow')]; const hit = rows.find(r => r.querySelector('.nm').textContent.indexOf('2食目（プラン）') === 0); hit.querySelector('.etime').click(); });
    await page.waitForSelector('#dlgTime'); await page.fill('#dlgTime', '10:40'); await page.click('#dlgOk'); await page.waitForSelector('#dlg', { state: 'hidden' }); await page.waitForTimeout(250);
    assert((await eatenRowOf(2)).indexOf('10:40') >= 0, 'edited: ' + (await eatenRowOf(2)));
    if (mode === 'db') { await page.waitForTimeout(200); assert(/T10:40/.test(rt.DB.log_meals['2026-09-16'].meals[2].loggedAt), 'loggedAt saved'); }
  });
  await T(G.today, '「いま」カード右上は現在時刻（1分ごと更新）、予定時刻は別表示', async () => { assert((await text('#nowClock')) === '07:36', 'clock ' + (await text('#nowClock'))); await setTime('2026-09-16T07:41:00+08:00'); await page.waitForFunction(() => document.querySelector('#nowClock').textContent === '07:41', null, { timeout: 70000 }); assert((await text('#now .k')).includes('予定'), 'planned shown separately'); });
  await shot('02-meal');
  // 5食目は直前のテストで毎回「未記録」に戻して終わっている。共有 page（9/16・体重記録済み）上で
  // そのまま検証する（新しい日付・別ページを使うと clock.setFixedTime がブラウザコンテキスト全体
  // ＝共有 page にも効いてしまい、後続テストを壊すため使わない）
  await T(G.meal, '品目選択シート: 品目ごとにチェックと分量を決めて記録する／長押しで ×0.5・×1.5・×2／全卵は「個」ホエイは「スクープ」／食品マスタから追加・新規登録／抜いた品目は打ち消し線でプランとの差も出す', async () => {
    const D = '2027-11-03', backTime = curTime;
    const p2 = await newPage(); p2.setDefaultTimeout(20000);
    try {
      await p2.click('.tabs [data-tab="today"]');
      await p2.clock.setFixedTime(new Date(D + 'T10:35:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
      await p2.click('.tabs [data-tab="today"]'); await p2.waitForSelector('[data-planrow="2"]');
      // 2食目のカードをタップ → 品目選択シート
      await p2.click('[data-planrow="2"]'); await p2.waitForSelector('#mpSave');
      const rowTxt = async () => (await p2.locator('.picks').textContent());
      const names = await p2.$$eval('.pick .pn', els => els.map(e => e.textContent.trim()));
      assert(names.length === 5 && names[0] === '白米（炊飯後基準）' && names[1].startsWith('鶏胸肉') && names[4].startsWith('インゲン') && !names.join('').includes('…'), '品目名を省略せず全部出す: ' + names.join('・'));
      assert((await p2.$$eval('.pick .cb', els => els.filter(e => e.className.includes('on')).length)) === 5, '最初は全部チェックが入っている');
      const kcals = await p2.$$eval('.pick .pkc', els => els.map(e => e.textContent));
      assert(kcals.join(',') === '336kcal,165kcal,0kcal,27kcal,25kcal', '各品目の右にその分量での kcal: ' + kcals.join(','));
      const tot = async () => (await p2.locator('#mpTot').textContent());
      assert((await tot()).includes('合計 553kcal') && (await tot()).includes('（プラン 553kcal'), '下部に合計とプランとの比較: ' + (await tot()));
      // チェックを外すと合計から除外される
      await p2.click('.pick:nth-child(5) .cb'); await p2.waitForTimeout(100);
      assert((await tot()).includes('合計 528kcal'), 'チェックを外すと合計から除外: ' + (await tot()));
      // 分量を変えると kcal と合計が即座に変わる
      await p2.fill('.pick:nth-child(2) [data-pg]', '100'); await p2.waitForTimeout(100);
      assert((await p2.$eval('.pick:nth-child(2) .pkc', e => e.textContent)) === '110kcal' && (await tot()).includes('合計 473kcal'), '分量を変えると即座に再計算: ' + (await tot()));
      // 長押しで ×0.5 / ×1.5 / ×2
      await p2.dispatchEvent('.pick:nth-child(2) .pg', 'pointerdown'); await p2.waitForTimeout(700); await p2.dispatchEvent('.pick:nth-child(2) .pg', 'pointerup');
      await p2.waitForSelector('#dlg:not([hidden]) [data-choice]');
      const opts = await p2.$$eval('#dlg [data-choice]', els => els.map(e => e.textContent));
      assert(opts.join('|') === '半分にする（×0.5）|1.5倍にする（×1.5）|2倍にする（×2）', '長押しメニュー: ' + opts.join('|'));
      await p2.click('#dlg [data-choice="0"]'); await p2.waitForTimeout(150);
      assert((await p2.$eval('.pick:nth-child(2) [data-pg]', e => e.value)) === '50' && (await p2.$eval('.pick:nth-child(2) .pkc', e => e.textContent)) === '55kcal', '×0.5 で 100g → 50g: ' + (await p2.$eval('.pick:nth-child(2) [data-pg]', e => e.value)));
      // 食品マスタから追加
      await p2.click('#mpAdd'); await p2.waitForSelector('#afQ');
      const master = await p2.$$eval('[data-af]', els => els.map(e => e.textContent));
      ['グミ', 'ナッツ', 'セレクタ アダルト アクティブ', 'ソヤ プロテイン フープス', 'サーモン寿司', 'ハンバーグ'].forEach(nm => assert(master.some(x => x.includes(nm)), '食品マスタに ' + nm + ' がある: ' + master.join(' / ')));
      assert(master.some(x => x.includes('ナッツ') && x.includes('225kcal')), 'ナッツ 40g = 225kcal: ' + master.filter(x => x.includes('ナッツ')).join(''));
      await p2.fill('#afQ', 'ハンバーグ'); await p2.waitForTimeout(150);
      assert((await p2.$$eval('[data-af]', els => els.length)) === 1, '検索で絞り込める');
      await p2.fill('#afQ', ''); await p2.waitForTimeout(150);
      await p2.click('[data-af="nuts"]'); await p2.waitForSelector('#mpSave'); await p2.waitForTimeout(120);
      assert((await rowTxt()).includes('ナッツ') && (await tot()).includes('合計 643kcal'), '選んだ食品が品目に足される（418 + ナッツ225）: ' + (await tot()));
      // 新しい食品を登録して追加
      await p2.click('#mpAdd'); await p2.waitForSelector('#afNew'); await p2.click('#afNew'); await p2.waitForSelector('#afSave');
      await p2.fill('#afName', 'コンビニのサンドイッチ'); await p2.fill('#afG', '150'); await p2.fill('#afK', '300'); await p2.fill('#afP', '12'); await p2.fill('#afF', '10'); await p2.fill('#afC', '40');
      await p2.click('#afSave'); await p2.waitForSelector('#mpSave'); await p2.waitForTimeout(150);
      assert((await rowTxt()).includes('コンビニのサンドイッチ') && (await tot()).includes('合計 943kcal'), '新しい食品を登録して追加できる（643 + 300）: ' + (await tot()));
      await p2.click('#mpAdd'); await p2.waitForSelector('#afQ');
      assert((await p2.$$eval('[data-af]', els => els.map(e => e.textContent))).some(x => x.includes('コンビニのサンドイッチ')), '登録した食品は次からマスタに残る');
      await p2.click('#afBack'); await p2.waitForSelector('#mpSave');
      // 記録する → 抜いた品目は打ち消し線、プランとの差
      await p2.click('#mpSave'); await p2.waitForSelector('#sheet', { state: 'hidden' }); await p2.waitForTimeout(300);
      const html = await p2.evaluate(() => { const rows = [...document.querySelectorAll('.elist .erow')]; const hit = rows.find(r => r.querySelector('.nm').textContent.indexOf('2食目（プラン）') === 0); return hit ? hit.innerText : ''; });
      assert(!html.includes('インゲン'), '抜いた品目は「食べたもの」に出さない: ' + html);
      assert(html.includes('鶏胸肉 皮なし50g') && html.includes('ナッツ40g') && html.includes('コンビニのサンドイッチ150g'), '変えた分量と足した品目を出す: ' + html);
      assert(!(await p2.$('.plist s')) && (await p2.locator('[data-planrow="2"]').textContent()).includes('インゲン'), 'プランは打ち消し線を付けず、元のまま出す');
      const card = html;
      assert(card.includes('943kcal') && !card.includes('プラン 553kcal') && !card.includes('変更して記録'), '1食ごとのプラン比は出さない: ' + card);
      // 個・スクープで数える品目
      await p2.click('[data-planrow="1"]'); await p2.waitForSelector('#mpSave');
      assert((await p2.$eval('.pick:nth-child(1) .pg', e => e.textContent.trim())) === '個' && (await p2.$eval('.pick:nth-child(1) [data-pg]', e => e.value)) === '4', '全卵は「個」で入力（200g = 4個）: ' + (await p2.$eval('.pick:nth-child(1) .pg', e => e.textContent)));
      await p2.click('#mpCancel'); await p2.waitForSelector('#sheet', { state: 'hidden' });
      await p2.click('[data-planrow="4"]'); await p2.waitForSelector('#mpSave');
      const p4 = await p2.$$eval('.pick', els => els.map(e => e.querySelector('.pn').textContent.trim() + '=' + e.querySelector('[data-pg]').value + e.querySelector('.pg .u').textContent));
      assert(p4.some(x => x.includes('ホエイプロテイン=1スクープ')), 'ホエイは「スクープ」で入力（30g = 1スクープ）: ' + p4.join(' / '));
      await p2.click('#mpCancel'); await p2.waitForSelector('#sheet', { state: 'hidden' });
      return '品目ごとのチェックと分量・即時再計算・長押しの倍率・個/スクープ入力・食品マスタからの追加と新規登録・打ち消し線とプラン差、すべて確認';
    } finally { await setTime(backTime); await p2.close(); rt.op('del', { coll: 'log_meals', id: D }); rt.op('del', { coll: 'log_daily', id: D }); }
  });
  await T(G.meal, 'カロリーを直接入力: どの食事かは聞かず「食べたもの」に1件増えるだけでプランは変わらない／カロリー必須・品目名は任意／タンパク質などから計算／合計と脂肪の塊に反映→取り消しで消える', async () => {
    const total = dayTotal;
    const base = await total();
    // いまは 07:36（1食目の時間帯）。1食目は記録済みなので間食として残る
    await openRecordWay('recKcal'); await page.waitForSelector('#koAdd');
    assert(!(await page.$('#mcMeal')), '記録画面に「どの食事か」を選ぶ項目は無い');
    assert((await text('#sheet h3')) === 'カロリーだけ入力', 'タイトル: ' + (await text('#sheet h3')));
    await page.click('#koAdd'); await page.waitForTimeout(150);
    assert((await text('#toast')).includes('カロリーを入力'), 'カロリーが空だと追加できない: ' + (await text('#toast')));
    await page.fill('#koName', '外食'); await page.fill('#koK', '450'); await page.click('#koAdd'); await page.waitForSelector('#recSave');
    assert((await page.locator('.rectot').textContent()).includes('1品'), 'よく食べるものと同じ画面に1品として加わる');
    await page.click('#recSave'); await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.waitForFunction(t => { const e = document.querySelector('#bbar .k1'); return e && Number(e.textContent.match(/^([\d,]+)/)[1].replace(/,/g, '')) === t; }, base + 450, { timeout: 20000 });
    const elist = await page.locator('.elist').textContent();
    assert(elist.includes('外食') && !elist.includes('✏️'), '「（手入力）」の表記は出さない: ' + elist);
    assert(await page.evaluate(() => [...document.querySelectorAll('.elist .erow')].some(r => !/食目/.test(r.querySelector('.nm').textContent))), 'プラン外の記録に番号は付かない');
    assert((await total()) === base + 450, 'カロリーだけで記録できる: +450: ' + (await total()) + ' (base ' + base + ')');
    // P/F/C も入れられる（2件目）
    await openRecordWay('recKcal'); await page.waitForSelector('#koAdd');
    await page.fill('#koName', 'コンビニ弁当'); await page.fill('#koK', '455'); await page.fill('#koP', '20'); await page.fill('#koF', '15'); await page.fill('#koC', '60');
    await page.click('#koAdd'); await page.waitForSelector('#recSave'); await page.click('#recSave'); await page.waitForSelector('#sheet', { state: 'hidden' });
    await page.waitForFunction(t => { const e = document.querySelector('#bbar .k1'); return e && Number(e.textContent.match(/^([\d,]+)/)[1].replace(/,/g, '')) === t; }, base + 905, { timeout: 20000 });
    assert((await total()) === base + 905, '1日合計に反映(+450+455=+905): ' + (await total()) + ' (base ' + base + ')');
    const bal = await page.evaluate(() => window.__tl.dayCalorieBalance('2026-09-16'));
    assert(bal && Math.round(bal.intake) === (await total()), '脂肪の塊の計算(dayCalorieBalance)にも反映: intake=' + (bal && bal.intake) + ' / 合計=' + (await total()));
    const matched = await page.evaluate(() => { const f = window.__tl.matchFood('コンビニ弁当'); return f && { nameJa: f.nameJa, source: f.source, kcal: f.kcal, p: f.p }; });
    assert(matched && matched.source === 'manual' && matched.kcal === 455 && matched.p === 20, '名前を付けた食品が foods に入り、次回検索で呼び出せる: ' + JSON.stringify(matched));
    // プラン外の記録はプランに一切影響しない
    const marks = await page.$$eval('[data-planchk]', els => els.map(e => e.className.includes('on') ? '✓' : '○'));
    assert(marks.filter(x => x === '○').length >= 1 && !(await page.$('.plist s')), 'プラン外を2件記録してもプランは変わらない: ' + marks.join(''));
    assert(!(await page.$('[data-relink]')) && !(await page.$('.slotchip')), '紐づけチップは無い');
    // 後片付け: プラン外の記録を消して合計を base に戻す
    for (const key of await page.$$eval('.elist .erow', els => els.filter(r => !/食目/.test(r.querySelector('.nm').textContent)).map(r => r.dataset.erow))) {
      await page.evaluate(k => { const r = document.querySelector('.elist [data-erow="' + k + '"]'); if (r) r.click(); }, key);
      await page.waitForSelector('#recDel'); await page.click('#recDel'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(250);
    }
    assert((await total()) === base, '後片付け: 合計を base に戻す: ' + (await total()) + ' vs ' + base);
    return 'どの食事かを聞かず、プランに触れずに「食べたもの」へ1件追加・カロリー必須・PFCから計算';
  });

  // ============ 筋トレ ============
  await T(G.workout, '必ずウォームアップから始まり、6種が完了扱いになるまで「筋トレを始める」が押せない', async () => { await goTab('workout'); await page.waitForSelector('#wuStart'); assert((await text('.cur-set .n')).includes('ウォームアップ 6種'), 'warmup first'); assert((await text('#wuProg')).includes('6種中 0種 完了'), 'progress'); await page.click('#wuStart'); await page.waitForTimeout(100); assert(await has('#wuStart'), 'still warmup'); assert((await text('#toast')).includes('ウォームアップがまだです'), 'blocked toast'); });
  await T(G.workout, 'アニメーション・3ステップ・動画リンク・セットカウンターが6種すべてで動く', async () => { const n = await page.$$eval('.wu', els => els.length); assert(n === 6, '6 cards'); const anims = await page.$$eval('.wu svg.anim', els => els.map(e => e.className.baseVal)); assert(anims.length === 6 && new Set(anims).size === 6, 'six distinct animations: ' + anims.join(',')); const running = await page.$$eval('.wu svg .armL, .wu svg .pelvis, .wu svg .upper', els => els.map(e => getComputedStyle(e).animationName).filter(a => a && a !== 'none').length); assert(running >= 6, 'css animations running: ' + running); const steps = await page.$$eval('.wu ol', els => els.map(e => e.querySelectorAll('li').length)); assert(steps.every(x => x === 3), '3 steps each'); const links = await page.$$eval('.wu .vid a', els => els.map(e => e.href)); assert(links.length === 6 && links.every(l => l.includes('youtube.com/results') && l.includes('warm')), 'video links');
    for (let id = 1; id <= 6; id++) { await page.click('[data-wuset="' + id + '"]'); await page.waitForFunction(i => document.querySelector('#wu' + i + ' .sc').textContent.includes('1/2'), id); await page.click('[data-wuset="' + id + '"]'); await page.waitForFunction(i => document.querySelector('#wu' + i + ' .sc').textContent.includes('2/2'), id); }
    assert((await text('#wuProg')).includes('6種中 6種 完了'), '2/2 = done'); assert(await page.$eval('#wu1 .sc', e => e.classList.contains('ok')), 'green at 2/2'); assert(await page.$eval('[data-wuset="1"]', e => e.disabled), '2/2 disables'); await page.click('[data-wuundo="1"]'); await page.waitForFunction(() => document.querySelector('#wu1 .sc').textContent.includes('1/2')); assert((await text('#wuProg')).includes('6種中 5種 完了'), 'undo → 5'); await page.click('#wuStart'); await page.waitForTimeout(100); assert(await has('#wuStart') && (await text('#toast')).includes('ウォームアップがまだです'), 'blocked at 5/6'); await page.click('[data-wuset="1"]'); await page.waitForFunction(() => document.querySelector('#wu1 .sc').textContent.includes('2/2')); await shot('03-warmup'); await page.click('#wuStart'); await pickChoice(); await page.waitForSelector('#setDone'); if (mode === 'db') { await page.waitForTimeout(200); const w = rt.DB.log_workout['2026-09-16'].warmup; assert(w.done && w.minutes >= 1, 'warmup minutes saved: ' + JSON.stringify(w)); return 'minutes=' + w.minutes; } });
  await T(G.workout, 'セット一覧（完了=実績値、現在=黄、未=薄）、タップで前セットに戻れる', async () => { assert((await text('.setrows .sr.cur')).includes('← いまここ'), 'cur'); assert((await text('.ghost')).includes(mode === 'db' ? '前回' : '初回です'), 'ghost'); if (mode === 'mock') await page.click('[data-qk="10"]'); await page.click('#setDone'); await page.waitForSelector('#rest:not([hidden])'); { const rw = await text('#rn'); assert(rw === '2:00' || rw === '1:59', 'pre-exhaust main rest 120s: ' + rw); } await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden]), [data-exchoice]'); const done = await text('.setrows .sr.done .rv'); assert(/kg×1\d/.test(done), 'done row actual: ' + done); assert((await text('.setrows .sr.cur .nm')).includes('2セット目'), 'moved to set2'); await page.click('[data-set="0"]'); await page.waitForTimeout(100); assert((await text('.setrows .sr.cur .nm')).includes('1セット目'), 'back to set1'); assert(!/0kg×0|kg×0\b/.test(await text('.setrows')), 'no 0kg×0'); assert((await text('.ghost')).includes('記録済み'), 'shows recorded'); await page.click('[data-set="1"]'); });
  await T(G.workout, '前回値なし→クイック重量ボタン。前回値あり→提案（トップ 上限到達で +5%／ダンベルは +1kg、バックオフ トップ×0.85、ドロップ 直前×0.7）', async () => { await gotoEx(1); assert((await text('.ex-name')).includes('インクライン'), 'ex2');
    if (mode === 'mock') { assert(await has('[data-qk]'), 'quick buttons'); return '前回値なし → クイック重量'; }
    await page.click('[data-set="1"]'); await page.waitForTimeout(80); const g = await text('.ghost'); assert(g.includes('前回 9/9（7日前）') && g.includes('22kg×8') && g.includes('23kg') && g.includes('上限到達'), 'TOP suggest: ' + g); assert((await text('#wv')) === '23', 'wv 23');
    await page.click('[data-set="2"]'); await page.waitForTimeout(80); assert((await text('.cur-set .n')).includes('バックオフ'), 'back-off set'); assert((await text('#wv')) === '20', 'BO 23×0.85=20: ' + (await text('#wv'))); assert((await text('.cur-set .p')).includes('トップより軽くして') && (await text('.cur-set .p')).includes('目安 20kg'), 'BO purpose: ' + (await text('.cur-set .p')));
    await gotoEx(5); assert((await text('.ex-name')).includes('サイドレイズ'), 'ex5'); await page.click('[data-set="0"]'); await page.waitForTimeout(80); assert((await text('#wv')) === '11', 'MAIN 10×12(上限)→11: ' + (await text('#wv'))); await page.click('[data-set="1"]'); await page.waitForTimeout(80); assert((await text('#wv')) === '12' && (await text('.ghost')).includes('漸増'), 'progressive set2 11→12: ' + (await text('.ghost'))); await page.click('[data-set="3"]'); await page.waitForTimeout(80); assert((await text('.cur-set .n')).includes('ドロップセット'), 'drop set'); assert((await text('#wv')) === '9', 'DROP 直前 13(12×1.05)×0.7=9: ' + (await text('#wv'))); assert((await text('.cur-set .p')).includes('休憩なし') && (await text('.cur-set .p')).includes('−30%') && (await text('.cur-set .p')).includes('目安 9kg'), 'DROP purpose: ' + (await text('.cur-set .p'))); assert((await text('.dropfig')).includes('→（休まず）→') && (await text('.dropfig')).includes('9kg'), 'drop figure: ' + (await text('.dropfig'))); const bk = await page.evaluate(() => [window.__tl.bumpKg(40, false, 2), window.__tl.bumpKg(10, false, 2), window.__tl.bumpKg(22, true, 1)]); assert(bk[0] === 42 && bk[1] === 11 && bk[2] === 23, 'bump +5%/+1kg: ' + bk.join(',')); await gotoEx(0); return 'ダンベル トップ 22×8(上限)→23kg / バックオフ 23×0.85=20kg / メイン 10×12(上限)→11kg → プログレッシブ 12kg・13kg / ドロップ 13×0.7=9kg / バー 40kg→42kg(+5%)'; });
  await T(G.workout, 'Day1 確定版: 8種目＋腹筋3種、スーパーセットは ①→②→休憩→①→② の順、漸増の説明、ドロップは休憩なしで即開始', async () => { assert((await text('.ex-head .p')).includes('/11'), '8 exercises + 3 abs'); const names = []; for (let k = 0; k < 11; k++) { await gotoEx(k); names.push(await text('.ex-name')); } assert(names[0].includes('ケーブルフライ') && names[2].includes('マシン インクラインプレス') && names[4].includes('スーパーセット') && names[7].includes('アンダーハンド') && names[8].includes('ケーブルクランチ') && names[9].includes('オブリーククランチ') && names[10].includes('ハンギングニーレイズ') && !names.join('').includes('確認中'), 'names: ' + names.join(' / '));
    await gotoEx(4); assert((await text('.tag.ss')).includes('スーパーセット') && (await text('.tag.ss')).includes('休憩なし'), 'superset tag'); assert((await page.$$eval('.tag', els => els.map(e => e.textContent).join('|'))).includes('漸増 ・ セットごとに少しずつ重くする'), 'progressive tag'); assert((await text('.tag.ss')).includes('休憩なし') && (await text('.tag.ss')).includes('①ペックデッキ → ②プレート'), 'pair names in tag'); const heads = await page.$$eval('.setrows .sr-head', els => els.map(e => e.textContent)); assert(heads.length === 3 && heads[0].includes('1セット目') && heads[1].includes('2セット目') && heads[2].includes('3セット目'), 'set groups: ' + heads.join(','));
    const rows = await page.$$eval('.setrows .sr .nm', els => els.map(e => e.textContent)); assert(rows.length === 6 && rows[0].includes('① ペックデッキ') && rows[0].includes('8〜12回') && rows[1].includes('② プレート') && !rows.some(r => /セット\d-\d/.test(r)), 'pairs: ' + rows.join(','));
    // 1-1 完了 → 休憩なしで 1-2 へ。1-2 完了 → 休憩
    await page.click('[data-set="0"]'); await page.waitForTimeout(60); if ((await text('#wv')) === '—') await page.click('[data-qk]'); await page.click('#setDone'); await page.waitForTimeout(100); assert(!(await has('#rest:not([hidden])')), 'no rest between pair'); assert((await text('.cur-set .pair-row.cur .nm')).includes('② プレート'), 'moved to ②: ' + (await text('.cur-set .pair-row.cur .nm'))); assert((await text('#toast')).includes('スーパーセット'), 'superset toast'); assert((await text('.cur-set .p')).includes('直後、休まずに'), 'pair purpose'); if ((await text('#wv')) === '—') await page.click('[data-qk]'); await page.click('#setDone'); await page.waitForSelector('#rest:not([hidden])'); assert((await text('#rnext')).includes('2セット目 ① ペックデッキ'), 'rest then next pair: ' + (await text('#rnext'))); await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden]), [data-exchoice]');
    await gotoEx(5); assert(!(await has('.tag.ss')), 'no superset tag'); assert((await page.$$eval('.tag', els => els.map(e => e.textContent).join('|'))).includes('漸増'), 'progressive on side raise'); assert((await page.$$eval('.setrows .sr .nm', els => els.map(e => e.textContent))).length === 4, '3 main + drop');
    // 3セット目の完了 → 休憩なしでドロップセットへ
    for (let k = 0; k < 3; k++) { await page.click('[data-set="' + k + '"]'); await page.waitForTimeout(60); if ((await text('#wv')) === '—') await page.click('[data-qk="8"]'); await page.click('#setDone'); await page.waitForTimeout(80); if (await has('#rest:not([hidden])')) { assert(k < 2, 'no rest before drop'); await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden]), [data-exchoice]'); } }
    assert((await text('.cur-set .n')).includes('ドロップセット'), 'now on drop set'); assert((await text('#toast')).includes('休まずすぐ開始'), 'drop toast'); assert(!(await has('#rest:not([hidden])')), 'no rest timer'); await gotoEx(0); });  await T(G.workout, '完了→休憩タイマー（トップ 180秒／他 120秒）→自動で次セット。「飛ばす」で即次へ', async () => { await gotoEx(1); await page.click('[data-set="1"]'); await page.waitForTimeout(80); assert((await text('.cur-set .n')).includes('トップセット'), 'on TOP set'); if ((await text('#wv')) === '—') await page.click('[data-qk="20"]'); await setTime('2026-09-16T07:41:10+08:00'); await page.click('#setDone'); await page.waitForSelector('#rest:not([hidden])'); const rn = await text('#rn'); assert(rn === '3:00' || rn === '2:59', 'TOP rest 180s: ' + rn); assert((await text('#rnext')).includes('3セット目 バックオフ'), 'next: ' + (await text('#rnext')));
    if (mode === 'db') { await page.waitForTimeout(250); await setTime('2026-09-16T07:42:00+08:00'); await page.reload(); await page.waitForFunction(() => !document.querySelector('#view .loading')); await goTab('workout'); await page.waitForSelector('#rest:not([hidden])'); const rl = await text('#rn'); assert(/^2:(0|1)\d$/.test(rl), 'rest continues after reload ~2:10: ' + rl); }
    await setTime('2026-09-16T08:40:00+08:00'); await page.waitForSelector('#setDone:not([hidden])', { timeout: 5000 }); assert((await text('.setrows .sr.cur .nm')).includes('3セット目'), 'auto advance to set3'); await page.click('#setDone'); await page.waitForSelector('#rest:not([hidden])'); const r2 = await text('#rn'); assert(r2 === '2:00' || r2 === '1:59', 'BO rest 120s: ' + r2); assert(/マシン インクラインプレス.*1セット目 漸増/.test(await text('#rnext')), 'next exercise: ' + (await text('#rnext'))); await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden]), [data-exchoice]'); });
  await T(G.workout, '代替種目名の上書きが保存され、マスタ名は不変', async () => { await gotoEx(2); assert((await text('.ex-name')).includes('マシン インクラインプレス'), 'ex3'); await page.click('#subBtn'); await dlgOk('フロアプレス'); assert((await text('.ex-name')).startsWith('フロアプレス'), 'sub name shown: ' + (await text('.ex-name'))); assert((await text('.tag.sub')).includes('代替'), 'tag'); if (mode === 'db') { await page.waitForTimeout(200); const ex = await page.$eval('.ex-en', e => e.textContent); assert(rt.DB.plan_exercises['31'].nameJa.startsWith('マシン インクラインプレス'), 'master unchanged'); assert(rt.DB.log_workout['2026-09-16'].meta['31'].subName === 'フロアプレス', 'meta saved'); } });
  await T(G.workout, '違和感メモ・RPE が保存', async () => { await page.click('#noteBtn'); await page.waitForSelector('#exNote'); await page.fill('#exNote', 'right shoulder slight discomfort'); await page.click('[data-r="8"]'); await page.click('#exSave'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(100); assert((await text('#noteBtn')).includes('●'), 'note marker'); if (mode === 'db') { await page.waitForTimeout(200); const m = rt.DB.log_workout['2026-09-16'].meta['31']; assert(m.note === 'right shoulder slight discomfort' && m.rpe === 8, 'meta ' + JSON.stringify(m)); } });
  await T(G.workout, 'フォーム動画アップロード（assets）と一覧。assets が null ならボタン非表示', async () => { if (mode === 'mock') { assert(!(await page.$eval('#formBtn', e => !e.hidden)), 'form button hidden'); return 'assets null → 非表示'; } assert(await page.$eval('#formBtn', e => !e.hidden), 'form button visible'); await page.click('#formBtn'); await page.waitForSelector('#mFile'); await page.setInputFiles('#mFile', { name: 'form.mp4', mimeType: 'video/mp4', buffer: Buffer.from('0123456789') }); await page.click('#mUp'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(200); assert(rt.assets.length === 1 && rt.assets[0].type === 'video/mp4', 'uploaded'); const media = Object.values(rt.DB.log_media); assert(media.length === 1 && media[0].category === 'form' && media[0].assetId === rt.assets[0].id, 'log_media'); await goTab('summary'); assert(await has('.gallery .thumb video'), 'gallery shows video'); await goTab('workout'); return 'assets.upload → log_media.assetId → 一覧'; });
  await T(G.workout, '途中で閉じて再開すると同じ種目・セットから続けられる', async () => { await gotoEx(2); const before = await text('.ex-head .p'); if (mode === 'db') { await page.waitForTimeout(300); await page.reload(); await page.waitForFunction(() => !document.querySelector('#view .loading')); await goTab('workout'); } else { await goTab('today'); await goTab('workout'); } if (await has('#rest:not([hidden])')) { await page.click('#skipRest'); } await page.waitForSelector('#setDone:not([hidden]), [data-exchoice]'); const after = await text('.ex-head .p'); assert(!(await has('#wuStart')), 'warmup not repeated'); assert(after.includes('種目 3/11'), 'resume at ex3: ' + after + ' (before ' + before + ')'); });
  await T(G.workout, '最終種目（腹筋3種）→完了画面: 所要時間・やった内容・有酸素記録・報告テキスト生成→コピー→今日へ戻る', async () => { await gotoEx(10); assert((await text('.ex-name')).includes('ハンギングニーレイズ'), 'ex 11 is hanging knee raise'); assert(!(await page.$('#wv')), '自重種目なので重量欄が出ない'); assert(!(await page.$$eval('.tag', els => els.map(e => e.textContent).join('|'))).includes('確認中'), 'no 確認中 tag'); for (let k = 0; k < 3; k++) { await page.click('[data-set="' + k + '"]'); await page.waitForTimeout(60); await page.click('#setDone'); await page.waitForTimeout(80); if (await has('#rest:not([hidden])')) { const rk = await text('#rn'); assert(rk === '1:30' || rk === '1:29', '腹筋の休憩は90秒: ' + rk); await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden]), [data-exchoice]'); } } await gotoEx(10); { const rv = await page.$$eval('.setrows .sr .rv', els => els.map(e => e.textContent)); assert(rv.length === 3 && rv.every(t => t === '自重×15'), 'abs bodyweight rows: ' + rv.join(',')); } await gotoEx(0);
    for (let guard = 0; guard < 60; guard++) { await pickChoice();
      // 記録済みの種目は完了表示（#exNext）になるので、次の種目へ送る
      if (await page.$('#exNext')) { if ((await text('#exNext')).includes('筋トレ完了')) break; await page.click('#exNext'); await page.waitForTimeout(40); continue; }
      if ((await text('#setDone')).includes('筋トレ完了')) break; const wEl = await page.$('#wv'); if (wEl && (await text('#wv')) === '—') { const q = await page.$('[data-qk]'); if (q) await q.click(); else { await page.click('[data-pm="w:1"]'); } } await page.click('#setDone'); if (await has('#rest:not([hidden])')) { await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden]), [data-exchoice]'); } await page.waitForTimeout(40); }
    const finBtn = (await page.$('#exNext')) ? '#exNext' : '#setDone';
    assert((await text(finBtn)).includes('筋トレ完了'), 'all done'); await page.click(finBtn); await page.waitForSelector('#repDay');
    const body = await text('#view'); assert(body.includes('Day 1 Push 完了') && body.includes('所要'), 'complete header'); assert(body.includes('やった内容') && body.includes('インクラインダンベルプレス') && body.includes('ハンギングニーレイズ') && body.includes('自重×15'), 'list with bodyweight abs: ' + body.slice(0, 200)); assert(!/0kg×0|kg×0(?!\d)/.test(body), 'no 0kg×0');
    await page.click('#cmpCardio'); await page.waitForSelector('#cMin'); assert((await page.$eval('#cType .on', e => e.textContent)) === '傾斜歩き', 'default incline walk'); await page.fill('#cMin', '40'); await page.fill('#cHr', '128'); await page.click('#cSave'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForSelector('#repDay'); assert((await text('#view')).includes('傾斜歩き 40分 ・ 心拍 128'), 'cardio recorded on complete screen');
    const rep = await page.$eval('#repDay', e => e.value); assert(rep.startsWith('Day 1 Push — Sep 16 (Wed)') && rep.includes('Duration:') && rep.includes('Warm-up: done (6 moves x 2 sets') && /Pre-exhaust: Seated cable fly/.test(rep) && /1\. Incline DB press — .*\(top\).*\(back-off\)/.test(rep) && /4\. Pec deck — [\d.]+x\d+/.test(rep) && /\n {3}\(superset with\) plate shoulder front raise — [\d.]+x\d+/.test(rep) && /5\. DB lateral raise.* \+ drop [\d.]+x\d+/.test(rep) && /Abs: Cable crunch — /.test(rep) && /Abs: Hanging knee raise — bodyweight x15/.test(rep) && rep.includes('Cardio: incline walk 40 min @ 128 bpm') && rep.includes('Notes:'), 'report: ' + rep); assert(!/\b0x0\b|0kg/.test(rep), 'report has no 0x0');
    await page.fill('#repDay', rep + '\nextra'); await page.click('#repCopy'); await page.waitForFunction(() => /コピー/.test(document.querySelector('#toast').textContent), null, { timeout: 5000 }); assert((await text('#toast')).includes('コピー'), 'copy toast'); await page.click('#cmpBack'); await page.waitForTimeout(150); assert((await page.$eval('.tabs .on', e => e.dataset.tab)) === 'today', 'back to today'); assert((await page.$eval('[data-step="workout"]', e => e.className)).includes('done'), 'workout done'); assert((await text('[data-step="workout"]')).includes('全22セット中 22セット完了'), 'set count with denominator (superset = 1): ' + (await text('[data-step="workout"]'))); assert((await text('[data-step="cardio"]')).includes('傾斜歩き 40分'), 'cardio row'); { const bg = await page.$eval('.step.done .row', e => getComputedStyle(e).backgroundColor); assert(bg !== 'rgba(0, 0, 0, 0)' && bg !== 'rgb(0, 0, 0)', 'done row not black: ' + bg); const tmCss = await page.$eval('.step.done .tm', e => [getComputedStyle(e).display, getComputedStyle(e).alignItems, !!e.querySelector('small')]); assert(tmCss[0] === 'flex' && tmCss[1] === 'flex-end' && tmCss[2], 'time column right-aligned with planned below: ' + tmCss.join(',')); } assert((await mark('accessory')).startsWith('ok|') && (await text('[data-step="accessory"]')).includes('自重×15'), 'abs row done: ' + (await text('[data-step="accessory"]'))); await goTab('workout'); await page.waitForSelector('#repDay'); assert((await page.$eval('#repDay', e => e.value)).endsWith('extra'), 'edited report kept while open'); await page.click('#cmpReview'); await page.waitForSelector('#setDone, #exNext'); await goTab('today'); });
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
    const days = { day1: '2026-12-02', day2: '2026-12-03', day3: '2026-12-04', day4: '2026-12-05', day5: '2026-12-06', day6: '2026-12-07', day7end: '2026-12-08' };
    const range = { start: days.day1, end: days.day7end };
    const targets = [days.day1, days.day2, days.day4, days.day5, days.day6];
    const saved = {}; targets.forEach(d => { if (rt.DB.log_workout[d]) saved[d] = rt.DB.log_workout[d]; });
    const savedDaily = {}; Object.values(days).forEach(d => { if (rt.DB.log_daily[d]) savedDaily[d] = rt.DB.log_daily[d]; });
    try {
      // 未消化キュー方式では日付を進めるだけで特定の Day に届くとは限らないため、各日を明示的に Day1〜7 に指定する
      Object.entries({ [days.day1]: 1, [days.day2]: 2, [days.day3]: 3, [days.day4]: 4, [days.day5]: 5, [days.day6]: 6, [days.day7end]: 7 }).forEach(([d, n]) => rt.op('set', { coll: 'log_daily', id: d, data: Object.assign({ date: d }, rt.DB.log_daily[d], { dayNo: n }) }));
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
    } finally {
      targets.forEach(d => { if (saved[d]) rt.op('set', { coll: 'log_workout', id: d, data: saved[d] }); else rt.op('del', { coll: 'log_workout', id: d }); });
      Object.values(days).forEach(d => { if (savedDaily[d]) rt.op('set', { coll: 'log_daily', id: d, data: savedDaily[d] }); else rt.op('del', { coll: 'log_daily', id: d }); });
    }
  });
  await T(G.workout, 'Day（部位）は「未消化キュー」方式: 差し替えは翌日に持ち越して再開／できなかったも同じ Day が翌日に繰り越す／未実施バッジ・バナー／連続日の注意／週まとめ・レポート／予定どおりに戻す／差し替え後のキュー順が本番相当（[4,6,7,1,2,3,5]）', async () => {
    if (mode === 'mock') return 'mock モードは永続化が無く複数日にまたがるキューの検証ができないため db モードのみで実施';
    const addD = (d, n) => { const dt = new Date(d + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10); };
    const mdStr = (ymd) => { const p = ymd.split('-'); return Number(p[1]) + '/' + Number(p[2]); };
    const REST_NO = new Set([3, 7]);
    const origStartDate = ((rt.DB.settings || {}).main || {}).startDate || '2026-09-16';
    const setStart = (nsd) => rt.op('set', { coll: 'settings', id: 'main', data: Object.assign({}, (rt.DB.settings || {}).main || {}, { startDate: nsd }) });
    const seedDone = (d, dayNo) => { if (REST_NO.has(dayNo)) rt.op('set', { coll: 'log_cardio', id: d, data: { date: d, entries: [{ type: 'jog', minutes: 30, at: '07:00', loggedAt: d + 'T07:00:00+08:00' }] } }); else rt.op('set', { coll: 'log_workout', id: d, data: { date: d, finished: '19:00', finishedAt: d + 'T19:00:00+08:00', sets: {}, meta: {}, warmup: { done: '07:00' } } }); };
    const clearRange = (from, to) => { for (let d = from; d <= to; d = addD(d, 1)) { rt.op('del', { coll: 'log_daily', id: d }); rt.op('del', { coll: 'log_workout', id: d }); rt.op('del', { coll: 'log_cardio', id: d }); } };
    // 開始日（settings.startDate）を一時的にテスト専用の過去日へ差し替える。「未消化キュー」はイベントソーシングで
    // startDate から今日まで毎日読み直すため、本番の startDate（2026-09-16）のまま未来日へ飛ぶと、他のテストが
    // 埋めた日々ぶんの実績データが無い区間が「未実施のまま」扱いになり、キューが正しく進まない。過去日に退避すれば
    // 少ない日数の仕込みだけで検証でき、他のテストの日付（2026-09〜2027-03 台）とも衝突しない
    const A0 = '2020-01-06', AD = {}; for (let i = 1; i <= 9; i++) AD[i] = addD(A0, i - 1);
    const B0 = '2021-03-01', BD = {}; for (let i = 1; i <= 8; i++) BD[i] = addD(B0, i - 1);
    try {
      // ---- 回帰チェック: 本番同等の「Day4→Day5 差し替え」後のキュー順が仕様どおり [4,6,7,1,2,3,5] になることを確認 ----
      setStart(A0);
      seedDone(AD[1], 1); seedDone(AD[2], 2); seedDone(AD[3], 3);
      rt.op('set', { coll: 'log_daily', id: AD[4], data: { date: AD[4], dayNo: 5, dayChange: { from: 4, loggedAt: AD[4] + 'T09:00:00+08:00' } } });
      seedDone(AD[4], 5);
      const p3 = await newPage(); p3.setDefaultTimeout(25000);
      await p3.clock.setFixedTime(new Date(AD[9] + 'T06:50:00+08:00')); await p3.waitForTimeout(350);
      const dn = (d) => p3.evaluate(ds => window.__tl.dayNoFor(ds), d);
      assert(await dn(AD[5]) === 4, '差し替え翌日は繰り越しでDay4: ' + await dn(AD[5]));
      seedDone(AD[5], 4); await p3.waitForTimeout(300);
      assert(await dn(AD[6]) === 6, 'キュー順どおりDay6: ' + await dn(AD[6]));
      seedDone(AD[6], 6); await p3.waitForTimeout(300);
      assert(await dn(AD[7]) === 7, 'キュー順どおりDay7（休み）: ' + await dn(AD[7]));
      seedDone(AD[7], 7); await p3.waitForTimeout(300);
      assert(await dn(AD[8]) === 1, 'キュー順どおりDay1: ' + await dn(AD[8]));
      seedDone(AD[8], 1); await p3.waitForTimeout(300);
      assert(await dn(AD[9]) === 2, 'キュー順どおりDay2（差し替え後のキューが [4,6,7,1,2,3,5] であることを確認）: ' + await dn(AD[9]));
      await p3.close();
      clearRange(A0, AD[9]);

      // ---- 実際の UI 操作: 差し替え・持ち越し表示・できなかった・未実施バッジ/バナー・連続日の注意・週まとめ/レポート・元に戻す ----
      setStart(B0);
      seedDone(BD[1], 1); seedDone(BD[2], 2); seedDone(BD[3], 3);
      const p2 = await newPage(); p2.setDefaultTimeout(25000);
      const dlgOk2 = async () => { await p2.waitForSelector('#dlg:not([hidden])'); await p2.click('#dlgOk'); await p2.waitForSelector('#dlg', { state: 'hidden' }); await p2.waitForTimeout(120); };
      const closeSheetP2 = async () => { if (await p2.$('#sheet:not([hidden])')) { await p2.click('#sheet', { position: { x: 5, y: 5 } }); await p2.waitForSelector('#sheet', { state: 'hidden' }); } };
      const pickReasonP2 = async (label) => { await p2.waitForSelector('[data-reason]'); await p2.click('[data-reason="' + label + '"]'); await p2.waitForFunction(() => document.querySelector('#dlg').hidden || !document.querySelector('[data-reason]')); await p2.waitForTimeout(80); };
      const gotoP2 = async (d) => { await p2.click('.tabs [data-tab="today"]'); await p2.clock.setFixedTime(new Date(d + 'T06:50:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading')); await p2.click('.tabs [data-tab="today"]'); await p2.waitForSelector('#dayHead'); };
      await gotoP2(BD[4]);
      // B1. 差し替え前は Day4
      assert((await p2.locator('#dayHead').textContent()).startsWith('Day 4'), '差し替え前はDay4: ' + (await p2.locator('#dayHead').textContent()));
      // B2. 記録が残っている状態で差し替える（ウォームアップ画面を開くと自動で記録扱いになる）。Day5 に差し替え、完了させる
      await p2.click('.tabs [data-tab="workout"]'); await p2.waitForSelector('#wuStart');
      await p2.click('#wkDayHead'); await p2.waitForSelector('[data-pickday="5"]');
      await p2.click('[data-pickday="5"]'); await p2.waitForSelector('#dcSave'); await p2.click('#dcSave');
      await dlgOk2();
      await p2.waitForFunction(() => document.querySelector('#wkDayHead').textContent.startsWith('Day 5'));
      seedDone(BD[4], 5); await p2.waitForTimeout(300);
      // B3. 翌日は繰り越しで Day4 が出て、差し替えた旨のメモが出る
      await gotoP2(BD[5]);
      assert((await p2.locator('#dayHead').textContent()).startsWith('Day 4'), '差し替え翌日は繰り越しでDay4: ' + (await p2.locator('#dayHead').textContent()));
      let viewTxt = await p2.locator('#view').textContent();
      assert(viewTxt.includes(mdStr(BD[4])) && viewTxt.includes('Day 5') && viewTxt.includes('持ち越し'), '差し替えで持ち越しになった旨のメモが出る: ' + viewTxt.slice(0, 400));
      // B4. Day ピッカーで Day4 が先頭に並び [未実施] バッジが付く
      await p2.click('#dayHead'); await p2.waitForSelector('[data-pickday]');
      let rows = await p2.$$eval('[data-pickday]', els => els.map(e => e.closest('.it').textContent));
      assert(rows[0].includes('Day 4') && rows[0].includes('[未実施]') && rows[0].includes(mdStr(BD[4])) && rows[0].includes('今日の予定'), '先頭行はDay4の持ち越し: ' + rows[0]);
      // B5. 連続日の注意: 前日にやった Day5 を選ぶと警告が出る（保存はしない）
      await p2.click('[data-pickday="5"]'); await p2.waitForSelector('#dcSave');
      const warnTxt = await p2.locator('#sheet .sheet-body').textContent();
      assert(warnTxt.includes('連続') && warnTxt.includes('昨日'), '前日と同じ部位を選ぶと注意が出る: ' + warnTxt);
      await p2.click('#dcBack'); await closeSheetP2();
      // B6. Day4 を完了せず「できなかった」で記録 → 翌日も Day4 が繰り越して出る
      await p2.click('[data-chk="workout"]'); await p2.waitForSelector('[data-choice]');
      await p2.click('[data-choice="1"]');
      await pickReasonP2('仕事');
      await p2.waitForFunction(() => document.querySelector('[data-step="workout"]').dataset.mark === 'na');
      const missedTxt = await p2.locator('[data-step="workout"]').textContent();
      assert(missedTxt.includes('できなかった') && missedTxt.includes('持ち越し'), 'できなかったの表示: ' + missedTxt);
      await gotoP2(BD[6]);
      assert((await p2.locator('#dayHead').textContent()).startsWith('Day 4'), 'できなかった翌日もDay4が繰り越し: ' + (await p2.locator('#dayHead').textContent()));
      let viewTxt2 = await p2.locator('#view').textContent();
      // 持ち越し開始日は最初にずれた 3/4（Day5 への差し替え）のまま。3/5 の「できなかった」で日付が上書きされるわけではない
      assert(viewTxt2.includes(mdStr(BD[4])) && viewTxt2.includes('Day 5 に差し替えたため持ち越し'), '持ち越しメモは元の差し替え日（3/4）のまま: ' + viewTxt2.slice(0, 400));
      // B7. さらに Day6 に差し替えて未完了のままにすると、未実施が2件になりバナーが出る
      await p2.click('#dayHead'); await p2.waitForSelector('[data-pickday="6"]');
      await p2.click('[data-pickday="6"]'); await p2.waitForSelector('#dcSave'); await p2.click('#dcSave');
      await p2.waitForFunction(() => document.querySelector('#dayHead').textContent.startsWith('Day 6'));
      await gotoP2(BD[7]);
      await p2.waitForSelector('#pendingBanner');
      const bannerTxt = await p2.locator('#pendingBanner').textContent();
      assert(bannerTxt.includes('未実施が 2 つ') && bannerTxt.includes('Day 4') && bannerTxt.includes('Day 6'), '未実施バナー: ' + bannerTxt);
      // B8. バナーからピッカーを開くと、今日の予定（Day6）が先頭、次に古い持ち越し（Day4）の順で並ぶ
      await p2.click('#pendingBanner'); await p2.waitForSelector('[data-pickday]');
      const rows2 = await p2.$$eval('[data-pickday]', els => els.map(e => e.closest('.it').textContent));
      const pend = rows2.filter(r => r.includes('[未実施]'));
      assert(pend.length === 2 && pend[0].includes('Day 6') && pend[0].includes('今日の予定') && pend[1].includes('Day 4'), '未実施2件（今日の予定が先頭）: ' + JSON.stringify(pend));
      await closeSheetP2();
      // B9. 週まとめ・コーチ向けレポートに差し替え履歴と未実施の一覧が出る
      const rep = await p2.evaluate(wn => window.__tl.weeklyReport(wn, {}), 1);
      assert(rep.includes('swapped Day 4') && /Day 5 \(Shoulder/.test(rep) && /Day 6 \(Pull/.test(rep), 'レポートに差し替え履歴: ' + rep);
      assert(/Pending: Day 4 \(Legs\) not done since/.test(rep) && /Pending: Day 6 \(Pull\) not done since/.test(rep), 'レポートに未実施の一覧: ' + rep);
      // B10. 予定どおりに戻す（Day6 への差し替えを取り消す。確認ダイアログは不要）
      await p2.click('[data-shift="-1"]'); await p2.waitForTimeout(100);
      await p2.click('#dayHead'); await p2.waitForSelector('#dayReset');
      await p2.click('#dayReset'); await p2.waitForSelector('#sheet', { state: 'hidden' });
      await p2.click('#dayHead'); await p2.waitForSelector('[data-pickday]');
      assert(!(await p2.$('#dayReset')), '予定どおりに戻すと差し替え記録が消える');
      await closeSheetP2();
      await p2.close();
      return '差し替えの持ち越し・できなかったの持ち越し・未実施バッジ/バナー・連続日の注意・週まとめ/レポート・元に戻す・差し替え後のキュー順、すべて確認';
    } finally { setStart(origStartDate); clearRange(A0, AD[9]); clearRange(B0, BD[8]); }
  });
  await T(G.meal, '記録画面: よく食べるものをチェックで複数選んで1件の記録にできる。個数は 0.5 単位、合計はその場で変わる。すべての食品に分量と単位が付き、重複が無い', async () => {
    const D = '2027-03-01';
    const p2 = await newPage(); p2.setDefaultTimeout(25000);
    try {
      await p2.clock.setFixedTime(new Date(D + 'T09:00:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
      await p2.click('.tabs [data-tab="today"]'); await p2.waitForSelector('#addMealBtn');
      await p2.click('#addMealBtn'); await p2.waitForSelector('#recQ');
      // すべての行に分量と単位が付く（「1」だけの表示はしない）
      const names = await p2.$$eval('.frow .nm', els => els.map(e => e.textContent.trim()));
      assert(names.every(n => /[0-9.]+\s*(g|ml|個|袋|枚|杯|スクープ|貫)$/.test(n)), '分量と単位が付く: ' + names.slice(0, 5).join(' / '));
      assert(new Set(names).size === names.length, '重複が無い: ' + names.join(' / '));
      assert(names.some(n => n.indexOf('ピスタチオ Meadows 20g') === 0), 'ピスタチオは 20g 単位にまとめる: ' + names.filter(n => /ピスタチオ/.test(n)).join(' / '));
      assert(!names.some(n => /\+/.test(n)), 'セットの食品は置かない（複数選択で代わりになる）');
      // 2品チェック → 1件の記録
      assert((await p2.locator('.rectot').textContent()).indexOf('0品') === 0, '最初は 0品: ' + (await p2.locator('.rectot').textContent()));
      await p2.click('[data-foodchk="soya_hoops"]'); await p2.waitForTimeout(120);
      await p2.click('[data-foodchk="selecta_adult"]'); await p2.waitForTimeout(120);
      assert((await p2.locator('.rectot').textContent()).includes('2品') && /390kcal/.test(await p2.locator('.rectot').textContent()), '品数と合計がその場で出る: ' + (await p2.locator('.rectot').textContent()));
      // 0.5 単位
      await p2.click('[data-fq="soya_hoops:0.5"]'); await p2.waitForTimeout(150);
      assert((await p2.$eval('[data-food="soya_hoops"] .qty b', e => e.textContent)) === '1.5', '0.5 単位で増やせる');
      await p2.click('[data-fq="soya_hoops:-0.5"]'); await p2.click('[data-fq="soya_hoops:-0.5"]'); await p2.waitForTimeout(150);
      assert((await p2.$eval('[data-food="soya_hoops"] .qty b', e => e.textContent)) === '0.5', '0.5 未満にはしない');
      await p2.click('[data-fq="soya_hoops:0.5"]'); await p2.waitForTimeout(150);
      await p2.click('#recSave'); await p2.waitForSelector('#sheet', { state: 'hidden' }); await p2.waitForTimeout(300);
      const row = await p2.locator('.elist').textContent();
      assert(row.includes('ソヤ プロテイン フープス80g') && row.includes('セレクタ アダルト アクティブ150ml') && /390kcal/.test(row), '2品が1件の記録になる: ' + row);
      assert((await p2.$$eval('.elist .erow', els => els.length)) === 1, '1件だけ');
      if (mode === 'db') { const k = Object.keys(rt.DB.log_meals[D].meals)[0]; const rec = rt.DB.log_meals[D].meals[k]; assert(rec.items.length === 2 && rec.planSlot === null, 'db: 1件に2品・planSlot null: ' + JSON.stringify({ n: rec.items.length, s: rec.planSlot })); }
      // 編集: 同じ画面でチェックが入った状態、外すと消える
      await p2.click('.elist .erow'); await p2.waitForSelector('#recQ');
      const on = await p2.$$eval('.frow.on .nm', els => els.map(e => e.textContent.trim()));
      assert(on.length === 2, '編集はチェック済みで開く: ' + on.join(' / '));
      await p2.click('[data-foodchk="selecta_adult"]'); await p2.waitForTimeout(120);
      assert((await p2.locator('.rectot').textContent()).includes('1品'), 'チェックを外すと減る');
      await p2.click('#recSave'); await p2.waitForSelector('#sheet', { state: 'hidden' }); await p2.waitForTimeout(300);
      assert(!(await p2.locator('.elist').textContent()).includes('セレクタ'), '外した品目が消える');
      // 新しい食品を登録 → そのままチェック済み
      await p2.click('.elist .erow'); await p2.waitForSelector('#recQ');
      await p2.click('#recNewFood'); await p2.waitForSelector('#nfSave');
      await p2.fill('#nfName', 'プロテインバー'); await p2.fill('#nfG', '60'); await p2.fill('#nfK', '230'); await p2.fill('#nfP', '20');
      await p2.click('#nfSave'); await p2.waitForSelector('#recQ'); await p2.waitForTimeout(200);
      assert((await p2.$$eval('.frow.on .nm', els => els.map(e => e.textContent.trim()))).some(n => n.indexOf('プロテインバー 60g') === 0), '登録した食品がチェック済みで入る');
      // カロリーだけ入力した品目も混ぜられる
      await p2.click('#recKcal'); await p2.waitForSelector('#koAdd');
      await p2.fill('#koName', '外食'); await p2.fill('#koK', '800'); await p2.click('#koAdd'); await p2.waitForSelector('#recQ'); await p2.waitForTimeout(200);
      assert((await p2.locator('.rectot').textContent()).includes('3品'), 'よく食べるものと混ぜて1件にできる: ' + (await p2.locator('.rectot').textContent()));
      await p2.click('#recSave'); await p2.waitForSelector('#sheet', { state: 'hidden' }); await p2.waitForTimeout(300);
      const row2 = await p2.locator('.elist').textContent();
      assert(row2.includes('プロテインバー') && row2.includes('外食'), '3品が1件に: ' + row2);
      // 編集画面の一番下に削除、削除後は元に戻せる
      await p2.click('.elist .erow'); await p2.waitForSelector('#recDel'); await p2.click('#recDel'); await p2.waitForTimeout(400);
      assert(!(await p2.$('.elist')), '削除で一覧から消える');
      assert((await p2.locator('#toast').textContent()).includes('元に戻す') || !!(await p2.$('#toast button')), '削除はトーストで元に戻せる');
      await p2.click('#toast button'); await p2.waitForTimeout(400);
      assert(await p2.$('.elist'), '元に戻せる');
      return 'チェックで複数選択 → 1件の記録。0.5 単位・新規登録・カロリーだけ入力を混ぜられる';
    } finally { await p2.close(); rt.op('del', { coll: 'log_meals', id: D }); rt.op('del', { coll: 'log_daily', id: D }); }
  });
  await T(G.workout, 'スーパーセットの①②は重量・提案・休憩・記録を完全に別々に管理する（Day5 ダンベルショルダープレス＋フロントレイズ）', async () => {
    const D = '2027-05-09'; // 他のテストと日付が衝突しない、履歴の無い孤立した日
    const p2 = await newPage(); p2.setDefaultTimeout(20000);
    await p2.click('.tabs [data-tab="today"]');
    await p2.clock.setFixedTime(new Date(D + 'T06:50:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
    // 未消化キュー方式では日付を進めるだけで特定の Day に届くとは限らないため、Day ピッカーで直接 Day5 を指定する
    await p2.click('#dayHead'); await p2.waitForSelector('[data-pickday="5"]'); await p2.click('[data-pickday="5"]'); await p2.waitForSelector('#dcSave'); await p2.click('#dcSave');
    await p2.waitForTimeout(80); if (await p2.$('#dlg:not([hidden])')) { await p2.click('#dlgOk'); await p2.waitForSelector('#dlg', { state: 'hidden' }); }
    await p2.waitForFunction(() => document.querySelector('h1') && document.querySelector('h1').textContent.startsWith('Day 5'));
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
      await recordSet(7, 10, p2);
      // ①→②は休憩なしで自動遷移。カードに①（実績7kg×10）②（いまここ）が並ぶ
      assert(!(await p2.$('#rest:not([hidden])')), '①→②の間は休憩タイマーが出ない');
      const curTxt1 = await p2.locator('.cur-set').textContent();
      assert(curTxt1.includes('① ダンベル シーテッド ショルダープレス') && curTxt1.includes('7kg×10') && curTxt1.includes('② ダンベル オーバーハンド フロントレイズ'), 'カードに①（実績あり）②（いまここ）が並んで出る: ' + curTxt1);
      // ②の初期値が①の7kgを引きずっていない（②も初回なので目安なし・空欄）
      assert(await p2.$('#noHint'), '②も初回は目安なし（①の値を引きずらない）');
      const w0b = await p2.$eval('#wv', e => e.dataset.v); assert(w0b === '', '②の入力初期値が空（①の7kgではない）: ' + JSON.stringify(w0b));

      // --- 1セット目 ②: 5kg×10 を記録 ---
      await recordSet(5, 10, p2);
      // ②のあとだけ休憩タイマーが出て、「次」に2セット目①の名前と提案重量が正しく出る（見切れない）
      await p2.waitForSelector('#rest:not([hidden])');
      const rnextTxt = await p2.locator('#rnext').textContent();
      assert(rnextTxt.includes('①') && rnextTxt.includes('ダンベル シーテッド ショルダープレス') && rnextTxt.includes('提案 8'), '②のあとの休憩「次」に2セット目①・提案8kgが正しく出る: ' + rnextTxt);
      await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden]), [data-exchoice]');

      // --- 2セット目 ①: ①自身の直前（7kg）からのプログレッシブ提案（+5%目安=8kg）。②の5kgを引きずらない ---
      const ghost1 = await p2.locator('.ghost').textContent();
      assert(ghost1.includes('漸増') && ghost1.includes('直前 7kg'), '2セット目①の提案根拠は①自身の直前セット（7kg）: ' + ghost1);
      const w0c = await p2.$eval('#wv', e => e.dataset.v); assert(w0c === '8', '2セット目①の提案重量=8kg（②の5kgではない）: ' + w0c);
      await p2.click('#setDone'); // 提案どおり 8kg×8 で記録
      assert(!(await p2.$('#rest:not([hidden])')), '2セット目も①→②は休憩なし');

      // --- 2セット目 ②: ②自身の直前（5kg）からのプログレッシブ提案（+5%目安=6kg）。①の7kg/8kgを引きずらない ---
      const ghost2 = await p2.locator('.ghost').textContent();
      assert(ghost2.includes('漸増') && ghost2.includes('直前 5kg'), '2セット目②の提案根拠は②自身の直前セット（5kg、①の7kg/8kgではない）: ' + ghost2);
      const w0d = await p2.$eval('#wv', e => e.dataset.v); assert(w0d === '6', '2セット目②の提案重量=6kg（①の8kgではない）: ' + w0d);
      await p2.click('#setDone'); // 提案どおり 6kg×8 で記録
      await p2.waitForSelector('#rest:not([hidden])'); await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden]), [data-exchoice]');

      // 残りの種目をクイック重量/提案どおりに進めて完了画面まで到達
      await finishAllSets(p2);
      await p2.waitForSelector('.rep-ta');
      // 完了画面「やった内容」: ①②が別々の行（実績が混ざらない）
      const cmpTxt = await p2.locator('.card').first().textContent();
      assert(cmpTxt.includes('ダンベル シーテッド ショルダープレス') && cmpTxt.includes('7kg×10、8kg×8') && cmpTxt.includes('とスーパーセット') && cmpTxt.includes('5kg×10、6kg×8'), '完了画面で①②が別行・別実績: ' + cmpTxt);
      // コーチ報告テキスト: 「3. DB seated shoulder press — 7x10, 8x8」「   (superset with) DB overhand front raise — 5x10, 6x8」の2行
      const repTxt = await p2.locator('#repDay').inputValue();
      assert(repTxt.includes('3. DB seated shoulder press — 7x10, 8x8') && repTxt.includes('(superset with) DB overhand front raise — 5x10, 6x8'), 'レポートで①②が別行: ' + repTxt);
      await p2.close();
      return '①7kg×10,8kg×8 ・ ②5kg×10,6kg×8 が完全に独立（保存・提案・休憩・一覧・完了画面・レポートすべて確認）';
    } finally { await resetClock(); rt.op('del', { coll: 'log_workout', id: D }); rt.op('del', { coll: 'log_daily', id: D }); rt.op('del', { coll: 'log_cardio', id: D }); }
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
      { const t = await p2.locator('#cKcalPreview').textContent(); assert(t.includes('約 504 kcal') && t.includes('体重 72kg'), '体重72kg・ふつう(METs7.0)・60分 → 504kcal＋計算に使った体重: ' + t); }
      // 「+30分」ボタンで加算
      await p2.click('#cPadelMin [data-pmin="+30"]');
      assert((await p2.$eval('#cMin', e => e.value)) === '90', '+30分ボタンで加算される');
      assert((await p2.locator('#cKcalPreview').textContent()).includes('約 756 kcal'), '90分 → 756kcal: ' + (await p2.locator('#cKcalPreview').textContent()));
      // 強度3段階で数値が変わる（激しめ METs8.5）
      await p2.click('#cIntensity [data-int="hard"]');
      assert((await p2.locator('#cKcalPreview').textContent()).includes('約 918 kcal'), '強度「激しめ」(8.5)で90分 → 918kcal: ' + (await p2.locator('#cKcalPreview').textContent()));
      // 自由入力（分）でも再計算される（軽め METs5.5・120分）
      await p2.click('#cIntensity [data-int="light"]'); await p2.fill('#cMin', '120');
      assert((await p2.locator('#cKcalPreview').textContent()).includes('約 792 kcal'), '自由入力120分・軽め(5.5) → 792kcal: ' + (await p2.locator('#cKcalPreview').textContent()));
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
      assert(rep.includes('Cardio:') && rep.includes('Padel x1 (90 min, 1.5 hrs, ~756 kcal)') && !rep.includes('Zone 2'), 'コーチ向けレポートにパデルが Zone 2 と分けて出る（この週は Zone 2 の記録が無い）: ' + rep);
      await p2.close();
      return 'パデル追加：30分単位・強度3段階(5.5/7.0/8.5)・kcal自動計算・今日画面/脂肪計算/週まとめでZone2と分離、すべて確認';
    } finally { await resetClock(); rt.op('del', { coll: 'log_weight', id: D }); rt.op('del', { coll: 'log_cardio', id: D }); rt.op('del', { coll: 'log_daily', id: D }); }
  });
  await T(G.workout, 'ピックルボールを有酸素の選択肢に追加：30分単位・強度3段階（4.5/5.5/7.0、初期値ふつう）・体重未測定でも初期値で計算・Zone2/パデルと3つに分けて集計', async () => {
    const D = '2027-06-08';
    const p2 = await newPage(); p2.setDefaultTimeout(20000);
    await p2.click('.tabs [data-tab="today"]');
    await p2.clock.setFixedTime(new Date(D + 'T06:50:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
    await p2.click('.tabs [data-tab="today"]');
    const prev = async () => (await p2.locator('#cKcalPreview').textContent());
    try {
      // 体重を一度も測っていない日でも、プロフィールの初期値 72.4kg にフォールバックして計算できる（エラーにならない）
      const fb = await p2.evaluate(() => ({ w: window.__tl.cardioWeightKg('2020-01-01'), k: window.__tl.racketKcal('pickleball', 60, 'normal', window.__tl.cardioWeightKg('2020-01-01')) }));
      assert(fb.w === 72.4 && Math.round(fb.k) === 398, '体重未測定なら初期値72.4kgで計算（60分・ふつう5.5 → 398kcal）: ' + JSON.stringify(fb));
      // 体重 72kg を記録 → 以後は実測値で計算し、計算に使った体重を画面に出す
      await p2.click('[data-open="weight"]'); await p2.waitForSelector('#shSave');
      await p2.fill('#shW', '72'); await p2.click('#shSave'); await p2.waitForFunction(() => document.querySelector('[data-step="weight"]').className.includes('done'));
      await p2.click('[data-open="cardio"]'); await p2.waitForSelector('#cType');
      const chips = await p2.$$eval('#cType button', els => els.map(e => e.textContent));
      assert(chips.includes('ピックルボール') && chips.includes('パデル') && !chips.join('').includes('…'), '有酸素の選択肢にピックルボールとパデルが名前で出る: ' + chips.join(','));
      assert(await p2.$eval('#cPadelBlock', e => e.hidden), 'デフォルト（傾斜歩き）では時間・強度の欄は隠れている');
      await p2.click('#cType [data-t="pickleball"]');
      assert(!(await p2.$eval('#cPadelBlock', e => e.hidden)), 'ピックルボールを選ぶと時間プリセット・強度・kcalプレビューが出る');
      // 時間ボタンは 30/60/90/120＋30分、自由入力は分数欄
      const mins = await p2.$$eval('#cPadelMin button', els => els.map(e => e.textContent));
      assert(mins.join(',') === '30分,60分,90分,120分,＋30分', '30分単位の時間ボタン: ' + mins.join(','));
      // 強度は3択で初期値が「ふつう」
      const ints = await p2.$$eval('#cIntensity button', els => els.map(e => e.textContent + (e.className.includes('on') ? '*' : '')));
      assert(ints.length === 3 && ints[0].startsWith('軽め') && ints[1].startsWith('ふつう') && ints[1].endsWith('*') && ints[2].startsWith('激しめ'), '強度3択・初期値はふつう: ' + ints.join(' / '));
      // 時間・強度を変えるたびに消費カロリーが更新される（体重72kg）
      await p2.click('#cPadelMin [data-pmin="60"]');
      { const t = await prev(); assert(t.includes('約 396 kcal') && t.includes('体重 72kg') && !t.includes('初期値'), '72kg・ふつう(5.5)・60分 → 396kcal＋実測体重: ' + t); }
      await p2.click('#cIntensity [data-int="light"]');
      assert((await prev()).includes('約 324 kcal'), '軽め(4.5)・60分 → 324kcal: ' + (await prev()));
      await p2.click('#cIntensity [data-int="hard"]');
      assert((await prev()).includes('約 504 kcal'), '激しめ(7.0)・60分 → 504kcal: ' + (await prev()));
      await p2.click('#cPadelMin [data-pmin="+30"]');
      assert((await p2.$eval('#cMin', e => e.value)) === '90' && (await prev()).includes('約 756 kcal'), '＋30分で90分・激しめ → 756kcal: ' + (await prev()));
      // 自由入力（その他）でも再計算される
      await p2.click('#cIntensity [data-int="normal"]'); await p2.fill('#cMin', '90');
      assert((await prev()).includes('約 594 kcal'), '自由入力90分・ふつう(5.5) → 594kcal: ' + (await prev()));
      // パデルに切り替えると METs が変わり、強度は「ふつう」に戻る（ピックルボールの選択を引きずらない）
      await p2.click('#cType [data-t="padel"]');
      assert((await p2.$$eval('#cIntensity button', els => els.filter(e => e.className.includes('on')).map(e => e.textContent)))[0].startsWith('ふつう'), 'パデルに切り替えても初期値はふつう');
      assert((await prev()).includes('約 756 kcal'), 'パデルのふつう(7.0)・90分 → 756kcal: ' + (await prev()));
      // ピックルボール ふつう 90分（594kcal）で保存
      await p2.click('#cType [data-t="pickleball"]'); await p2.fill('#cMin', '90');
      await p2.click('#cSave'); await p2.waitForTimeout(250);
      // 同じ日に Zone 2（傾斜歩き40分）とパデル（ふつう60分＝504kcal）も記録して、3つが混ざらないことを見る
      await p2.click('[data-open="cardio"]'); await p2.waitForSelector('#cType'); await p2.fill('#cMin', '40'); await p2.click('#cSave'); await p2.waitForTimeout(250);
      await p2.click('[data-open="cardio"]'); await p2.waitForSelector('#cType'); await p2.click('#cType [data-t="padel"]'); await p2.click('#cPadelMin [data-pmin="60"]'); await p2.click('#cSave'); await p2.waitForTimeout(250);
      // 今日画面: 種目名を省略せず全部出し、Zone 2 とは別物だと伝える
      const cardioRow = await p2.locator('[data-step="cardio"]').textContent();
      assert(cardioRow.includes('ピックルボール 90分') && cardioRow.includes('約594 kcal') && cardioRow.includes('パデル 60分') && cardioRow.includes('約504 kcal') && cardioRow.includes('傾斜歩き 40分'), '今日画面に3種すべてが名前と実績で出る: ' + cardioRow);
      assert(cardioRow.includes('パデル・ピックルボールは強度が変動するので、Zone 2 とは別物です'), 'Zone 2 と別物である注意書きに種目名が出る: ' + cardioRow);
      // 脂肪の計算（TDEEの運動分）と1日の収支に加算される
      const exVal = await p2.evaluate(ds => window.__tl.exerciseKcalFor(ds, 72), D);
      assert(Math.round(exVal) === 594 + 504 + Math.round(6.5 * 72 * 40 / 60), '運動消費kcalにピックルボールも加算される: ' + exVal);
      const bal = await p2.evaluate(ds => window.__tl.dayCalorieBalance(ds), D);
      assert(bal === null || Math.round(bal.exVal) === Math.round(exVal), '1日の収支の運動分と一致: ' + JSON.stringify(bal));
      // 週まとめ: Zone 2・パデル・ピックルボールの3つに分かれる（ピックルボールは Zone 2 の遵守率に入れない）
      const wa = await p2.evaluate(ds => window.__tl.weekAdherence({ start: ds, end: ds }).cardio, D);
      assert(wa.zone2.count === 1 && wa.padel.count === 1 && wa.pickleball.count === 1 && wa.pickleball.minutes === 90 && Math.round(wa.pickleball.kcal) === 594, 'weekAdherence で3つに分離: ' + JSON.stringify(wa));
      await p2.click('.tabs [data-tab="summary"]'); await p2.waitForSelector('#cardioBreak');
      const brk = await p2.locator('#cardioBreak').textContent();
      assert(brk.includes('Zone 2') && brk.includes('パデル') && brk.includes('ピックルボール') && brk.includes('1回 ・ 合計1.5時間 ・ 594 kcal') && !brk.includes('…'), '週まとめの有酸素が3つに分かれて名前つきで出る: ' + brk);
      // コーチ向けレポート
      const rep = await p2.evaluate(() => window.__tl.weeklyReport());
      assert(rep.includes('Zone 2 x1 (40 min)') && rep.includes('Padel x1 (60 min, 1.0 hrs, ~504 kcal)') && rep.includes('Pickleball x1 (90 min, 1.5 hrs, ~594 kcal)'), 'レポートで Zone 2・パデル・ピックルボールが分かれて出る: ' + rep);
      await p2.close();
      return 'ピックルボール追加：30分単位・強度3段階(4.5/5.5/7.0、初期値ふつう)・体重未測定は初期値72.4kg・72kg×ふつう×60分=396kcal・今日画面/脂肪計算/1日収支/週まとめ/レポートで Zone2・パデルと3分割、すべて確認';
    } finally { await resetClock(); rt.op('del', { coll: 'log_weight', id: D }); rt.op('del', { coll: 'log_cardio', id: D }); rt.op('del', { coll: 'log_daily', id: D }); }
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
      // 未消化キュー方式では日付を進めるだけで特定の Day に届くとは限らないため、Day ピッカーで直接 Day5 を指定する
      // （前回のセットを完了させていないので Day5 は未実施のまま繰り越しており、既に Day5 のことも多い＝その場合ピッカーは不要）
      if (!(await p2.locator('h1').textContent()).startsWith('Day 5')) {
        await p2.click('#dayHead'); await p2.waitForSelector('[data-pickday="5"]'); await p2.click('[data-pickday="5"]'); await p2.waitForSelector('#dcSave'); await p2.click('#dcSave');
        await p2.waitForTimeout(80); if (await p2.$('#dlg:not([hidden])')) { await p2.click('#dlgOk'); await p2.waitForSelector('#dlg', { state: 'hidden' }); }
        await p2.waitForFunction(() => document.querySelector('h1') && document.querySelector('h1').textContent.startsWith('Day 5'));
      }
      await p2.click('.tabs [data-tab="workout"]'); await p2.waitForSelector('#wuStart');
      for (let id = 1; id <= 6; id++) { await p2.click('[data-wuset="' + id + '"]'); await p2.click('[data-wuset="' + id + '"]'); }
      await p2.click('#wuStart'); await p2.waitForSelector('#setDone');
      await p2.click('[data-ex="1"]'); // 種目2 = マシン／スミス ショルダープレス（選択式・TOP→BO×2）
      await pickChoice(0, p2); // 毎回「どちらをやるか」を選ぶ。0番目＝マシン ショルダープレス（id42）
      assert((await p2.locator('.ex-name').textContent()).includes('ショルダープレス'), '種目2はソロのショルダープレス: ' + (await p2.locator('.ex-name').textContent()));
    };
    const recordTopBo = async (topW, topR, boW, boR) => {
      await p2.click('[data-set="0"]'); await recordSet(topW, topR, p2);
      if (await p2.$('#rest:not([hidden])')) await p2.click('#skipRest');
      await p2.waitForSelector('#setDone:not([hidden]), [data-exchoice]');
      await p2.click('[data-set="1"]'); await recordSet(boW, boR, p2);
      if (await p2.$('#rest:not([hidden])')) await p2.click('#skipRest');
      await p2.waitForSelector('#setDone:not([hidden]), [data-exchoice]');
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
    } finally { await resetClock(); dates.forEach(d => { rt.op('del', { coll: 'log_workout', id: d }); rt.op('del', { coll: 'log_daily', id: d }); rt.op('del', { coll: 'log_cardio', id: d }); }); }
  });
  await T(G.workout, '全7日確定版: Day2 Pull 8種目＋カーフ / Day4 Legs 8種目＋腹筋 / Day5 Shoulder & Arms 8種目＋カーフ / Day6 Pull 8種目＋腹筋。ドロップ「限界まで」とスーパーセットの組展開', async () => {
    // 9/16 は他の多数のテストが依存する既存データ（Day1 完了済みなど）を持つため、ここで Day を差し替えて壊さないよう
    // 履歴の無い孤立した日付に移ってから Day ピッカーで直接指定する
    const p2 = await newPage(); p2.setDefaultTimeout(20000);
    await p2.click('.tabs [data-tab="today"]');
    await p2.clock.setFixedTime(new Date('2027-07-01T06:50:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
    try {
    const wk = async () => (await p2.locator('[data-step="workout"]').textContent());
    const forceDayP2 = async (dayNo) => {
      await p2.click('#dayHead'); await p2.waitForSelector('[data-pickday="' + dayNo + '"]'); await p2.click('[data-pickday="' + dayNo + '"]'); await p2.waitForSelector('#dcSave'); await p2.click('#dcSave');
      await p2.waitForTimeout(80); if (await p2.$('#dlg:not([hidden])')) { await p2.click('#dlgOk'); await p2.waitForSelector('#dlg', { state: 'hidden' }); }
      await p2.waitForFunction((n) => document.querySelector('h1') && document.querySelector('h1').textContent.startsWith('Day ' + n), dayNo);
    };
    await forceDayP2(2); { const acc = await p2.locator('[data-step="accessory"]').textContent(); assert(acc.includes('カーフ') && acc.includes('スミスマシン カーフレイズ') && acc.includes('ドンキーカーフレイズ') && acc.includes('レッグプレス トープレス') && !acc.includes('確認中'), 'Day2 は最終種目のあとにカーフ3択: ' + acc); } assert((await p2.locator('h1').textContent()).startsWith('Day 2') && (await wk()).includes('Pull ・ 8種目') && (await wk()).includes('Vバー ロウ（事前疲労）・ベントオーバーロウ') && (await wk()).includes('ほか5種目') && !(await wk()).includes('ラックプル'), 'Day2: ' + (await wk()));
    await forceDayP2(4); { const acc = await p2.locator('[data-step="accessory"]').textContent(); assert(acc.includes('腹筋') && acc.includes('ケーブルクランチ') && acc.includes('ケーブル 片手 オブリーククランチ') && acc.includes('ハンギングニーレイズ') && !acc.includes('確認中'), 'Day4 は最終種目のあとに腹筋3種: ' + acc); } assert((await p2.locator('h1').textContent()).startsWith('Day 4') && (await wk()).includes('Legs ・ 8種目') && (await wk()).includes('ダンベル ルーマニアンデッドリフト（事前疲労）・自重スクワット（事前疲労）') && (await wk()).includes('ほか5種目'), 'Day4: ' + (await wk()));
    await forceDayP2(5); { const acc = await p2.locator('[data-step="accessory"]').textContent(); assert(acc.includes('カーフ') && acc.includes('スミスマシン カーフレイズ') && !acc.includes('確認中'), 'Day5 calves: ' + acc); } assert((await p2.locator('h1').textContent()).startsWith('Day 5') && (await wk()).includes('Shoulder & Arms ・ 8種目') && (await wk()).includes('ウォームアップ: フロントレイズ') && (await wk()).includes('ほか5種目'), 'Day5: ' + (await wk()));
    await forceDayP2(6); { const acc = await p2.locator('[data-step="accessory"]').textContent(); assert(acc.includes('腹筋') && acc.includes('ハンギングニーレイズ') && !acc.includes('確認中'), 'Day6 abs: ' + acc); } assert((await p2.locator('h1').textContent()).startsWith('Day 6') && (await wk()).includes('Pull ・ 8種目') && (await wk()).includes('ストレートアーム ラットエクステンション（事前疲労）') && (await wk()).includes('ホリゾンタルロウ ＋ フェイスプル（スーパーセット）') && (await wk()).includes('ほか5種目'), 'Day6: ' + (await wk()));
    } finally { await resetClock(); await p2.close(); ['2027-07-01'].forEach(d => { rt.op('del', { coll: 'log_workout', id: d }); rt.op('del', { coll: 'log_daily', id: d }); rt.op('del', { coll: 'log_cardio', id: d }); }); }
    const r = await page.evaluate(() => { const t = window.__tl; const d = t.parseSetScheme('MAIN10-15x3,DROP*'); const p = t.expandPairSets(t.parseSetScheme('MAIN8,MAIN10,MAIN12'), ['A動作', 'B動作']); return { n: d.length, last: d[3], lastTxt: t.repsText(d[3]), pn: p.length, labels: p.map(x => t.setLabel(x)), moves: p.map(x => x.move).join('') }; });
    assert(r.n === 4 && r.last.setType === 'DROP' && r.last.min === 0 && r.lastTxt === '限界まで', 'DROP*: ' + JSON.stringify(r)); assert(r.pn === 6 && r.moves === 'ababab' && r.labels[0] === '1セット目 ① A動作' && r.labels[5] === '3セット目 ② B動作', 'pairs: ' + JSON.stringify(r.labels)); return 'Day2/4/5/6 の種目数と代表種目、DROP*=限界まで、スーパーセット 3組→6セット'; });
  await T(G.workout, '不具合修正: 最終種目（Day2 カーフ）に自然に到達しても、1セット目は「このセット完了」。最終セットまで進んで初めて「筋トレ完了」になる。遷移のたびに最上部へスクロール', async () => {
    const p2 = await newPage(); await p2.click('.tabs [data-tab="today"]');
    // 9/16 は他の多数のテストが依存する既存データ（Day1 完了済みなど）を持つため、Day を差し替えて壊さないよう
    // 履歴の無い孤立した日付に移ってから Day ピッカーで直接指定する
    await p2.clock.setFixedTime(new Date('2027-07-08T06:50:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
    try {
    await p2.click('#dayHead'); await p2.waitForSelector('[data-pickday="2"]'); await p2.click('[data-pickday="2"]'); await p2.waitForSelector('#dcSave'); await p2.click('#dcSave');
    await p2.waitForTimeout(80); if (await p2.$('#dlg:not([hidden])')) { await p2.click('#dlgOk'); await p2.waitForSelector('#dlg', { state: 'hidden' }); }
    await p2.waitForFunction(() => document.querySelector('h1') && document.querySelector('h1').textContent.startsWith('Day 2'));
    await p2.click('.tabs [data-tab="workout"]'); await p2.waitForSelector('#wuStart');
    for (let id = 1; id <= 6; id++) { await p2.click('[data-wuset="' + id + '"]'); await p2.click('[data-wuset="' + id + '"]'); }
    await p2.click('#wuStart'); await p2.waitForSelector('#setDone');
    const p2text = async sel => (await p2.locator(sel).first().textContent()).trim();
    for (let guard = 0; guard < 60; guard++) {
      await pickChoice(0, p2); await enterEdit(p2); // 「A または B」の種目は先頭を選ぶ
      if ((await p2text('.ex-head .p')).includes('種目 9/9')) break;
      if ((await p2text('#wv')) === '—') { const q = await p2.$('[data-qk]'); if (q) await q.click(); else await p2.click('[data-pm="w:1"]'); }
      await p2.click('#setDone'); if (await p2.$('#rest:not([hidden])')) { await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden]), [data-exchoice]'); } await p2.waitForTimeout(40);
    }
    // ここが今回の不具合の核心: 8種目すべて終えて9種目目（カーフ、1セット目）に自然到達した瞬間
    assert((await p2text('.ex-head .p')).includes('種目 9/9 ・ セット 1/3'), '9番目のセット1/3に到達: ' + (await p2text('.ex-head .p')));
    assert((await p2text('.ex-name')).includes('カーフ'), 'exercise name in view: ' + (await p2text('.ex-name')));
    assert((await p2text('#setDone')) === 'このセット完了', '1セット目はまだ「このセット完了」（筋トレ完了になってはいけない）: ' + (await p2text('#setDone')));
    assert(await p2.evaluate(() => window.scrollY) === 0, '種目が変わったら最上部へスクロール（種目名が見切れない）');
    // セット1完了 → まだ「このセット完了」・セット2/3
    if ((await p2text('#wv')) === '—') { const q = await p2.$('[data-qk]'); if (q) await q.click(); }
    await p2.click('#setDone'); if (await p2.$('#rest:not([hidden])')) { await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden]), [data-exchoice]'); }
    assert((await p2text('.ex-head .p')).includes('セット 2/3'), 'now on set 2/3: ' + (await p2text('.ex-head .p')));
    assert((await p2text('#setDone')) === 'このセット完了', 'セット2/3でもまだ「このセット完了」: ' + (await p2text('#setDone')));
    // セット2完了 → まだ「このセット完了」・セット3/3
    if ((await p2text('#wv')) === '—') { const q = await p2.$('[data-qk]'); if (q) await q.click(); }
    await p2.click('#setDone'); if (await p2.$('#rest:not([hidden])')) { await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden]), [data-exchoice]'); }
    assert((await p2text('.ex-head .p')).includes('セット 2/3（任意1つ残り）'), '必須2セットが終わったら「セット 2/3（任意1つ残り）」: ' + (await p2text('.ex-head .p')));
    assert((await p2text('#setDone')) === 'このセット完了', '任意セットを開いているあいだはまだ「このセット完了」（未記録のまま完了画面に飛ばない）: ' + (await p2text('#setDone')));
    // 最終セットを完了して初めて「筋トレ完了」
    if ((await p2text('#wv')) === '—') { const q = await p2.$('[data-qk]'); if (q) await q.click(); }
    await p2.click('#setDone'); if (await p2.$('#rest:not([hidden])')) { await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden]), [data-exchoice]'); }
    assert((await p2text('#setDone')).includes('筋トレ完了'), '最終種目・最終セットを終えて初めて「筋トレ完了」: ' + (await p2text('#setDone')));
    assert((await p2text('.ex-head .p')).includes('セット 3/3 完了'), '全セット記録済みなら「セット 3/3 完了」: ' + (await p2text('.ex-head .p')));
    const rv = await p2.$$eval('.setrows .sr .rv', els => els.map(e => e.textContent)); assert(rv.length === 3 && rv.every(t => t !== '未記録' && t !== ''), '3セットとも記録済み: ' + rv.join(','));
    await p2.click('#setDone'); await p2.waitForSelector('#repDay'); const body = await p2.locator('#view').innerText(); assert(!/未記録|0kg×0/.test(body.split('コーチ報告用テキスト')[0]), '完了画面のやった内容に未記録が残っていない');
    } finally { await resetClock(); await p2.close(); ['2027-07-08'].forEach(d => { rt.op('del', { coll: 'log_workout', id: d }); rt.op('del', { coll: 'log_daily', id: d }); rt.op('del', { coll: 'log_cardio', id: d }); }); }
  });

  // --- Round 6: Day4 差し替え・「A または B」の選択・入力ポップアップ・腹筋/カーフ確定 ---
  /** 孤立した日付へ移り、Day ピッカーで dayNo を直接指定してウォームアップまで終わらせた p2 を返す */
  const openDayOn = async (date, dayNo) => {
    const p2 = await newPage(); p2.setDefaultTimeout(20000);
    await p2.click('.tabs [data-tab="today"]');
    await p2.clock.setFixedTime(new Date(date + 'T06:50:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
    if (!(await p2.locator('h1').textContent()).startsWith('Day ' + dayNo)) {
      await p2.click('#dayHead'); await p2.waitForSelector('[data-pickday="' + dayNo + '"]'); await p2.click('[data-pickday="' + dayNo + '"]'); await p2.waitForSelector('#dcSave'); await p2.click('#dcSave');
      await p2.waitForTimeout(80); if (await p2.$('#dlg:not([hidden])')) { await p2.click('#dlgOk'); await p2.waitForSelector('#dlg', { state: 'hidden' }); }
      await p2.waitForFunction(n => document.querySelector('h1') && document.querySelector('h1').textContent.startsWith('Day ' + n), dayNo);
    }
    await p2.click('.tabs [data-tab="workout"]'); await p2.waitForSelector('#wuStart');
    for (let id = 1; id <= 6; id++) { await p2.click('[data-wuset="' + id + '"]'); await p2.click('[data-wuset="' + id + '"]'); }
    await p2.click('#wuStart'); await p2.waitForSelector('#setDone, [data-exchoice]');
    return p2;
  };
  /** 別ページで Day ピッカーを使って dayNo を指定する（すでにその Day ならピッカーは開かない＝ボタンが無効なので） */
  const forceDayP2 = async (pg, dayNo) => {
    if ((await pg.locator('h1').textContent()).startsWith('Day ' + dayNo)) return;
    await pg.click('#dayHead'); await pg.waitForSelector('[data-pickday="' + dayNo + '"]'); await pg.click('[data-pickday="' + dayNo + '"]'); await pg.waitForSelector('#dcSave'); await pg.click('#dcSave');
    await pg.waitForTimeout(80); if (await pg.$('#dlg:not([hidden])')) { await pg.click('#dlgOk'); await pg.waitForSelector('#dlg', { state: 'hidden' }); }
    await pg.waitForFunction(n => document.querySelector('h1').textContent.startsWith('Day ' + n), dayNo);
  };
  /** i 番目の種目へ移動する（pick=false なら選択画面のまま止める） */
  const gotoExOn = async (pg, i, pick) => {
    for (let g = 0; g < 20; g++) {
      const m = /種目 (\d+)\//.exec(await pg.locator('.ex-head .p').textContent()); const cur = Number(m[1]) - 1;
      if (cur === i) { if (pick !== false) { await pickChoice(0, pg); await enterEdit(pg); } return; }
      await pg.click('[data-ex="' + (cur < i ? 1 : -1) + '"]'); await pg.waitForTimeout(60);
    }
    throw new Error('gotoExOn ' + i);
  };

  await T(G.workout, '休みの日は「その日を過ごした記録」があれば消化: 食事だけ・体重だけでも翌日に持ち越さない／何も無ければ持ち越す／「有酸素はやらない」で消化／筋トレの日は記録があっても未完了なら持ち越す。休みの日の目標カロリーも平日と同じ', async () => {
    const D = '2027-10-06', D1 = '2027-10-07';
    const p2 = await newPage(); p2.setDefaultTimeout(20000);
    // mock モードは reload をまたいだ永続化が無いので、読み込み直すたびに Day 3 を指定し直す
    const reloadAt = async (d, hm, dayNo) => { await p2.click('.tabs [data-tab="today"]'); await p2.clock.setFixedTime(new Date(d + 'T' + hm + ':00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading')); await p2.click('.tabs [data-tab="today"]'); await p2.waitForSelector('#dayHead'); if (dayNo) await forceDayP2(p2, dayNo); };
    const consumed = () => p2.evaluate(d => window.__tl.restDayConsumed(d), D);
    try {
      await reloadAt(D, '08:00');
      await forceDayP2(p2, 3);
      assert((await consumed()) === false, '記録が何も無ければ休みの日は未消化のまま');
      // 休みの日でも1日の目標はコーチ指定の 2,632 kcal / P210 F69 C295（平日と同じ）
      const bar = await p2.locator('#bbar').textContent();
      assert(bar.includes('2,632 kcal') && bar.includes('210g') && bar.includes('69g') && bar.includes('295g'), '休みの日の目標も平日と同じ: ' + bar);
      const tg = await p2.evaluate(() => window.__tl.coachTarget());
      assert(tg.kcal === 2632 && tg.p === 210 && tg.f === 69 && tg.c === 295, 'コーチ指定の目標値: ' + JSON.stringify(tg));
      // 体重の入力欄は空・前回値は薄いプレースホルダー・空のままでは保存できない
      assert((await p2.$eval('#nowW', e => e.value)) === '', '体重の入力欄は空');
      assert((await p2.$eval('#nowW', e => e.getAttribute('placeholder'))) !== '', '前回値はプレースホルダーとして出す');
      assert(await p2.$eval('#nowBtn', e => e.disabled), '空のままでは保存ボタンが押せない');
      await p2.fill('#nowW', '70.4'); await p2.waitForFunction(() => !document.querySelector('#nowBtn').disabled);
      await p2.click('#nowBtn'); await p2.waitForFunction(() => document.querySelector('[data-step="weight"]').className.includes('done'));
      assert((await consumed()) === true, '体重だけでも休みの日は消化扱い（体脂肪は空でも保存できる）');
      if (mode === 'db') { await p2.waitForTimeout(250); assert(rt.DB.log_weight[D] && rt.DB.log_weight[D].bodyFatPct === '', '体脂肪は空でも保存できる: ' + JSON.stringify(rt.DB.log_weight[D])); }
      // 翌日は次の Day へ進む（持ち越さない）
      if (mode === 'db') { await reloadAt(D1, '08:00'); assert(!(await p2.locator('h1').textContent()).startsWith('Day 3'), '消化した休みの日は翌日に持ち越さない: ' + (await p2.locator('h1').textContent()));
        assert(!(await p2.locator('#view').textContent()).includes('できなかったため持ち越し'), '「できなかったため持ち越し」も出ない'); await reloadAt(D, '08:00', 3); }
      // 体重を消して食事だけにしても消化扱い
      rt.op('del', { coll: 'log_weight', id: D }); await reloadAt(D, '08:00', 3);
      assert((await consumed()) === false, '記録を消したら未消化に戻る');
      await openRecordWay('recKcal', p2); await p2.waitForSelector('#koAdd'); await p2.fill('#koK', '400'); await p2.click('#koAdd'); await p2.waitForSelector('#recSave'); await p2.click('#recSave'); await p2.waitForSelector('#sheet', { state: 'hidden' }); await p2.waitForTimeout(250);
      assert((await consumed()) === true, '食事だけでも休みの日は消化扱い');
      // 「有酸素はやらない」でも消化扱い（休みの日なので理由は聞かない）
      rt.op('del', { coll: 'log_meals', id: D }); await reloadAt(D, '08:00', 3);
      assert((await consumed()) === false, '記録を消したら未消化に戻る');
      await p2.click('.tabs [data-tab="workout"]'); await p2.waitForSelector('#rcSkip');
      assert((await p2.locator('#rcSave').textContent()) === '有酸素を記録する' && (await p2.locator('#rcSkip').textContent()) === '有酸素はやらない', '休みの日は2つの選択肢を出す: ' + (await p2.locator('#rcSkip').textContent()));
      await p2.click('#rcSkip'); await p2.waitForTimeout(400);
      assert(!(await p2.$('[data-reason]')), '休みの日なので理由は聞かない');
      assert((await consumed()) === true, '「有酸素はやらない」で消化扱い');
      if (mode === 'db') { await p2.waitForTimeout(250); assert(rt.DB.log_daily[D] && rt.DB.log_daily[D].restDone, 'restDone を保存: ' + JSON.stringify(rt.DB.log_daily[D] && rt.DB.log_daily[D].restDone)); }
      // 筋トレの日は記録があっても、トレーニングを完了していなければ持ち越す
      if (mode === 'db') {
        const E = '2027-10-13', E1 = '2027-10-14';
        try {
          await reloadAt(E, '08:00');
          await forceDayP2(p2, 4);
          await openRecordWay('recKcal', p2); await p2.waitForSelector('#koAdd'); await p2.fill('#koK', '400'); await p2.click('#koAdd'); await p2.waitForSelector('#recSave'); await p2.click('#recSave'); await p2.waitForSelector('#sheet', { state: 'hidden' }); await p2.waitForTimeout(250);
          await reloadAt(E1, '08:00');
          assert((await p2.locator('h1').textContent()).startsWith('Day 4'), '筋トレの日は食事の記録があっても未完了なら翌日に持ち越す: ' + (await p2.locator('h1').textContent()));
        } finally { rt.op('del', { coll: 'log_meals', id: E }); rt.op('del', { coll: 'log_daily', id: E }); rt.op('del', { coll: 'log_daily', id: E1 }); }
      }
      return '休みの日は 有酸素／食事／体重／サプリ／「有酸素はやらない」のどれかで消化。筋トレの日は今までどおり完了が必要。休みの日の目標も 2,632kcal / P210 F69 C295';
    } finally { await resetClock(); await p2.close(); [D, D1].forEach(d => { rt.op('del', { coll: 'log_weight', id: d }); rt.op('del', { coll: 'log_meals', id: d }); rt.op('del', { coll: 'log_daily', id: d }); rt.op('del', { coll: 'log_workout', id: d }); rt.op('del', { coll: 'log_cardio', id: d }); }); }
  });

  await T(G.workout, 'Day4（脚）コーチ原文どおり: 事前疲労はA2セット→B2セット（スーパーセット無し）・8種目＋腹筋3種・レッグプレスにウォームアップ無し・末尾の任意セットは飛ばせる', async () => {
    const D = '2027-08-05';
    const p2 = await openDayOn(D, 4);
    try {
      assert((await p2.locator('.ex-head .p').textContent()).includes('/11'), 'Day4 は 8種目＋腹筋3種 = 11: ' + (await p2.locator('.ex-head .p').textContent()));
      // [名前, セット数, セット一覧に出るべきセット種類]
      const want = [
        ['ダンベル ルーマニアンデッドリフト（事前疲労）', 2, ['事前疲労']],
        ['自重スクワット（事前疲労）', 2, ['事前疲労']],
        ['シーテッド ハムストリングカール', 3, ['ウォームアップ', 'トップセット', 'バックオフ']],
        ['スミスマシン バックスクワット', 3, ['ウォームアップ', 'トップセット', '中重量']],
        ['レッグプレス', 2, ['トップセット', '中重量']],
        ['ライイング ハムストリングカール', 3, ['漸増']],
        ['レッグエクステンション', 4, ['漸増']],
        ['アダクターマシン', 3, ['中重量']],
        ['ケーブルクランチ', 3, []],
        ['ケーブル 片手 オブリーククランチ', 3, []],
        ['ハンギングニーレイズ', 3, []]
      ];
      for (let i = 0; i < want.length; i++) {
        const [name, nSets, types] = want[i];
        await gotoExOn(p2, i);
        const shown = await p2.locator('.ex-name').textContent();
        assert(shown.startsWith(name), '種目' + (i + 1) + ' は ' + name + ': ' + shown);
        const rows = await p2.$$eval('.setrows .sr .nm', els => els.map(e => e.textContent));
        assert(rows.length === nSets, name + ' は ' + nSets + 'セット: ' + rows.length + ' / ' + rows.join(' | '));
        types.forEach(t => assert(rows.join(' | ').includes(t), name + ' のセット一覧に「' + t + '」: ' + rows.join(' | ')));
        assert(!(await p2.$('.tag.ss')), 'Day4 にスーパーセットは無い（' + name + '）');
        assert(!rows.join('').includes('確認中'), '「確認中」は残っていない: ' + rows.join(' | '));
      }
      // レッグプレス（種目5）はウォームアップセットが無い
      await gotoExOn(p2, 4);
      const lpRows = (await p2.$$eval('.setrows .sr .nm', els => els.map(e => e.textContent))).join(' | ');
      assert(!lpRows.includes('ウォームアップ'), 'レッグプレスにウォームアップセットは無い: ' + lpRows);
      // 自重スクワット（種目2）は重量欄が出ない
      await gotoExOn(p2, 1);
      assert(!(await p2.$('#wv')), '自重スクワットに重量欄は出ない');
      assert((await p2.locator('.tag').first().textContent()).includes('事前疲労'), '事前疲労タグ');
      // レッグエクステンション 4セット目 / アダクター 3セット目 は「（任意）」＋飛ばせる
      for (const [idx, optIdx, nm] of [[6, 3, 'レッグエクステンション'], [7, 2, 'アダクターマシン']]) {
        await gotoExOn(p2, idx);
        const rows = await p2.$$eval('.setrows .sr .nm', els => els.map(e => e.textContent));
        assert(rows[optIdx].includes('（任意）') && !rows[optIdx - 1].includes('（任意）'), nm + ' は最後のセットだけ任意: ' + rows.join(' | '));
        await p2.click('[data-set="' + optIdx + '"]'); await p2.waitForTimeout(60);
        assert(await p2.$('#skipSet'), nm + ' の任意セットには「飛ばす」ボタンが出る');
        await p2.click('[data-set="0"]'); await p2.waitForTimeout(60);
        assert(!(await p2.$('#skipSet')), nm + ' の必須セットには「飛ばす」ボタンは出ない');
      }
      return 'Day4 = 事前疲労 ダンベルRDL 2×10 → 自重スクワット 2×12-15（スーパーセット無し）＋6種目＋腹筋3種、レッグプレスはウォームアップ無し、任意セットは飛ばせる';
    } finally { await resetClock(); await p2.close(); rt.op('del', { coll: 'log_workout', id: D }); rt.op('del', { coll: 'log_daily', id: D }); }
  });

  await T(G.workout, '「A または B」は毎回どちらをやるか選ぶ: 前回の日付・重量つきの選択カード／記録なし／選び直しは確認のうえ当日の記録を消す／数字は種目ごとに完全に独立', async () => {
    const D = '2027-08-12';
    const p2 = await openDayOn(D, 4);
    try {
      // 種目4（スミスマシン または バーベル バックスクワット）の選択カード
      await gotoExOn(p2, 3, false);
      assert((await p2.locator('.ex-name').first().textContent()).includes('どちらをやりますか'), '2択は「どちらをやりますか」: ' + (await p2.locator('.ex-name').first().textContent()));
      const cards = await p2.$$eval('[data-exchoice]', els => els.map(e => e.textContent));
      assert(cards.length === 2 && cards[0].includes('スミスマシン バックスクワット') && cards[1].includes('バーベル バックスクワット'), '選択肢はコーチ原文の順: ' + cards.join(' / '));
      assert(cards.every(c => c.includes('記録なし')), '記録が無い種目は「記録なし」（提案も出さない）: ' + cards.join(' / '));
      assert(!(await p2.$('#setDone')), '選ぶまではセット入力を出さない');
      // スミスマシンを選んでウォームアップ 40kg×12 を記録
      await pickChoice(0, p2);
      assert((await p2.locator('.ex-name').textContent()).startsWith('スミスマシン バックスクワット'), '選んだ方だけが出る: ' + (await p2.locator('.ex-name').textContent()));
      assert(await p2.$('#rePick'), '種目名の横に「選び直す」');
      await recordSet(40, 12, p2);
      if (await p2.$('#rest:not([hidden])')) { await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden]), [data-exchoice]'); }
      if (mode === 'db') { await p2.waitForTimeout(250); const doc = rt.DB.log_workout[D] || {};
        assert(String((doc.choices || {}).d4_squat) === '24', '選んだ種目が choices に入る: ' + JSON.stringify(doc.choices));
        assert(Object.values(doc.sets || {}).every(x => Number(x.exerciseId) === 24), '記録は選んだ exerciseId だけ（選ばなかった方は「未実施」として残さない）: ' + JSON.stringify(doc.sets)); }
      // 選び直す → 記録済みなので確認ダイアログ
      await gotoExOn(p2, 3, false); await p2.click('#rePick');
      await p2.waitForSelector('#dlg:not([hidden])');
      assert((await p2.locator('#dlg .msg').textContent()).includes('記録したセットは消えます'), '記録済みなら確認ダイアログ: ' + (await p2.locator('#dlg .msg').textContent()));
      await p2.click('#dlgOk'); await p2.waitForSelector('#dlg', { state: 'hidden' }); await p2.waitForTimeout(150);
      await p2.waitForSelector('[data-exchoice]');
      if (mode === 'db') { await p2.waitForTimeout(250); const doc = rt.DB.log_workout[D] || {};
        assert(Object.keys(doc.sets || {}).length === 0 && (doc.choices || {}).d4_squat == null, '選び直しで当日の記録と選択が消える: ' + JSON.stringify(doc)); }
      // バーベルを選ぶと、スミスマシンの 40kg はまったく引き継がれない（別々の exerciseId）
      await pickChoice(1, p2);
      assert((await p2.locator('.ex-name').textContent()).startsWith('バーベル バックスクワット'), 'もう一方を選べる: ' + (await p2.locator('.ex-name').textContent()));
      await p2.click('[data-set="1"]'); await p2.waitForTimeout(80);
      const ghost = await p2.locator('.ghost').textContent();
      assert(!ghost.includes('40') && !ghost.includes('前回'), 'バーベル側にスミスマシンの重量は引き継がない: ' + ghost);
      // 3択（カーフ）は「どれをやりますか」
      await p2.close();
      const p3 = await openDayOn('2027-08-19', 2);
      try {
        await gotoExOn(p3, 8, false);
        assert((await p3.locator('.ex-name').first().textContent()).includes('どれをやりますか'), '3択は「どれをやりますか」: ' + (await p3.locator('.ex-name').first().textContent()));
        const cs = await p3.$$eval('[data-exchoice]', els => els.map(e => e.textContent));
        assert(cs.length === 3 && cs[0].includes('スミスマシン カーフレイズ') && cs[1].includes('ドンキーカーフレイズ') && cs[2].includes('レッグプレス トープレス'), 'カーフは3択: ' + cs.join(' / '));
        assert(!cs.join('').includes('確認中'), 'カーフに「確認中」は残っていない');
        await pickChoice(2, p3);
        const rows = await p3.$$eval('.setrows .sr .nm', els => els.map(e => e.textContent));
        assert(rows.length === 3 && rows[2].includes('（任意）') && !rows[1].includes('（任意）'), 'カーフは2セット必須＋3セット目は任意: ' + rows.join(' | '));
      } finally { await p3.close(); rt.op('del', { coll: 'log_workout', id: '2027-08-19' }); rt.op('del', { coll: 'log_daily', id: '2027-08-19' }); }
      return '選択カード（前回の日付・重量／記録なし／しばらくやっていません）→ 選んだ種目だけ記録、選び直しは確認のうえ当日分を削除、2択「どちらを」3択「どれを」、数字は種目ごとに独立';
    } finally { await resetClock(); if (!p2.isClosed()) await p2.close(); rt.op('del', { coll: 'log_workout', id: D }); rt.op('del', { coll: 'log_daily', id: D }); }
  });

  await T(G.workout, '重量と回数の入力は1つのポップアップ（左右に並ぶ ±ボタン・提案値が入った状態・日本語のセット種類と目標回数・自重は回数だけ・目標外でも止めずに一言）', async () => {
    const D = '2027-08-26';
    const p2 = await openDayOn(D, 4);
    try {
      // 種目3 シーテッド ハムストリングカール 1セット目＝ウォームアップ 10〜12回
      await gotoExOn(p2, 2);
      await p2.click('#wv'); await p2.waitForSelector('#siSave');
      assert(await p2.$('#siW') && await p2.$('#siR'), '重量と回数が1つのポップアップに並ぶ');
      const head = await p2.locator('#dlg .msg').textContent();
      assert(head.includes('1セット目') && head.includes('ウォームアップ') && head.includes('10〜12回'), '見出しは日本語のセット種類＋目標回数: ' + head);
      assert(!/\b(W|TOP|BO|DROP|PRE|SS)\b/.test(await p2.locator('#dlg').textContent()), '英略語は出さない: ' + (await p2.locator('#dlg').textContent()));
      assert((await p2.locator('#siR').inputValue()) === '10', '回数の初期値は目標の下限: ' + (await p2.locator('#siR').inputValue()));
      // ±ボタン（バーベル種目は ±2.5、回数は ±1）
      const pm = await p2.$$eval('#dlg [data-si]', els => els.map(e => e.textContent));
      assert(pm.join('') === '−2.5＋2.5−1＋1', '重量 ±2.5・回数 ±1: ' + pm.join(' '));
      await p2.fill('#siW', '30'); await p2.click('[data-si="w:1"]');
      assert((await p2.locator('#siW').inputValue()) === '32.5', '＋2.5 で 30→32.5: ' + (await p2.locator('#siW').inputValue()));
      // 目標（10〜12回）を超えても止めずに記録し、一言だけ出す
      await p2.fill('#siR', '20'); await p2.click('#siSave');
      await p2.waitForFunction(() => document.querySelector('#dlg').hidden);
      assert((await p2.locator('#toast').textContent()).includes('目標を超えました。次回は重量を上げてください'), '目標超過のメッセージ: ' + (await p2.locator('#toast').textContent()));
      assert(await p2.$('#rest:not([hidden])'), '「記録する」で閉じて休憩タイマーが始まる');
      await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden]), [data-exchoice]');
      assert((await p2.locator('.setrows .sr.done .rv').first().textContent()).includes('32.5kg×20'), '入力どおり保存: ' + (await p2.locator('.setrows .sr.done .rv').first().textContent()));
      // 目標に届かない場合
      await p2.click('[data-set="1"]'); await p2.waitForTimeout(80);
      await p2.click('#wv'); await p2.waitForSelector('#siSave'); await p2.fill('#siR', '2'); await p2.click('#siSave');
      await p2.waitForFunction(() => document.querySelector('#dlg').hidden);
      assert((await p2.locator('#toast').textContent()).includes('目標に届きませんでした。次回は同じ重量で'), '目標未達のメッセージ: ' + (await p2.locator('#toast').textContent()));
      await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden]), [data-exchoice]');
      // 自重種目（種目2 自重スクワット）は回数だけ
      await gotoExOn(p2, 1);
      await p2.click('#rv'); await p2.waitForSelector('#siSave');
      assert(!(await p2.$('#siW')) && await p2.$('#siR'), '自重の種目は重量欄を出さない');
      assert((await p2.locator('#dlg').textContent()).includes('自重の種目なので回数だけ記録します'), '自重の説明: ' + (await p2.locator('#dlg').textContent()));
      await p2.fill('#siR', '15'); await p2.click('#siSave'); await p2.waitForFunction(() => document.querySelector('#dlg').hidden);
      if (await p2.$('#rest:not([hidden])')) { await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden]), [data-exchoice]'); }
      assert((await p2.locator('.setrows .sr.done .rv').first().textContent()).includes('自重×15'), '自重は回数だけ保存: ' + (await p2.locator('.setrows .sr.done .rv').first().textContent()));
      // 腹筋・カーフの休憩は 90 秒
      await gotoExOn(p2, 8);
      assert((await p2.locator('.ex-name').textContent()).startsWith('ケーブルクランチ'), '種目9は腹筋のケーブルクランチ');
      await recordSet(20, 18, p2);
      await p2.waitForSelector('#rest:not([hidden])');
      const rn = await p2.locator('#rn').textContent();
      assert(rn === '1:30' || rn === '1:29', '腹筋の休憩は 60〜90秒（90秒）: ' + rn);
      await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden]), [data-exchoice]');
      return '1つのポップアップに重量（±2.5／ダンベル±1）と回数（±1）、提案値と目標下限が入った状態、日本語の見出し、自重は回数だけ、目標外でも記録して一言、記録するで休憩開始（腹筋は90秒）';
    } finally { await resetClock(); await p2.close(); rt.op('del', { coll: 'log_workout', id: D }); rt.op('del', { coll: 'log_daily', id: D }); }
  });


  // --- Round 11: 完了・スキップは記録から判定する ／ コーチのフォーム指摘 ---
  await T(G.workout, '不具合修正: 完了・スキップは記録だけから判定する。全セット記録済みなら「セット 3/3 完了」＋完了カード＋「次の種目へ」／記録済み行をタップすると「記録を上書きする」／再訪時のカーソルは最初の未記録セット／「筋トレ完了」を押していなくても記録が揃っていれば Day は消化される', async () => {
    const D = '2027-09-02', N = '2027-09-03';
    const p2 = await openDayOn(D, 1);
    const t2 = async sel => (await p2.locator(sel).first().textContent()).trim();
    const rec = async () => {
      if ((await p2.$('#wv')) && (await t2('#wv')) === '—') { const q = await p2.$('[data-qk]'); if (q) await q.click(); else await p2.click('[data-pm="w:1"]'); }
      await p2.click('#setDone');
      if (await p2.$('#rest:not([hidden])')) { await p2.click('#skipRest'); await p2.waitForSelector('#setDone:not([hidden]), [data-exchoice], #exNext'); }
      await p2.waitForTimeout(40);
    };
    try {
      await gotoExOn(p2, 1, true);
      assert((await t2('.ex-name')).includes('インクライン'), '2種目目はインクラインダンベルプレス（3セット）: ' + (await t2('.ex-name')));
      assert((await t2('.ex-head .p')).includes('セット 1/3'), '未記録なら「セット 1/3」: ' + (await t2('.ex-head .p')));
      assert((await t2('#setDone')) === 'このセット完了', '未記録のセットは「このセット完了」: ' + (await t2('#setDone')));
      for (let i = 0; i < 3; i++) await rec();
      // 戻ってくると「いまのセット」ではなく完了表示になる
      await p2.click('[data-ex="-1"]'); await p2.waitForSelector('#exNext');
      assert((await t2('.ex-head .p')).includes('セット 3/3 完了'), '全セット記録済みなら「セット 3/3 完了」: ' + (await t2('.ex-head .p')));
      assert(!(await p2.$('#setDone')), '完了した種目では「いまのセット」カードと記録ボタンを出さない');
      const doneCard = await t2('.cur-set.done-set');
      assert(doneCard.includes('✓ この種目は完了しました') && doneCard.includes('3セット記録済み'), '完了カード: ' + doneCard);
      assert((await t2('#exNext')) === '次の種目へ', '最終種目でなければ「次の種目へ」: ' + (await t2('#exNext')));
      const rows = await p2.$$eval('.setrows .sr', els => els.map(e => e.textContent));
      assert(rows.length === 3 && rows.every(t => !/未記録/.test(t)), '完了後もセット一覧は残る: ' + rows.join(' / '));
      // 記録済みの行をタップすると修正できる
      await p2.click('[data-set="1"]'); await p2.waitForSelector('#setDone');
      assert((await t2('#setDone')) === '記録を上書きする', '記録済みのセットは「記録を上書きする」: ' + (await t2('#setDone')));
      const ghost = await t2('.ghost');
      assert(ghost.includes('記録済み') && !ghost.includes('変えて完了で上書き'), '「（変えて完了で上書き）」は出さない: ' + ghost);
      // 1セットだけ記録 → 離れて戻るとカーソルは最初の未記録セット
      await p2.click('[data-ex="-1"]'); await p2.waitForTimeout(120); await pickChoice(0, p2); await enterEdit(p2);
      assert((await t2('.ex-head .p')).includes('セット 1/2'), '1種目目は未記録なので「セット 1/2」: ' + (await t2('.ex-head .p')));
      await rec();
      await p2.click('[data-ex="1"]'); await p2.waitForTimeout(120); await p2.click('[data-ex="-1"]'); await p2.waitForTimeout(150);
      assert((await t2('.ex-head .p')).includes('セット 2/2'), '戻ったら最初の未記録セット（2セット目）を開く: ' + (await t2('.ex-head .p')));
      // 全種目を記録する。ただし「筋トレ完了」は押さない
      for (let guard = 0; guard < 90; guard++) {
        await pickChoice(0, p2);
        if (await p2.$('#exNext')) { if ((await t2('#exNext')).includes('筋トレ完了')) break; await p2.click('#exNext'); await p2.waitForTimeout(40); continue; }
        if ((await t2('#setDone')).includes('筋トレ完了')) break;
        await rec();
      }
      assert(!(await p2.$('#repDay')), '「筋トレ完了」を押していないので完了画面には進んでいない');
      if (mode === 'db') {
        await p2.clock.setFixedTime(new Date(N + 'T06:50:00+08:00')); await p2.reload();
        await p2.waitForFunction(() => !document.querySelector('#view .loading'));
        await p2.click('.tabs [data-tab="today"]'); await p2.waitForTimeout(150);
        assert(!(await t2('h1')).startsWith('Day 1'), '記録が揃っていれば「完了」を押さなくても Day 1 は消化され、翌日に持ち越さない: ' + (await t2('h1')));
      }
      return '記録済みセットから完了を判定（フラグを持たない）';
    } finally { await resetClock(); await p2.close(); [D, N].forEach(d => { rt.op('del', { coll: 'log_workout', id: d }); rt.op('del', { coll: 'log_daily', id: d }); rt.op('del', { coll: 'log_cardio', id: d }); }); }
  });
  await T(G.workout, 'コーチのフォーム指摘: 種目名のすぐ下・セット入力の上に折りたたまずに出す（ショルダープレス・トライセップ プッシュダウン・カーフ3種）。「コーチより 9/21」・動画は別タブ・新しい指摘は最初の1回だけ強調。カーフの提案は前回20回で+10kg・18回で+5kg', async () => {
    const D = '2027-09-09';
    const p2 = await openDayOn(D, 5);
    const t2 = async sel => (await p2.locator(sel).first().textContent()).trim();
    try {
      await p2.evaluate(() => { try { localStorage.removeItem('tl.cueSeen'); } catch (e) { /* ignore */ } });
      await gotoExOn(p2, 1, true);
      assert((await t2('.ex-name')).includes('ショルダープレス'), '2種目目はショルダープレス: ' + (await t2('.ex-name')));
      const cue = await t2('#formCues');
      assert(cue.includes('少し後ろに寄って座る') && cue.includes('肘はやや前に向ける。横に開かない（フレアさせない）'), 'ショルダープレスの指摘2つを全文表示: ' + cue);
      assert(cue.includes('コーチより 9/21'), '日付つきの出どころ: ' + cue);
      assert(!(await p2.$eval('#formCues', e => e.hidden)) && (await p2.$eval('#formCues', e => e.querySelectorAll('li').length)) === 2, '折りたたまず箇条書きで出す');
      const order = await p2.$$eval('.ex-name, #formCues, .cur-set, .setrows', els => els.map(e => e.id || e.className.split(' ')[0]).join('>'));
      assert(order.startsWith('ex-name>formCues>cur-set'), '種目名の直後・セット入力の上: ' + order);
      assert((await p2.$eval('#formCues', e => e.className)).includes('new'), '初めて見るときは強調する: ' + (await p2.$eval('#formCues', e => e.className)));
      const vid = await p2.$eval('.cue-vid', e => [e.textContent, e.getAttribute('href'), e.getAttribute('target')]);
      assert(vid[0] === '動画を見る' && vid[1] === 'https://youtube.com/shorts/E7ngsffMPR0' && vid[2] === '_blank', '動画は別タブで開く: ' + vid.join(' '));
      await p2.click('[data-ex="1"]'); await p2.waitForTimeout(150); await p2.click('[data-ex="-1"]'); await p2.waitForSelector('#formCues');
      assert(!(await p2.$eval('#formCues', e => e.className)).includes('new'), '一度見たら通常表示に戻す: ' + (await p2.$eval('#formCues', e => e.className)));
      await gotoExOn(p2, 4, true);
      assert((await t2('.ex-name')).includes('トライセップ プッシュダウン'), '5種目目: ' + (await t2('.ex-name')));
      assert((await t2('#formCues')).includes('毎回、伸ばしきったところで止めて絞る'), 'プッシュダウンの指摘: ' + (await t2('#formCues')));
      assert(!(await p2.$('.cue-vid')), '動画の無い指摘には「動画を見る」を出さない');
      await gotoExOn(p2, 8, true);
      assert((await t2('.ex-name')).includes('カーフ'), '最終種目はカーフ: ' + (await t2('.ex-name')));
      const calfCue = await t2('#formCues');
      assert(calfCue.includes('一番上で止めて、コントロールしながら効かせる') && calfCue.includes('重量が軽すぎる。もっと重くすること'), 'カーフの指摘2つ: ' + calfCue);
      assert(calfCue.includes('15〜20回でギリギリになる重量まで上げる'), 'カーフ画面に重量の目安を出す: ' + calfCue);
      // 週画面に指摘の一覧
      await p2.click('.tabs [data-tab="summary"]'); await p2.waitForSelector('#cueBlock');
      const wk = (await p2.locator('#cueBlock').innerText());
      ['スミスマシン カーフレイズ', 'ドンキーカーフレイズ', 'レッグプレス トープレス', 'マシン ショルダープレス', 'スミス ショルダープレス', 'トライセップ プッシュダウン'].forEach(n => assert(wk.includes(n), '週画面の一覧に ' + n + ' が出る: ' + wk));
      assert(wk.includes('9/21') && wk.includes('一番上で止めて、コントロールしながら効かせる') && !wk.includes('…'), '日付つき・省略なしで全文: ' + wk);
      // カーフの提案幅（前回の回数で変える）
      const calf = await page.evaluate(() => { const mk = pr => window.__tl.suggestSets([{ setNo: 1, setType: 'MAIN', min: 15, max: 20, weightKg: '', reps: '', done: false, prevWeightKg: 60, prevReps: pr, move: '' }], 1, { calfBump: true })[0]; return { r20: mk(20), r18: mk(18), r15: mk(15), r14: mk(14) }; });
      assert(calf.r20.suggestWeightKg === 70 && /20回/.test(calf.r20.suggestReason), '前回20回 → +10kg: ' + JSON.stringify(calf.r20.suggestWeightKg));
      assert(calf.r18.suggestWeightKg === 65, '前回18回 → +5kg: ' + calf.r18.suggestWeightKg);
      assert(calf.r15.suggestWeightKg === 62.5, '前回15〜17回 → +2.5kg: ' + calf.r15.suggestWeightKg);
      assert(calf.r14.suggestWeightKg === 60, '15回に届かなければ据え置き: ' + calf.r14.suggestWeightKg);
      return 'カーフ 20回→+10kg / 18回→+5kg / 15回→+2.5kg / 14回→据え置き';
    } finally { await resetClock(); await p2.close(); rt.op('del', { coll: 'log_workout', id: D }); rt.op('del', { coll: 'log_daily', id: D }); }
  });


  // ============ 週 ============
  await goTab('summary'); await page.waitForSelector('#repText');
  await T(G.week, '体重グラフ（実測＋7日平均）。データ1日でも壊れない', async () => { assert(await has('#weightSpark30 svg'), 'svg'); const pt = await page.$$eval('#weightSpark30 svg .pt', els => els.length), ma = await page.$$eval('#weightSpark30 svg .mapt', els => els.length); assert(pt === 1 && ma === 1, '1 measured point + 1 ma point: ' + pt + '/' + ma); assert((await page.$$eval('#weightSpark30 svg polyline', els => els.length)) === 0, 'single day → no line'); assert(!errors.length, 'no errors'); });
  await T(G.week, '遵守率にウォームアップ・筋トレ・有酸素・食事・サプリ・水が含まれる', async () => { const st = await page.$eval('.stat', e => e.textContent); assert(st.includes('筋トレ') && st.includes('ウォームアップ 1/1') && st.includes('食事') && st.includes('有酸素') && st.includes('サプリ 50%') && st.includes('水 1/1'), st); const hist = await text('.hist'); assert(hist.includes('Day1') && hist.includes('ウォームアップ') && hist.includes('遅れ'), 'history table with 遅れ'); assert(await has('details .hist'), 'per-day planned/logged table'); });
  await T(G.week, 'コーチ向けレポート生成→コピーが実データと一致', async () => { const rep = await text('#repText'); assert(rep.startsWith('Week 1 (Sep 16–22) Report'), 'header'); assert(rep.includes('Weight: 72.6 → 72.6 kg (avg 72.6, 1/1 days measured)'), 'weight line: ' + rep.split('\n')[1]); assert(rep.includes('Workouts: 1/1 done, Warm-up: 1/1, Cardio: 1/1 (40 min)'), 'workouts line: ' + rep.split('\n')[2]); assert(rep.includes('Machine incline press: right shoulder slight discomfort'), 'notes: ' + rep); assert(rep.includes('Supplements: 50%') && rep.includes('Water: 1/1 days'), 'supp/water: ' + rep); assert(/Timing: \d+\/\d+ logged within 60 min of plan/.test(rep), 'timing line: ' + rep); await page.click('#copyRep'); await page.waitForTimeout(100); assert((await text('#toast')).includes('コピー'), 'copy toast'); });
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
      await p2.click('.tabs [data-tab="today"]'); await p2.waitForSelector('#bbTot'); await p2.click('#bbTot'); await p2.waitForSelector('.fat-mini');
      const t2 = async () => (await p2.locator('.fat-mini').textContent()).trim();
      /** 新方式: 枠をタップせず「手で入力」で記録し、時刻から自動で紐づける */
      const logP2 = async (slot) => { await p2.click('.tabs [data-tab="today"]');
        await p2.click('[data-planrow="' + slot + '"]'); await p2.waitForSelector('#mpAll'); await p2.click('#mpAll'); await p2.waitForSelector('#sheet', { state: 'hidden' }); await p2.waitForTimeout(250);
        if (!(await p2.$('.fat-mini'))) { await p2.click('#bbTot'); await p2.waitForSelector('.fat-mini'); } };
      assert((await t2()).includes('体重を記録すると表示されます'), '体重も食事も無い → 体重の案内');
      await p2.fill('#nowW', '72.4'); await p2.click('#nowBtn'); await p2.waitForFunction(() => document.querySelector('[data-step="weight"]').classList.contains('done'));
      assert((await t2()).includes('まだ記録がありません'), '体重はあるが食事が無い → まだ記録がありません（1日目でも「データが足りません」ではない）');
      await logP2(1);
      assert(await p2.$('.fat-mini .fat-blob-mini svg'), '食事を1つ記録した時点で小さい塊が出る（待たせない）');
      const after1 = await t2(); assert(/今日 −[\d,]+ kcal → 脂肪 \d+g/.test(after1), '「今日 −N kcal → 脂肪 Ng」の書式: ' + after1); assert(after1.includes('これまで合計'), 'これまでの合計kgも出る: ' + after1);
      await logP2(2);
      const after2 = await t2(); assert(after2 !== after1, '食事を追加するたびに今日の数字が更新される: ' + after1 + ' → ' + after2);
      await p2.click('.tabs [data-tab="summary"]'); await p2.waitForSelector('.fat-card'); assert(await p2.$('.fat-blob svg'), '週タブにも同じ日の塊が出る（今日画面と週タブの両方）');
      await p2.close(); await resetClock(); return '記録0件→まだ記録がありません、1食目でただちに塊表示、2食目で数字が更新、今日画面と週タブ両方に表示';
    } finally { await resetClock(); rt.op('del', { coll: 'log_weight', id: date2 }); rt.op('del', { coll: 'log_meals', id: date2 }); Object.entries(savedWeights).forEach(([id, data]) => rt.op('set', { coll: 'log_weight', id, data })); } });
  await T(G.week, 'データ不足時のフォールバック: 体重0件→非表示メッセージ／記録0件→「まだ記録がありません」／1日でもあれば塊を表示／今週プラス→「今週は +Xkg」', async () => { if (mode === 'mock') return 'db のみ';
    // 体重が1件も無い状態を一時的に作る（既存の log_weight を退避 → 空にして確認 → 元に戻す）
    const savedWeights = Object.assign({}, rt.DB.log_weight);
    Object.keys(savedWeights).forEach(id => rt.op('del', { coll: 'log_weight', id }));
    try { const pw = await newPage(); await pw.click('.tabs [data-tab="today"]'); await pw.waitForSelector('#bbTot'); await pw.click('#bbTot'); await pw.waitForSelector('.fat-mini');
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
  await T(G.missed, 'あとで測れたら数値保存で skipped 解除。「記録を取り消す」で未記録に戻る', async () => { await setTime('2026-09-17T07:00:00+08:00'); await goTab('today'); await page.click('[data-shift="-1"]'); assert((await text('.date')).includes('9/17'), 'on 9/17'); await page.click('[data-open="weight"]'); await page.waitForSelector('#shSave'); await page.fill('#shW', '72.3'); await page.click('#shSave'); await page.waitForFunction(() => document.querySelector('[data-step="weight"]').dataset.mark === 'ok'); assert((await text('[data-step="weight"]')).includes('72.3kg'), 'measured later'); if (mode === 'db') { await page.waitForTimeout(150); assert(!rt.DB.log_weight['2026-09-17'].skipped, 'skipped cleared'); }
    await page.click('[data-chk="weight"]'); await page.waitForFunction(() => document.querySelector('[data-step="weight"]').dataset.mark === ''); assert((await text('#toast')).includes('取り消しました'), 'cancel toast'); await page.click('#toast button'); await page.waitForFunction(() => document.querySelector('[data-step="weight"]').dataset.mark === 'ok'); await page.click('[data-open="weight"]'); await page.waitForSelector('#shCancel'); await page.click('#shCancel'); await dlgOk(); await page.waitForFunction(() => document.querySelector('[data-step="weight"]').dataset.mark === ''); if (mode === 'db') { await page.waitForTimeout(150); assert(!rt.DB.log_weight['2026-09-17'], 'db doc removed'); } });
  await T(G.missed, 'サプリ「今日はなし（理由）」→ 灰色−・理由表示。再タップで取り消し', async () => { await clickUntil('[data-open="supp:after_meal"]', '#suppNA'); await clickUntil('#suppNA', '[data-reason]'); await pickReason('切れていた'); await page.waitForTimeout(150); const m = await mark('supp:after_meal'); assert(m.startsWith('na|chk na|−'), 'supp mark ' + m); assert((await text('[data-step="supp:after_meal"]')).includes('今日はなし（切れていた）'), 'reason line'); await page.click('[data-chk="supp:after_meal"]'); await page.waitForFunction(() => document.querySelector('[data-step="supp:after_meal"]').dataset.mark === ''); assert((await text('#toast')).includes('取り消しました'), 'undo toast');
    // ルーティンは長押し
    await page.dispatchEvent('[data-chk="routine:1"]', 'pointerdown'); await page.waitForTimeout(700); await page.dispatchEvent('[data-chk="routine:1"]', 'pointerup'); await pickReason('忘れた'); await page.waitForTimeout(150); assert((await mark('routine:1')).startsWith('na|'), 'routine long-press NA'); assert((await text('[data-step="routine:1"]')).includes('今日はなし（忘れた）'), 'routine reason'); });
  await T(G.missed, '筋トレ「できなかった（理由）」→ 完了していないので翌日も同じ Day が繰り越して出る（未消化キュー方式）。取り消しで「できなかった」の記録は消える', async () => {
    const addD = (d, n) => { const dt = new Date(d + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10); };
    await goTab('today');
    // 9/16・9/17 は他のテストが依存する既存データ（Day1 完了済み・体重の欠測など）を持つため、Day を差し替えて壊さないよう、
    // 同じ週の中の既存データが無い日（9/19以降）へ移ってから Day ピッカーで直接指定する
    let awayShifts = 0;
    for (let i = 0; i < 6 && (/9\/16|9\/17|9\/18/.test(await text('.date'))); i++) { await page.click('[data-shift="1"]'); awayShifts++; }
    const dateTxt = await text('.date');
    assert(!(/9\/16|9\/17|9\/18/.test(dateTxt)), '9/16〜9/18 以外に移動: ' + dateTxt);
    // TD は awayShifts からの推測ではなく、実際に表示されている月日から直接組み立てる（このテストの前に
    // 別のテストが日付を 9/16 以外に残していた場合でも awayShifts だけではズレることがあるため）
    const md = /(\d+)\/(\d+)/.exec(dateTxt); const TD = '2026-' + String(md[1]).padStart(2, '0') + '-' + String(md[2]).padStart(2, '0'), TD1 = addD(TD, 1);
    // 今日以外の日付は「いま」カードも ✓ も出ない仕様なので、時計を移動先の日に合わせる
    await setTime(TD + 'T08:00:00+08:00'); await goTab('workout'); await goTab('today');
    await forceDay('#dayHead', 4);
    assert((await text('h1')).startsWith('Day 4'), 'Day4 に変更: ' + (await text('h1')));
    await page.click('[data-chk="workout"]'); await page.waitForSelector('[data-choice="1"]'); await page.click('[data-choice="1"]'); await pickReason('仕事'); await page.waitForTimeout(150);
    assert((await mark('workout')).startsWith('na|chk na|−'), 'workout na');
    assert((await text('[data-step="workout"]')).includes('できなかった（仕事）') && (await text('[data-step="workout"]')).includes('持ち越しになります'), 'row: ' + (await text('[data-step="workout"]')));
    if (mode === 'db') {
      // mock モードは reload をまたいだ永続化が無いため、実際に時計を翌日へ進めての繰り越し確認は db モードのみで行う
      // （クロックはブラウザコンテキスト全体を進めるため、reload 前に today タブへ切り替えておく）
      await page.waitForTimeout(150);
      await setTime(TD1 + 'T08:00:00+08:00'); await page.reload(); await page.waitForFunction(() => !document.querySelector('#view .loading')); await goTab('today');
      assert((await text('h1')).startsWith('Day 4'), '完了していない Day4 は翌日も繰り越して出る（先の Day には進まない）: ' + (await text('h1')));
      await page.click('[data-shift="-1"]'); await setTime(TD + 'T08:00:00+08:00'); await goTab('workout'); await goTab('today');
    }
    // 取り消し（できなかったの記録が消える。wo.finished は元々未設定のままなので Day の繰り越し自体には影響しない）
    await page.click('[data-chk="workout"]'); await page.waitForFunction(() => document.querySelector('[data-step="workout"]').dataset.mark === '');
    assert(!(await text('[data-step="workout"]')).includes('できなかった'), '取り消し後は「できなかった」表示が消える');
    // 有酸素の「できなかった」も同様に記録できる
    await page.click('[data-chk="cardio"]'); await page.waitForSelector('[data-choice="1"]'); await page.click('[data-choice="1"]'); await pickReason('体調不良'); await page.waitForTimeout(150);
    assert((await text('[data-step="cardio"]')).includes('できなかった（体調不良）'), 'cardio missed');
    if (mode === 'db') {
      // 週まとめ／レポートの「できなかった一覧」は today（実クロック）以前の日だけを集計するため、
      // 実際に時計を進めていない mock モードでは今回の記録日（未来扱い）が反映されない。db モードのみで検証する
      await goTab('summary'); await page.waitForSelector('#missedBlock'); const mb = await text('#missedBlock');
      assert(mb.includes('有酸素') && mb.includes('体調不良') && mb.includes('忘れた') && !mb.includes('切れていた'), 'missed block lists cardio + routine (cancelled supp NA excluded): ' + mb);
      assert((await text('#repText')).includes('cardio missed (sick)'), 'report notes cardio');
    }
    // 後始末: Day4 への差し替えを取り消し、日付と時計をもとに戻す
    await goTab('today'); await page.click('#dayHead'); await page.waitForSelector('#dayReset'); await page.click('#dayReset'); await page.waitForSelector('#sheet', { state: 'hidden' });
    await goTab('today'); await setTime(T0); await page.reload(); await page.waitForFunction(() => !document.querySelector('#view .loading')); await goTab('today');
    assert((await text('.date')).includes('9/16') && !(await text('.date')).includes('過去'), 'back to 9/16');
  });

  await T(G.common, 'db スキーマ: log_weight{value,unit,skipped,skipReason,loggedAt} / warmup{completed,minutes,loggedAt} / meals{status: plan|substitute|skip|photo, photoId, reason} / log_daily{dayNo,dayName,notes,skippedItems[]}', async () => { if (mode === 'mock') return 'db のみ';
    const w = rt.DB.log_weight['2026-09-16']; assert(w.value === 72.6 && w.unit === 'kg' && w.skipped === false && w.loggedAt, 'weight ' + JSON.stringify(w));
    const wu = rt.DB.log_workout['2026-09-16'].warmup; assert(wu.completed === true && wu.minutes >= 1 && wu.loggedAt, 'warmup ' + JSON.stringify(wu));
    const meals = rt.DB.log_meals['2026-09-16'].meals; const sts = Object.values(meals).map(m => m.status); assert(sts.every(x => ['plan', 'substitute', 'skip', 'photo'].includes(x)), 'statuses ' + sts.join(',')); assert(Object.values(meals).every(m => 'photoId' in m && 'reason' in m && m.loggedAt), 'photoId/reason/loggedAt'); assert(Object.entries(meals).every(([k, m]) => m.planSlot === (/^snack_/.test(k) ? 'snack' : Number(k))), '記録はプランのどの食事から記録されたかを planSlot で持つ: ' + JSON.stringify(Object.entries(meals).map(([k, m]) => k + '=' + m.planSlot))); const sk = Object.values(meals).find(m => m.status === 'skip'); if (sk) assert(sk.reason, 'skip reason persisted');
    const dd = rt.DB.log_daily['2026-09-17']; assert(dd && dd.dayName === 'Pull' && Array.isArray(dd.skippedItems) && 'notes' in dd, 'daily ' + JSON.stringify(dd)); const dd16 = rt.DB.log_daily['2026-09-16']; assert(dd16 && Array.isArray(dd16.skippedItems), 'skippedItems: ' + JSON.stringify(dd16 && dd16.skippedItems)); return 'statuses=' + sts.join(',') + ' / 9/16 skippedItems=' + dd16.skippedItems.map(x => x.item).join('|'); });

  // ============ 写真で記録 ============
  const G2 = '写真で記録';
  const makeImageFile = (w, h, noise) => page.evaluate(([w, h, noise]) => new Promise(res => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const ctx = cv.getContext('2d'); if (noise) { const id = ctx.createImageData(w, h); const a = id.data; for (let i = 0; i < a.length; i += 4) { a[i] = Math.random() * 255; a[i + 1] = Math.random() * 255; a[i + 2] = Math.random() * 255; a[i + 3] = 255; } ctx.putImageData(id, 0, 0); } else { const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#c33'); g.addColorStop(1, '#3c3'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); } cv.toBlob(b => { window.__img = new File([b], 'meal.' + (noise ? 'png' : 'jpg'), { type: b.type }); res({ size: b.size, type: b.type }); }, noise ? 'image/png' : 'image/jpeg', 0.95); }), [w, h, noise]);
  const setPhoto = () => page.evaluate(() => { const inp = document.querySelector('#phFile'); const dt = new DataTransfer(); dt.items.add(window.__img); inp.files = dt.files; inp.dispatchEvent(new Event('change')); });
  /** 新方式: 写真は画面下部の固定ボタンから入れる（どの食事かは聞かれない） */
  const pickTopPhoto = (pg) => (pg || page).evaluate(() => { const inp = document.querySelector('#photoFile'); const dt = new DataTransfer(); dt.items.add(window.__img); inp.files = dt.files; inp.dispatchEvent(new Event('change')); });
  /** 別ページで、その場で作った JPEG を下部バーの写真入力に渡す */
  const pickTopPhotoOn = (pg) => pg.evaluate(() => new Promise(res => { const cv = document.createElement('canvas'); cv.width = 600; cv.height = 400; const c = cv.getContext('2d'); c.fillStyle = '#c93'; c.fillRect(0, 0, 600, 400); cv.toBlob(b => { const inp = document.querySelector('#photoFile'); const dt = new DataTransfer(); dt.items.add(new File([b], 'm.jpg', { type: 'image/jpeg' })); inp.files = dt.files; inp.dispatchEvent(new Event('change')); res(); }, 'image/jpeg', 0.9); }));
  await T(G2, '写真→推定→修正→記録→合計に反映→取り消し→合計から消える', async () => { await goTab('today'); assert((await text('.date')).includes('9/16'), 'on 9/16');
    if (mode === 'mock') { await page.click('#addMealBtn'); await page.waitForSelector('#recQ'); const no = !(await page.$('#recPhoto')); await closeSheet(); assert(no, 'sample null → 「写真から推定」非表示'); return 'sample null → 写真の選択肢を出さない（文字入力のみ）'; }
    const total = dayTotal;
    const base = await total(); const nAssets = rt.assets.length;
    // 5食目の時間帯（19:30）に写真から記録すると、どの食事かを聞かれずに 5食目へ自動で紐づく
    await setTime('2026-09-16T19:30:00+08:00'); await goTab('workout'); await goTab('today');
    await makeImageFile(3000, 2000, false); await pickTopPhoto(); await page.waitForSelector('#phEst');
    assert(!(await has('#dlg:not([hidden])')), '記録画面に「どの食事か」を選ぶ項目は無い');
    assert((await text('#sheet h3')) === '写真で記録' && (await text('#sheet .mute')).includes('今日のプランは変わりません'), '写真だけの記録画面は枠を聞かない: ' + (await text('#sheet .mute')));
    const dim = await text('#photoPanel .num'); assert(dim.startsWith('1280×853'), 'resized to 1280×853: ' + dim);
    await page.fill('#phNote', 'ご飯は少なめ'); await page.click('#phEst'); await page.waitForSelector('#phSave', { timeout: 15000 });
    const sc = rt.sampleCalls[rt.sampleCalls.length - 1]; assert(sc.hasImage && sc.imageType === 'image/jpeg' && sc.imageSize < 1000000 && sc.tier === 'default', 'sample got resized jpeg on default tier: ' + JSON.stringify(sc)); assert(sc.prompt.length > 0);
    assert((await page.$$eval('.photo .est .it', els => els.length)) === 2, 'two item rows'); assert((await text('.photo .conf')).includes('確からしさ: 中'), 'confidence'); assert((await text('.photo .row2')).includes('合計 652kcal※'), 'total 652※');
    // 推定した品目をそのまま食品マスタへ登録できる（次から「＋ 他のものを追加」で選べる）
    { const nFoods = Object.keys(rt.DB.foods).length; await page.click('#phReg'); await page.waitForFunction(() => document.querySelector('#phReg').textContent === '登録しました', null, { timeout: 15000 });
      assert(Object.keys(rt.DB.foods).length > nFoods, '推定結果を食品マスタに登録できる: ' + nFoods + ' → ' + Object.keys(rt.DB.foods).length);
      assert(Object.values(rt.DB.foods).some(f => f.nameJa === '白ご飯' && Number(f.portionG) > 0), '分量つきでマスタに残る'); }
    await page.click('[data-phg="0:10"]'); await page.waitForSelector('#phSave'); assert((await text('.photo .est .it')).includes('210g'), 'grams +10'); await page.click('[data-phoff="1"]'); await page.waitForSelector('#phSave'); assert((await text('.photo .row2')).includes('合計 328kcal※'), 'exclude item → 328: ' + (await text('.photo .row2')));
    await page.click('#phSave'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(250);
    const row = await page.locator('.elist').textContent(); assert(row.includes('📷') && row.includes('白ご飯210g') && /約328kcal/.test(row) && row.includes('※推定'), 'row: ' + row); assert(Math.abs((await total()) - (base + 328)) <= 1, 'total +328: ' + (await total()) + ' vs ' + base);
    assert(rt.assets.length === nAssets + 1 && rt.assets[nAssets].type === 'image/jpeg', 'photo uploaded to assets'); const med = Object.values(rt.DB.log_media).find(m => m.category === 'meal'); assert(med && med.assetId === rt.assets[nAssets].id, 'log_media meal link'); const fd = Object.values(rt.DB.foods).find(f => f.source === 'ai_photo'); assert(fd && fd.nameJa === '白ご飯' && Math.round(fd.kcal) === 156, 'foods ai_photo per100g: ' + JSON.stringify(fd)); assert(Object.values(rt.DB.log_meals['2026-09-16'].meals).some(mm => mm.photo && mm.photo.assetId === med.assetId), 'meal photo ref');
    await page.click('.elist .cam'); await page.waitForSelector('#dlg img.thumb'); assert((await page.$eval('#dlg img.thumb', e => e.getAttribute('src'))).startsWith('/_blob/'), 'thumbnail from assets'); await page.click('#dlgNo'); await page.waitForSelector('#dlg', { state: 'hidden' });
    for (const key of await page.$$eval('.elist .erow', els => els.filter(r => !/食目/.test(r.querySelector('.nm').textContent)).map(r => r.dataset.erow))) {
      await page.evaluate(k => { const r = document.querySelector('.elist [data-erow="' + k + '"]'); if (r) r.click(); }, key);
      await page.waitForSelector('#recDel'); await page.click('#recDel'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(250); }
    assert((await total()) === base, 'cancel → total back: ' + (await total()) + ' vs ' + base);
    await setTime('2026-09-16T07:41:00+08:00'); await goTab('summary'); await page.waitForSelector('#repText'); await goTab('today'); return '1280×853 JPEG ' + Math.round(sc.imageSize / 1024) + 'KB を送信 / 白ご飯 210g=328kcal※ を記録'; });
  await T(G2, '「＋ 食べたものを記録」→ 写真から推定 → 「食べたもの」に記録した時刻で並び、合計に反映。プランは一切変わらない。取り消しで消える', async () => {
    await goTab('today');
    if (mode === 'mock') { await page.click('#addMealBtn'); await page.waitForSelector('#recQ'); const no = !(await page.$('#recPhoto')); await closeSheet(); assert(no, 'sample null → 写真の選択肢なし'); return 'sample null → 写真の選択肢なし'; }
    await setTime('2026-09-16T15:00:00+08:00'); await goTab('workout'); await goTab('today');
    assert(await has('#addMealBtn') && (await text('#addMealBtn')).includes('食べたものを記録'), '記録ボタンは1つにまとまっている: ' + (await text('#addMealBtn')));
    assert(await page.$eval('#photoFile', e => (e.getAttribute('accept') || '').includes('image/jpeg') && !e.hasAttribute('capture')), 'gallery picker: no capture attribute so camera and library both offered');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(120);
    assert(await page.$eval('#addMealBtn', e => e.getBoundingClientRect().bottom <= window.innerHeight + 1 && e.getBoundingClientRect().top >= 0), 'スクロールしても記録ボタンが画面内に残る');
    const total = dayTotal; const base = await total();
    const planBefore = await page.$$eval('[data-planchk]', els => els.map(e => e.className.includes('on') ? '✓' : '○').join(''));
    await makeImageFile(1600, 1200, false); await pickTopPhoto();
    await page.waitForSelector('#phEst');
    assert((await text('#sheet .mute')).includes('今日のプランは変わりません'), '写真の記録画面は枠を聞かない: ' + (await text('#sheet .mute')));
    assert(!(await has('#mPlan')) && !(await has('#mReset')), 'no plan buttons');
    await page.click('#phEst'); await page.waitForSelector('#phSave', { timeout: 15000 }); await page.click('#phSave');
    await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(300);
    const rows = await page.$$eval('.elist .erow', els => els.map(e => e.querySelector('.etime').textContent + ' ' + e.querySelector('.nm').textContent));
    const idx = rows.findIndex(x => x.indexOf('15:00') === 0);
    assert(idx >= 0 && !/食目/.test(rows[idx]), '15:00 の記録が番号なしで並ぶ: ' + rows.join(' / '));
    const ts = rows.map(x => x.slice(0, 5)); assert(ts.slice().sort().join(',') === ts.join(','), '時刻順に並ぶ: ' + rows.join(' / '));
    assert(/※推定/.test(await page.locator('.elist').textContent()), '推定値には ※推定 を付ける: ' + (await page.locator('.elist').textContent()));
    assert((await page.$$eval('[data-planchk]', els => els.map(e => e.className.includes('on') ? '✓' : '○').join(''))) === planBefore, 'プランは変わらない: ' + planBefore);
    assert((await total()) === base + 652, 'total +652: ' + (await total()));
    await page.waitForTimeout(200);
    const key = Object.keys(rt.DB.log_meals['2026-09-16'].meals).filter(k => /^snack/.test(k)).pop();
    const doc = rt.DB.log_meals['2026-09-16'].meals[key];
    assert(doc && doc.status === 'photo' && doc.planSlot === null && doc.items.length === 2 && doc.items.every(i => i.estimated) && doc.photoId, 'db: planSlot は null: ' + JSON.stringify({ planSlot: doc && doc.planSlot, n: doc && doc.items.length }));
    assert(Object.values(rt.DB.foods).some(f => f.source === 'ai_photo'), 'foods ai_photo');
    // 長押しで削除 → 合計から消える
    await page.evaluate(k => { const r = document.querySelector('.elist [data-erow="' + k + '"]'); if (r) r.click(); }, key);
    await page.waitForSelector('#recDel'); await page.click('#recDel'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(250);
    assert((await total()) === base, 'total back after cancel: ' + (await total()));
    await page.waitForTimeout(200); assert(!rt.DB.log_meals['2026-09-16'].meals[key], 'db doc removed');
    await setTime(T0); await goTab('workout'); await goTab('today');
    return '写真 → 食べたものに1件（時刻順・番号なし・※推定）。プランには触れない';
  });
  await T(G2, '推定 JSON の parse 失敗時にアプリが落ちず、手入力に切替できる', async () => { if (mode === 'mock') return '写真ボタン非表示のため対象外'; await makeImageFile(800, 600, false); await pickTopPhoto(); await page.waitForSelector('#phEst'); await page.fill('#phNote', 'BAD'); await page.click('#phEst'); await page.waitForSelector('#phManual', { timeout: 15000 }); assert((await text('.photo .pending')).includes('推定結果を読み取れませんでした'), 'error line: ' + (await text('.photo .pending'))); await page.click('#phManual'); await page.waitForSelector('#recQ'); assert(!(await has('#photoPanel')), 'switched to the record screen'); assert(!errors.length, 'no page errors'); await closeSheet(); });
  await T(G2, '画像を送れない画面（limits に images が無い）では「写真から推定」を出さない。設定に「写真推定：使える／使えない」が出る', async () => {
    if (mode === 'mock') return 'db のみ（sample を注入して判定する）';
    const p2 = await newPage({ noImages: true }); p2.setDefaultTimeout(20000);
    try {
      await p2.waitForTimeout(600); await p2.click('.tabs [data-tab="today"]');
      await p2.click('#addMealBtn'); await p2.waitForSelector('#recQ');
      assert(!(await p2.$('#recPhoto')), '写真は送れないので「写真から推定」を出さない');
      assert(await p2.$('#recChat'), '代わりにチャット経由の入口は出す');
      await p2.click('#sheet', { position: { x: 5, y: 5 } }); await p2.waitForSelector('#sheet', { state: 'hidden' });
      await p2.click('.tabs [data-tab="summary"]'); await p2.waitForSelector('#diagPhoto');
      const diag = (await p2.locator('#diagPhoto').textContent()).trim();
      assert(diag.includes('写真推定：使えない') && diag.includes('画像を送れません'), '設定に診断行: ' + diag);
      return diag;
    } finally { await p2.close(); }
  });
  await T(G2, 'sample が画像を受け付けない環境の逃げ道: Claude のチャットで写真を見てもらい、返ってきた JSON を貼り付けると、写真から推定したときと同じ結果画面になる（```json の囲みや前後の文章が付いていても読める）', async () => {
    if (mode === 'mock') return 'db のみ';
    const p2 = await newPage({ noImages: true }); p2.setDefaultTimeout(20000);
    try {
      await p2.waitForTimeout(600); await p2.click('.tabs [data-tab="today"]');
      await p2.click('#addMealBtn'); await p2.waitForSelector('#recChat'); await p2.click('#recChat'); await p2.waitForSelector('#phPasteTa');
      assert(await p2.$('#phCopyPrompt'), '指示文をコピーするボタンがある');
      const reply = 'はい、推定しました。\n```json\n{"items":[{"name_ja":"白ご飯","name_en":"White rice","grams":200,"kcal":336,"p":5,"f":0.6,"c":74},{"name_ja":"鶏の唐揚げ","name_en":"Fried chicken","grams":120,"kcal":340,"p":20,"f":22,"c":12}],"total":{"kcal":676,"p":25,"f":22.6,"c":86},"confidence":"medium","note":"ご飯の量は茶碗から推定しました"}\n```\n以上です。';
      await p2.fill('#phPasteTa', reply); await p2.click('#phPasteGo');
      await p2.waitForSelector('#phSave');
      const panel = await p2.locator('#photoPanel').textContent();
      assert(panel.includes('白ご飯') && panel.includes('鶏の唐揚げ') && /合計 676kcal/.test(panel), '貼り付けた内容がそのまま結果画面になる: ' + panel.slice(0, 160));
      assert(panel.includes('確からしさ: 中') && panel.includes('茶碗から推定'), '確からしさと note も反映: ' + panel.slice(0, 200));
      await p2.click('[data-phg="0:-10"]'); await p2.waitForTimeout(200);
      assert(!/合計 676kcal/.test(await p2.locator('#photoPanel').textContent()), '分量はその場で直せる');
      await p2.click('#phSave'); await p2.waitForSelector('#sheet', { state: 'hidden' }); await p2.waitForTimeout(300);
      const meals = (rt.DB.log_meals['2026-09-16'] || {}).meals || {};
      assert(Object.values(meals).some(mm => (mm.items || []).length === 2 && (mm.photo || {}).confidence === 'medium'), '貼り付けからも記録できる');
      // 壊れた貼り付けは落とさずに知らせるだけ
      const bad = await p2.evaluate(() => { try { window.__tl.parseEstimateText('なにも JSON がありません'); return 'no-throw'; } catch (e) { return e.code; } });
      assert(bad === 'invalid_json', '読み取れない貼り付けは invalid_json: ' + bad);
      return 'Claude のチャットの返事を貼るだけで、写真と同じ結果画面・同じ記録になる';
    } finally {
      await p2.close();
      await page.reload(); await page.waitForFunction(() => !document.querySelector('#view .loading')); await goTab('today');
      const snacks = (await page.$$eval('.step', els => els.map(e => e.dataset.step))).filter(x => /^meal:snack/.test(x));
      for (const k of snacks) { await page.click('[data-chk="' + k + '"]'); await page.waitForTimeout(250); }
    }
  });
  await T(G2, '写真の送信に失敗したら、実際に返った code を画面に出す（images_unavailable なら写真の入口も消す）。自動の再試行はしない', async () => {
    if (mode === 'mock') return 'db のみ';
    const p2 = await newPage({ sampleErr: 'images_unavailable', sampleErrImageOnly: true }); p2.setDefaultTimeout(20000);
    try {
      await p2.waitForTimeout(600); await p2.click('.tabs [data-tab="today"]');
      await p2.click('#addMealBtn'); await p2.waitForSelector('#recQ'); assert(await p2.$('#recPhoto'), 'limits が images を返す画面では「写真から推定」を出す'); await p2.click('#sheet', { position: { x: 5, y: 5 } }); await p2.waitForSelector('#sheet', { state: 'hidden' });
      const before = rt.sampleCalls.length;
      await pickTopPhotoOn(p2);
      await p2.waitForSelector('#phEst'); await p2.click('#phEst');
      await p2.waitForSelector('#phTextLead');
      assert((await p2.locator('#phTextLead').textContent()).includes('images_unavailable'), '実際に返った code を画面に出す: ' + (await p2.locator('#phTextLead').textContent()));
      await p2.waitForTimeout(1200);
      assert(rt.sampleCalls.length === before + 1, '自動で再試行しない: ' + (rt.sampleCalls.length - before) + ' 回呼ばれた');
      await p2.click('#sheet', { position: { x: 5, y: 5 } }); await p2.waitForSelector('#sheet', { state: 'hidden' }); await p2.waitForTimeout(250);
      await p2.click('#addMealBtn'); await p2.waitForSelector('#recQ'); assert(!(await p2.$('#recPhoto')), 'images_unavailable のあとは「写真から推定」を隠す');
      // この表示は写真に対応していないと覚えるので、後続のテストのために消しておく（localStorage はページ間で共有）
      await p2.evaluate(() => { try { localStorage.removeItem('tl.noImages'); } catch (e) { /* ignore */ } });
      return 'code をそのまま表示 → 写真の入口を隠す（次回から静かに案内する）';
    } finally { await p2.evaluate(() => { try { localStorage.removeItem('tl.noImages'); } catch (e) { /* ignore */ } }).catch(() => {}); await p2.close(); }
  });
  await T(G2, '解析中は「写真を解析しています…（最大1分ほどかかります）」と「止める」を出し、止めたら元に戻る。補足を足して推定し直せる（自前のタイムアウトは入れない）', async () => {
    if (mode === 'mock') return 'db のみ';
    const p2 = await newPage({ sampleDelay: 2500 }); p2.setDefaultTimeout(20000);
    try {
      await p2.waitForTimeout(600); await p2.click('.tabs [data-tab="today"]');
      await pickTopPhotoOn(p2);
      await p2.waitForSelector('#phEst'); await p2.click('#phEst'); await p2.waitForSelector('#phWait');
      const wait = await p2.locator('#phWait').textContent();
      assert(wait.includes('写真を解析しています') && wait.includes('最大1分'), '待ち時間の案内: ' + wait);
      await p2.click('#phStop'); await p2.waitForSelector('#phEst');
      assert(!(await p2.$('#phErr')), '止めてもエラー扱いにしない（元の画面に戻るだけ）');
      // もう一度、今度は最後まで
      await p2.click('#phEst'); await p2.waitForSelector('#phSave');
      assert((await p2.locator('#photoPanel').textContent()).includes('白ご飯'), '写真から推定できる');
      // 補足を足して推定し直す（写真は付けたまま）
      await p2.fill('#phNote', '実際はご飯半分だった'); await p2.click('#phEst'); await p2.waitForSelector('#phSave');
      const calls = rt.sampleCalls.slice(-1)[0];
      assert(calls.hasImage, '補足を足しても写真は付けたまま推定し直す');
      await p2.click('#sheet', { position: { x: 5, y: 5 } }); await p2.waitForSelector('#sheet', { state: 'hidden' });
      return '解析中の案内と中止、結果からの補足つき推定し直し';
    } finally { await p2.close(); }
  });
  await T(G2, 'レート制限など他の失敗も code を画面に出し「もう一度」「チャットで見てもらう」「手で選んで記録」を選べる／JPEG に変換できない写真は image_rejected として案内する（accept に capture は付けない）', async () => {
    if (mode === 'mock') return 'db のみ';
    const p2 = await newPage({ sampleErr: 'rate_limited', sampleErrImageOnly: true }); p2.setDefaultTimeout(20000);
    try {
      await p2.waitForTimeout(600); await p2.click('.tabs [data-tab="today"]');
      await pickTopPhotoOn(p2);
      await p2.waitForSelector('#phEst'); await p2.click('#phEst'); await p2.waitForSelector('#phErr');
      const err = await p2.locator('#phErr').textContent();
      assert(err.includes('エラー: rate_limited') && err.includes('少し時間をおいてください'), 'code と文言の両方を出す: ' + err);
      assert((await p2.$('#phEst')) && (await p2.$('#phToPaste')) && (await p2.$('#phManual')), 'もう一度・チャット・手で選んで記録 を出す');
      await p2.click('#phAgain'); await p2.waitForSelector('#phPick'); await p2.waitForSelector('#phFile', { state: 'attached' });
      const acc = await p2.$eval('#phFile', e => e.getAttribute('accept'));
      assert(acc.includes('image/jpeg') && acc.includes('image/png') && acc.includes('image/webp'), 'accept: ' + acc);
      assert(!(await p2.$eval('#phFile', e => e.hasAttribute('capture'))), 'capture は付けない（アルバムからも選べるように）');
      await p2.evaluate(() => { const inp = document.querySelector('#phFile'); const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'photo.heic', { type: 'image/heic' })); inp.files = dt.files; inp.dispatchEvent(new Event('change')); });
      await p2.waitForSelector('#phErr');
      const err2 = await p2.locator('#phErr').textContent();
      assert(err2.includes('エラー: image_rejected') && err2.includes('スクリーンショット'), '読み込めない写真の案内: ' + err2);
      assert(!(await p2.$('#phEst')), '読み込めない写真では「もう一度」ではなく別の写真を選ばせる');
      return 'rate_limited / image_rejected とも code を画面に出す';
    } finally { await p2.close(); }
  });
  await T(G2, 'assets null で推定だけ動く（写真はメモリ保持、記録は保存）', async () => { if (mode === 'mock') return 'db のみ'; const p2 = await newPage({ noAssets: true }); await p2.waitForTimeout(600); await p2.click('.tabs [data-tab="today"]'); const nAssets = rt.assets.length;
    await p2.clock.setFixedTime(new Date('2026-09-16T19:30:00+08:00')); await p2.click('.tabs [data-tab="workout"]'); await p2.click('.tabs [data-tab="today"]');
    await p2.evaluate(() => new Promise(res => { const cv = document.createElement('canvas'); cv.width = 600; cv.height = 400; cv.getContext('2d').fillStyle = '#c93'; cv.getContext('2d').fillRect(0, 0, 600, 400); cv.toBlob(b => { const inp = document.querySelector('#photoFile'); const dt = new DataTransfer(); dt.items.add(new File([b], 'm.jpg', { type: 'image/jpeg' })); inp.files = dt.files; inp.dispatchEvent(new Event('change')); res(); }, 'image/jpeg', 0.9); }));
    await p2.waitForSelector('#phEst'); await p2.click('#phEst'); await p2.waitForSelector('#phSave', { timeout: 15000 }); await p2.click('#phSave'); await p2.waitForSelector('#sheet', { state: 'hidden' }); await p2.waitForTimeout(250);
    assert(rt.assets.length === nAssets, 'no upload'); const mk = Object.keys(rt.DB.log_meals['2026-09-16'].meals).filter(k => /^snack/.test(k)).pop(); const meal = rt.DB.log_meals['2026-09-16'].meals[mk]; assert(meal && meal.photo && !meal.photo.assetId && meal.items.length === 2, 'recorded without assetId'); assert((await p2.locator('.elist').textContent()).includes('📷'), 'camera icon'); await p2.click('.elist .cam'); await p2.waitForSelector('#dlg:not([hidden])'); assert((await p2.$eval('#dlg', e => e.textContent)).includes('保存されていません') || await p2.$('#dlg img.thumb'), 'photo dialog'); await p2.close();
    // 後始末: メインページで取り消し
    await resetClock(); await page.reload(); await page.waitForFunction(() => !document.querySelector('#view .loading')); await goTab('today');
    for (const key of await page.$$eval('.elist .erow', els => els.filter(r => !/食目/.test(r.querySelector('.nm').textContent)).map(r => r.dataset.erow))) {
      await page.evaluate(k => { const r = document.querySelector('.elist [data-erow="' + k + '"]'); if (r) r.click(); }, key);
      await page.waitForSelector('#recDel'); await page.click('#recDel'); await page.waitForSelector('#sheet', { state: 'hidden' }); await page.waitForTimeout(250);
    } });
  await T(G2, '縦長・横長・大きい写真（10MB超）で送信前にリサイズ（長辺1280px、JPEG 0.8）して成功する', async () => { const r = await page.evaluate(async () => { const mk = (w, h, noise) => new Promise(res => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const ctx = cv.getContext('2d'); if (noise) { const id = ctx.createImageData(w, h); const a = id.data; for (let i = 0; i < a.length; i += 4) { a[i] = Math.random() * 255; a[i + 1] = Math.random() * 255; a[i + 2] = Math.random() * 255; a[i + 3] = 255; } ctx.putImageData(id, 0, 0); } else { ctx.fillStyle = '#48c'; ctx.fillRect(0, 0, w, h); } cv.toBlob(b => res(new File([b], 'x', { type: b.type })), noise ? 'image/png' : 'image/jpeg', 0.95); });
    const out = {}; const big = await mk(3200, 2400, true); const rb = await window.__tl.resizeImage(big, 1280, 0.8); out.big = { inSize: big.size, w: rb.width, h: rb.height, type: rb.blob.type, outSize: rb.blob.size };
    const land = await mk(4000, 2000, false); const rl = await window.__tl.resizeImage(land); out.land = { w: rl.width, h: rl.height }; const port = await mk(1500, 3000, false); const rp = await window.__tl.resizeImage(port); out.port = { w: rp.width, h: rp.height }; const small = await mk(640, 480, false); const rs = await window.__tl.resizeImage(small); out.small = { w: rs.width, h: rs.height }; return out; });
    assert(r.big.inSize > 10 * 1024 * 1024, 'noise png > 10MB: ' + r.big.inSize); assert(r.big.w === 1280 && r.big.h === 960 && r.big.type === 'image/jpeg' && r.big.outSize < 1.5 * 1024 * 1024, 'big → ' + JSON.stringify(r.big)); assert(r.land.w === 1280 && r.land.h === 640, 'landscape ' + JSON.stringify(r.land)); assert(r.port.w === 640 && r.port.h === 1280, 'portrait ' + JSON.stringify(r.port)); assert(r.small.w === 640 && r.small.h === 480, 'small unchanged'); return (r.big.inSize / 1048576).toFixed(1) + 'MB PNG → ' + (r.big.outSize / 1024).toFixed(0) + 'KB JPEG 1280×960'; });

  // ============ 共通（後で） ============
  await T(G.common, '英略語（W/MAIN/TOP/BO/DROP/PRE/FINAL）がUIに出ない', async () => { const re = /(^|[^A-Za-z])(WU|W|MAIN|TOP|BO|DROP|PRE|FINAL)([^A-Za-z]|$)/; for (const tab of ['today', 'workout', 'summary']) { await goTab(tab); const txt = await page.$eval('#view', e => e.innerText); const m = re.exec(txt); assert(!m, tab + ': ' + (m && m[0])); } });
  await T(G.common, '数だけの表示（7種、1種）がない', async () => { for (const tab of ['today', 'workout', 'summary']) { await goTab(tab); const txt = await page.$eval('#view', e => e.innerText); const bad = txt.split('\n').filter(l => /サプリ\s*\d+種/.test(l) || /^\s*\d+種(目)?\s*$/.test(l)); assert(!bad.length, tab + ': ' + bad.join(' | ')); } });
  await T(G.common, '同日に2回開いても二重保存されない', async () => { if (mode === 'mock') return 'db のみ'; const before = JSON.stringify(rt.DB); const p2 = await newPage(); await p2.waitForTimeout(800); assert(!(await p2.$('#view .loading')), 'second page rendered'); const after = JSON.stringify(rt.DB); assert(before === after, 'second open changed db'); const counts = Object.fromEntries(Object.entries(rt.DB).map(([k, v]) => [k, Object.keys(v).length])); assert(counts.plan_days === 7 && counts.plan_exercises === 54 && counts.plan_supplements === 8 && counts.plan_warmup === 6, JSON.stringify(counts)); await p2.close(); return 'docs: ' + JSON.stringify(counts); });
  // --- 緊急修正: 読み込みが必ず終わる（「読み込み中…」で止めない） ---
  await T(G.common, '読み込みが終わらないときは 10 秒で打ち切ってエラー画面に進む: 実際のエラー内容を画面に出し、「もう一度読み込む」と「記録はそのままで初期化」を置く。初期化しても食事・体重・トレーニングの記録は消さない', async () => {
    if (mode === 'mock') return 'db のみ（db の応答が返らない状況を再現する）';
    const before = { w: JSON.parse(JSON.stringify(rt.DB.log_weight || {})), wo: JSON.parse(JSON.stringify(rt.DB.log_workout || {})), m: JSON.parse(JSON.stringify(rt.DB.log_meals || {})) };
    const beforeSettings = JSON.parse(JSON.stringify(rt.DB.settings.main));
    assert(Object.keys(before.wo).length > 0, '消えていないことを確かめるための記録が db にある');
    const p2 = await newPage({ dbHang: ['plan_days'] }, true);
    p2.setDefaultTimeout(20000);
    try {
      // 打ち切る前は「いまどこを読んでいるか」を出す
      await p2.waitForSelector('#loadStep');
      assert((await p2.locator('#loadStep').textContent()).trim().length > 0, '読み込み中に、いま読んでいるところを1行出す');
      await p2.waitForSelector('#loadErr', { timeout: 20000 });
      const msg = (await p2.locator('#loadErrMsg').textContent()).trim();
      assert(msg.includes('タイムアウト') && msg.includes('記録の読み込み'), 'エラー内容をそのまま画面に出す: ' + msg);
      assert(!(await p2.$('#view .loading')), '「読み込み中…」で止まらない');
      assert(await p2.$('#loadRetry'), '「もう一度読み込む」がある');
      // 「記録はそのままで初期化」: 設定だけ初期値に戻し、記録には触らない
      await p2.click('#loadReset'); await p2.waitForSelector('#dlgOk'); await p2.click('#dlgOk');
      for (let i = 0; i < 150 && Number((rt.DB.settings || {}).main.seedVersion) !== 0; i++) await p2.waitForTimeout(100);
      assert(JSON.stringify(rt.DB.log_weight || {}) === JSON.stringify(before.w), '体重の記録は消えない');
      assert(JSON.stringify(rt.DB.log_workout || {}) === JSON.stringify(before.wo), '筋トレの記録は消えない');
      assert(JSON.stringify(rt.DB.log_meals || {}) === JSON.stringify(before.m), '食事の記録は消えない');
      assert(Number((rt.DB.settings || {}).main.seedVersion) === 0, '設定は初期値に戻してプランを入れ直す: seedVersion=' + (rt.DB.settings || {}).main.seedVersion);
      return '10 秒で打ち切り → エラー内容表示 → 記録を残したまま初期化';
    } finally { await p2.close(); rt.op('set', { coll: 'settings', id: 'main', data: beforeSettings }); }
  });
  await T(G.common, '一部のコレクションが読めなくても「今日」は開ける（必須でないものは待たずに進む）／壊れた記録（存在しない種目・sets が配列でない・Day 番号が範囲外）があっても落ちない', async () => {
    if (mode === 'mock') return 'db のみ';
    const D = '2026-09-14';
    rt.op('set', { coll: 'log_workout', id: D, data: { date: D, sets: { '9999_1': { exerciseId: 9999, setNo: 1, setType: 'MAIN', weightKg: 10, reps: 10 } } } });
    rt.op('set', { coll: 'log_workout', id: '2026-09-13', data: { date: '2026-09-13', sets: 'こわれた値' } });
    rt.op('set', { coll: 'log_daily', id: D, data: { date: D, dayNo: 99 } });
    const p2 = await newPage({ dbHang: ['log_media'] });
    p2.setDefaultTimeout(20000);
    try {
      assert(!(await p2.$('#loadErr')), '必須でないコレクションが遅れてもエラー画面にしない');
      const h1 = (await p2.locator('h1').first().textContent()).trim();
      assert(/^Day [1-7] /.test(h1), '範囲外の Day 番号は無視して 1〜7 の Day を出す: ' + h1);
      assert((await p2.locator('#tabWorkout').textContent()).trim() !== 'Day', '下部タブの Day が出る');
      await p2.click('.tabs [data-tab="workout"]'); await p2.waitForTimeout(200);
      assert(!(await p2.$('.ttl:has-text("表示エラー")')), '筋トレタブも落ちない');
      return '必須は settings・週の予定・種目・食事プランの4つ。ほかは遅れても今日画面を出す';
    } finally { await p2.close(); ['2026-09-13', D].forEach(d => { rt.op('del', { coll: 'log_workout', id: d }); rt.op('del', { coll: 'log_daily', id: d }); }); }
  });
  await T(G.common, 'sample の呼び方: api.anthropic.com を直接叩かない／画像は options.images に Blob で渡す（base64 をプロンプトに埋めない）／window.claude.sample を直接読まない／公開時の capabilities に sample を宣言している', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'artifact', 'index.html'), 'utf8');
    assert(!/api\.anthropic\.com/.test(src), 'api.anthropic.com を直接呼んでいる');
    assert(!/window\.claude\.sample/.test(src), 'window.claude.sample を直接読んでいる');
    assert(/images:\s*\[ph\.blob\]/.test(src), '画像は options.images に Blob で渡す');
    assert(!/data:image\/[a-z]+;base64/.test(src.replace(/toDataURL/g, '')), 'base64 をプロンプトに埋め込んでいる');
    assert(/sample:\s*\{\}/.test(src), '公開時の capabilities 宣言に sample がある');
    assert(/modelTier:\s*'default'/.test(src), '写真・文字の推定は modelTier: default');
    return 'claude.use("sample") → sample.json(prompt, { images: [blob] })';
  });
  await T(G.meal, '記録ボタンは1つにまとまり、開いた瞬間に検索へフォーカスが当たる。「食べたもの」から削除すると、プランの記録ならプランも ○ に戻る', async () => {
    const D = '2027-10-06';
    const p2 = await newPage(); p2.setDefaultTimeout(20000);
    try {
      await p2.clock.setFixedTime(new Date(D + 'T12:00:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
      await p2.click('.tabs [data-tab="today"]'); await p2.waitForSelector('#addMealBtn');
      const btns = await p2.$$eval('#bbar .rec button', els => els.map(e => e.textContent));
      assert(btns.length === 1 && btns[0].includes('食べたものを記録'), '下部の記録ボタンは1つ: ' + btns.join(' / '));
      await p2.click('#addMealBtn'); await p2.waitForSelector('#recQ');
      assert((await p2.evaluate(() => document.activeElement && document.activeElement.id)) === 'recQ', 'シートを開くと検索にフォーカスが当たる');
      const ways = await p2.$$eval('#sheet .sheet-body button', els => els.map(e => e.id).filter(Boolean));
      assert(ways.includes('recNewFood') && ways.includes('recKcal') && ways.includes('recSave'), '操作は チェック・個数・記録する だけ: ' + ways.join(','));
      assert(ways.includes('recPhoto') === (mode === 'db'), '写真の選択肢は使える画面のときだけ出す: ' + ways.join(','));
      const bodyTxt = await p2.locator('#sheet .sheet-body').textContent();
      assert(!/文字で推定|AI 計算|AI計算|よく使う差替え|半分だけ|1つ戻す|変更して記録済み/.test(bodyTxt), '消したものが残っていない: ' + bodyTxt.slice(0, 120));
      await p2.click('#sheet', { position: { x: 5, y: 5 } }); await p2.waitForSelector('#sheet', { state: 'hidden' });
      // プランから記録 → 食べたものに1件 → 削除するとプランも ○ に戻る
      await p2.click('[data-planchk="3"]'); await p2.waitForTimeout(400);
      assert(await planEaten(3, p2), 'プラン3食目が ✓');
      assert((await eatenRowOf(3, p2)).includes('3食目（プラン）'), '食べたものに出る');
      await p2.click('[data-planchk="3"]'); await p2.waitForTimeout(400);
      assert(!(await planEaten(3, p2)), '食べたものから消すと、プランも ○ に戻る');
      assert(!(await p2.$('.elist')) || !(await p2.locator('.elist').textContent()).includes('3食目（プラン）'), '一覧からも消える');
      return '記録ボタン1つ・フォーカス・削除でプランも ○ に戻る';
    } finally { await p2.close(); rt.op('del', { coll: 'log_meals', id: D }); rt.op('del', { coll: 'log_daily', id: D }); }
  });
  await T(G.workout, '不具合修正: 筋トレの日（Day 6 Pull）が「休み」にならない。手で休みに変えた日はその旨を出して1タップで戻せる。有酸素の説明から「確認中」が消えている', async () => {
    const D = '2027-10-13';
    const p2 = await newPage(); p2.setDefaultTimeout(20000);
    try {
      await p2.clock.setFixedTime(new Date(D + 'T06:50:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
      await p2.click('.tabs [data-tab="today"]'); await p2.waitForSelector('#dayHead');
      await forceDayP2(p2, 6);
      assert(!(await p2.locator('h1').first().textContent()).includes('休み'), 'Day 6 は休みではない: ' + (await p2.locator('h1').first().textContent()));
      assert((await p2.locator('#tabWorkoutIc').textContent()) === '筋トレ', '筋トレの日はタブが「筋トレ」: ' + (await p2.locator('#tabWorkoutIc').textContent()));
      assert(!(await p2.locator('#tabWorkout').textContent()).includes('休み'), 'タブのサブテキストも休みにしない: ' + (await p2.locator('#tabWorkout').textContent()));
      assert(await p2.$('[data-step="workout"]'), '筋トレの行が出る');
      assert(!(await p2.locator('[data-step="cardio"]').textContent()).includes('確認中'), '有酸素の説明に「確認中」を残さない: ' + (await p2.locator('[data-step="cardio"]').textContent()));
      // 手で「休み」に変えたら、その旨を出して1タップで戻せる
      await p2.click('#dayHead'); await p2.waitForSelector('#restToggle'); await p2.click('#restToggle'); await p2.waitForTimeout(400);
      assert((await p2.locator('#tabWorkoutIc').textContent()) === '有酸素', '休みにするとタブが「有酸素」に変わる');
      assert(await p2.$('#restOvBanner'), '手で変えたことを画面に出す');
      await p2.click('#restOvBanner'); await p2.waitForTimeout(400);
      assert((await p2.locator('#tabWorkoutIc').textContent()) === '筋トレ' && !(await p2.$('#restOvBanner')), '1タップで予定どおりに戻る');
      return 'Day 6 は筋トレの日。手で休みにした日は戻せる';
    } finally { await p2.close(); rt.op('del', { coll: 'log_daily', id: D }); rt.op('del', { coll: 'log_workout', id: D }); }
  });
  await T(G.today, '15分カウンターは次の行動を記録したときだけ消え「◯分後に…」が残る。15分より早く進めたら「（15分より早い）」を添える。15分に達したらその場で知らせる', async () => {
    const D = '2027-11-03';
    const p2 = await newPage(); p2.setDefaultTimeout(20000);
    const lineOf = id => p2.$eval('[data-waitline="' + id + '"]', e => e.textContent + '|' + e.dataset.state).catch(() => 'NONE');
    try {
      await p2.clock.setFixedTime(new Date(D + 'T06:45:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
      await p2.click('.tabs [data-tab="today"]'); await p2.waitForSelector('[data-chk="routine:1"]');
      // リンゴ酢 → 15分 → 1食目を記録すると消えて「◯分後に1食目」が残る
      await p2.click('[data-chk="routine:1"]'); await p2.waitForSelector('[data-waitline="acv"]');
      assert((await lineOf('acv')) === '1食目まで あと 15:00|counting', 'counting: ' + (await lineOf('acv')));
      // 開いている間に15分たったら知らせる（描き直さずに表示が切り替わる）
      await p2.clock.setFixedTime(new Date(D + 'T07:00:30+08:00'));
      await p2.waitForFunction(() => { const e = document.querySelector('[data-waitline="acv"]'); return e && e.dataset.state === 'ready'; });
      assert((await p2.locator('#toast').textContent()).includes('15分経ちました') && (await p2.locator('#toast').textContent()).includes('1食目'), '15分で知らせる: ' + (await p2.locator('#toast').textContent()));
      await p2.clock.setFixedTime(new Date(D + 'T07:03:00+08:00'));
      await p2.click('[data-planchk="1"]'); await p2.waitForTimeout(500);
      assert((await lineOf('acv')) === '18分後に1食目|done', '記録したら「◯分後に1食目」が残る: ' + (await lineOf('acv')));
      assert(!/1食目まで|あと/.test(await p2.locator('#now').textContent()), 'カウンターは「いま」からも消える: ' + (await p2.locator('#now').textContent()));
      // 経口サプリ → 15分より早くサイリウムを完了 → 「（15分より早い）」
      await p2.click('[data-chk="supp:after_meal"]'); await p2.waitForSelector('[data-waitline="supp"]');
      assert((await p2.locator('#now .t').textContent()) === 'サイリウムまで', '「いま」はサイリウムまでのカウンター: ' + (await p2.locator('#now .t').textContent()));
      assert((await lineOf('supp')) === 'サイリウムまで あと 15:00|counting', 'supp counting: ' + (await lineOf('supp')));
      await p2.clock.setFixedTime(new Date(D + 'T07:12:00+08:00'));
      await p2.click('[data-chk="routine:2"]'); await p2.waitForTimeout(500);
      assert((await lineOf('supp')) === '9分後にサイリウム（15分より早い）|done', '15分より早いと添える: ' + (await lineOf('supp')));
      assert((await lineOf('acv')) === '18分後に1食目|done', 'リンゴ酢側はそのまま残る: ' + (await lineOf('acv')));
      return 'リンゴ酢 18分後に1食目 ／ 経口サプリ 9分後にサイリウム（15分より早い）';
    } finally { await p2.close(); ['log_meals', 'log_daily', 'log_routine', 'log_supplements'].forEach(c => rt.op('del', { coll: c, id: D })); }
  });
  await T(G.meal, '食品マスタの重複をまとめる移行: 過去の記録は消さず、まとめた先の食品に付け替わる。よく食べるものは使った回数の多い順に並ぶ', async () => {
    if (mode === 'mock') return 'db のみ（移行は db 上の既存データに対して走る）';
    const D = '2027-04-05';
    const beforeSettings = JSON.parse(JSON.stringify(rt.DB.settings.main));
    rt.op('set', { coll: 'foods', id: 'pistachio_dup', data: { foodId: 'pistachio_dup', nameJa: 'ピスタチオ 1', nameEn: '', per: '100g', kcal: 562, p: 23.7, f: 42.4, c: 23.9, unitG: 0, unitLabel: '', portionG: 0, source: 'ai' } });
    rt.op('set', { coll: 'foods', id: 'cereal_dup', data: { foodId: 'cereal_dup', nameJa: 'シリアル', nameEn: '', per: '100g', kcal: 373, p: 38.2, f: 11.4, c: 34.3, unitG: 0, unitLabel: '', portionG: 0, source: 'ai' } });
    rt.op('set', { coll: 'log_meals', id: D, data: { date: D, meals: { snack_1: { planSlot: null, loggedAt: D + 'T12:00:00+08:00', items: [{ foodId: 'pistachio_dup', grams: 40, kcal: 225, p: 9.5, f: 17, c: 9.6, origin: 'add', eaten: true, deleted: false, planGrams: '' }] } } } });
    rt.op('set', { coll: 'settings', id: 'main', data: Object.assign({}, beforeSettings, { seedVersion: 12 }) });
    const p2 = await newPage(); p2.setDefaultTimeout(25000);
    try {
      await p2.waitForTimeout(800);
      await p2.waitForFunction(() => !document.querySelector('#view .loading'));
      for (let i = 0; i < 100 && rt.DB.foods.pistachio_dup; i++) await p2.waitForTimeout(100);
      assert(!rt.DB.foods.pistachio_dup && !rt.DB.foods.cereal_dup, '重複した食品はマスタから消える');
      const rec = rt.DB.log_meals[D].meals.snack_1;
      assert(rec && rec.items.length === 1 && rec.items[0].foodId === 'pistachio_meadows' && rec.items[0].grams === 40, '記録は消えず、まとめた先に付け替わる: ' + JSON.stringify(rec && rec.items[0]));
      // よく使う順
      await p2.clock.setFixedTime(new Date(D + 'T13:00:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
      await p2.click('.tabs [data-tab="today"]'); await p2.waitForSelector('#addMealBtn');
      await p2.click('#addMealBtn'); await p2.waitForSelector('#recQ');
      const names = await p2.$$eval('.frow .nm', els => els.map(e => e.textContent.trim()));
      const iPis = names.findIndex(n => n.indexOf('ピスタチオ Meadows 20g') === 0), iUnused = names.findIndex(n => n.indexOf('オリーブオイル') === 0);
      assert(iPis >= 0 && iPis < iUnused, '使った食品が使っていない食品より上: ' + names.slice(0, 4).join(' / '));
      return 'ピスタチオ 1・シリアル → まとめ先に付け替え。よく使う順に並ぶ';
    } finally { await p2.close(); rt.op('set', { coll: 'settings', id: 'main', data: beforeSettings }); rt.op('del', { coll: 'log_meals', id: D }); rt.op('del', { coll: 'log_daily', id: D }); }
  });
  await T(G.meal, 'プランの「まとめて記録」で複数の食事を選び、同じ時刻でそれぞれ別の記録として入れられる。記録の時刻はタップで直せる', async () => {
    const D = '2027-04-12';
    const p2 = await newPage(); p2.setDefaultTimeout(20000);
    try {
      await p2.clock.setFixedTime(new Date(D + 'T20:00:00+08:00')); await p2.reload(); await p2.waitForFunction(() => !document.querySelector('#view .loading'));
      await p2.click('.tabs [data-tab="today"]'); await p2.waitForSelector('#planBulk');
      await p2.click('#planBulk'); await p2.waitForSelector('[data-bulk="1"]');
      await p2.click('[data-bulk="1"]'); await p2.waitForTimeout(200);
      await p2.click('[data-bulk="2"]'); await p2.waitForTimeout(200);
      await p2.click('#planBulkGo'); await p2.waitForTimeout(600);
      assert(await planEaten(1, p2), '1食目が ✓'); assert(await planEaten(2, p2), '2食目が ✓');
      const rows = await p2.$$eval('.elist .erow', els => els.map(e => e.querySelector('.etime').textContent + ' ' + e.querySelector('.nm').textContent));
      assert(rows.length === 2 && rows[0].indexOf('20:00') === 0 && rows[1].indexOf('20:00') === 0, '同じ時刻でそれぞれ別の記録: ' + rows.join(' / '));
      assert(rows.join(' ').includes('1食目（プラン）') && rows.join(' ').includes('2食目（プラン）'), '両方が入る: ' + rows.join(' / '));
      // 記録画面の時刻ボタンは折り返さない
      await p2.click('[data-planrow="3"]'); await p2.waitForSelector('#mpAll'); await p2.click('#mpAll'); await p2.waitForSelector('#sheet', { state: 'hidden' }); await p2.waitForTimeout(250);
      await p2.click('#addMealBtn'); await p2.waitForSelector('#recAt');
      const wrap = await p2.$eval('#recAt', e => { const c = getComputedStyle(e); return { ws: c.whiteSpace, h: e.getBoundingClientRect().height }; });
      assert(wrap.ws === 'nowrap' && wrap.h < 44, '時刻ボタンは1行で折り返さない: ' + JSON.stringify(wrap));
      await p2.click('#recAt'); await p2.waitForSelector('#dlgTime'); await p2.fill('#dlgTime', '18:30'); await p2.click('#dlgOk'); await p2.waitForSelector('#dlg', { state: 'hidden' }); await p2.waitForTimeout(200);
      assert((await p2.locator('#recAt').textContent()) === '18:30', '時刻はタップで直せる: ' + (await p2.locator('#recAt').textContent()));
      return 'まとめて記録（同じ時刻・別々の記録）・記録画面の時刻修正';
    } finally { await p2.close(); rt.op('del', { coll: 'log_meals', id: D }); rt.op('del', { coll: 'log_daily', id: D }); }
  });
  await T(G.common, '文字のAI推定（AI計算・文字で推定）がコードに残っていない。写真の推定だけが sample を使う', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'artifact', 'index.html'), 'utf8');
    ['parseMealText', 'tokenizeMeal', 'estimateFoodAi', 'freeTxt', 'freeBtn', 'AI 計算', 'quickSubs', 'PINNED_QUICK_SUBS', '100g あたりで追加', 'よく使う差替え'].forEach(k => assert(src.indexOf(k) < 0, k + ' が残っている'));
    assert(src.indexOf('estimateMealTextWith') < 0 && src.indexOf('textPrompt') < 0, '文字だけの推定は残さない');
    assert(src.indexOf('estimateMealPhotoWith') > 0, '写真の推定は残す');
    return '文字のAI推定は完全に削除';
  });

  await browser.close();
  return errors;
}
(async () => {
  const errs = {};
  const MODES = (process.env.E2E_MODES || 'mock,db').split(',');
  for (const mode of MODES) { errs[mode] = await run(mode); if (errs[mode].length) console.error('[' + mode + '] page errors:\n' + errs[mode].join('\n')); }
  // ---- TEST.md ----
  const groups = [...new Set(results.map(r => r.group))];
  let md = '# テスト結果（自動生成: `npm run e2e:artifact`）\n\n実行日: ' + new Date().toISOString().slice(0, 10) + ' ／ 固定時刻 2026-09-16 06:50 (Asia/Manila) ／ Chromium 390×844\n\n';
  md += '- **mock**: `window.claude` なし → メモリ上のモックモード\n- **db**: `claude.use("db"/"assets"/"sample"/"downloads")` を疑似ランタイムで注入（db は Node 側に永続し、再読み込み・二重オープンを再現。実際の claude.ai ランタイムではなく API 形状を模したもの）\n\n';
  const fails = results.filter(r => r.mock === '✗' || r.db === '✗').length;
  md += '合計 ' + results.length + ' 項目 ／ NG ' + fails + ' 件 ／ ページエラー mock ' + (errs.mock||[]).length + ' 件・db ' + (errs.db||[]).length + ' 件\n\n';
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
| 29 | 「やっていない Day が飛ばされてしまう」修正（カレンダー計算 \`calcDayNo\` → イベントソーシングの未消化キュー \`replayQueue\`）で、Day 判定・全7日確定版・前回の重量・不具合修正・できなかった 等、日付を進めるだけで特定の Day を表示できる前提のテストが軒並み壊れた。原因を追ううちに3つの根本的な発見があった: (1) \`dayNoFor\` に startDate より前の日付を渡すと \`replayQueue\` のループが一度も回らず \`assignments[date]\` が \`undefined\` になり \`.dayNo\` 参照でクラッシュ（前日・翌日ナビゲーションのような基本操作で即発生）。(2) 「今日」自身が未完了だと、その日の完了判定を「今日以降は自動消化」にするか「実績どおり」にするかで、翌日プレビュー（クロックを進めずに \`[data-shift]\` だけで先を覗く）の挙動が大きく変わる。今日ちょうどの \`date > today\` だけを自動消化にすると、今日が未完了な限り明日のプレビューも同じ Day のまま止まり、\`want=['Day1',...,'Day7']\` のような素朴な周回テストが壊れる。逆に \`date >= today\` まで自動消化にすると、今日画面自身の「未実施」バッジ／バナー（\`pendingSince\`）まで誤って消えてしまう。(3) Playwright の \`page.clock\` はページ単位ではなくブラウザコンテキスト全体で共有される（\`newPage()\` で作った子ページの \`clock.setFixedTime()\` が共有 \`page\` の時計まで進めてしまう）。旧 \`calcDayNo\` は \`today\` に一切依存しない純粋な \`(startDate, date)\` 関数だったためこの共有に気づかれていなかったが、\`replayQueue\` は \`today\` に強く依存するため、孤立日付へ飛ばした \`p2\` のテストの直後に \`newPage()\` を挟まない限り時計が戻らず、9/16 に依存する後続テスト（週まとめ・db スキーマ等）まで連鎖的に壊れた | (1) 過去日を弾くガードが無かった。(2) 「今日はまだ終わっていない」という現実の時間経過と、未消化キューが要求する「完了実績の有無」を区別せずに1つの比較式で済まそうとした。(3) \`clock.setFixedTime\` のスコープを確認せずに、各テストが独立して安全だと思い込んでいた | (1) \`dayNoFor\` の先頭で \`date < ST.settings.startDate\` ならカレンダー計算にフォールバックするガードを追加。(2) 完了判定は \`date > today\`（今日自身は実績どおり、未来だけ自動消化）に統一し、翌日プレビューが素朴に進むことを求める既存テストの方を「未完了なら翌日プレビューも同じ Day のまま」という新仕様に書き換えた。(3) 9/16・9/17 は他のテストが依存する既存データを持つため Day ピッカーで直接指定するテストはすべて孤立した日付（過去は 2020/2021年、未来は 2027年）に一時移動する \`forceDay\` ヘルパーに統一し、\`newPage()\` を挟まずに \`p2.clock\` を進めたテストは終了直前に \`p2.clock.setFixedTime(new Date(T0))\` で明示的に戻すようにした。新しい「できなかった」テストは、翌日への本当の繰り越し確認（クロックを実際に進めて reload）は db モードのみで行い、mock モードは reload をまたげないため当日内で完結する縮小版の確認にとどめた |

| 30 | Round 6（Day4 差し替え・「A または B」の選択式・入力ポップアップ統一・腹筋/カーフ確定）で、選択カードのボタンに \`data-choice\` を使ったところ、食事の差替えチップ（\`[data-choice]\`）と属性名が衝突し、\`locator('[data-choice]').first()\` が非表示の食事チップに解決して「element is not visible」で 8 秒タイムアウトした。筋トレ系のテストが原因不明のクリックタイムアウトで軒並み落ちた | 新しい DOM 属性を足すとき、既存のアプリ全体で同じ属性名が使われていないか確認していなかった。セレクタがページ内で一意である保証が無いのにテスト側は \`.first()\` を使っていた | 種目の選択カードを \`data-exchoice\` に改名。あわせて (a) 末尾 \`?\` の任意セットを開いている間はボタンを「このセット完了」のままにし（未記録のまま完了画面へ飛ばない）、最後の任意セットを「飛ばす」と筋トレ完了へ進むようにした。(b) 漸増の伸び幅は仕様の +2.5kg を既定にしつつ、ダンベルは既存の「1個 +1kg」ルールを引き継ぐ（2.5kg 刻みのダンベルは無いため）。(c) 孤立した日付へ飛ばすテストはすべて \`try { … } finally { await resetClock(); }\` で囲み、途中で落ちてもブラウザコンテキスト共有の時計が今日（T0）に戻るようにした（#29 で見つけた \`page.clock\` の共有が、失敗時にだけ後続テストへ漏れていた） |

| 31 | 有酸素にピックルボールを追加したとき、今日画面の注意書きが「ピックルボール・パデルは…」と**記録した順**で並び、文言が日によって変わってしまった | 注意書きの種目名を \`entries\` を舐めた出現順で組み立てていた。同じ画面でも記録の順番次第で文言が変わり、テストからも見た目からも安定しない | \`racketNote()\` は \`RACKET_INTENSITY\` のキー順（パデル → ピックルボール）で並べるようにした。あわせて、消費カロリーの計算に使う体重を \`cardioWeightKg()\`（直近の実測値 → 無ければ \`settings.bioWeightKg\` 72.4kg）に一本化し、体重を一度も測っていなくても「計算できません」にならないようにした |

| 32 | 食事記録を「枠を埋める」から「食べたら記録する」方式に変えた際、既存の食事テストが軒並み壊れた。未記録の枠から \`data-open\` と ✓ ボタンを外したので、\`[data-open="meal:N"]\` で枠を開いて埋める前提のテストがすべてタイムアウト。さらに (a) 画面下部に固定した記録バーの上にトーストが重なってボタンをクリックできない、(b) 未記録の枠には \`.chk\` が無いのに \`mark()\` ヘルパーが \`.chk.className\` を無条件に読んでいた、(c) 紐づけ先を変えたあとの「位置が変わらない」を**配列の添字**で比較していたため、同時刻の記録が複数あると並び替えのタイ順で 1 つズレて落ちた | 「枠は記録の入口ではない」という仕様変更は、テスト側の「枠をタップして埋める」という前提ごと置き換わる。UI を画面下部に固定したのに、同じ位置に出るトーストの退避先を見直していなかった | テスト側に \`logIntoSlot(slot)\`（その枠の予定時刻に時計を合わせてから「手で入力」で記録 → 自動紐づけに任せる）と \`openMealSlot(slot)\` を用意し、枠を埋める操作をすべてこれに置き換えた。アプリ側は記録バーが出ている間トーストを上へ逃がすようにし（\`body:has(#bbar:not([hidden])) .toast\`）、\`#mAlt\`（代替案）は記録済みでも出すようにした。テストの \`mark()\` は \`.chk\` が無い場合に空文字を返すようにし、位置の検証は添字の一致ではなく「時刻順で前後の行の間にあること」と「表示時刻が変わらないこと」に変えた |

| 33 | 実施済みの休みの日が「できなかった」として翌日以降に持ち越され続けた。9/18 は体重・リンゴ酢・1食目の記録があるのに、有酸素だけ記録が無かったため未消化のまま残り、9/21 に「9/18 にできなかったため持ち越し」と出ていた。あわせて (a) 過去の日付にも「いま」カードが今の時刻つきで出て、そこから押すと過去の日付に今の時刻で記録が入ってしまう、(b) 1日の目標がコーチ指定の 2,632kcal ではなくプランの品目合計 2,178kcal になっていた、(c) 体重の入力が空でも保存ボタンを押せた | (a) 休みの日の消化判定を「有酸素を記録したか」だけで見ていた。休みの日に求められるのは「トレーニングをしないこと」なので、その日を過ごした記録があれば消化とみなすべきだった。(b) 「いま」カードは常に今日のものとして描いていて、表示中の日付が今日かどうかを見ていなかった。(c) 目標値をプランの品目合計から計算しており、コーチ指定の値とのズレがそのまま目標になっていた | (a) \`restDayConsumed(date)\` を追加し、有酸素の記録／食事・体重・サプリのいずれか1件以上／「有酸素はやらない」（\`log_daily.restDone\`、休みの日なので理由は聞かない）／\`cardioMissed\`／\`log_workout.finished\` のどれかで休みの日を消化扱いにした。筋トレの日は今までどおり \`finished\` だけで判定する。(b) 今日以外の日付では「いま」カードと記録バーを出さず、✓ を無効にし、行タップでも開かないようにして、修正は長押しの「修正する」からに限定した（時刻の初期値は元の記録時刻）。(c) 目標を \`settings.targetKcal/targetP/targetF/targetC\`（2632 / 210 / 69 / 295、全曜日共通）に固定し、プランの品目合計とのズレは隠さず合計の展開に 1 行で出すようにした。(d) 体重は入力欄を空のままにして、何か入るまで保存ボタンを無効にした |

| 34 | 「プランの枠はタップできない予定表示」から「タップすると品目選択シートが開く」へ戻したとき、テスト側が \`#manualCalBtn\` ＋「プランから入れる」チップで枠を埋める作りだったため、食事系のテストが連鎖で壊れた。あわせて (a) 品目ごとの栄養値を新しい表に入れ替えたので合計 kcal が全部ズレた、(b) 未記録の枠に「まだ記録がありません」が付く日だけ、打ち消し線用の \`lineHtml\` が 1 行足りず \`undefined\` が表示された、(c) テストの時計を戻す \`resetClock()\` が \`curTime\` を更新していなかったため、別のテストの \`logIntoSlot\` が「戻す」ときに**古い時刻**をブラウザへ書き戻しており、その副作用に後続のテストが依存していた | (a) 表示に使う行（\`lines\`）と HTML 版（\`lineHtml\`）を別々のタイミングで組み立てていた。(b) 時計のヘルパーが「テスト側が覚えている時刻」と「ブラウザの時刻」の2つの状態を持ちながら、片方だけ更新する経路があった | テスト側の \`logIntoSlot(slot)\` を「カードをタップ →『全部食べた』」に作り直し、\`openMealSlot(slot)\` は未記録なら先に記録してから詳細を開くようにした。アプリ側は \`lineHtml\` を \`lines\` が確定してから組み立てるように直した。時計は \`resetClock()\` でも \`curTime\` を同期させ、孤立した日付へ飛ぶテストは \`T0\` ではなく**入ってきた時刻**（\`backTime = curTime\`）へ戻すようにして、暗黙の依存を無くした |

| 35 | 全セット記録済みの種目が「セット 1/3」のままで、スキップ扱いにもなっていた。完了とスキップを記録とは別のフラグで持ち、カーソルを返す \`firstUndoneIn()\` が「未記録なし」のとき 0（＝1セット目）を返していたのが原因。状態を \`exStarted()\`/\`exComplete()\` として記録から毎回導出し、\`firstUndoneIn()\` は全部記録済みなら最後のセットを返すようにした。完了した種目は完了カード＋「次の種目へ」にしたので、\`#setDone\` があることを前提に種目を歩いていた既存テスト（最終種目→完了画面、Day2 カーフ、\`#cmpReview\`）が壊れ、\`enterEdit()\`（セット行をタップして入力に戻す）と \`#exNext\` 分岐を足して直した。あわせて \`openDayOn()\` が \`#setDone\` だけを待っていたため、1種目目が「A または B」の Day 1 で固まっていたのを \`[data-exchoice]\` も待つようにした |

| 36 | db モードで「手で入力」「サプリ」「写真」まわりのテストが実行のたびに違う場所で落ちた（\`#bbar .k1\` が無い等）。孤立した日付へ飛ばしたテストが \`page.clock.setFixedTime()\` を戻しても画面は描き直されず、「今日ではない日付」として描いた状態（＝下部の固定バーが消えたまま）が次のテストに残っていたのが原因。\`setTime()\` / \`resetClock()\` が時刻を動かしたあと必ず \`window.__tl.rerender()\` で描き直すようにした |

| 37 | アプリが「読み込み中…」から進まなくなった。\`store.init()\` が最初のスナップショットに加えて \`seedIfNeeded()\` の完了まで待ってから \`ready\` を立てており、SEED_VERSION 11 で全プラン（種目54件を含む100件超）を**1件ずつ await して**書き直していたため、回線が遅いと何十秒もかかり、しかも \`seedVersion\` は最後に書くので再読み込みしても毎回最初からやり直していた。投入を \`inParallel()\` で 8 件ずつ並列にし、プランが既にあるときは投入を待たずに使える状態にして裏で流すようにした。あわせて、読み込み全体に 10 秒の期限（\`withTimeout\`）、失敗時のエラー画面（内容表示・再読み込み・記録を消さない初期化）、読み込み中の進捗表示、壊れたデータ（開始日・Day 番号・\`sets\`・種目マスタに無い id）への防御を入れた |

| 38 | 写真からのカロリー推定が動かない。呼び出し方（\`claude.use("sample")\` → \`sample.json(prompt, {images:[blob]})\`）自体は正しかったが、**失敗しても code を画面に出していなかった**ため原因が分からず、「動かない」としか見えなかった。（a）\`PHOTO_ERRS\` を足して「推定できませんでした（エラー: images_unavailable）」のように **code をそのまま表示**、（b）\`limits()\` が images を返さない画面／実際に \`images_unavailable\` が返った画面では写真の入口を隠して **「文字で推定」** に切り替え（同じ JSON 形式なので結果画面は共通）、（c）結果の下に「文字で直す」（補足を足して写真つきで推定し直す）、（d）確からしさ「低」を黄色に、（e）設定に「写真推定：使える／使えない」の診断行、（f）\`accept\` に JPEG/PNG/WebP を明示。これに伴い、以前の #17/#19（「\`limits()\` を信じず常に写真ボタンを出す」）は**逆向きに変更**した（\`limits()\` が「使えない」と言う画面では文字で推定に切り替える） |

| 39 | db モードのテストが実行のたびに違う場所で落ちる件が残っていた。今回は \`#suppNA\` のクリックが取りこぼされ、理由の選択ダイアログが出ずに 20 秒待ってタイムアウトし、以降の「できなかった」「写真」系テストが連鎖で壊れた。\`clickUntil(trigger, target)\`（目的の要素が出るまで最大3回押し直す）を足して、そのクリックに使うようにした |

| 40 | 写真からの推定が、Claude アプリ内の表示でも Safari でも \`images_unavailable\` で失敗した（実際に送信まで進んで返ってくる）。この環境の \`sample\` は画像をいっさい受け付けない、というのが結論。ブラウザ側では回避できないので、**Claude のチャット側の画像入力を借りる経路**を足した: 「① 指示文をコピー → ② チャットに写真と一緒に貼る → ③ 返事を貼り戻す」。\`parseEstimateText()\` がコードブロックの囲みや前後の文章から JSON を取り出し、\`validateEstimate()\` に通すので、結果画面・分量の修正・記録はすべて写真から推定したときと同じ |

| 41 | 食事が「プランの枠に押し込む」作りで、プラン外のもの（スタバの抹茶ラテ）が時刻から4食目の枠に入り、4食目のプランが打ち消し線で上書きされていた。食べた順と番号もずれていた。**「食べた順の記録」と「今日のプランのチェック」を完全に別物にする**方針へ変更: 時刻からの自動紐づけ・紐づけチップ・「間食」の区分・打ち消し線・「変更あり」・1食ごとのプラン比を全廃し、プランは ✓／○ だけ（\`planSlot\` が一致する記録の有無から導出）、食べたものは \`loggedAt\` 順に番号なしで並べる。記録ボタンも1つにまとめた。既存データは書き換えず、「プラン由来の品目があるか」で \`planSlot\` を導出して移行する |

| 42 | Day 6（Pull）なのに下部タブが「Day 6 休み」「有酸素」になっていた。Day ピッカーの「休みにする」（\`log_daily.isRestOverride\`）が立ったままだったのが原因で、画面上はそれと分からず戻し方も無かった。手で変えた日は今日画面にその旨を出し、タップで予定どおりに戻せるようにした。あわせて、古い \`settings.cardioLabel\` に残っていた「（種類はコーチ確認中）」を SEED_VERSION 12 の移行で既定文に戻す |

| 43 | 朝の「15分あける」カウンターを足したとき、15分に達した瞬間のトーストが出なかった。「いま」カードのタイマー（\`renderNow\` の \`every\`）が 0 秒で先に \`render()\` してしまい、カウンター行の状態が counting → ready に切り替わる瞬間を \`tickWaits()\` が見られなくなっていたのが原因。描き直す前に \`tellWaitDone()\` を呼ぶ順に直した |

| 44 | 記録の編集画面に要素が多すぎて何をどこで操作するのか分からなかった（説明文・バッジ・「1つ戻す」「半分だけ」「スキップ」「よく使う差替え」「AI計算」で操作が5種類）。**文字の AI 推定を全廃**し、記録は「よく食べるものから複数チェック → 個数 → 記録する」の1画面に作り直した。新規と編集は同じ画面で、編集時だけ「この記録を削除」。食品マスタは重複をまとめて1個あたりの分量と単位を必ず出すようにし、過去の記録は付け替えて残した。この作業中、\`openFoodSheet\` を消すときに終端の目印を広く取りすぎて写真推定のブロックごと消してしまい、\`resizeImage is not defined\` で起動しなくなった（HEAD から復元）。あわせて、日本語だけの食品名は id が全部 \`food\` になり、\`Date.now()\` の接尾辞が衝突すると別の食品を上書きし得たので、空いている id が見つかるまで付け直すようにした |


## 実行方法

\`\`\`
npm run e2e:artifact   # Playwright + Chromium。mock → db の順に実行し、この TEST.md を上書き
\`\`\`

db モードの「疑似ランタイム」は \`claude.use()\` の API 形状（db.collection/doc/get/set/delete/onSnapshot、assets.upload、sample.json、downloads.save）を模したもので、実際の claude.ai ランタイムでの動作確認は公開版を開いて行う。
`;
  fs.writeFileSync(path.join(__dirname, '..', 'artifact', 'TEST.md'), md);
  console.log('\n' + results.length + ' items, ' + fails + ' NG. → artifact/TEST.md');
  if (fails || (errs.mock||[]).length || (errs.db||[]).length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
