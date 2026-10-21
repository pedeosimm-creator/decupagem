(() => {
  hydrateIcons();

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  const prefs = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(`decupagem.${key}`);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(`decupagem.${key}`, JSON.stringify(value)); } catch { /* sem storage */ }
    },
  };

  const state = {
    folderPath: null,
    items: [],
    recentFolders: [],
    filter: 'todos',
    kind: 'all',
    query: '',
    view: prefs.get('view', 'grid'),
    sort: prefs.get('sort', 'name'),
    vItems: [],
    vIndex: -1,
    previewCache: new Map(),
    probe: null, // info do vídeo aberto (fps, duração, bit depth…)
    frameTime: null, // mediaTime do último frame realmente exibido
    markIn: null,
    markOut: null,
    proxyJob: null,
    usingProxy: false,
    frameFormat: prefs.get('frameFormat', 'png'),
    frameFollowLook: prefs.get('frameFollowLook', true),
    clipMode: prefs.get('clipMode', 'exact'),
    look: prefs.get('look', true),
    muted: prefs.get('muted', false),
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    home: $('home'), browser: $('browser'), viewer: $('viewer'),
    folderLabel: $('folder-label'), jobName: $('job-name'), jobPath: $('job-path'),
    grid: $('grid'), gridEmpty: $('grid-empty'), filters: $('filters'), resultCount: $('result-count'), trashRejected: $('btn-trash-rejected'),
    search: $('search'), kindFilter: $('kind-filter'), thumbSize: $('thumb-size'), viewMode: $('view-mode'), sortMode: $('sort-mode'),
    progressPct: $('progress-pct'), progressFill: $('progress-fill'), progressText: $('progress-text'),
    recentJobs: $('recent-jobs'), recentList: $('recent-list'), dropzone: $('dropzone'), dropOverlay: $('drop-overlay'),
    stage: $('v-stage'), image: $('v-image'), video: $('v-video'), vName: $('v-name'), vMeta: $('v-meta'),
    vCounter: $('v-counter'), vStatus: $('v-status'), vAlternate: $('v-alternate'), vRotateLeft: $('v-rotate-left'), vRotateRight: $('v-rotate-right'), vReject: $('v-reject'), vPrev: $('v-prev'), vNext: $('v-next'), zoomHint: $('v-zoom-hint'),
    loading: $('v-loading'), loadingTitle: $('v-loading-title'), loadingDetail: $('v-loading-detail'), loadingFill: $('v-loading-fill'),
    flash: $('v-flash'), videoUi: $('v-video-ui'), timeline: $('timeline'), tlPlayed: $('tl-played'), tlBuffer: $('tl-buffer'),
    tlRange: $('tl-range'), tlIn: $('tl-in'), tlOut: $('tl-out'), tlHead: $('tl-head'), tlHover: $('tl-hover'),
    play: $('tr-play'), tcCur: $('tc-cur'), tcDur: $('tc-dur'), mute: $('tr-mute'), speed: $('tr-speed'), look: $('tr-look'),
    cutIn: $('cut-in'), cutOut: $('cut-out'), cutInTc: $('cut-in-tc'), cutOutTc: $('cut-out-tc'), cutClear: $('cut-clear'),
    cutSave: $('cut-save'), cutOpts: $('cut-opts'), frameSave: $('frame-save'), frameOpts: $('frame-opts'), frameFmt: $('frame-fmt'),
    decide: $('v-decide'), popRename: $('pop-rename'), renameInput: $('rename-input'), popFolder: $('pop-folder'),
    folderInput: $('folder-input'), folderRecent: $('folder-recent'), popFrame: $('pop-frame'), popClip: $('pop-clip'),
    help: $('help'), toasts: $('toasts'),
  };

  // ---- utilidades ----

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toFileUrl(p) {
    let clean = p.replace(/\\/g, '/');
    if (!clean.startsWith('/')) clean = '/' + clean;
    return 'file://' + encodeURI(clean).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }

  function basename(p) {
    return p.split(/[\\/]/).filter(Boolean).pop() || p;
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function formatDateTime(ms) {
    return ms ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(ms)) : '—';
  }

  function formatDuration(sec) {
    if (!sec && sec !== 0) return '';
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  function fpsOf() {
    return (state.probe && state.probe.fps) || 30;
  }

  function timecode(sec) {
    const fps = fpsOf();
    const rate = Math.max(1, Math.round(fps));
    const t = Math.max(0, sec || 0);
    const frames = Math.round(t * fps);
    const ff = frames % rate;
    const whole = Math.floor((frames - ff) / fps + 1e-6);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}:${pad(ff)}`;
  }

  function isPhoto(item) { return item.kind === 'raw' || item.kind === 'image'; }

  function sortItems() {
    state.items.sort((a, b) => collator.compare(a.name, b.name));
  }

  // ---- toasts ----

  function toast({ kind = 'info', title, detail = '', actions = [], progress = false, timeout = 4200, onClose }) {
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    const iconName = kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'sparkle';
    node.innerHTML = `
      <div class="t-ic">${icon(iconName)}</div>
      <div class="t-body">
        <div class="t-title">${escapeHtml(title)}</div>
        <div class="t-detail">${escapeHtml(detail)}</div>
        ${progress ? '<div class="t-bar"><div></div></div>' : ''}
        <div class="t-actions"></div>
      </div>
      <button class="t-x" title="Fechar">${icon('close')}</button>`;
    const actionsEl = node.querySelector('.t-actions');
    const handle = {
      update({ ratio, title: t, detail: d } = {}) {
        if (ratio != null && node.querySelector('.t-bar div')) node.querySelector('.t-bar div').style.width = `${Math.round(ratio * 100)}%`;
        if (t) node.querySelector('.t-title').textContent = t;
        if (d != null) node.querySelector('.t-detail').textContent = d;
      },
      close() {
        if (node.classList.contains('out')) return;
        node.classList.add('out');
        setTimeout(() => node.remove(), 220);
        if (onClose) onClose();
      },
      setActions(list) {
        actionsEl.innerHTML = '';
        actionsEl.hidden = list.length === 0;
        for (const a of list) {
          const b = document.createElement('button');
          b.textContent = a.label;
          b.onclick = () => { a.fn(); if (a.close !== false) handle.close(); };
          actionsEl.appendChild(b);
        }
      },
      later(ms) { setTimeout(() => handle.close(), ms); },
    };
    handle.setActions(actions);
    node.querySelector('.t-x').onclick = () => handle.close();
    el.toasts.appendChild(node);
    if (timeout) handle.later(timeout);
    return handle;
  }

  function errorToast(title, err) {
    toast({ kind: 'err', title, detail: err || 'Tenta de novo.', timeout: 7000 });
  }

  // ---- janela ----

  $('btn-min').onclick = () => winapi.minimize();
  $('btn-max').onclick = () => winapi.toggleMaximize();
  $('btn-close').onclick = () => winapi.close();
  winapi.onMaximized((max) => {
    $('btn-max').innerHTML = icon(max ? 'restore' : 'maximize');
  });

  // ---- abrir pasta / arquivo ----

  $('btn-choose').onclick = chooseFolder;
  $('btn-trocar-pasta').onclick = chooseFolder;
  $('btn-open-file').onclick = chooseFile;
  $('btn-open-file-2').onclick = chooseFile;
  $('btn-reload').onclick = () => state.folderPath && loadFolder(state.folderPath);

  async function chooseFolder() {
    const folder = await sessionapi.chooseFolder();
    if (folder) await loadFolder(folder);
  }

  async function chooseFile() {
    const file = await sessionapi.chooseFile();
    if (file) await openPath(file);
  }

  async function openPath(p) {
    const res = await sessionapi.resolvePath(p);
    if (!res || res.error) { errorToast('Não deu pra abrir', res && res.error); return; }
    await loadFolder(res.folder, res.file);
  }

  async function loadFolder(folder, openFile = null) {
    let data;
    try {
      data = await sessionapi.load(folder);
    } catch (err) {
      errorToast('Não consegui ler a pasta', String(err && err.message));
      return;
    }
    state.folderPath = data.folderPath;
    state.items = data.items;
    state.recentFolders = data.recentFolders;
    state.previewCache.clear();
    el.folderLabel.textContent = state.folderPath;
    el.jobName.textContent = basename(state.folderPath);
    el.jobPath.textContent = state.folderPath;
    el.jobPath.title = state.folderPath;
    el.home.hidden = true;
    el.browser.hidden = false;
    if (!el.viewer.hidden) closeViewer(false);

    if (openFile) {
      const target = openFile.toLowerCase();
      state.filter = 'todos';
      state.kind = 'all';
      state.query = '';
      el.search.value = '';
      syncFilterButtons();
      renderGrid();
      const list = visibleItems();
      const idx = list.findIndex((it) => it.path && it.path.toLowerCase() === target);
      if (idx !== -1) openViewer(list, idx);
    } else {
      renderGrid();
    }
  }

  async function renderRecent() {
    const settings = await sessionapi.settings();
    const jobs = (settings && settings.recentJobs) || [];
    el.recentJobs.hidden = jobs.length === 0;
    el.recentList.innerHTML = '';
    for (const p of jobs) {
      const b = document.createElement('button');
      b.className = 'recent-item';
      b.innerHTML = `${icon('folder')}<span class="r-text"><span class="r-name">${escapeHtml(basename(p))}</span><span class="r-path">${escapeHtml(p)}</span></span>`;
      b.onclick = () => loadFolder(p);
      el.recentList.appendChild(b);
    }
  }
  renderRecent();

  // arrastar e soltar em qualquer lugar da janela
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    el.dropOverlay.hidden = false;
    el.dropzone.classList.add('over');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) { el.dropOverlay.hidden = true; el.dropzone.classList.remove('over'); }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.dropOverlay.hidden = true;
    el.dropzone.classList.remove('over');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const p = sessionapi.pathForFile(file);
    if (p) openPath(p);
  });

  // ---- filtros ----

  function statusMatches(status, filter) {
    if (filter === 'todos') return status !== 'exported' && status !== 'rejected' && status !== 'discarded';
    if (filter === 'pendentes') return status === 'pending';
    if (filter === 'talvez') return status === 'maybe';
    if (filter === 'aprovados') return status === 'approved';
    if (filter === 'desaprovadas') return status === 'rejected';
    if (filter === 'descarte') return status === 'discarded';
    if (filter === 'exportados') return status === 'exported';
    return true;
  }

  function kindMatches(item) {
    if (state.kind === 'all') return true;
    if (item.kind === 'ghost') {
      const ext = item.ext || '';
      const video = /\.(mp4|mov|m4v|webm|mkv|avi|mts|m2ts|mxf|wmv|mpg|mpeg|3gp|flv|ogv)$/.test(ext);
      return state.kind === 'video' ? video : !video;
    }
    return state.kind === 'video' ? item.kind === 'video' : isPhoto(item);
  }

  function visibleItems() {
    const q = state.query.trim().toLowerCase();
    const items = state.items.filter((it) => statusMatches(it.status, state.filter) && kindMatches(it) && (!q || it.name.toLowerCase().includes(q)));
    if (state.sort !== 'name') items.sort((a, b) => (state.sort === 'date-desc' ? b.mtimeMs - a.mtimeMs : a.mtimeMs - b.mtimeMs) || collator.compare(a.name, b.name));
    return items;
  }

  function syncFilterButtons() {
    for (const b of el.filters.querySelectorAll('.filter')) b.classList.toggle('active', b.dataset.filter === state.filter);
    for (const b of el.kindFilter.querySelectorAll('.seg')) b.classList.toggle('active', b.dataset.kind === state.kind);
  }

  el.filters.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    syncFilterButtons();
    renderGrid();
  });

  el.kindFilter.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    state.kind = btn.dataset.kind;
    syncFilterButtons();
    renderGrid();
  });

  function syncViewButtons() {
    for (const b of el.viewMode.querySelectorAll('.seg')) b.classList.toggle('active', b.dataset.view === state.view);
    el.thumbSize.hidden = state.view === 'list';
    el.grid.classList.toggle('list-view', state.view === 'list');
  }
  if (!['grid', 'list'].includes(state.view)) state.view = 'grid';
  if (!['name', 'date-desc', 'date-asc'].includes(state.sort)) state.sort = 'name';
  el.sortMode.value = state.sort;
  syncViewButtons();
  el.viewMode.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    state.view = btn.dataset.view;
    prefs.set('view', state.view);
    syncViewButtons();
    renderGrid();
  });
  el.sortMode.addEventListener('change', () => {
    state.sort = el.sortMode.value;
    prefs.set('sort', state.sort);
    renderGrid();
  });

  let searchTimer;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = el.search.value; renderGrid(); }, 120);
  });

  el.thumbSize.value = prefs.get('thumbSize', 210);
  document.documentElement.style.setProperty('--tile-min', `${el.thumbSize.value}px`);
  el.thumbSize.addEventListener('input', () => {
    document.documentElement.style.setProperty('--tile-min', `${el.thumbSize.value}px`);
    prefs.set('thumbSize', Number(el.thumbSize.value));
  });

  function updateCounts() {
    const counts = { todos: 0, pendentes: 0, talvez: 0, aprovados: 0, desaprovadas: 0, descarte: 0, exportados: 0 };
    for (const it of state.items) {
      if (it.status === 'exported') { counts.exportados++; continue; }
      if (it.status === 'discarded') { counts.descarte++; continue; }
      if (it.status === 'rejected') { counts.desaprovadas++; continue; }
      counts.todos++;
      if (it.status === 'pending') counts.pendentes++;
      else if (it.status === 'maybe') counts.talvez++;
      else if (it.status === 'approved') counts.aprovados++;
    }
    for (const b of el.filters.querySelectorAll('.filter')) b.querySelector('.count').textContent = counts[b.dataset.filter] || '';
    el.trashRejected.hidden = state.filter !== 'desaprovadas' || counts.desaprovadas === 0;
    el.trashRejected.innerHTML = `${icon('trash')}Excluir ${counts.desaprovadas} desaprovada${counts.desaprovadas === 1 ? '' : 's'}`;
    const total = counts.todos + counts.desaprovadas;
    const decided = total - counts.pendentes;
    const pct = total ? Math.round((decided / total) * 100) : 0;
    el.progressPct.textContent = `${pct}%`;
    el.progressFill.style.width = `${pct}%`;
    el.progressText.textContent = total
      ? (counts.pendentes ? `${decided} de ${total} decididos · faltam ${counts.pendentes}` : `Tudo decidido · ${total} arquivos`)
      : 'Nenhuma foto ou vídeo nesta pasta';
  }

  el.trashRejected.addEventListener('click', async () => {
    if (!state.folderPath || el.trashRejected.disabled) return;
    const count = state.items.filter((it) => it.status === 'rejected').length;
    if (!count || !window.confirm(`Enviar ${count} arquivo${count === 1 ? '' : 's'} de Desaprovadas para a Lixeira do Windows?\n\nAs outras pilhas não serão alteradas.`)) return;
    el.trashRejected.disabled = true;
    const folder = state.folderPath;
    let result;
    try { result = await sessionapi.trashRejected({ folderPath: folder }); }
    catch (err) { result = { ok: false, deleted: [], errors: [{ error: String(err && err.message ? err.message : err) }] }; }
    el.trashRejected.disabled = false;
    await loadFolder(folder);
    if (result.ok) toast({ kind: 'ok', title: `${result.deleted.length} arquivo${result.deleted.length === 1 ? '' : 's'} enviado${result.deleted.length === 1 ? '' : 's'} à Lixeira` });
    else errorToast('Alguns arquivos não foram excluídos', (result.errors || []).slice(0, 3).map((e) => `${e.name}: ${e.error}`).join(' · '));
  });

  // ---- grade ----

  const STATUS_ICON = { approved: 'check', maybe: 'question', rejected: 'close', discarded: 'close', exported: 'camera' };
  let gridToken = 0;
  let thumbObserver = null;
  const thumbQueue = [];
  let thumbActive = 0;

  function renderGrid() {
    updateCounts();
    const list = visibleItems();
    const token = ++gridToken;
    thumbQueue.length = 0;
    if (thumbObserver) thumbObserver.disconnect();
    thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbObserver.unobserve(entry.target);
        const item = entry.target._item;
        if (item) enqueueThumb(entry.target, item, token);
      }
    }, { root: el.grid, rootMargin: '400px 0px' });

    el.grid.innerHTML = '';
    el.gridEmpty.hidden = list.length > 0;
    el.resultCount.textContent = `${list.length} ${list.length === 1 ? 'arquivo' : 'arquivos'}`;
    const frag = document.createDocumentFragment();

    list.forEach((item, i) => {
      const tile = document.createElement('div');
      tile.className = 'tile' + (item.status === 'discarded' ? ' ghost' : '');
      tile.style.animationDelay = `${Math.min(i, 24) * 12}ms`;
      tile._item = item;
      const extLabel = (item.ext || '').replace('.', '').toUpperCase();
      const phIcon = item.status === 'discarded' ? 'trash' : item.kind === 'video' ? 'film' : 'image';
      const statusKey = item.status && item.status.startsWith('custom:') ? 'custom' : item.status;
      const meta = item.status === 'discarded' ? 'Na lixeira' : [extLabel, formatSize(item.size)].filter(Boolean).join(' · ');
      const location = item.path ? item.path.slice(state.folderPath.length).replace(/^[\\/]+/, '').replace(/[\\/][^\\/]+$/, '') || 'Raiz' : '—';
      tile.innerHTML = `
        <div class="thumb">
          <div class="ph">${icon(phIcon)}</div>
          ${item.kind === 'raw' ? `<span class="tag">RAW · ${escapeHtml(extLabel)}</span>` : ''}
          ${STATUS_ICON[statusKey] || statusKey === 'custom' ? `<span class="status ${statusKey}">${icon(STATUS_ICON[statusKey] || 'folder')}</span>` : ''}
        </div>
        <div class="cap"><span class="n" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><span class="m">${escapeHtml(meta)}</span></div>
        <div class="list-detail"><span title="Data e hora de modificação do arquivo">${formatDateTime(item.mtimeMs)}</span><span>${escapeHtml(meta)}</span><span title="Pasta relativa ao job">${escapeHtml(location)}</span></div>`;
      if (item.status !== 'discarded') {
        tile.addEventListener('click', () => openViewer(list, list.indexOf(item)));
        thumbObserver.observe(tile);
      }
      frag.appendChild(tile);
    });
    el.grid.appendChild(frag);
  }

  function enqueueThumb(tile, item, token) {
    thumbQueue.push({ tile, item, token });
    pumpThumbs();
  }

  function pumpThumbs() {
    while (thumbActive < 4 && thumbQueue.length) {
      const job = thumbQueue.shift();
      if (job.token !== gridToken) continue;
      thumbActive++;
      loadThumb(job).finally(() => { thumbActive--; pumpThumbs(); });
    }
  }

  async function loadThumb({ tile, item, token }) {
    const url = await previewapi.thumbnail(item);
    if (token !== gridToken) return;
    const thumb = tile.querySelector('.thumb');
    if (url) {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (token !== gridToken) return;
        const ph = thumb.querySelector('.ph');
        if (ph) ph.remove();
        thumb.prepend(img);
        tile.classList.add('loaded');
      };
      img.onerror = () => tile.classList.add('noprev');
      img.src = url;
    } else {
      tile.classList.add('noprev');
    }
    if (item.kind === 'video') {
      const info = await mediaapi.probe(item.path);
      if (token !== gridToken || !info || !info.duration) return;
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.innerHTML = `${icon('play')}${formatDuration(info.duration)}`;
      thumb.appendChild(dur);
    }
  }

  // ---- visualizador ----

  function openViewer(list, index) {
    state.vItems = list.filter((it) => it.status !== 'discarded');
    const item = list[index];
    state.vIndex = state.vItems.indexOf(item);
    if (state.vIndex === -1) return;
    el.viewer.hidden = false;
    showCurrent();
  }

  function closeViewer(rerender = true) {
    el.viewer.hidden = true;
    releaseMedia();
    hidePopovers();
    setZoom(false);
    if (rerender) renderGrid();
  }

  // Windows trava o arquivo enquanto o <video>/<img> tem um handle aberto —
  // mover/renomear/excluir falha se não soltarmos antes de pedir ao main.
  function releaseMedia() {
    cancelProxy();
    el.video.pause();
    el.video.removeAttribute('src');
    el.video.load();
    el.image.removeAttribute('src');
  }

  function cancelProxy() {
    if (state.proxyJob) {
      mediaapi.cancel(state.proxyJob);
      state.proxyJob = null;
    }
  }

  $('v-close').onclick = () => closeViewer();
  el.vPrev.onclick = () => goToOffset(-1);
  el.vNext.onclick = () => goToOffset(1);

  function showLoading(title, detail = '', ratio = null) {
    el.loading.hidden = false;
    el.loadingTitle.textContent = title;
    el.loadingDetail.textContent = detail;
    const bar = el.loading.querySelector('.v-loading-bar');
    bar.hidden = ratio === null;
    if (ratio !== null) el.loadingFill.style.width = `${Math.round(ratio * 100)}%`;
  }

  function hideLoading() {
    el.loading.hidden = true;
  }

  const STATUS_LABEL = { pending: 'Pendente', approved: 'Aprovado', maybe: 'Talvez', rejected: 'Desaprovado', exported: 'Exportado' };

  function renderMeta(item, info) {
    const chips = [];
    const ext = (item.ext || '').replace('.', '').toUpperCase();
    chips.push(`<span class="chip">${escapeHtml(item.kind === 'raw' ? `RAW ${ext}` : ext)}</span>`);
    if (info && info.displayWidth) chips.push(`<span class="chip">${info.displayWidth}×${info.displayHeight}</span>`);
    if (info && info.fps) chips.push(`<span class="chip">${Math.round(info.fps * 100) / 100} fps</span>`);
    if (info && info.bitDepth > 8) chips.push(`<span class="chip hl">${info.bitDepth}-bit</span>`);
    if (info && info.codec) chips.push(`<span class="chip">${escapeHtml(info.codec.toUpperCase())}</span>`);
    if (info && info.duration) chips.push(`<span class="chip">${formatDuration(info.duration)}</span>`);
    if (item.size) chips.push(`<span class="chip">${formatSize(item.size)}</span>`);
    if (item.mtimeMs) chips.push(`<span class="chip" title="Data e hora de modificação do arquivo">${formatDateTime(item.mtimeMs)}</span>`);
    if (state.usingProxy) chips.push('<span class="chip hl" title="O formato não toca direto; você assiste uma cópia leve, mas frame e corte usam o original">prévia convertida</span>');
    el.vMeta.innerHTML = chips.join('');
  }

  async function showCurrent() {
    hidePopovers();
    setZoom(false);
    hideLoading();
    cancelProxy();
    const item = state.vItems[state.vIndex];
    if (!item) { closeViewer(); return; }

    el.vName.textContent = item.name;
    el.vCounter.textContent = `${state.vIndex + 1} / ${state.vItems.length}`;
    const statusKey = item.status && item.status.startsWith('custom:') ? null : item.status;
    el.vStatus.hidden = !STATUS_LABEL[statusKey];
    el.vStatus.className = `status-pill ${statusKey}`;
    el.vStatus.textContent = STATUS_LABEL[statusKey] || '';
    el.vPrev.disabled = state.vIndex === 0;
    el.vNext.disabled = state.vIndex >= state.vItems.length - 1;
    el.vAlternate.hidden = item.kind === 'video';
    const rejected = item.status === 'rejected';
    el.vReject.dataset.action = rejected ? 'restore' : 'reject';
    el.vReject.innerHTML = rejected ? `${icon('refresh')}Voltar para pendentes<kbd>U</kbd>` : `${icon('close')}Desaprovar<kbd>Del</kbd>`;
    const canRotate = item.kind !== 'video' && /\.(jpe?g|jfif|tiff?|heic|heif|arw|srf|sr2|cr2|cr3|crw|nef|nrw|dng|raf|orf|rw2|pef|srw|3fr|iiq|rwl|x3f|erf|kdc|mrw|mos)$/i.test(item.ext);
    el.vRotateLeft.hidden = !canRotate;
    el.vRotateRight.hidden = !canRotate;

    el.video.pause();
    el.video.hidden = true;
    el.image.hidden = true;
    el.videoUi.hidden = true;
    el.zoomHint.hidden = true;
    state.probe = null;
    state.usingProxy = false;
    renderMeta(item, null);

    if (item.kind === 'video') {
      await showVideo(item);
    } else {
      await showImage(item);
    }
    prefetchNeighbors();
  }

  async function showImage(item) {
    el.image.hidden = false;
    el.image.removeAttribute('src');
    const cached = state.previewCache.get(item.path);
    if (cached) {
      el.image.src = cached;
    } else {
      if (item.kind === 'raw' || !/\.(jpe?g|jfif|png|webp|gif|bmp|avif|ico)$/i.test(item.ext)) showLoading('Gerando prévia…');
      const url = await previewapi.full(item);
      if (state.vItems[state.vIndex] !== item) return;
      hideLoading();
      if (!url) { errorToast('Sem prévia pra este arquivo', item.name); return; }
      state.previewCache.set(item.path, url);
      el.image.src = url;
    }
    el.image.onload = () => {
      if (state.vItems[state.vIndex] !== item) return;
      renderMeta(item, { displayWidth: el.image.naturalWidth, displayHeight: el.image.naturalHeight });
      el.zoomHint.hidden = !(el.image.naturalWidth > el.image.clientWidth + 4);
    };
  }

  el.vAlternate.addEventListener('click', async () => {
    const item = state.vItems[state.vIndex];
    if (!item || item.kind === 'video') return;
    showLoading('Gerando outra prévia…');
    const url = await previewapi.alternate(item);
    if (state.vItems[state.vIndex] !== item) return;
    hideLoading();
    if (!url) { errorToast('Não consegui gerar outra prévia', item.name); return; }
    state.previewCache.set(item.path, url);
    el.image.src = url;
  });

  async function rotateCurrent(direction) {
    const item = state.vItems[state.vIndex];
    if (!item || el.vRotateRight.disabled) return;
    el.vRotateLeft.disabled = true;
    el.vRotateRight.disabled = true;
    releaseMedia();
    showLoading('Salvando orientação…');
    let result;
    try {
      result = await sessionapi.rotate({ folderPath: state.folderPath, filePath: item.path, direction });
    } catch (err) {
      result = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    hideLoading();
    el.vRotateLeft.disabled = false;
    el.vRotateRight.disabled = false;
    if (!result.ok) {
      errorToast('Não consegui girar a foto', result.error);
      showCurrent();
      return;
    }
    item.size = result.size;
    item.mtimeMs = result.mtimeMs;
    state.previewCache.delete(item.path);
    toast({ kind: 'ok', title: 'Foto girada e salva no original', detail: 'Cópia de segurança: ' + result.backupPath });
    showCurrent();
  }

  el.vRotateLeft.addEventListener('click', () => rotateCurrent('left'));
  el.vRotateRight.addEventListener('click', () => rotateCurrent('right'));

  async function showVideo(item) {
    el.video.hidden = false;
    el.videoUi.hidden = false;
    state.frameTime = null;
    state.markIn = null;
    state.markOut = null;
    updateMarks();
    applyLook();
    el.video.muted = state.muted;
    el.video.playbackRate = Number(el.speed.value) || 1;
    updateMuteIcon();
    updateFrameLabel();

    el.video.src = toFileUrl(item.path);
    el.video.load();
    trackFrames();
    el.video.play().catch(() => {});

    const info = await mediaapi.probe(item.path);
    if (state.vItems[state.vIndex] !== item) return;
    state.probe = info;
    renderMeta(item, info);
    updateFrameLabel();
    el.tcDur.textContent = timecode((info && info.duration) || el.video.duration || 0);
  }

  // Vídeo que o Chromium não decodifica: troca por uma prévia convertida
  async function fallbackToProxy() {
    const item = state.vItems[state.vIndex];
    if (!item || item.kind !== 'video' || state.usingProxy || state.proxyJob) return;
    const resumeAt = el.video.currentTime || 0;
    const jobId = `proxy-${Date.now()}`;
    state.proxyJob = jobId;
    el.video.removeAttribute('src');
    el.video.load();
    showLoading('Preparando o vídeo pra assistir…', 'Esse formato não toca direto (10-bit 4:2:2, ProRes, AVI…). Gero uma cópia leve só pra visualizar; o frame e o corte continuam saindo do arquivo original.', 0);
    const res = await mediaapi.proxy(item, jobId);
    if (state.proxyJob !== jobId) return; // trocou de arquivo no meio
    state.proxyJob = null;
    if (!res || !res.ok) {
      hideLoading();
      if (!res || !res.cancelled) errorToast('Não consegui preparar o vídeo', res && res.error);
      return;
    }
    hideLoading();
    state.usingProxy = true;
    renderMeta(item, state.probe);
    el.video.src = res.url;
    el.video.load();
    el.video.currentTime = resumeAt;
    trackFrames();
    el.video.play().catch(() => {});
  }

  mediaapi.onProgress(({ jobId, ratio }) => {
    if (jobId && jobId === state.proxyJob) {
      el.loadingFill.style.width = `${Math.round(ratio * 100)}%`;
      el.loadingTitle.textContent = `Preparando o vídeo pra assistir… ${Math.round(ratio * 100)}%`;
    }
    const t = clipToasts.get(jobId);
    if (t) t.update({ ratio, title: `Salvando corte… ${Math.round(ratio * 100)}%` });
  });

  el.video.addEventListener('error', () => {
    if (el.video.hidden || !el.video.getAttribute('src')) return;
    fallbackToProxy();
  });
  el.video.addEventListener('loadedmetadata', () => {
    // faixa de vídeo que o decoder não aceita às vezes "abre" só com o áudio
    if (el.video.videoWidth === 0) {
      fallbackToProxy();
      return;
    }
    if (!state.probe || !state.probe.duration) el.tcDur.textContent = timecode(el.video.duration);
  });
  el.video.addEventListener('play', updatePlayIcon);
  el.video.addEventListener('pause', updatePlayIcon);
  el.video.addEventListener('progress', updateBuffer);

  function trackFrames() {
    if (!el.video.requestVideoFrameCallback) return;
    const video = el.video;
    const src = video.currentSrc || video.src;
    const cb = (_now, meta) => {
      if ((video.currentSrc || video.src) !== src || video.hidden) return;
      state.frameTime = meta.mediaTime;
      video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
  }

  // instante (pts) do frame que está na tela agora
  function shownFrameTime() {
    const fps = fpsOf();
    const t = el.video.currentTime || 0;
    if (state.frameTime != null && Math.abs(state.frameTime - t) < 1.5 / fps) return state.frameTime;
    return Math.floor(t * fps + 1e-3) / fps;
  }

  function prefetchNeighbors() {
    for (const off of [1, -1, 2]) {
      const it = state.vItems[state.vIndex + off];
      if (!it || it.kind === 'video' || state.previewCache.has(it.path)) continue;
      previewapi.full(it).then((url) => { if (url) state.previewCache.set(it.path, url); });
    }
  }

  function goToOffset(offset) {
    const next = state.vIndex + offset;
    if (next < 0 || next >= state.vItems.length) return;
    releaseMedia();
    state.vIndex = next;
    showCurrent();
  }

  // ---- zoom de foto ----

  function setZoom(on, evt) {
    if (on && el.image.hidden) return;
    const was = el.stage.classList.contains('zoomed');
    el.stage.classList.toggle('zoomed', on);
    if (on && !was) {
      const rect = el.image.getBoundingClientRect();
      const fx = evt ? (evt.clientX - rect.left) / rect.width : 0.5;
      const fy = evt ? (evt.clientY - rect.top) / rect.height : 0.5;
      requestAnimationFrame(() => {
        el.stage.scrollLeft = el.image.naturalWidth * fx - el.stage.clientWidth / 2;
        el.stage.scrollTop = el.image.naturalHeight * fy - el.stage.clientHeight / 2;
      });
      el.zoomHint.hidden = true;
    }
  }

  let panning = null;
  el.image.addEventListener('mousedown', (e) => {
    if (!el.stage.classList.contains('zoomed')) return;
    panning = { x: e.clientX, y: e.clientY, sl: el.stage.scrollLeft, st: el.stage.scrollTop, moved: false };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    const dx = e.clientX - panning.x;
    const dy = e.clientY - panning.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) panning.moved = true;
    el.stage.scrollLeft = panning.sl - dx;
    el.stage.scrollTop = panning.st - dy;
  });
  window.addEventListener('mouseup', () => { setTimeout(() => { panning = null; }, 0); });
  el.image.addEventListener('click', (e) => {
    if (panning && panning.moved) return;
    setZoom(!el.stage.classList.contains('zoomed'), e);
  });

  // ---- transporte ----

  function updatePlayIcon() {
    el.play.innerHTML = icon(el.video.paused ? 'play' : 'pause');
  }

  function togglePlay() {
    if (el.video.hidden) return;
    if (el.video.paused) el.video.play().catch(() => {});
    else el.video.pause();
  }

  function stepFrames(n) {
    if (el.video.hidden) return;
    el.video.pause();
    const fps = fpsOf();
    const base = shownFrameTime();
    // mira o meio do intervalo do frame vizinho pra cair nele com folga
    const target = base + n / fps + 0.25 / fps;
    el.video.currentTime = Math.max(0, Math.min(el.video.duration || target, target));
  }

  function seekBy(sec) {
    if (el.video.hidden) return;
    el.video.currentTime = Math.max(0, Math.min(el.video.duration || 0, el.video.currentTime + sec));
  }

  el.play.onclick = togglePlay;
  $('tr-back').onclick = () => stepFrames(-1);
  $('tr-fwd').onclick = () => stepFrames(1);
  el.mute.onclick = toggleMute;
  el.speed.onchange = () => { el.video.playbackRate = Number(el.speed.value) || 1; };
  el.look.onclick = toggleLook;

  function toggleMute() {
    state.muted = !state.muted;
    prefs.set('muted', state.muted);
    el.video.muted = state.muted;
    updateMuteIcon();
  }

  function updateMuteIcon() {
    el.mute.innerHTML = icon(state.muted ? 'volumeOff' : 'volume');
  }

  function toggleLook() {
    state.look = !state.look;
    prefs.set('look', state.look);
    applyLook();
    updateFrameLabel();
  }

  function applyLook() {
    el.video.classList.toggle('rec709', state.look);
    el.look.classList.toggle('on', state.look);
  }

  // loop de desenho da timeline enquanto o visualizador de vídeo está aberto
  function tick() {
    if (!el.viewer.hidden && !el.video.hidden) {
      const dur = el.video.duration || (state.probe && state.probe.duration) || 0;
      const t = el.video.paused ? shownFrameTime() : el.video.currentTime;
      const pct = dur ? Math.min(100, (t / dur) * 100) : 0;
      el.tlPlayed.style.width = `${pct}%`;
      el.tlHead.style.left = `${pct}%`;
      el.tcCur.textContent = timecode(t);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  function updateBuffer() {
    const dur = el.video.duration;
    if (!dur || !el.video.buffered.length) return;
    const end = el.video.buffered.end(el.video.buffered.length - 1);
    el.tlBuffer.style.width = `${Math.min(100, (end / dur) * 100)}%`;
  }

  function timeAt(clientX) {
    const rect = el.timeline.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * (el.video.duration || 0);
  }

  let scrubbing = false;
  let wasPlaying = false;
  el.timeline.addEventListener('mousedown', (e) => {
    if (!el.video.duration) return;
    scrubbing = true;
    wasPlaying = !el.video.paused;
    el.video.pause();
    el.video.currentTime = timeAt(e.clientX);
  });
  window.addEventListener('mousemove', (e) => {
    if (scrubbing) el.video.currentTime = timeAt(e.clientX);
  });
  window.addEventListener('mouseup', () => {
    if (!scrubbing) return;
    scrubbing = false;
    if (wasPlaying) el.video.play().catch(() => {});
  });
  el.timeline.addEventListener('mousemove', (e) => {
    if (!el.video.duration) return;
    const rect = el.timeline.getBoundingClientRect();
    el.tlHover.hidden = false;
    el.tlHover.style.left = `${Math.min(rect.width - 40, Math.max(40, e.clientX - rect.left))}px`;
    el.tlHover.textContent = timecode(timeAt(e.clientX));
  });
  el.timeline.addEventListener('mouseleave', () => { el.tlHover.hidden = true; });

  // ---- marcações e corte ----

  function setMarkIn() {
    if (el.video.hidden) return;
    state.markIn = shownFrameTime();
    if (state.markOut != null && state.markOut <= state.markIn) state.markOut = null;
    updateMarks();
  }

  function setMarkOut() {
    if (el.video.hidden) return;
    // a saída inclui o frame marcado
    const out = shownFrameTime() + 1 / fpsOf();
    state.markOut = Math.min(out, el.video.duration || out);
    if (state.markIn != null && state.markIn >= state.markOut) state.markIn = null;
    updateMarks();
  }

  function clearMarks() {
    state.markIn = null;
    state.markOut = null;
    updateMarks();
  }

  function updateMarks() {
    const dur = el.video.duration || (state.probe && state.probe.duration) || 0;
    const hasIn = state.markIn != null;
    const hasOut = state.markOut != null;
    el.cutIn.classList.toggle('set', hasIn);
    el.cutOut.classList.toggle('set', hasOut);
    el.cutInTc.textContent = hasIn ? timecode(state.markIn) : 'Entrada';
    // a saída guardada é exclusiva (frame marcado + 1); mostra o frame marcado
    el.cutOutTc.textContent = hasOut ? timecode(state.markOut - 1 / fpsOf()) : 'Saída';
    el.cutClear.hidden = !hasIn && !hasOut;
    const pct = (t) => `${dur ? (t / dur) * 100 : 0}%`;
    el.tlIn.hidden = !hasIn;
    el.tlOut.hidden = !hasOut;
    if (hasIn) el.tlIn.style.left = pct(state.markIn);
    if (hasOut) el.tlOut.style.left = pct(state.markOut);
    el.tlRange.hidden = !(hasIn || hasOut) || !dur;
    if (!el.tlRange.hidden) {
      const a = hasIn ? state.markIn : 0;
      const b = hasOut ? state.markOut : dur;
      el.tlRange.style.left = pct(a);
      el.tlRange.style.width = `${dur ? ((b - a) / dur) * 100 : 0}%`;
    }
  }

  el.cutIn.onclick = setMarkIn;
  el.cutOut.onclick = setMarkOut;
  el.cutClear.onclick = clearMarks;
  el.cutSave.onclick = saveClip;

  const clipToasts = new Map();

  async function saveClip() {
    const item = state.vItems[state.vIndex];
    if (!item || item.kind !== 'video') return;
    if (state.markIn == null && state.markOut == null) {
      toast({ kind: 'info', title: 'Marque o trecho primeiro', detail: 'Use I pra entrada e O pra saída (ou os botões ao lado).' });
      return;
    }
    const dur = el.video.duration || (state.probe && state.probe.duration) || 0;
    const start = state.markIn != null ? state.markIn : 0;
    const end = state.markOut != null ? state.markOut : dur;
    if (end - start < 0.04) { errorToast('Trecho curto demais'); return; }

    const jobId = `clip-${Date.now()}`;
    const exact = state.clipMode !== 'copy';
    const t = toast({
      kind: 'info', title: 'Salvando corte…', detail: `${timecode(start)} → ${timecode(end - 1 / fpsOf())} · ${exact ? 'exato' : 'rápido'}`,
      progress: true, timeout: 0, actions: [{ label: 'Cancelar', fn: () => mediaapi.cancel(jobId), close: false }],
    });
    clipToasts.set(jobId, t);
    const res = await mediaapi.saveClip({ folderPath: state.folderPath, filePath: item.path, start, end, mode: exact ? 'exact' : 'copy', jobId });
    clipToasts.delete(jobId);
    t.close();
    if (res && res.cancelled) { toast({ kind: 'info', title: 'Corte cancelado' }); return; }
    if (!res || !res.ok) { errorToast('Não consegui salvar o corte', res && res.error); return; }
    addExported(res.file);
    toast({
      kind: 'ok', title: 'Corte salvo', detail: `${res.file.name} · ${formatDuration(end - start)}`, timeout: 7000,
      actions: [{ label: 'Mostrar na pasta', fn: () => sessionapi.showItem(res.file.path) }],
    });
  }

  function addExported(file) {
    if (!file) return;
    state.items = state.items.filter((it) => it.id !== file.id);
    state.items.push(file);
    sortItems();
    updateCounts();
  }

  // ---- salvar frame ----

  const FORMAT_LABEL = { png: 'PNG', tiff: 'TIFF', jpg: 'JPEG' };

  function updateFrameLabel() {
    const deep = state.probe && state.probe.bitDepth > 8;
    let label = FORMAT_LABEL[state.frameFormat] || 'PNG';
    if (state.frameFormat === 'jpg') label += ' máx';
    else label += deep ? ' 16-bit' : ' 8-bit';
    if (state.frameFollowLook && state.look) label += ' · 709';
    el.frameFmt.textContent = label;
  }

  el.frameSave.onclick = saveFrame;
  let savingFrame = false;

  async function saveFrame() {
    const item = state.vItems[state.vIndex];
    if (!item || item.kind !== 'video' || savingFrame) return;
    el.video.pause();
    const time = shownFrameTime();
    const look = state.frameFollowLook && state.look;
    savingFrame = true;
    el.frameSave.disabled = true;
    el.flash.classList.remove('go');
    void el.flash.offsetWidth;
    el.flash.classList.add('go');
    const res = await mediaapi.saveFrame({ folderPath: state.folderPath, filePath: item.path, time, format: state.frameFormat, look });
    savingFrame = false;
    el.frameSave.disabled = false;
    if (!res || !res.ok) { errorToast('Não consegui salvar o frame', res && res.error); return; }
    addExported(res.file);
    const fmt = res.format === 'jpg' ? 'JPEG qualidade máx' : `${FORMAT_LABEL[res.format]} ${res.bitDepth}-bit`;
    toast({
      kind: 'ok', title: 'Frame salvo', detail: `${res.width}×${res.height} · ${fmt}${res.look ? ' · Rec709' : ''} · ${timecode(time)}`, timeout: 6000,
      actions: [{ label: 'Mostrar na pasta', fn: () => sessionapi.showItem(res.file.path) }],
    });
  }

  // ---- popovers de opções (frame / corte) ----

  function placePopover(pop, anchor, align = 'right') {
    const viewerRect = el.viewer.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    pop.hidden = false;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = align === 'right' ? r.right - w : r.left + r.width / 2 - w / 2;
    left = Math.max(12, Math.min(viewerRect.width - w - 12, left - viewerRect.left));
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(12, r.top - viewerRect.top - h - 10)}px`;
  }

  function togglePopover(pop, anchor, align) {
    const open = !pop.hidden;
    hidePopovers();
    if (!open) placePopover(pop, anchor, align);
  }

  for (const r of el.popFrame.querySelectorAll('input[name=frame-format]')) {
    r.checked = r.value === state.frameFormat;
    r.onchange = () => { state.frameFormat = r.value; prefs.set('frameFormat', r.value); updateFrameLabel(); };
  }
  const followLook = $('frame-follow-look');
  followLook.checked = state.frameFollowLook;
  followLook.onchange = () => { state.frameFollowLook = followLook.checked; prefs.set('frameFollowLook', followLook.checked); updateFrameLabel(); };
  for (const r of el.popClip.querySelectorAll('input[name=clip-mode]')) {
    r.checked = r.value === state.clipMode;
    r.onchange = () => { state.clipMode = r.value; prefs.set('clipMode', r.value); };
  }
  el.frameOpts.onclick = (e) => { e.stopPropagation(); togglePopover(el.popFrame, el.frameOpts.parentElement, 'right'); };
  el.cutOpts.onclick = (e) => { e.stopPropagation(); togglePopover(el.popClip, el.cutOpts.parentElement, 'center'); };
  document.addEventListener('mousedown', (e) => {
    for (const pop of [el.popFrame, el.popClip]) {
      if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.caret')) pop.hidden = true;
    }
  });

  // ---- decisões ----

  el.decide.addEventListener('click', (e) => {
    const btn = e.target.closest('.decide');
    if (btn) handleAction(btn.dataset.action, btn);
  });

  async function handleAction(action, anchor) {
    const item = state.vItems[state.vIndex];
    if (!item) return;
    if (action === 'rename') { openRenamePop(item, anchor); return; }
    if (action === 'folder') { openFolderPop(anchor); return; }
    if (action === 'reveal') { sessionapi.showItem(item.path); return; }

    releaseMedia();
    const result = await safeDecide({ folderPath: state.folderPath, filePath: item.path, action });
    applyDecideResult(item, result);
  }

  async function safeDecide(payload) {
    try {
      return await sessionapi.decide(payload);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  function applyDecideResult(item, result) {
    hidePopovers();
    if (!result || !result.ok) {
      errorToast('Não consegui completar a ação', result && result.error);
      showCurrent();
      return;
    }
    const idx = state.items.findIndex((it) => it.id === item.id);
    if (idx !== -1) {
      if (result.newPath === null) {
        state.items[idx] = { ...state.items[idx], status: 'discarded', path: null, kind: 'ghost' };
      } else {
        state.items[idx] = { ...state.items[idx], path: result.newPath, id: result.newPath, status: result.newStatus || state.items[idx].status };
      }
    }
    if (result.recentFolders) state.recentFolders = result.recentFolders;
    updateCounts();

    state.vItems.splice(state.vIndex, 1);
    if (state.vIndex >= state.vItems.length) state.vIndex = state.vItems.length - 1;
    showCurrent();
  }

  // ---- renomear ----

  function anchorPopover(pop, anchor) {
    placePopover(pop, anchor || el.decide, 'center');
  }

  function openRenamePop(item, anchor) {
    hidePopovers();
    const ext = item.name.includes('.') ? item.name.slice(item.name.lastIndexOf('.')) : '';
    el.renameInput.value = ext ? item.name.slice(0, -ext.length) : item.name;
    anchorPopover(el.popRename, anchor || el.decide.querySelector('[data-action=rename]'));
    el.renameInput.focus();
    el.renameInput.select();
  }

  $('rename-cancel').onclick = hidePopovers;
  $('rename-ok').onclick = confirmRename;
  el.renameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') confirmRename();
    if (e.key === 'Escape') hidePopovers();
  });

  async function confirmRename() {
    const item = state.vItems[state.vIndex];
    const newBase = el.renameInput.value.trim();
    if (!item || !newBase) return;
    releaseMedia();
    const result = await safeDecide({ folderPath: state.folderPath, filePath: item.path, action: 'rename', extra: newBase });
    hidePopovers();
    if (!result.ok) {
      errorToast('Não consegui renomear', result.error);
      showCurrent();
      return;
    }
    const ext = item.name.includes('.') ? item.name.slice(item.name.lastIndexOf('.')) : '';
    const newName = basename(result.newPath) || newBase + ext;
    const idx = state.items.findIndex((it) => it.id === item.id);
    if (idx !== -1) state.items[idx] = { ...state.items[idx], name: newName, path: result.newPath, id: result.newPath };
    state.vItems[state.vIndex] = { ...item, name: newName, path: result.newPath, id: result.newPath };
    sortItems();
    state.previewCache.delete(item.path);
    showCurrent();
  }

  // ---- mover pra pasta ----

  function openFolderPop(anchor) {
    hidePopovers();
    el.folderRecent.innerHTML = '';
    for (const name of state.recentFolders) {
      const b = document.createElement('button');
      b.textContent = name;
      b.onclick = () => confirmFolder(name);
      el.folderRecent.appendChild(b);
    }
    el.folderInput.value = '';
    anchorPopover(el.popFolder, anchor || el.decide.querySelector('[data-action=folder]'));
    el.folderInput.focus();
  }

  $('folder-cancel').onclick = hidePopovers;
  $('folder-ok').onclick = () => confirmFolder(el.folderInput.value.trim());
  el.folderInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') confirmFolder(el.folderInput.value.trim());
    if (e.key === 'Escape') hidePopovers();
  });

  async function confirmFolder(name) {
    if (!name) return;
    const item = state.vItems[state.vIndex];
    if (!item) return;
    releaseMedia();
    const result = await safeDecide({ folderPath: state.folderPath, filePath: item.path, action: 'moveTo', extra: name });
    applyDecideResult(item, result);
  }

  function hidePopovers() {
    for (const pop of [el.popRename, el.popFolder, el.popFrame, el.popClip]) pop.hidden = true;
  }

  function anyPopoverOpen() {
    return [el.popRename, el.popFolder, el.popFrame, el.popClip].some((p) => !p.hidden);
  }

  // ---- ajuda ----

  const toggleHelp = (show = el.help.hidden) => { el.help.hidden = !show; };
  $('btn-help').onclick = () => toggleHelp();
  $('btn-help-2').onclick = () => toggleHelp(true);
  $('help-close').onclick = () => toggleHelp(false);
  el.help.addEventListener('mousedown', (e) => { if (e.target === el.help) toggleHelp(false); });

  // ---- teclado ----

  document.addEventListener('keydown', (e) => {
    const typing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
      && document.activeElement.type !== 'range' && document.activeElement.type !== 'radio' && document.activeElement.type !== 'checkbox';

    if (e.key === '?' && !typing) { toggleHelp(); return; }
    if (!el.help.hidden) { if (e.key === 'Escape') toggleHelp(false); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); chooseFolder(); return; }
    if (typing) {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    if (el.viewer.hidden) {
      if (e.key === '/' && !el.browser.hidden) { e.preventDefault(); el.search.focus(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const isVideo = !el.video.hidden;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (key) {
      case 'Escape':
        if (anyPopoverOpen()) hidePopovers();
        else if (el.stage.classList.contains('zoomed')) setZoom(false);
        else closeViewer();
        return;
      case 'ArrowRight': e.preventDefault(); goToOffset(1); return;
      case 'ArrowLeft': e.preventDefault(); goToOffset(-1); return;
      case 'a': handleAction('approve'); return;
      case 't': handleAction('maybe'); return;
      case 'Delete': case 'Backspace': if (state.vItems[state.vIndex]?.status !== 'rejected') handleAction('reject'); return;
      case 'u': if (state.vItems[state.vIndex]?.status === 'rejected') handleAction('restore'); return;
      case 'r': handleAction('rename'); return;
      case 'p': handleAction('folder'); return;
      case 'z': if (!isVideo) setZoom(!el.stage.classList.contains('zoomed')); return;
      default: break;
    }
    if (!isVideo) return;
    switch (key) {
      case ' ': case 'k': e.preventDefault(); togglePlay(); return;
      case ',': stepFrames(-1); return;
      case '.': stepFrames(1); return;
      case 'j': seekBy(-1); return;
      case 'l': seekBy(1); return;
      case 'i': setMarkIn(); return;
      case 'o': setMarkOut(); return;
      case 'x': clearMarks(); return;
      case 's': saveFrame(); return;
      case 'c': saveClip(); return;
      case 'v': toggleLook(); return;
      case 'm': toggleMute(); return;
      default: break;
    }
  });
})();
