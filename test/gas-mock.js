'use strict';
/**
 * GAS グローバル（SpreadsheetApp / Utilities / LockService など）の最小モック。
 * src/*.js を 1 つの VM コンテキストに読み込み、サーバー API をそのまま実行できるようにする。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class Range {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = this.sheet.data[this.row - 1 + r] || [];
      out.push(Array.from({ length: this.cols }, (_, c) => (line[this.col - 1 + c] === undefined ? '' : line[this.col - 1 + c])));
    }
    return out;
  }
  setValues(vals) {
    vals.forEach((line, r) => {
      const idx = this.row - 1 + r;
      while (this.sheet.data.length <= idx) this.sheet.data.push([]);
      line.forEach((v, c) => { this.sheet.data[idx][this.col - 1 + c] = v; });
    });
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  clearContent() { for (let r = 0; r < this.rows; r++) { const idx = this.row - 1 + r; if (this.sheet.data[idx]) for (let c = 0; c < this.cols; c++) this.sheet.data[idx][this.col - 1 + c] = ''; } this.sheet.trim(); return this; }
  setFontWeight() { return this; }
  setNumberFormat() { return this; }
}

class Sheet {
  constructor(ss, name) { this.ss = ss; this.name = name; this.data = []; }
  getName() { return this.name; }
  trim() { while (this.data.length && this.data[this.data.length - 1].every(v => v === '' || v === undefined)) this.data.pop(); }
  getLastRow() { this.trim(); return this.data.length; }
  getMaxRows() { return Math.max(1000, this.data.length); }
  getRange(row, col, rows = 1, cols = 1) { return new Range(this, row, col, rows, cols); }
  getDataRange() { return new Range(this, 1, 1, Math.max(this.data.length, 1), Math.max(...this.data.map(r => r.length), 1)); }
  appendRow(row) { this.trim(); this.data.push(row.slice()); return this; }
  deleteRow(i) { this.data.splice(i - 1, 1); return this; }
  setFrozenRows() { return this; }
}

class Spreadsheet {
  constructor() { this.sheets = [new Sheet(this, 'Sheet1')]; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(this, n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
}

function pad(n) { return ('0' + n).slice(-2); }

function makeContext(opts = {}) {
  const ss = new Spreadsheet();
  const now = opts.now || new Date('2026-09-18T10:30:00+08:00');
  const folders = {};
  const files = {};
  const mkFolder = (name) => {
    const id = 'folder_' + name.replace(/[^a-z0-9]/gi, '_') + '_' + Object.keys(folders).length;
    const f = { id, name, folders: [], files: [], getId: () => id, getName: () => name,
      getFoldersByName: (n) => iter(f.folders.filter(x => x.name === n)),
      createFolder: (n) => { const c = mkFolder(n); f.folders.push(c); return c; },
      createFile: (blob) => { const fid = 'file_' + Object.keys(files).length; const file = { id: fid, blob, getId: () => fid, getUrl: () => 'https://drive.google.com/file/d/' + fid + '/view', setSharing: () => {} }; files[fid] = file; f.files.push(file); return file; } };
    folders[id] = f;
    return f;
  };
  const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  const rootFolders = [];
  const props = {};
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        // Asia/Manila 固定 (+08:00) の簡易実装
        const t = new Date(d.getTime() + 8 * 3600 * 1000);
        const map = { yyyy: t.getUTCFullYear(), MM: pad(t.getUTCMonth() + 1), dd: pad(t.getUTCDate()), HH: pad(t.getUTCHours()), mm: pad(t.getUTCMinutes()), ss: pad(t.getUTCSeconds()) };
        return fmt.replace(/'T'/g, 'T').replace(/yyyy|MM|dd|HH|mm|ss/g, k => map[k]);
      },
      base64Decode: (s) => Buffer.from(s, 'base64'),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'anyone' }, Permission: { VIEW: 'view' },
      getFoldersByName: (n) => iter(rootFolders.filter(f => f.name === n)),
      createFolder: (n) => { const f = mkFolder(n); rootFolders.push(f); return f; },
      getFolderById: (id) => { if (!folders[id]) throw new Error('not found'); return folders[id]; },
      getFileById: (id) => { if (!files[id]) throw new Error('not found'); return files[id]; }
    },
    UrlFetchApp: { fetch: opts.fetch || (() => { throw new Error('no network in tests'); }) },
    HtmlService: {},
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [now.getTime()])); } },
    encodeURIComponent, JSON, Math, Number, String, Object, Array, RegExp, Error, isNaN, Buffer,
    _ss: ss, _files: files, _props: props
  };
  vm.createContext(ctx);
  if (opts.bundle) {
    const bundle = path.join(__dirname, '..', 'dist', 'Code.gs');
    vm.runInContext(fs.readFileSync(bundle, 'utf8'), ctx, { filename: 'Code.gs' });
  } else {
    const dir = path.join(__dirname, '..', 'src');
    fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort().forEach(f => {
      vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
    });
  }
  return ctx;
}

module.exports = { makeContext };
