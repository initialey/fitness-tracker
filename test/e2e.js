'use strict';
/**
 * ブラウザ E2E（手動実行）: node test/e2e.js
 * Index.html を GAS 風に組み立て、google.script.run を Node の GAS モックへ橋渡しして各画面を操作・撮影する。
 * スクリーンショットは test/screens/ に出る。
 */
const fs = require('fs');
const path = require('path');
const { makeContext } = require('./gas-mock');
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); }

const src = path.join(__dirname, '..', 'src');
const outDir = path.join(__dirname, 'screens');
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const g = makeContext({ now: new Date('2026-09-16T06:50:00+08:00') });
  g.setupSheets();
  const html = fs.readFileSync(path.join(src, 'Index.html'), 'utf8')
    // 置換文字列中の "$'" などが特殊パターンにならないよう関数で置換する
    .replace("<?!= include('Styles') ?>", () => fs.readFileSync(path.join(src, 'Styles.html'), 'utf8'))
    .replace("<?!= include('AppJs') ?>", () => fs.readFileSync(path.join(src, 'AppJs.html'), 'utf8'))
    .replace('<?!= bootstrap ?>', () => JSON.stringify(g.bootstrap_()))
    // google.script.run の代わりに Node 側の GAS モックへ橋渡しするシム
    .replace('<script>window.BOOT', () => `<script>
      window.google = { script: { run: (function () {
        function mk(ok, ko) {
          return new Proxy({}, { get(_, name) {
            if (name === 'withSuccessHandler') return h => mk(h, ko);
            if (name === 'withFailureHandler') return h => mk(ok, h);
            return (...args) => window.__gas(name, args).then(r => { if (r.err) ko && ko(new Error(r.err)); else ok && ok(r.ok); });
          } });
        }
        return mk(null, null);
      })() } };
    </script><script>window.BOOT`);

  const browser = await playwright.chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: 'Asia/Manila' });
  // モックの「現在時刻」に合わせてブラウザの Date も固定（タイマーは動く）
  await page.clock.setFixedTime(new Date('2026-09-16T06:50:00+08:00'));
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.exposeFunction('__gas', (fn, args) => {
    try { const r = g[fn].apply(null, args); return { ok: r === undefined ? null : JSON.parse(JSON.stringify(r)) }; }
    catch (e) { return { err: e.message }; }
  });
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.setContent(html, { waitUntil: 'load' });
  const shot = async (name) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(outDir, name + '.png'), fullPage: true }); };
  const text = async (sel) => (await page.locator(sel).first().textContent()).trim();
  const assert = (c, m) => { if (!c) { errors.push('assert: ' + m); console.error('FAIL', m); } else console.log('ok  ', m); };

  // ---- 今日 ----
  try { await page.waitForSelector('#now', { timeout: 8000 }); } catch (e) { console.error('view:', (await page.locator('#view').innerHTML()).slice(0, 500)); console.error('toast:', await page.locator('#toast').textContent()); console.error('gas:', JSON.stringify(await page.evaluate(() => window.__gas('getToday', ['2026-09-16']).then(r => ({ hasGas: true, keys: Object.keys(r) })).catch(err => ({ err: String(err) })))).slice(0, 300)); console.error(errors.join('\n')); throw e; }
  assert((await text('h1')).startsWith('Day 1 ・ Push'), 'home: Day1 Push');
  assert((await text('#now .t')) === '体重を測る', 'home: now = 体重');
  await shot('01-home-weight');
  await page.fill('#nowW', '72.4');
  await page.click('#nowBtn');
  await page.waitForFunction(() => document.querySelector('#now .t') && document.querySelector('#now .t').textContent.includes('リンゴ酢'));
  assert((await text('.step.done .v')).startsWith('72.4kg'), 'home: weight logged in timeline');
  await page.click('#nowBtn'); // 飲んだ
  await page.waitForFunction(() => document.querySelector('#nowTimer'));
  assert((await text('#now .t')) === '1食目まで', 'home: timer to meal 1');
  await shot('02-home-timer');
  await page.click('#nowBtn'); // 食べる画面を開く
  await page.waitForSelector('#mPlan');
  assert((await text('h1')) === '1食目', 'meals: opened meal 1');
  await shot('03-meal');
  await page.click('#mChange');
  await page.fill('#freeTxt', 'サーモン150 米150');
  await page.click('#freeBtn');
  await page.waitForSelector('.badge.warn');
  assert((await text('.badge.warn')).includes('変更して記録'), 'meals: free text logged');
  await shot('04-meal-sub');
  await page.click('[data-msel="2"]');
  await page.waitForSelector('#mPlan');
  await page.click('#mPlan');
  await page.waitForFunction(() => document.querySelector('[data-msel="2"]') && document.querySelector('[data-msel="2"]').textContent.includes('✓'));
  assert((await text('h1')) === '3食目', 'meals: plan done → 次の食事へ');

  // ---- 筋トレ ----
  await page.click('.tabs [data-tab="workout"]');
  await page.waitForSelector('#setDone');
  assert((await text('.ex-name')).includes('ケーブルフライ'), 'workout: first exercise');
  await shot('05-workout');
  await page.click('[data-pm="w:1"]'); await page.click('[data-pm="w:1"]');
  await page.click('#wv', { trial: true });
  await page.evaluate(() => { const e = document.querySelector('#wv'); e.dataset.v = '20'; e.textContent = '20'; e.classList.remove('empty'); });
  await page.click('#setDone');
  await page.waitForSelector('#rest:not(.hidden)');
  assert((await text('#rnext')).includes('次：'), 'workout: rest timer shown');
  await shot('06-workout-rest');
  await page.click('#skipRest');
  await page.waitForSelector('#setDone');
  assert((await text('.setlist .ok')).includes('✓'), 'workout: set 1 marked done');
  assert(g.readRows_('log_workout').length === 1 && g.readRows_('log_workout')[0].weight_kg === 20, 'workout: set saved 20kg');
  await page.click('[data-ex="1"]');
  await page.waitForSelector('#setDone');
  assert((await text('.ex-name')).includes('インクライン'), 'workout: next exercise');
  await page.click('#noteBtn');
  await page.fill('#exNote', 'right shoulder slight discomfort');
  await page.click('[data-r="8"]');
  await page.click('#exSave');
  await page.waitForSelector('#sheet', { state: 'hidden' });
  assert(g.getWorkout('2026-09-16').exercises[1].rpe === 8, 'workout: rpe saved');

  // ---- 週 ----
  await page.click('.tabs [data-tab="summary"]');
  await page.waitForFunction(() => document.querySelector('#repText') && document.querySelector('#repText').textContent.startsWith('Week 1'));
  assert((await text('#repText')).includes('Weight: 72.4'), 'summary: report generated');
  await shot('07-summary');

  // ---- 今日（進行後） ----
  await page.click('.tabs [data-tab="today"]');
  await page.waitForSelector('.tl');
  await shot('08-home-progress');
  const steps = await page.$$eval('.step', els => els.map(e => e.className));
  assert(steps[0].includes('done') && steps[1].includes('done') && steps[2].includes('done'), 'home: first 3 steps done');

  await browser.close();
  if (errors.length) { console.error('\nERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('\nE2E OK. screenshots in test/screens/');
})().catch(e => { console.error(e); process.exit(1); });
