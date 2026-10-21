// Regressão: desaprovar separa os arquivos; a exclusão em lote exige confirmação.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DECUPAGEM_SMOKE = '1';
require('../main.js');

async function run() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'decupagem-reject-'));
  const photo = nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 255), { width: 64, height: 64 }).toJPEG(85);
  for (let i = 1; i <= 3; i++) {
    const file = path.join(folder, `foto-${i}.jpg`);
    fs.writeFileSync(file, photo);
    fs.copyFileSync(file, `${file}.decupagem-original`);
  }
  const win = BrowserWindow.getAllWindows()[0] || await new Promise((resolve) => app.once('browser-window-created', (_e, created) => resolve(created)));
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  try {
    await win.webContents.executeJavaScript(`sessionapi.load(${JSON.stringify(folder)})`);
    await new Promise((resolve) => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 50 && !document.querySelector('.recent-item'); i++) await new Promise(r => setTimeout(r, 50));
      document.querySelector('.recent-item').click();
      for (let i = 0; i < 50 && document.querySelectorAll('.tile').length !== 3; i++) await new Promise(r => setTimeout(r, 50));
      document.querySelector('.tile').click();
      for (let n = 1; n <= 2; n++) {
        const button = document.querySelector('[data-action=reject]');
        if (!button) throw new Error('Ação Desaprovar ausente');
        button.click();
        for (let i = 0; i < 100 && Number(document.querySelector('[data-filter=desaprovadas] .count')?.textContent || 0) !== n; i++) await new Promise(r => setTimeout(r, 50));
        if (Number(document.querySelector('[data-filter=desaprovadas] .count')?.textContent || 0) !== n) throw new Error('Contagem de desaprovadas não mudou');
      }
      document.querySelector('#v-close').click();
    })()`);
    let data = await win.webContents.executeJavaScript(`sessionapi.load(${JSON.stringify(folder)})`);
    if (data.items.filter((x) => x.status === 'rejected').length !== 2 || data.items.filter((x) => x.status === 'pending').length !== 1) throw new Error('Pilha não persistiu no disco');
    if (!fs.existsSync(path.join(folder, 'Desaprovadas'))) throw new Error('Pasta Desaprovadas ausente');
    const originalPendingName = data.items.find((x) => x.status === 'pending').name;
    await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-filter=desaprovadas]').click();
      document.querySelector('.tile').click();
      const button = document.querySelector('#v-reject');
      if (button.dataset.action !== 'restore') throw new Error('Voltar para pendentes ausente');
      button.click();
      for (let i = 0; i < 100 && Number(document.querySelector('[data-filter=desaprovadas] .count')?.textContent || 0) !== 1; i++) await new Promise(r => setTimeout(r, 50));
      document.querySelector('#v-close').click();
    })()`);
    data = await win.webContents.executeJavaScript(`sessionapi.load(${JSON.stringify(folder)})`);
    if (data.items.filter((x) => x.status === 'pending').length !== 2) throw new Error('Voltar para pendentes falhou');
    const restored = data.items.find((x) => x.status === 'pending' && x.name !== originalPendingName);
    const reRejected = await win.webContents.executeJavaScript(`sessionapi.decide(${JSON.stringify({ folderPath: folder, filePath: restored.path, action: 'reject' })})`);
    if (!reRejected.ok) throw new Error(`Não consegui desaprovar novamente: ${reRejected.error}`);
    await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('#btn-reload').click();
      for (let i = 0; i < 100 && Number(document.querySelector('[data-filter=desaprovadas] .count')?.textContent || 0) !== 2; i++) await new Promise(r => setTimeout(r, 50));
    })()`);
    const before = fs.readdirSync(path.join(folder, 'Desaprovadas')).filter((n) => n.endsWith('.jpg')).length;
    if (fs.readdirSync(path.join(folder, 'Desaprovadas')).filter((n) => n.endsWith('.decupagem-original')).length !== 2) throw new Error('Backups não acompanharam as fotos');
    await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-filter=desaprovadas]').click();
      if (document.querySelectorAll('.tile').length !== 2) throw new Error('Filtro Desaprovadas incorreto');
      if (document.querySelector('#btn-trash-rejected').hidden) throw new Error('Excluir todas não aparece');
      window.confirm = () => false;
      document.querySelector('#btn-trash-rejected').click();
      await new Promise(r => setTimeout(r, 100));
    })()`);
    if (fs.readdirSync(path.join(folder, 'Desaprovadas')).filter((n) => n.endsWith('.jpg')).length !== before) throw new Error('Excluiu sem confirmação');
    await win.webContents.executeJavaScript(`(async () => {
      window.confirm = () => true;
      document.querySelector('#btn-trash-rejected').click();
      for (let i = 0; i < 150 && Number(document.querySelector('[data-filter=desaprovadas] .count')?.textContent || 0) !== 0; i++) await new Promise(r => setTimeout(r, 50));
    })()`);
    data = await win.webContents.executeJavaScript(`sessionapi.load(${JSON.stringify(folder)})`);
    if (data.items.some((x) => x.status === 'rejected')) throw new Error('A pilha não foi esvaziada');
    if (data.items.filter((x) => x.status === 'pending').length !== 1) throw new Error('Foto pendente foi apagada');
    if (fs.readdirSync(path.join(folder, 'Desaprovadas')).length !== 0) throw new Error('Ficaram backups na pilha excluída');
    const result = { rejected: 2, restored: true, cancelled: true, trashed: 2, pending: 1 };
    if (process.env.DECUPAGEM_SMOKE_RESULT) fs.writeFileSync(process.env.DECUPAGEM_SMOKE_RESULT, JSON.stringify(result));
    console.log(JSON.stringify(result));
  } finally {
    try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch { /* miniatura ainda em uso */ }
    app.quit();
  }
}

app.whenReady().then(run).catch((err) => { console.error(err); app.exit(1); });
