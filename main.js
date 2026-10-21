const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { exiftool } = require('exiftool-vendored');

// Alguns drivers mostram faixas nas imagens decodificadas pelo Chromium/GPU.
// O app de revisão prioriza uma prévia estável; vídeo continua funcional em CPU.
app.disableHardwareAcceleration();

let trashFn;
async function trash(paths) {
  if (!trashFn) trashFn = (await import('trash')).default;
  return trashFn(paths);
}

// ---- formatos ----

const RAW_EXTS = new Set(['.arw', '.srf', '.sr2', '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.dng', '.raf', '.orf', '.rw2', '.pef', '.srw', '.3fr', '.iiq', '.rwl', '.x3f', '.erf', '.kdc', '.mrw', '.mos']);
// o Chromium mostra estes direto; TIFF/HEIC precisam virar JPEG de prévia antes
const WEB_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.gif', '.bmp', '.avif', '.ico']);
const CONVERT_IMAGE_EXTS = new Set(['.tif', '.tiff', '.heic', '.heif']);
const IMAGE_EXTS = new Set([...WEB_IMAGE_EXTS, ...CONVERT_IMAGE_EXTS]);
const ROTATABLE_EXTS = new Set(['.jpg', '.jpeg', '.jfif', '.tif', '.tiff', '.heic', '.heif', ...RAW_EXTS]);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mts', '.m2ts', '.mxf', '.wmv', '.mpg', '.mpeg', '.3gp', '.flv', '.ogv']);
const MEDIA_EXTS = new Set([...RAW_EXTS, ...IMAGE_EXTS, ...VIDEO_EXTS]);

// pastas onde o app grava o que exporta (frames e cortes), na raiz do job
const EXPORT_DIRS = { frames: 'Frames', clips: 'Cortes' };

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
const PROXY_DIR = path.join(CACHE_ROOT, 'proxies');
const SESSIONS_DIR = path.join(CACHE_ROOT, 'sessions');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

async function ensureCacheDirs() {
  for (const dir of [THUMB_DIR, PREVIEW_DIR, PROXY_DIR, SESSIONS_DIR]) await fsp.mkdir(dir, { recursive: true });
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

// ---- configurações globais (pastas de job abertas recentemente) ----

async function loadSettings() {
  try {
    return { recentJobs: [], ...JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { recentJobs: [] };
  }
}

async function rememberJob(folderPath) {
  const settings = await loadSettings();
  settings.recentJobs = [folderPath, ...settings.recentJobs.filter((p) => p !== folderPath)].slice(0, 6);
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
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
      const locked = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES' || /move item to trash|continua na pasta/i.test(err.message || ''));
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

function fileEntry(full, name, st) {
  const ext = path.extname(name).toLowerCase();
  return { name, path: full, ext, kind: kindFor(ext), size: st.size, mtimeMs: st.mtimeMs };
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
      out.push(fileEntry(full, entry.name, await fsp.stat(full)));
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
        out.push(fileEntry(full, entry.name, await fsp.stat(full)));
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
  const excludeTop = new Set([
    'aprovado', 'talvez',
    ...Object.values(EXPORT_DIRS).map((f) => f.toLowerCase()),
    ...log.customFolders.map((f) => f.toLowerCase()),
    ...log.recentFolders.map((f) => f.toLowerCase()),
  ]);
  const rootFiles = await listMediaFilesDeep(folderPath, excludeTop);
  const approvedFiles = await listMediaFiles(path.join(folderPath, 'Aprovado'));
  const maybeFiles = await listMediaFiles(path.join(folderPath, 'Talvez'));
  const exportedFiles = [
    ...(await listMediaFiles(path.join(folderPath, EXPORT_DIRS.frames))),
    ...(await listMediaFiles(path.join(folderPath, EXPORT_DIRS.clips))),
  ];

  const items = [];
  for (const f of rootFiles) items.push({ ...f, status: 'pending', id: f.path });
  for (const f of approvedFiles) items.push({ ...f, status: 'approved', id: f.path });
  for (const f of maybeFiles) items.push({ ...f, status: 'maybe', id: f.path });
  for (const f of exportedFiles) items.push({ ...f, status: 'exported', id: f.path });
  for (const d of log.discarded) {
    items.push({ name: d.name, path: null, ext: path.extname(d.name).toLowerCase(), kind: 'ghost', size: 0, mtimeMs: 0, status: 'discarded', id: `ghost:${d.name}:${d.at}`, discardedAt: d.at });
  }

  items.sort((a, b) => collator.compare(a.name, b.name));
  return { items, recentFolders: log.recentFolders };
}

// ---- ffmpeg ----

let ffmpegBin;
function ffmpegPath() {
  if (ffmpegBin) return ffmpegBin;
  try {
    const bundled = require('ffmpeg-static');
    if (bundled && fs.existsSync(bundled)) return (ffmpegBin = bundled);
  } catch {
    // sem o binário empacotado, tenta o do PATH
  }
  return (ffmpegBin = 'ffmpeg');
}

const jobs = new Map();

function runFfmpeg(args, { jobId, duration, onProgress } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', ...args], { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stderr: String(err && err.message), cancelled: false });
      return;
    }
    if (jobId) jobs.set(jobId, child);
    let stderr = '';
    let pending = '';
    child.stdout.on('data', (chunk) => {
      if (!onProgress || !duration) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    child.on('error', (err) => {
      if (jobId) jobs.delete(jobId);
      resolve({ code: -1, stderr: String(err && err.message), cancelled: false });
    });
    child.on('close', (code) => {
      if (jobId) jobs.delete(jobId);
      resolve({ code, stderr, cancelled: !!child.cancelledByUser });
    });
  });
}

function lastError(stderr) {
  const lines = String(stderr || '').trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-2).join(' — ') || 'erro desconhecido do ffmpeg';
}

function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const lightQueue = limiter(3);

// Lê o que o ffmpeg imprime sobre o arquivo (sem ffprobe): duração, resolução,
// fps, formato de pixel (pra saber se é 10-bit) e a matriz de cor.
function parseProbe(text) {
  const info = { duration: 0, width: 0, height: 0, fps: 0, codec: null, pixFmt: null, bitDepth: 8, range: null, matrix: null, rotation: 0, hasVideo: false, hasAudio: /Stream #[^\n]*: Audio:/.test(text) };
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (d) info.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + parseFloat(d[3]);
  const v = /Stream #\d+:\d+[^\n]*?: Video: ([^\s,]+)[^\n]*?, ([a-z0-9_]+)(?:\(([^)]*)\))?, (\d{2,5})x(\d{2,5})/.exec(text);
  if (v) {
    info.hasVideo = true;
    info.codec = v[1];
    info.pixFmt = v[2];
    info.width = Number(v[4]);
    info.height = Number(v[5]);
    const props = (v[3] || '').split(',').map((s) => s.trim());
    if (props.includes('pc')) info.range = 'pc';
    else if (props.includes('tv')) info.range = 'tv';
    else if (info.pixFmt.startsWith('yuvj')) info.range = 'pc';
    const matrix = props.find((p) => /^(bt709|bt470bg|smpte170m|bt2020|smpte240m|fcc)/.test(p));
    if (matrix) info.matrix = matrix.split('/')[0];
    const depth = /p(\d{2})(le|be)$/.exec(info.pixFmt);
    if (depth) info.bitDepth = Number(depth[1]);
    else if (/^(rgb48|rgba64|bgr48|bgra64)/.test(info.pixFmt)) info.bitDepth = 16;
    const lineEnd = text.indexOf('\n', v.index);
    const line = text.slice(v.index, lineEnd === -1 ? undefined : lineEnd);
    const fps = /, ([\d.]+) fps/.exec(line) || /, ([\d.]+) tbr/.exec(line);
    if (fps) info.fps = parseFloat(fps[1]);
  }
  const rot = /rotation of (-?[\d.]+) degrees/.exec(text);
  if (rot) info.rotation = Math.round(parseFloat(rot[1]));
  return info;
}

const probeCache = new Map();
async function probe(filePath) {
  const st = await fsp.stat(filePath);
  const key = `${filePath}|${st.size}|${st.mtimeMs}`;
  if (probeCache.has(key)) return probeCache.get(key);
  const { stderr } = await runFfmpeg(['-i', filePath]);
  const info = parseProbe(stderr);
  const quarterTurn = Math.abs(info.rotation) % 180 === 90;
  info.displayWidth = quarterTurn ? info.height : info.width;
  info.displayHeight = quarterTurn ? info.width : info.height;
  probeCache.set(key, info);
  return info;
}

function timecodeForFile(seconds, fps) {
  const rate = Math.max(1, Math.round(fps || 30));
  const totalFrames = Math.round(seconds * (fps || 30));
  const ff = totalFrames % rate;
  const s = Math.floor(seconds);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}-${pad(Math.floor((s % 3600) / 60))}-${pad(s % 60)}-${pad(ff)}`;
}

function exportDirFor(folderPath, filePath, kind) {
  return folderPath ? path.join(folderPath, EXPORT_DIRS[kind]) : path.dirname(filePath);
}

// ---- exportar frame ----

// Mesmo look do "Rec709 simulado" da tela (CSS: contrast saturate brightness),
// refeito em RGB de 16 bits pra o frame salvo bater com o que se vê.
const LOOK = { contrast: 1.35, saturate: 1.4, brightness: 1.05 };

function lookFilters() {
  const { contrast: c, saturate: s, brightness: b } = LOOK;
  const con = `'clip((val/maxval-0.5)*${c}+0.5,0,1)*maxval'`;
  const bri = `'clip(val*${b},0,maxval)'`;
  const n = (x) => x.toFixed(4);
  const mix = [
    `rr=${n(0.213 + 0.787 * s)}`, `rg=${n(0.715 - 0.715 * s)}`, `rb=${n(0.072 - 0.072 * s)}`,
    `gr=${n(0.213 - 0.213 * s)}`, `gg=${n(0.715 + 0.285 * s)}`, `gb=${n(0.072 - 0.072 * s)}`,
    `br=${n(0.213 - 0.213 * s)}`, `bg=${n(0.715 - 0.715 * s)}`, `bb=${n(0.072 + 0.928 * s)}`,
  ].join(':');
  return [`lutrgb=r=${con}:g=${con}:b=${con}`, `colorchannelmixer=${mix}`, `lutrgb=r=${bri}:g=${bri}:b=${bri}`];
}

function colorMatrixFor(info) {
  const m = info.matrix || '';
  if (m.startsWith('bt709')) return 'bt709';
  if (m.startsWith('bt470bg') || m.startsWith('smpte170m')) return 'bt601';
  if (m.startsWith('bt2020')) return 'bt2020';
  if (m.startsWith('smpte240m')) return 'smpte240m';
  if (m.startsWith('fcc')) return 'fcc';
  return info.height >= 720 ? 'bt709' : 'bt601';
}

const FRAME_FORMATS = {
  png: { ext: 'png', deep: 'rgb48be', flat: 'rgb24', codec: ['-c:v', 'png'] },
  tiff: { ext: 'tif', deep: 'rgb48le', flat: 'rgb24', codec: ['-c:v', 'tiff', '-compression_algo', 'deflate'] },
  jpg: { ext: 'jpg', deep: null, flat: null, codec: ['-c:v', 'mjpeg', '-q:v', '1', '-qmin', '1', '-qmax', '1'] },
};

async function saveFrame({ folderPath, filePath, time, format, look }) {
  const info = await probe(filePath);
  if (!info.hasVideo) throw new Error('não achei a faixa de vídeo do arquivo');
  const spec = FRAME_FORMATS[format] || FRAME_FORMATS.png;
  const deep = info.bitDepth > 8 && !!spec.deep;
  const work = deep ? 'rgb48le' : 'rgb24';

  // converte YUV→RGB com a matriz/faixa certas do arquivo e chroma em resolução
  // cheia — o padrão do ffmpeg usaria BT.601 e deixaria a cor levemente errada
  const range = info.range === 'pc' ? 'pc' : 'tv';
  const chain = [
    `scale=in_color_matrix=${colorMatrixFor(info)}:in_range=${range}:flags=accurate_rnd+full_chroma_int+full_chroma_inp+lanczos`,
    `format=${work}`,
  ];
  if (look) chain.push(...lookFilters());
  if (format === 'jpg') chain.push('scale=out_color_matrix=bt601:out_range=pc', 'format=yuvj444p');
  else chain.push(`format=${deep ? spec.deep : spec.flat}`);

  const outDir = exportDirFor(folderPath, filePath, 'frames');
  await fsp.mkdir(outDir, { recursive: true });
  const base = path.basename(filePath, path.extname(filePath));
  const out = await uniquePath(path.join(outDir, `${base}_${timecodeForFile(time, info.fps)}.${spec.ext}`));

  // o renderer manda o instante do frame exibido; recua meio frame pra o
  // seek preciso do ffmpeg cair exatamente nele e não no seguinte
  const half = 0.5 / (info.fps || 30);
  const attempt = (t) => runFfmpeg([
    '-y', '-ss', Math.max(0, t).toFixed(6), '-i', filePath,
    '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn',
    '-vf', chain.join(','), ...spec.codec, '-update', '1', out,
  ]);
  let res = await attempt(time - half);
  if (res.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) {
    res = await attempt(time - 0.25); // perto do fim às vezes não sobra frame no ponto exato
  }
  if (res.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) {
    try { await fsp.unlink(out); } catch { /* nada pra limpar */ }
    throw new Error(lastError(res.stderr));
  }
  const st = await fsp.stat(out);
  return {
    file: { ...fileEntry(out, path.basename(out), st), status: 'exported', id: out },
    width: info.displayWidth, height: info.displayHeight,
    bitDepth: deep ? 16 : 8, format: format in FRAME_FORMATS ? format : 'png', look: !!look,
  };
}

// ---- exportar corte ----

async function saveClip({ folderPath, filePath, start, end, mode, jobId }) {
  const info = await probe(filePath);
  const duration = Math.max(0.04, end - start);
  const srcExt = path.extname(filePath);
  const outDir = exportDirFor(folderPath, filePath, 'clips');
  await fsp.mkdir(outDir, { recursive: true });
  const base = path.basename(filePath, srcExt);
  const lastFrame = Math.max(start, end - 1 / (info.fps || 30));
  const label = `${timecodeForFile(start, info.fps)}_a_${timecodeForFile(lastFrame, info.fps)}`;
  const progress = (ratio) => { if (win && !win.isDestroyed()) win.webContents.send('job:progress', { jobId, ratio }); };
  const head = ['-y', '-ss', start.toFixed(6), '-i', filePath, '-t', duration.toFixed(6)];
  const tail = ['-map_metadata', '0', '-progress', 'pipe:1', '-nostats'];
  const isMp4Family = (ext) => ['.mp4', '.mov', '.m4v'].includes(ext.toLowerCase());

  let out;
  let attempts;
  if (mode === 'copy') {
    // sem recodificar: instantâneo e sem perda, mas o início cai no keyframe
    out = await uniquePath(path.join(outDir, `${base}_corte_${label}${srcExt}`));
    const mux = [...(isMp4Family(srcExt) ? ['-movflags', '+faststart'] : []), '-avoid_negative_ts', 'make_zero'];
    attempts = [
      [...head, '-map', '0:v:0?', '-map', '0:a?', '-c', 'copy', ...mux, ...tail, out],
      // áudio PCM nem sempre cabe no contêiner — converte só o áudio
      [...head, '-map', '0:v:0?', '-map', '0:a?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', ...mux, ...tail, out],
    ];
  } else {
    // exato: recodifica com qualidade quase sem perda, mantendo 10-bit/4:2:2
    out = await uniquePath(path.join(outDir, `${base}_corte_${label}.mp4`));
    const video = ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '14'];
    const audio = ['-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart'];
    attempts = [
      [...head, ...video, ...audio, ...tail, out],
      [...head, ...video, '-pix_fmt', 'yuv420p', ...audio, ...tail, out],
    ];
  }

  let res;
  for (const args of attempts) {
    res = await runFfmpeg(args, { jobId, duration, onProgress: progress });
    if (res.cancelled) break;
    if (res.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) break;
  }
  if (res.cancelled || res.code !== 0) {
    try { await fsp.unlink(out); } catch { /* nada pra limpar */ }
    if (res.cancelled) return { ok: false, cancelled: true };
    throw new Error(lastError(res.stderr));
  }
  const st = await fsp.stat(out);
  return { ok: true, file: { ...fileEntry(out, path.basename(out), st), status: 'exported', id: out } };
}

// ---- preview / thumbnail extraction ----

function cacheKeyFor(item) {
  return crypto.createHash('sha1').update(`v2|${item.path}|${item.size}|${item.mtimeMs}`).digest('hex');
}

function urlIfExists(file) {
  return fs.existsSync(file) && fs.statSync(file).size > 0 ? pathToFileURL(file).href : null;
}

// JPEG embutido no RAW vem sem a tag de orientação: copia a do RAW pra a
// prévia não aparecer deitada quando a foto foi feita na vertical.
async function copyOrientation(srcPath, destJpg) {
  try {
    const tags = await exiftool.read(srcPath);
    const orientation = Number(tags.Orientation);
    if (orientation && orientation !== 1) {
      await exiftool.write(destJpg, { Orientation: orientation }, ['-overwrite_original']);
    }
  } catch {
    // sem orientação legível, fica como está
  }
}

async function shellThumbnail(item, dest, size, quality) {
  const img = await nativeImage.createThumbnailFromPath(item.path, { width: size, height: size });
  if (!img || img.isEmpty()) throw new Error('thumbnail vazia');
  await fsp.writeFile(dest, img.toJPEG(quality));
  return urlIfExists(dest);
}

async function ffmpegStill(src, dest, { seek = 0, width } = {}) {
  const args = ['-y', ...(seek > 0 ? ['-ss', seek.toFixed(3)] : []), '-i', src, '-map', '0:v:0', '-frames:v', '1'];
  if (width) args.push('-vf', `scale='min(${width},iw)':-2`);
  args.push('-q:v', '3', '-update', '1', dest);
  const res = await runFfmpeg(args);
  return res.code === 0 ? urlIfExists(dest) : null;
}

async function getThumbnail(item) {
  const key = cacheKeyFor(item);
  const dest = path.join(THUMB_DIR, `${key}.jpg`);
  const cached = urlIfExists(dest);
  if (cached) return cached;

  if (item.kind === 'video') {
    return lightQueue(async () => {
      const info = await probe(item.path);
      const seek = info.duration > 2 ? Math.min(1, info.duration * 0.1) : 0;
      return (await ffmpegStill(item.path, dest, { seek, width: 480 })) || (seek > 0 ? ffmpegStill(item.path, dest, { width: 480 }) : null);
    });
  }

  if (item.kind === 'image') {
    // O decoder de miniaturas do Windows pode produzir faixas em fotos de
    // certas câmeras; FFmpeg gera uma prévia independente dele.
    try {
      const converted = await ffmpegStill(item.path, dest, { width: 480 });
      if (converted) return converted;
    } catch {
      // usa o decoder do sistema como alternativa
    }
    try { return await shellThumbnail(item, dest, 480, 82); } catch { /* próxima alternativa */ }
    if (WEB_IMAGE_EXTS.has(item.ext)) return pathToFileURL(item.path).href;
    return getFullPreview(item);
  }

  if (item.kind !== 'raw') return null;
  try {
    await exiftool.extractThumbnail(item.path, dest);
    if (urlIfExists(dest)) {
      await copyOrientation(item.path, dest);
      return urlIfExists(dest);
    }
  } catch {
    // fall through to full preview below
  }
  // some RAW files carry no small ThumbnailImage tag — fall back to the full preview
  return getFullPreview(item);
}

async function getFullPreview(item) {
  if (item.kind === 'image' && WEB_IMAGE_EXTS.has(item.ext)) return `${pathToFileURL(item.path).href}?v=${Math.round(item.mtimeMs || 0)}`;
  if (item.kind !== 'raw' && item.kind !== 'image') return null;

  const key = cacheKeyFor(item);
  const dest = path.join(PREVIEW_DIR, `${key}.jpg`);
  const cached = urlIfExists(dest);
  if (cached) return cached;

  if (item.kind === 'image') {
    // TIFF / HEIC: o Chromium não abre — vira um JPEG grande de prévia
    try {
      return await shellThumbnail(item, dest, 2560, 92);
    } catch {
      const viaFfmpeg = await ffmpegStill(item.path, dest);
      if (viaFfmpeg) return viaFfmpeg;
      try {
        await exiftool.extractPreview(item.path, dest);
        return urlIfExists(dest);
      } catch {
        return null;
      }
    }
  }

  try {
    await exiftool.extractJpgFromRaw(item.path, dest);
  } catch {
    try {
      await exiftool.extractPreview(item.path, dest);
    } catch {
      return null;
    }
  }
  if (!urlIfExists(dest)) return null;
  await copyOrientation(item.path, dest);
  return urlIfExists(dest);
}

async function getAlternatePreview(item) {
  if (item.kind !== 'raw' && item.kind !== 'image') return null;
  const dest = path.join(PREVIEW_DIR, `${cacheKeyFor(item)}-alternate.jpg`);
  const cached = urlIfExists(dest);
  if (cached) return cached;
  try {
    const converted = await ffmpegStill(item.path, dest, { width: 4096 });
    if (converted) return converted;
  } catch { /* formato não aceito pelo FFmpeg */ }
  try { return await shellThumbnail(item, dest, 4096, 90); }
  catch { return null; }
}

// Vídeo que o Chromium não decodifica (10-bit 4:2:2, ProRes, AVI, MXF...) ganha
// uma cópia leve em H.264 só pra assistir; frame e corte sempre usam o original.
async function ensureProxy(item, jobId) {
  const dest = path.join(PROXY_DIR, `${cacheKeyFor(item)}.mp4`);
  const cached = urlIfExists(dest);
  if (cached) return { ok: true, url: cached };
  const info = await probe(item.path);
  const part = dest.replace(/\.mp4$/, '.part.mp4');
  const res = await runFfmpeg([
    '-y', '-i', item.path, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "scale=-2:'min(1080,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-pix_fmt', 'yuv420p', '-g', '12', '-fps_mode', 'passthrough',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', part,
  ], {
    jobId,
    duration: info.duration,
    onProgress: (ratio) => { if (win && !win.isDestroyed()) win.webContents.send('job:progress', { jobId, ratio }); },
  });
  if (res.cancelled || res.code !== 0) {
    try { await fsp.unlink(part); } catch { /* nada pra limpar */ }
    return res.cancelled ? { ok: false, cancelled: true } : { ok: false, error: lastError(res.stderr) };
  }
  await fsp.rename(part, dest);
  return { ok: true, url: pathToFileURL(dest).href };
}

// ---- window ----

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    backgroundColor: '#0e0e10',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.on('maximize', () => win.webContents.send('window:maximized', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized', false));
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
  for (const child of jobs.values()) {
    try { child.kill(); } catch { /* já terminou */ }
  }
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

ipcMain.handle('session:chooseFile', async () => {
  const exts = (set) => [...set].map((e) => e.slice(1));
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Fotos e vídeos', extensions: [...exts(RAW_EXTS), ...exts(IMAGE_EXTS), ...exts(VIDEO_EXTS)] },
      { name: 'Vídeos', extensions: exts(VIDEO_EXTS) },
      { name: 'Fotos', extensions: [...exts(IMAGE_EXTS), ...exts(RAW_EXTS)] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// arrastar e soltar: pasta abre como job; arquivo abre a pasta dele já nele
ipcMain.handle('session:resolvePath', async (_e, p) => {
  try {
    const st = await fsp.stat(p);
    if (st.isDirectory()) return { folder: p, file: null };
    if (!MEDIA_EXTS.has(path.extname(p).toLowerCase())) return { error: 'formato não suportado' };
    return { folder: path.dirname(p), file: p };
  } catch {
    return { error: 'não consegui abrir esse caminho' };
  }
});

ipcMain.handle('session:load', async (_e, folderPath) => {
  const { items, recentFolders } = await buildSessionItems(folderPath);
  await rememberJob(folderPath);
  return { folderPath, items, recentFolders };
});

ipcMain.handle('settings:get', async () => {
  const settings = await loadSettings();
  settings.recentJobs = settings.recentJobs.filter((p) => fs.existsSync(p));
  return settings;
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
      // A API nativa do Electron não interpreta o caminho como glob. A
      // alternativa cobre sistemas nos quais a lixeira do shell falha.
      await sleep(250);
      await withRetry(async () => {
        try {
          await shell.trashItem(filePath);
        } catch (nativeError) {
          try { await trash([filePath], { glob: false }); }
          catch { throw nativeError; }
        }
        if (fs.existsSync(filePath)) throw new Error('O arquivo continua na pasta após enviar à lixeira');
      }, 8, 250);
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

const ROTATE_RIGHT = { 1: 6, 2: 7, 3: 8, 4: 5, 5: 2, 6: 3, 7: 4, 8: 1 };
const ROTATE_LEFT = { 1: 8, 2: 5, 3: 6, 4: 7, 5: 4, 6: 1, 7: 2, 8: 3 };

ipcMain.handle('session:rotate', async (_e, { folderPath, filePath, direction }) => {
  try {
    if (direction !== 'left' && direction !== 'right') throw new Error('Direção de giro inválida');
    const relative = path.relative(path.resolve(folderPath), path.resolve(filePath));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Foto fora da pasta aberta');
    if (!ROTATABLE_EXTS.has(path.extname(filePath).toLowerCase())) throw new Error('Este formato não aceita giro seguro no arquivo original');
    const before = await fsp.stat(filePath);
    if (!before.isFile()) throw new Error('O arquivo não é uma foto');
    const tags = await exiftool.read(filePath);
    const current = Number(tags.Orientation) || 1;
    const next = (direction === 'right' ? ROTATE_RIGHT : ROTATE_LEFT)[current];
    if (!next) throw new Error('Orientação EXIF inválida');
    const backupPath = `${filePath}.decupagem-original`;
    try {
      await withRetry(() => fsp.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL));
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    await sleep(250);
    await withRetry(() => exiftool.write(filePath, { 'Orientation#': next }, ['-overwrite_original']), 8, 250);
    const saved = Number((await exiftool.read(filePath)).Orientation) || 1;
    if (saved !== next) throw new Error('O arquivo não confirmou o giro; o backup foi preservado');
    const after = await fsp.stat(filePath);
    return { ok: true, orientation: next, backupPath, size: after.size, mtimeMs: after.mtimeMs };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('preview:alternate', async (_e, item) => {
  try { return await getAlternatePreview(item); }
  catch { return null; }
});

// ---- IPC: vídeo (probe, proxy, frame, corte) ----

ipcMain.handle('media:probe', async (_e, filePath) => {
  try {
    return await probe(filePath);
  } catch {
    return null;
  }
});

ipcMain.handle('media:proxy', async (_e, { item, jobId }) => {
  try {
    return await ensureProxy(item, jobId);
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('media:saveFrame', async (_e, payload) => {
  try {
    return { ok: true, ...(await saveFrame(payload)) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('media:saveClip', async (_e, payload) => {
  try {
    return await saveClip(payload);
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('media:cancel', async (_e, jobId) => {
  const child = jobs.get(jobId);
  if (!child) return false;
  child.cancelledByUser = true;
  child.kill();
  return true;
});

ipcMain.handle('shell:showItem', async (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});
