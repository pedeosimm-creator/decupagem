const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { exiftool } = require('exiftool-vendored');

let trashFn;
async function trash(paths) {
  if (!trashFn) trashFn = (await import('trash')).default;
  return trashFn(paths);
}

const RAW_EXTS = new Set(['.arw']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v']);
const MEDIA_EXTS = new Set([...RAW_EXTS, ...IMAGE_EXTS, ...VIDEO_EXTS]);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function kindFor(ext) {
  if (RAW_EXTS.has(ext)) return 'raw';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'other';
}

// ---- per-session state (discard log + recently used custom folders) ----

const CACHE_ROOT = path.join(app.getPath('userData'), 'decupagem-cache');
const THUMB_DIR = path.join(CACHE_ROOT, 'thumbs');
const PREVIEW_DIR = path.join(CACHE_ROOT, 'previews');
const SESSIONS_DIR = path.join(CACHE_ROOT, 'sessions');

async function ensureCacheDirs() {
  await fsp.mkdir(THUMB_DIR, { recursive: true });
  await fsp.mkdir(PREVIEW_DIR, { recursive: true });
  await fsp.mkdir(SESSIONS_DIR, { recursive: true });
}

function sessionKeyFor(folderPath) {
  return crypto.createHash('sha1').update(folderPath).digest('hex');
}

function sessionFileFor(folderPath) {
  return path.join(SESSIONS_DIR, `${sessionKeyFor(folderPath)}.json`);
}

async function loadSessionLog(folderPath) {
  try {
    const raw = await fsp.readFile(sessionFileFor(folderPath), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      discarded: parsed.discarded || [],
      recentFolders: parsed.recentFolders || [],
      customFolders: parsed.customFolders || [],
    };
  } catch {
    return { discarded: [], recentFolders: [], customFolders: [] };
  }
}

async function saveSessionLog(folderPath, log) {
  await fsp.writeFile(sessionFileFor(folderPath), JSON.stringify(log, null, 2), 'utf8');
}

async function appendDiscarded(folderPath, name) {
  const log = await loadSessionLog(folderPath);
  log.discarded.push({ name, at: new Date().toISOString() });
  await saveSessionLog(folderPath, log);
}

async function rememberFolder(folderPath, name) {
  const log = await loadSessionLog(folderPath);
  log.recentFolders = [name, ...log.recentFolders.filter((f) => f !== name)].slice(0, 8);
  if (!log.customFolders.includes(name)) log.customFolders.push(name);
  await saveSessionLog(folderPath, log);
  return log.recentFolders;
}

// ---- file helpers ----

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// O renderer solta o handle do vídeo/imagem antes de pedir a ação, mas o
// Windows pode levar um instante pra liberar o arquivo de fato — tenta de
// novo por um curto período em vez de falhar na primeira.
async function withRetry(fn, attempts = 6, delayMs = 150) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const locked = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
      if (!locked || i === attempts - 1) throw err;
      await sleep(delayMs);
    }
  }
}

async function uniquePath(target) {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  let i = 2;
  let candidate;
  do {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i++;
  } while (fs.existsSync(candidate));
  return candidate;
}

async function listMediaFiles(dirPath) {
  let names;
  try {
    names = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of names) {
    if (entry.isDirectory()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!MEDIA_EXTS.has(ext)) continue;
    const full = path.join(dirPath, entry.name);
    try {
      const st = await fsp.stat(full);
      out.push({ name: entry.name, path: full, ext, kind: kindFor(ext), size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // unreadable, skip
    }
  }
  return out;
}

const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information']);

// Cartão de câmera guarda tudo em subpastas (DCIM\100MSDCF\...), então o scan
// desce nelas. Na raiz ignora Aprovado/Talvez (tratadas à parte) e as pastas
// customizadas já usadas — senão o que foi organizado voltaria como pendente.
async function listMediaFilesDeep(root, excludeTop, maxDepth = 6, maxFiles = 5000) {
  const out = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (depth >= maxDepth || entry.name.startsWith('.') || SKIP_DIRS.has(lower)) continue;
        if (depth === 0 && excludeTop.has(lower)) continue;
        await walk(full, depth + 1);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!MEDIA_EXTS.has(ext)) continue;
      try {
        const st = await fsp.stat(full);
        out.push({ name: entry.name, path: full, ext, kind: kindFor(ext), size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // unreadable, skip
      }
    }
  }
  await walk(root, 0);
  return out;
}

async function buildSessionItems(folderPath) {
  const log = await loadSessionLog(folderPath);
  const excludeTop = new Set(['aprovado', 'talvez', ...log.customFolders.map((f) => f.toLowerCase()), ...log.recentFolders.map((f) => f.toLowerCase())]);
  const rootFiles = await listMediaFilesDeep(folderPath, excludeTop);
  const approvedFiles = await listMediaFiles(path.join(folderPath, 'Aprovado'));
  const maybeFiles = await listMediaFiles(path.join(folderPath, 'Talvez'));

  const items = [];
  for (const f of rootFiles) items.push({ ...f, status: 'pending', id: f.path });
  for (const f of approvedFiles) items.push({ ...f, status: 'approved', id: f.path });
  for (const f of maybeFiles) items.push({ ...f, status: 'maybe', id: f.path });
  for (const d of log.discarded) {
    items.push({ name: d.name, path: null, ext: path.extname(d.name).toLowerCase(), kind: 'ghost', size: 0, mtimeMs: 0, status: 'discarded', id: `ghost:${d.name}:${d.at}`, discardedAt: d.at });
  }

  items.sort((a, b) => collator.compare(a.name, b.name));
  return { items, recentFolders: log.recentFolders };
}

// ---- preview / thumbnail extraction ----

function cacheKeyFor(item) {
  return crypto.createHash('sha1').update(`${item.path}|${item.size}|${item.mtimeMs}`).digest('hex');
}

async function getThumbnail(item) {
  if (item.kind === 'image') return pathToFileURL(item.path).href;
  if (item.kind !== 'raw') return null;

  const key = cacheKeyFor(item);
  const dest = path.join(THUMB_DIR, `${key}.jpg`);
  if (fs.existsSync(dest)) return pathToFileURL(dest).href;

  try {
    await exiftool.extractThumbnail(item.path, dest);
    if (fs.existsSync(dest)) return pathToFileURL(dest).href;
  } catch {
    // fall through to full preview below
  }
  // some ARW files carry no small ThumbnailImage tag — fall back to the full preview
  return getFullPreview(item);
}

async function getFullPreview(item) {
  if (item.kind === 'image') return pathToFileURL(item.path).href;
  if (item.kind !== 'raw') return null;

  const key = cacheKeyFor(item);
  const dest = path.join(PREVIEW_DIR, `${key}.jpg`);
  if (fs.existsSync(dest)) return pathToFileURL(dest).href;

  try {
    await exiftool.extractJpgFromRaw(item.path, dest);
  } catch {
    try {
      await exiftool.extractPreview(item.path, dest);
    } catch {
      return null;
    }
  }
  return fs.existsSync(dest) ? pathToFileURL(dest).href : null;
}

// ---- window ----

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#faf8f6',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(async () => {
  await ensureCacheDirs();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', async () => {
  try {
    await exiftool.end();
  } catch {
    // already stopped
  }
});

// ---- IPC: window controls ----

ipcMain.on('window:minimize', () => win.minimize());
ipcMain.on('window:toggle-maximize', () => { if (win.isMaximized()) win.unmaximize(); else win.maximize(); });
ipcMain.on('window:close', () => win.close());

// ---- IPC: session ----

ipcMain.handle('session:chooseFolder', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('session:load', async (_e, folderPath) => {
  const { items, recentFolders } = await buildSessionItems(folderPath);
  return { folderPath, items, recentFolders };
});

function sanitizeName(name) {
  return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/^\.+/, '').trim();
}

ipcMain.handle('session:decide', async (_e, { folderPath, filePath, action, extra }) => {
  try {
    if (extra) extra = sanitizeName(extra);
    if (action === 'approve' || action === 'maybe') {
      const destDir = path.join(folderPath, action === 'approve' ? 'Aprovado' : 'Talvez');
      await fsp.mkdir(destDir, { recursive: true });
      const dest = await uniquePath(path.join(destDir, path.basename(filePath)));
      await withRetry(() => fsp.rename(filePath, dest));
      return { ok: true, newPath: dest, newStatus: action === 'approve' ? 'approved' : 'maybe' };
    }
    if (action === 'discard') {
      await withRetry(() => trash([filePath]));
      await appendDiscarded(folderPath, path.basename(filePath));
      return { ok: true, newPath: null, newStatus: 'discarded' };
    }
    if (action === 'moveTo') {
      if (!extra) return { ok: false, error: 'nome de pasta vazio' };
      const destDir = path.join(folderPath, extra);
      await fsp.mkdir(destDir, { recursive: true });
      const dest = await uniquePath(path.join(destDir, path.basename(filePath)));
      await withRetry(() => fsp.rename(filePath, dest));
      const recentFolders = await rememberFolder(folderPath, extra);
      return { ok: true, newPath: dest, newStatus: `custom:${extra}`, recentFolders };
    }
    if (action === 'rename') {
      if (!extra) return { ok: false, error: 'nome vazio' };
      const ext = path.extname(filePath);
      const dest = await uniquePath(path.join(path.dirname(filePath), `${extra}${ext}`));
      await withRetry(() => fsp.rename(filePath, dest));
      return { ok: true, newPath: dest, newStatus: null };
    }
    return { ok: false, error: `ação desconhecida: ${action}` };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// ---- IPC: preview ----

ipcMain.handle('preview:thumbnail', async (_e, item) => {
  try {
    return await getThumbnail(item);
  } catch {
    return null;
  }
});

ipcMain.handle('preview:full', async (_e, item) => {
  try {
    return await getFullPreview(item);
  } catch {
    return null;
  }
});
