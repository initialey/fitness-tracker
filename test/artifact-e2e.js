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
  page.on('dialog', d => d.accept(d.type() === 'prompt' ? '時間がない' : undefined));
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto(file);
  const shot = async n => { await page.waitForTimeout(200); await page.screenshot({ path: path.join(outDir, 'art-' + n + '.png'), fullPage: true }); };
  const text = async s => (await page.locator(s).first().textContent()).trim();
  const ok = (c, m) => { if (!c) { errors.push('assert: ' + m); console.error('FAIL', m); } else console.log('ok  ', m); };

  // ---- 今日 ----
  await page.waitForSelector('#now .t');
  ok((await text('h1')).startsWith('Day 1 ・ Push'), 'home Day1');
  ok((await text('#now .t')) === '体重を測る', 'now=体重');
  const rows = await page.$$eval('.step', els => els.map(e => e.textContent));
  ok(rows.some(r => r.includes('全卵4個・卵白150g・塩1g')), 'meal1 row lists full items');
  ok(rows.some(r => r.includes('クレアチン・マグネシウム・フィッシュオイル・亜鉛・アシュワガンダ・B12+D3・ベルベリン')), 'supp row lists all 7 names');
  ok(rows.some(r => r.includes('ウォームアップ 6種')) && rows.some(r => r.includes('腕を前後に振る・腕を交互に振る')), 'warmup row present with contents');
  ok(rows.some(r => r.includes('筋トレ Day1 Push ・ 6種目 ・ 約60分') && r.includes('ケーブルフライ')), 'workout row lists exercises');
  ok(rows.some(r => r.includes('白米200g（炊飯後基準）')), 'rice basis shown');
  ok(!rows.some(r => r.includes('…')), 'no ellipsis');
  ok(!(await page.$('.tabs [data-tab="meals"]')), 'no meals tab');
  ok((await text('.card .ttl')).includes('1日合計'), 'totals block on today');
  await shot('01-home');
  await page.fill('#nowW', '72.4'); await page.click('#nowBtn');
  await page.waitForFunction(() => document.querySelector('#now .t').textContent.includes('リンゴ酢'));
  await page.click('#nowBtn'); await page.waitForSelector('#nowTimer');
  ok((await text('#now .t')) === '1食目まで', 'timer to meal1');
  // 食事シート
  await page.click('[data-open="meal:1"]'); await page.waitForSelector('#mPlan');
  ok((await text('.sheet-body .items')).includes('全卵4個（約200g）'), 'meal sheet shows full plan');
  await shot('02-meal-sheet');
  await page.click('#mChange'); await page.fill('#freeTxt', 'サーモン150 米150'); await page.click('#freeBtn');
  await page.waitForSelector('.sheet-body .badge.warn');
  ok((await text('.sheet-body .badge.warn')).includes('変更して記録済み'), 'free text logged in sheet');
  await page.click('#sheet', { position: { x: 5, y: 5 } }); await page.waitForSelector('#sheet', { state: 'hidden' });
  await page.click('[data-chk="meal:2"]');
  await page.waitForFunction(() => document.querySelector('[data-step="meal:2"]').className.includes('done'));
  ok(true, 'meal2 plan done via ✓');
  // 4食目 代替案
  await page.click('[data-open="meal:4"]'); await page.waitForSelector('#mAlt');
  ok((await text('#mAlt')).includes('白米150g・鶏胸肉100g・全卵1個'), 'meal4 alt option');
  await page.click('#mAlt'); await page.waitForSelector('#sheet', { state: 'hidden' });
  ok((await text('[data-step="meal:4"]')).includes('代替案で記録'), 'meal4 alt logged');
  // 5食目 ブロッコリー選択
  await page.click('[data-open="meal:5"]'); await page.waitForSelector('[data-choice="broccoli"]');
  await page.click('[data-choice="broccoli"]'); await page.click('#mPlan'); await page.waitForSelector('#sheet', { state: 'hidden' });
  await page.click('[data-open="meal:5"]'); await page.waitForSelector('.sheet-body .list');
  ok((await text('.sheet-body .list')).includes('ブロッコリー'), 'meal5 broccoli choice logged');
  await page.click('#sheet', { position: { x: 5, y: 5 } }); await page.waitForSelector('#sheet', { state: 'hidden' });

  // ---- 筋トレ: ウォームアップ必須 ----
  await page.click('.tabs [data-tab="workout"]'); await page.waitForSelector('#wuStart');
  ok((await text('.cur-set .n')).includes('ウォームアップ 6種'), 'workout starts with warmup');
  await page.click('#wuStart'); await page.waitForTimeout(100);
  ok(await page.$('#wuStart'), 'blocked until all checked');
  await shot('03-warmup');
  for (let i = 1; i <= 6; i++) { await page.click('[data-wu="' + i + '"]'); await page.waitForTimeout(30); }
  await page.waitForFunction(() => document.querySelectorAll('[data-wu].on').length === 6);
  await page.click('#wuStart'); await page.waitForSelector('#setDone');
  ok((await text('.ex-name')).includes('ケーブルフライ'), 'after warmup: first exercise');
  ok((await text('.ex-head .p')).includes('種目 1/6 ・ セット 1/3'), 'progress line');
  ok((await text('.cur-set .n')) === 'セット1 ／ ウォームアップ', 'current set card');
  ok((await text('.cur-set .p')).includes('軽めの重さで 12〜15回'), 'purpose sentence');
  ok((await text('.setrows')).includes('← いまここ') && !/\bWU\b|\bMAIN\b/.test(await text('.setrows')), 'set rows in Japanese');
  ok((await text('.ghost')).includes('初回なので目安なし'), 'first-time hint');
  await shot('04-workout-set');
  await page.click('[data-qk="10"]');
  ok((await text('#wv')) === '10', 'quick weight');
  await page.click('#setDone'); await page.waitForSelector('#rest:not([hidden])');
  ok((await text('#rnext')).includes('セット2 事前疲労'), 'rest shows next set in Japanese');
  await page.click('#skipRest'); await page.waitForSelector('#setDone:not([hidden])');
  ok((await text('.setrows .sr.done .rv')).includes('10kg×12'), 'done row shows actual');
  await page.click('#glossBtn'); await page.waitForSelector('.glossary');
  ok((await text('.glossary')).includes('バックオフ'), 'glossary');
  await page.click('#glClose'); await page.waitForSelector('#sheet', { state: 'hidden' });

  // ---- 週 ----
  await page.click('.tabs [data-tab="summary"]'); await page.waitForSelector('#repText');
  const rep = await text('#repText');
  ok(rep.includes('Warm-up: 1/1'), 'report warmup');
  ok((await text('.hist')).includes('Day1'), 'history table');
  ok(!(await page.$('#mPlan')), 'no daily input on summary');
  await shot('05-summary');
  await page.click('.tabs [data-tab="today"]'); await page.waitForSelector('.tl');
  ok((await text('[data-step="warmup"]')).includes('ウォームアップ'), 'warmup row done state ' + (await page.$eval('[data-step="warmup"]', e => e.className)));
  await shot('06-home-progress');
  await browser.close();
  if (errors.length) { console.error('\nERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('\nArtifact E2E OK');
})().catch(e => { console.error(e); process.exit(1); });
