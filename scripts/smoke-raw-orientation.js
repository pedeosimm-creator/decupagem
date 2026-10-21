// Diagnóstico opcional com um RAW real: nunca altera o original.
const { app, BrowserWindow } = require('electron');
const { exiftool } = require('exiftool-vendored');
const { fileURLToPath } = require('url');
const fs = require('fs');
const path = require('path');
process.env.DECUPAGEM_SMOKE = '1';
require('../main.js');

async function run() {
  const file = process.argv.find((arg) => /\.(arw|cr2|cr3|nef|dng|raf|rw2)$/i.test(arg));
  if (!file) throw new Error('Informe o caminho de um RAW como argumento');
  const before = fs.statSync(file);
  const source = await exiftool.read(file);
  const expected = Number(source.Orientation) || 1;
  const item = { path: file, ext: path.extname(file).toLowerCase(), kind: 'raw', size: before.size, mtimeMs: before.mtimeMs };
  const win = BrowserWindow.getAllWindows()[0] || await new Promise((resolve) => app.once('browser-window-created', (_e, created) => resolve(created)));
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  try {
    const urls = await win.webContents.executeJavaScript(`(async () => ({ full: await previewapi.full(${JSON.stringify(item)}), thumb: await previewapi.thumbnail(${JSON.stringify(item)}) }))()`);
    if (!urls.full || !urls.thumb) throw new Error('Prévia RAW ausente');
    const full = await exiftool.read(fileURLToPath(urls.full));
    const thumb = await exiftool.read(fileURLToPath(urls.thumb));
    if ((Number(full.Orientation) || 1) !== expected || (Number(thumb.Orientation) || 1) !== expected) {
      throw new Error(`Orientação divergente: original ${expected}, prévia ${full.Orientation}, miniatura ${thumb.Orientation}`);
    }
    const after = fs.statSync(file);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Original RAW foi alterado');
    const result = { source: expected, full: Number(full.Orientation) || 1, thumbnail: Number(thumb.Orientation) || 1, originalUnchanged: true };
    if (process.env.DECUPAGEM_SMOKE_RESULT) fs.writeFileSync(process.env.DECUPAGEM_SMOKE_RESULT, JSON.stringify(result));
    console.log(JSON.stringify(result));
  } finally {
    await exiftool.end();
    app.quit();
  }
}

app.whenReady().then(run).catch((err) => { console.error(err); app.exit(1); });
