'use strict';
/** Artifact 版のモックモード E2E: node test/artifact-e2e.js  → test/screens/art-*.png */
const path = require('path');
const fs = require('fs');
let playwright; try { playwright = require('playwright'); } catch (e) { playwright = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); }
const file = 'file://' + path.join(__dirname, '..', 'artifact', 'index.html');
const outDir = path.join(__dirname, 'screens'); fs.mkdirSync(outDir, { recursive: true });
(async () => {
  const browser = await playwright.chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: 'Asia/Manila' });
  await page.clock.setFixedTime(new Date('2026-09-16T06:50:00+08:00'));
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts.googleapis|ERR_/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto(file);
  const shot = async n => { await page.waitForTimeout(200); await page.screenshot({ path: path.join(outDir, 'art-' + n + '.png'), fullPage: true }); };
  const text = async s => (await page.locator(s).first().textContent()).trim();
  const ok = (c, m) => { if (!c) { errors.push('assert: ' + m); console.error('FAIL', m); } else console.log('ok  ', m); };

  await page.waitForSelector('#now .t');
  ok((await text('h1')).startsWith('Day 1 ・ Push'), 'home Day1');
  ok((await text('#now .t')) === '体重を測る', 'now=体重');
  await shot('01-home');
  await page.fill('#nowW', '72.4'); await page.click('#nowBtn');
  await page.waitForFunction(() => document.querySelector('#now .t').textContent.includes('リンゴ酢'));
  ok((await text('.step.done .v')).startsWith('72.4kg'), 'weight in timeline');
  await page.click('#nowBtn');
  await page.waitForSelector('#nowTimer');
  ok((await text('#now .t')) === '1食目まで', 'timer to meal1');
  await shot('02-home-timer');
  await page.click('#nowBtn'); // 食べる画面
  await page.waitForSelector('#mPlan');
  ok((await text('h1')) === '1食目', 'meals opened meal1');
  await page.click('#mChange'); await page.fill('#freeTxt', 'サーモン150 米150'); await page.click('#freeBtn');
  await page.waitForSelector('.badge.warn');
  ok((await text('.badge.warn')).includes('変更して記録済み'), 'free text logged (local match)');
  await shot('03-meal');
  await page.click('[data-msel="2"]'); await page.waitForSelector('#mPlan'); await page.click('#mPlan');
  await page.waitForFunction(() => document.querySelector('[data-msel="2"]').textContent.includes('✓'));
  ok((await text('h1')) === '3食目', 'plan done → next meal');
  // 筋トレ
  await page.click('.tabs [data-tab="workout"]'); await page.waitForSelector('#setDone');
  ok((await text('.ex-name')).includes('ケーブルフライ'), 'workout first exercise');
  await page.evaluate(() => { const e = document.querySelector('#wv'); e.dataset.v = '20'; e.textContent = '20'; });
  await page.click('#setDone');
  await page.waitForSelector('#rest:not([hidden])');
  ok((await text('#rnext')).includes('次：'), 'rest timer');
  await shot('04-workout-rest');
  await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden])');
  ok((await text('.setlist .ok')).includes('✓'), 'set1 done chip');
  await page.click('[data-ex="1"]'); await page.waitForSelector('#setDone');
  ok((await text('.ex-name')).includes('インクライン'), 'next exercise');
  await page.click('#noteBtn'); await page.fill('#exNote', 'right shoulder slight discomfort'); await page.click('[data-r="8"]'); await page.click('#exSave');
  await page.waitForSelector('#sheet', { state: 'hidden' });
  ok((await text('#noteBtn')).includes('●'), 'note saved');
  // 週
  await page.click('.tabs [data-tab="summary"]'); await page.waitForSelector('#repText');
  const rep = await text('#repText');
  ok(rep.startsWith('Week 1 (Sep 16–22) Report') && rep.includes('Weight: 72.4'), 'report');
  ok(rep.includes('Notes: Incline DB press: right shoulder'), 'report notes');
  await shot('05-summary');
  await page.click('.tabs [data-tab="today"]'); await page.waitForSelector('.tl');
  const steps = await page.$$eval('.step', els => els.map(e => e.className));
  ok(steps[0].includes('done') && steps[1].includes('done') && steps[2].includes('done'), 'home first 3 done');
  await browser.close();
  if (errors.length) { console.error('\nERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('\nArtifact E2E OK');
})().catch(e => { console.error(e); process.exit(1); });
