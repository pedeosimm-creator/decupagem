// Regressão: muitas fotos não podem virar faixas finas na grade.
const { app, BrowserWindow, nativeImage, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DECUPAGEM_SMOKE = '1';
require('../main.js');

async function run() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'decupagem-grid-'));
  const pixels = Buffer.alloc(64 * 64 * 4, 255);
  const photo = nativeImage.createFromBitmap(pixels, { width: 64, height: 64 }).toJPEG(85);
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(folder, `foto-${String(i).padStart(3, '0')}.jpg`), photo);
  const win = BrowserWindow.getAllWindows()[0] || await new Promise((resolve) => app.once('browser-window-created', (_e, created) => resolve(created)));
  if (win.isVisible()) throw new Error('Teste abriu uma janela visível');
  const left = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x)[0].workArea;
  const bounds = win.getBounds();
  if (bounds.x < left.x || bounds.x + bounds.width > left.x + left.width) throw new Error('Janela posicionada fora do monitor esquerdo');
  win.setSize(1036, 700);
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  try {
    await win.webContents.executeJavaScript(`(async () => { localStorage.setItem('decupagem.view', JSON.stringify('grid')); localStorage.setItem('decupagem.thumbSize', JSON.stringify(210)); await sessionapi.load(${JSON.stringify(folder)}); })()`);
    await new Promise((resolve) => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    const metrics = await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 50 && !document.querySelector('.recent-item'); i++) await new Promise(r => setTimeout(r, 50));
      document.querySelector('.recent-item').click();
      for (let i = 0; i < 60 && document.querySelectorAll('.tile').length !== 100; i++) await new Promise(r => setTimeout(r, 50));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tiles = [...document.querySelectorAll('.tile')];
      return { count: tiles.length, heights: tiles.slice(0, 20).map(x => Math.round(x.getBoundingClientRect().height)), thumbHeights: tiles.slice(0, 20).map(x => Math.round(x.querySelector('.thumb').getBoundingClientRect().height)), gridWidth: Math.round(document.querySelector('#grid').getBoundingClientRect().width) };
    })()`);
    if (process.env.DECUPAGEM_GRID_SHOT) {
      await win.webContents.executeJavaScript(`(async () => {
        for (let i = 0; i < 100 && document.querySelectorAll('.tile.loaded').length < 3; i++) await new Promise(r => setTimeout(r, 50));
      })()`);
      fs.writeFileSync(process.env.DECUPAGEM_GRID_SHOT, (await win.capturePage()).toPNG());
    }
    if (process.env.DECUPAGEM_SMOKE_RESULT) fs.writeFileSync(process.env.DECUPAGEM_SMOKE_RESULT, JSON.stringify(metrics));
    if (metrics.count !== 100 || metrics.heights.some((h) => h < 150)) throw new Error(`Grade comprimida: ${JSON.stringify(metrics)}`);
    console.log(JSON.stringify(metrics));
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    app.quit();
  }
}

app.whenReady().then(run).catch((err) => {
  console.error(err);
  app.exit(1);
});
