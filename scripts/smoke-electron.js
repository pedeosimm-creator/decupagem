// Testa a ponte real do Electron: prévia de foto e descarte com imagem aberta.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DECUPAGEM_SMOKE = '1';
require('../main.js');

async function run() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'decupagem-smoke-'));
  const file = path.join(folder, 'foto [teste].jpg');
  const pixels = Buffer.alloc(128 * 128 * 4);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const i = (y * 128 + x) * 4;
    pixels[i] = x < 64 ? 255 : 0;
    pixels[i + 1] = y < 64 ? 255 : 0;
    pixels[i + 2] = 30;
    pixels[i + 3] = 255;
  }
  fs.writeFileSync(file, nativeImage.createFromBitmap(pixels, { width: 128, height: 128 }).toJPEG(90));
  const win = BrowserWindow.getAllWindows()[0] || await new Promise((resolve) => app.once('browser-window-created', (_event, created) => resolve(created)));
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  try {
    await win.webContents.executeJavaScript(`sessionapi.load(${JSON.stringify(folder)})`);
    await new Promise((resolve) => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    const result = await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 40 && !document.querySelector('.recent-item'); i++) await new Promise(r => setTimeout(r, 50));
      const recent = document.querySelector('.recent-item');
      if (!recent) throw new Error('job recente ausente');
      recent.click();
      for (let i = 0; i < 40 && !document.querySelector('.tile'); i++) await new Promise(r => setTimeout(r, 50));
      const data = await sessionapi.load(${JSON.stringify(folder)});
      const item = data.items.find(x => x.name === 'foto [teste].jpg');
      if (!item || !item.mtimeMs) throw new Error('arquivo/data ausente');
      document.querySelector('#view-mode [data-view=list]').click();
      if (!document.querySelector('#grid').classList.contains('list-view')) throw new Error('modo lista não ativou');
      if (!document.querySelector('.tile .list-detail').textContent.match(/\\d{2}\\/\\d{2}\\/\\d{4}/)) throw new Error('data/hora não apareceu na lista');
      const sort = document.querySelector('#sort-mode');
      sort.value = 'date-desc';
      sort.dispatchEvent(new Event('change'));
      if (sort.value !== 'date-desc') throw new Error('ordenação por data falhou');
      for (const get of [previewapi.thumbnail, previewapi.full, previewapi.alternate]) {
        const url = await get(item);
        if (!url) throw new Error('prévia ausente');
        await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => { document.body.appendChild(img); resolve(); };
          img.onerror = () => reject(new Error('prévia não abriu'));
          img.src = url;
        });
      }
      document.querySelectorAll('body > img').forEach(img => { img.removeAttribute('src'); img.remove(); });
      const discarded = await sessionapi.decide({ folderPath: ${JSON.stringify(folder)}, filePath: item.path, action: 'discard' });
      if (!discarded.ok) throw new Error(discarded.error);
      return { previews: 3, list: true, discarded: discarded.ok };
    })()`);
    if (fs.existsSync(file)) throw new Error('arquivo permaneceu após descarte');
    console.log(JSON.stringify(result));
    if (process.env.DECUPAGEM_SMOKE_RESULT) fs.writeFileSync(process.env.DECUPAGEM_SMOKE_RESULT, JSON.stringify(result));
  } finally {
    app.quit();
  }
}

app.whenReady().then(run).catch((err) => {
  console.error(err);
  if (process.env.DECUPAGEM_SMOKE_RESULT) fs.writeFileSync(process.env.DECUPAGEM_SMOKE_RESULT, JSON.stringify({ error: err.message }));
  app.exit(1);
});
