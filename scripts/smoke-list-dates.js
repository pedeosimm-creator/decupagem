// Regressão: a lista mostra a data de captura (EXIF), não a do arquivo, e
// ordena por ela; "Excluir de vez" só apaga o que está em Desaprovadas.
const { app, BrowserWindow, nativeImage } = require('electron');
const { exiftool } = require('exiftool-vendored');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DECUPAGEM_SMOKE = '1';
require('../main.js');

async function run() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'decupagem-datas-'));
  const photo = nativeImage.createFromBitmap(Buffer.alloc(64 * 48 * 4, 200), { width: 64, height: 48 }).toJPEG(85);
  // nomes em ordem alfabética A, B, C; datas de captura em ordem inversa
  const shots = [['A.jpg', '2024:05:03 10:00:00'], ['B.jpg', '2024:05:02 10:00:00'], ['C.jpg', '2024:05:01 10:00:00']];
  for (const [name, date] of shots) {
    fs.writeFileSync(path.join(folder, name), photo);
    await exiftool.write(path.join(folder, name), { DateTimeOriginal: date }, ['-overwrite_original']);
  }
  fs.mkdirSync(path.join(folder, 'Desaprovadas'));
  fs.writeFileSync(path.join(folder, 'Desaprovadas', 'ruim.jpg'), photo);
  fs.writeFileSync(path.join(folder, 'fora.jpg'), photo);

  const win = BrowserWindow.getAllWindows()[0] || await new Promise((resolve) => app.once('browser-window-created', (_e, created) => resolve(created)));
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  try {
    await win.webContents.executeJavaScript(`(async () => { localStorage.setItem('decupagem.view', JSON.stringify('list')); localStorage.setItem('decupagem.sort', JSON.stringify('date-desc')); await sessionapi.load(${JSON.stringify(folder)}); })()`);
    await new Promise((resolve) => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    const result = await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 50 && !document.querySelector('.recent-item'); i++) await new Promise(r => setTimeout(r, 50));
      document.querySelector('.recent-item').click();
      // espera a leitura das datas reordenar a lista
      for (let i = 0; i < 100; i++) {
        const whens = [...document.querySelectorAll('#grid .tile .when')];
        if (whens.length >= 3 && whens.filter(w => !w.classList.contains('approx')).length >= 3) break;
        await new Promise(r => setTimeout(r, 100));
      }
      const rows = [...document.querySelectorAll('#grid .tile')].map(t => ({ name: t.querySelector('.n').textContent, when: t.querySelector('.when').textContent }));
      return { header: !!document.querySelector('#grid .list-head'), rows };
    })()`);
    if (process.env.DECUPAGEM_LIST_SHOT) fs.writeFileSync(process.env.DECUPAGEM_LIST_SHOT, (await win.capturePage()).toPNG());

    const order = result.rows.map((r) => r.name).filter((n) => /^[ABC]\.jpg$/.test(n)).join(',');
    if (!result.header) throw new Error('Lista sem cabeçalho');
    if (order !== 'A.jpg,B.jpg,C.jpg') throw new Error(`Ordem por data de captura errada: ${order}`);
    const a = result.rows.find((r) => r.name === 'A.jpg');
    if (!a || !a.when.includes('03/05/2024') || !a.when.includes('10:00')) throw new Error(`Data de captura não exibida: ${JSON.stringify(a)}`);

    const del = await win.webContents.executeJavaScript(`sessionapi.deleteRejected({ folderPath: ${JSON.stringify(folder)}, names: ['ruim.jpg', '../fora.jpg'] })`);
    if (fs.existsSync(path.join(folder, 'Desaprovadas', 'ruim.jpg'))) throw new Error('Exclusão definitiva não apagou o arquivo de Desaprovadas');
    if (!fs.existsSync(path.join(folder, 'fora.jpg'))) throw new Error('Exclusão definitiva apagou arquivo fora de Desaprovadas');

    const summary = { header: result.header, order, dateA: a.when, deleted: del.deleted, foraIntacta: true };
    if (process.env.DECUPAGEM_SMOKE_RESULT) fs.writeFileSync(process.env.DECUPAGEM_SMOKE_RESULT, JSON.stringify(summary));
    console.log(JSON.stringify(summary));
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    await exiftool.end();
    app.quit();
  }
}

app.whenReady().then(run).catch((err) => {
  console.error(err);
  if (process.env.DECUPAGEM_SMOKE_RESULT) fs.writeFileSync(process.env.DECUPAGEM_SMOKE_RESULT, JSON.stringify({ error: err.message }));
  app.exit(1);
});
