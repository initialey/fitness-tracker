'use strict';
/**
 * src/ の全ファイルを 1 つの Code.gs に束ねる。
 * Apps Script エディタに貼るファイルを 1 つにするためのもの。
 *   node scripts/build-bundle.js  → dist/Code.gs
 */
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'src');
const out = path.join(__dirname, '..', 'dist', 'Code.gs');
const files = fs.readdirSync(src).sort();
const js = files.filter(f => f.endsWith('.js'));
const html = files.filter(f => f.endsWith('.html'));

let bundle = '';
bundle += '/**\n * Training Log — 単一ファイル版（自動生成: node scripts/build-bundle.js）\n';
bundle += ' * Apps Script エディタの Code.gs にこのファイル全体を貼り付けて保存し、setupSheets を実行する。\n */\n\n';
for (const f of js) {
  let body = fs.readFileSync(path.join(src, f), 'utf8');
  // Node テスト用の module.exports 行は不要
  body = body.replace(/^if \(typeof module !== 'undefined'\)[\s\S]*?\n}\n?/m, '').replace(/^if \(typeof module !== 'undefined'\) module\.exports = .*\n?/m, '');
  bundle += '// ===== ' + f + ' =====\n' + body.trim() + '\n\n';
}
bundle += '// ===== HTML files (Index / Styles / AppJs) =====\n';
bundle += 'var BUNDLED_FILES = {\n';
bundle += html.map(f => '  ' + JSON.stringify(f.replace(/\.html$/, '')) + ': ' + JSON.stringify(fs.readFileSync(path.join(src, f), 'utf8'))).join(',\n');
bundle += '\n};\n';
fs.writeFileSync(out, bundle);
console.log('wrote', path.relative(process.cwd(), out), (bundle.length / 1024).toFixed(0) + 'KB');
