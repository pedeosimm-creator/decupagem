// Regressão: o giro da foto precisa ficar gravado no arquivo original.
const { app, BrowserWindow, nativeImage } = require('electron');
const { exiftool } = require('exiftool-vendored');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DECUPAGEM_SMOKE = '1';
require('../main.js');

async function orientation(file) { return Number((await exiftool.read(file)).Orientation) || 1; }
async function waitFor(file, expected) {
  for (let i = 0; i < 50; i++) {
    if (await orientation(file) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Orientação não virou para ${expected}`);
}

async function run() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'decupagem-rotate-'));
  const file = path.join(folder, 'foto.jpg');
  fs.writeFileSync(file, nativeImage.createFromBitmap(Buffer.alloc(160 * 80 * 4, 255), { width: 160, height: 80 }).toJPEG(90));
  const original = fs.readFileSync(file);
  const win = BrowserWindow.getAllWindows()[0] || await new Promise((resolve) => app.once('browser-window-created', (_e, created) => resolve(created)));
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  try {
    await win.webContents.executeJavaScript(`sessionapi.load(${JSON.stringify(folder)})`);
    await new Promise((resolve) => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 50 && !document.querySelector('.recent-item'); i++) await new Promise(r => setTimeout(r, 50));
      document.querySelector('.recent-item').click();
      for (let i = 0; i < 50 && !document.querySelector('.tile'); i++) await new Promise(r => setTimeout(r, 50));
      document.querySelector('.tile').click();
      if (!document.querySelector('#v-rotate-right')) throw new Error('Botão de giro ausente');
      document.querySelector('#v-rotate-right').click();
    })()`);
    await waitFor(file, 6);
    const backup = `${file}.decupagem-original`;
    if (!fs.existsSync(backup) || !fs.readFileSync(backup).equals(original)) throw new Error('Backup do original ausente ou alterado');
    const display = await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100 && (!document.querySelector('#v-image').complete || !document.querySelector('#v-image').naturalWidth || document.querySelector('#v-rotate-left').disabled); i++) await new Promise(r => setTimeout(r, 50));
      const img = document.querySelector('#v-image');
      return { width: img.naturalWidth, height: img.naturalHeight, src: img.currentSrc };
    })()`);
    if (display.width !== 80 || display.height !== 160) throw new Error(`A prévia não girou: ${JSON.stringify(display)}`);
    const thumbnail = await win.webContents.executeJavaScript(`(async () => {
      const data = await sessionapi.load(${JSON.stringify(folder)});
      const url = await previewapi.thumbnail(data.items[0]);
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('Miniatura não abriu após giro'));
        img.src = url;
      });
    })()`);
    if (thumbnail.width !== 80 || thumbnail.height !== 160) throw new Error(`A miniatura não girou: ${JSON.stringify(thumbnail)}`);
    await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100 && document.querySelector('#v-rotate-left').disabled; i++) await new Promise(r => setTimeout(r, 50));
      if (document.querySelector('#v-rotate-left').disabled) throw new Error('Botão de giro não voltou a habilitar');
      document.querySelector('#v-rotate-left').click();
    })()`);
    await waitFor(file, 1);
    if (!fs.readFileSync(backup).equals(original)) throw new Error('Backup foi alterado pelo segundo giro');
    await win.webContents.executeJavaScript(`document.querySelector('#v-close').click()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = { right: 6, left: 1, backup: true, display: `${display.width}x${display.height}`, thumbnail: `${thumbnail.width}x${thumbnail.height}` };
    if (process.env.DECUPAGEM_SMOKE_RESULT) fs.writeFileSync(process.env.DECUPAGEM_SMOKE_RESULT, JSON.stringify(result));
    console.log(JSON.stringify(result));
  } finally {
    try { await exiftool.end(); } catch { /* encerrado */ }
    try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* em uso até o app sair */ }
    app.quit();
  }
}

app.whenReady().then(run).catch((err) => { console.error(err); app.exit(1); });
