'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeContext } = require('./gas-mock');

test('dist/Code.gs 単一ファイル版でも setupSheets / getToday / include が動く', () => {
  const g = makeContext({ bundle: true });
  g.setupSheets();
  assert.equal(g.readRows_('plan_exercises').length, 30);
  const t = g.getToday('2026-09-16');
  assert.equal(t.day_name, 'Push');
  assert.ok(g.BUNDLED_FILES.Index.includes("<?!= include('Styles') ?>"));
  assert.ok(g.include('Styles').startsWith('<style>'));
  assert.ok(g.include('AppJs').includes('google.script.run'));
  assert.equal(typeof g.module, 'undefined');
});
