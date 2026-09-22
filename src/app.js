(() => {
  const state = {
    folderPath: null,
    items: [],
    recentFolders: [],
    activeFilter: 'todos',
    fsItems: [],
    fsIndex: -1,
    previewCache: new Map(),
  };

  const el = {
    emptyState: document.getElementById('empty-state'),
    gridView: document.getElementById('grid-view'),
    fsView: document.getElementById('fullscreen-view'),
    grid: document.getElementById('grid'),
    folderPath: document.getElementById('folder-path'),
    folderLabel: document.getElementById('folder-label'),
    chips: document.getElementById('chips'),
    fsImage: document.getElementById('fs-image'),
    fsVideo: document.getElementById('fs-video'),
    fsBadge: document.getElementById('fs-badge'),
    fsCounter: document.getElementById('fs-counter'),
    fsRec709: document.getElementById('fs-rec709'),
    fsBar: document.getElementById('fs-bar'),
    renamePop: document.getElementById('fs-rename-pop'),
    renameInput: document.getElementById('fs-rename-input'),
    folderPop: document.getElementById('fs-folder-pop'),
    folderInput: document.getElementById('fs-folder-input'),
    folderRecent: document.getElementById('fs-folder-recent'),
  };

  // ---- window controls ----
  document.getElementById('btn-min').onclick = () => winapi.minimize();
  document.getElementById('btn-max').onclick = () => winapi.toggleMaximize();
  document.getElementById('btn-close').onclick = () => winapi.close();

  document.getElementById('btn-choose').onclick = chooseFolder;
  document.getElementById('btn-trocar-pasta').onclick = chooseFolder;

  async function chooseFolder() {
    const folder = await sessionapi.chooseFolder();
    if (!folder) return;
    await loadFolder(folder);
  }

  async function loadFolder(folder) {
    const data = await sessionapi.load(folder);
    state.folderPath = data.folderPath;
    state.items = data.items;
    state.recentFolders = data.recentFolders;
    state.previewCache.clear();
    el.folderPath.textContent = state.folderPath;
    el.folderLabel.textContent = `— ${state.folderPath}`;
    el.emptyState.hidden = true;
    el.gridView.hidden = false;
    renderGrid();
  }

  // ---- filters ----

  function statusMatchesFilter(status, filter) {
    if (filter === 'todos') return true;
    if (filter === 'pendentes') return status === 'pending';
    if (filter === 'talvez') return status === 'maybe';
    if (filter === 'aprovados') return status === 'approved';
    if (filter === 'descarte') return status === 'discarded';
    return true;
  }

  function filteredItems(filter) {
    return state.items.filter((it) => statusMatchesFilter(it.status, filter));
  }

  el.chips.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.activeFilter = btn.dataset.filter;
    [...el.chips.querySelectorAll('.chip')].forEach((c) => c.classList.toggle('active', c === btn));
    renderGrid();
  });

  function updateChipCounts() {
    const counts = { todos: state.items.length, pendentes: 0, talvez: 0, aprovados: 0, descarte: 0 };
    for (const it of state.items) {
      if (it.status === 'pending') counts.pendentes++;
      else if (it.status === 'maybe') counts.talvez++;
      else if (it.status === 'approved') counts.aprovados++;
      else if (it.status === 'discarded') counts.descarte++;
    }
    for (const chip of el.chips.querySelectorAll('.chip')) {
      chip.querySelector('span').textContent = counts[chip.dataset.filter];
    }
  }

  // ---- grid rendering ----

  let thumbQueueToken = 0;

  function renderGrid() {
    updateChipCounts();
    const list = filteredItems(state.activeFilter);
    el.grid.innerHTML = '';
    const myToken = ++thumbQueueToken;
    const pending = [];

    for (const item of list) {
      const tile = document.createElement('div');
      tile.className = 'tile' + (item.status === 'discarded' ? ' ghost' : '');
      tile.dataset.id = item.id;

      if (item.kind === 'raw' || item.kind === 'image') {
        const ph = document.createElement('div');
        ph.className = 'placeholder';
        ph.innerHTML = `<span class="name">${escapeHtml(item.name)}</span>`;
        tile.appendChild(ph);
        pending.push(item);
      } else if (item.kind === 'video') {
        tile.innerHTML = `<div class="placeholder"><span class="play">&#9654;</span><span class="name">${escapeHtml(item.name)}</span></div>`;
      } else {
        tile.innerHTML = `<div class="placeholder"><span class="play">&#128465;</span><span class="name">${escapeHtml(item.name)}</span></div>`;
      }

      const overlay = document.createElement('div');
      overlay.className = 'name-overlay';
      overlay.textContent = item.name;
      tile.appendChild(overlay);

      const badgeClass = item.status === 'approved' ? 'approved'
        : item.status === 'discarded' ? 'discarded'
        : item.status === 'maybe' ? 'maybe'
        : item.status && item.status.startsWith('custom:') ? 'custom'
        : null;
      if (badgeClass) {
        const badge = document.createElement('div');
        badge.className = `status-badge ${badgeClass}`;
        badge.textContent = badgeClass === 'discarded' ? '\u2715' : badgeClass === 'maybe' ? '?' : '\u2713';
        tile.appendChild(badge);
      }

      if (item.status !== 'discarded') {
        tile.addEventListener('click', () => openFullscreen(list, list.indexOf(item)));
      }

      el.grid.appendChild(tile);
    }

    loadThumbnailsProgressively(pending, myToken);
  }

  async function loadThumbnailsProgressively(items, token) {
    const concurrency = 3;
    let idx = 0;
    async function next() {
      if (token !== thumbQueueToken) return;
      const i = idx++;
      if (i >= items.length) return;
      const item = items[i];
      const url = await previewapi.thumbnail(item);
      if (token !== thumbQueueToken) return;
      if (url) {
        const tile = el.grid.querySelector(`.tile[data-id="${cssEscape(item.id)}"]`);
        if (tile) {
          const ph = tile.querySelector('.placeholder');
          if (ph) {
            const img = document.createElement('img');
            img.src = url;
            img.loading = 'lazy';
            tile.replaceChild(img, ph);
          }
        }
      }
      return next();
    }
    await Promise.all(Array.from({ length: concurrency }, next));
  }

  function toFileUrl(p) {
    let clean = p.replace(/\\/g, '/');
    if (!clean.startsWith('/')) clean = '/' + clean;
    return 'file://' + encodeURI(clean);
  }

  function cssEscape(s) {
    return s.replace(/["\\]/g, '\\$&');
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- fullscreen review ----

  function openFullscreen(list, index) {
    state.fsItems = list.filter((it) => it.status !== 'discarded');
    const item = list[index];
    state.fsIndex = state.fsItems.indexOf(item);
    if (state.fsIndex === -1) return;
    el.fsView.hidden = false;
    showCurrent();
  }

  function closeFullscreen() {
    el.fsView.hidden = true;
    releaseMedia();
    hidePopovers();
    renderGrid();
  }

  // Windows locks a file while it has an open handle (e.g. the <video>/<img>
  // element pointing at it) — mover/renomear/excluir falha silenciosamente se
  // não soltarmos o arquivo antes de pedir a operação ao processo principal.
  function releaseMedia() {
    el.fsVideo.pause();
    el.fsVideo.removeAttribute('src');
    el.fsVideo.load();
    el.fsImage.removeAttribute('src');
  }

  document.getElementById('fs-close').onclick = closeFullscreen;

  async function showCurrent() {
    hidePopovers();
    const item = state.fsItems[state.fsIndex];
    if (!item) { closeFullscreen(); return; }

    el.fsBadge.textContent = item.name;
    el.fsCounter.textContent = `${state.fsIndex + 1} / ${state.fsItems.length}`;

    el.fsVideo.pause();
    el.fsVideo.hidden = true;
    el.fsImage.hidden = true;
    el.fsRec709.hidden = true;

    if (item.kind === 'video') {
      el.fsVideo.hidden = false;
      el.fsVideo.src = toFileUrl(item.path);
      el.fsVideo.classList.add('rec709');
      el.fsVideo.load();
      el.fsVideo.play().catch(() => {});
      el.fsRec709.hidden = false;
      el.fsRec709.textContent = 'Rec709 simulado: ON';
    } else {
      el.fsImage.hidden = false;
      el.fsImage.src = '';
      const cached = state.previewCache.get(item.path);
      if (cached) {
        el.fsImage.src = cached;
      } else {
        const url = await previewapi.full(item);
        if (url) {
          state.previewCache.set(item.path, url);
          if (state.fsItems[state.fsIndex] === item) el.fsImage.src = url;
        }
      }
    }

    prefetchNeighbors();
  }

  function prefetchNeighbors() {
    const offsets = [1, -1, 2];
    for (const off of offsets) {
      const it = state.fsItems[state.fsIndex + off];
      if (!it || it.kind === 'video' || state.previewCache.has(it.path)) continue;
      previewapi.full(it).then((url) => { if (url) state.previewCache.set(it.path, url); });
    }
  }

  el.fsRec709.onclick = () => {
    const on = el.fsVideo.classList.toggle('rec709');
    el.fsRec709.textContent = `Rec709 simulado: ${on ? 'ON' : 'OFF'}`;
  };

  function goToOffset(offset) {
    const newIndex = state.fsIndex + offset;
    if (newIndex < 0 || newIndex >= state.fsItems.length) return;
    state.fsIndex = newIndex;
    showCurrent();
  }

  el.fsBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.fs-btn');
    if (!btn) return;
    handleAction(btn.dataset.action);
  });

  async function handleAction(action) {
    const item = state.fsItems[state.fsIndex];
    if (!item) return;

    if (action === 'rename') { openRenamePop(item); return; }
    if (action === 'folder') { openFolderPop(); return; }

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
      alert(`Não consegui completar a ação${result && result.error ? `: ${result.error}` : ''}. Tenta de novo.`);
      showCurrent();
      return;
    }
    const idx = state.items.findIndex((it) => it.id === item.id);
    if (idx !== -1) {
      if (result.newPath === null) {
        state.items[idx] = { ...state.items[idx], status: 'discarded', path: null };
      } else {
        state.items[idx] = { ...state.items[idx], path: result.newPath, id: result.newPath, status: result.newStatus || state.items[idx].status };
      }
    }
    if (result.recentFolders) state.recentFolders = result.recentFolders;

    state.fsItems.splice(state.fsIndex, 1);
    if (state.fsIndex >= state.fsItems.length) state.fsIndex = state.fsItems.length - 1;
    showCurrent();
  }

  // ---- rename popover ----

  function openRenamePop(item) {
    hidePopovers();
    const ext = item.name.includes('.') ? item.name.slice(item.name.lastIndexOf('.')) : '';
    const base = ext ? item.name.slice(0, -ext.length) : item.name;
    el.renameInput.value = base;
    el.renamePop.hidden = false;
    el.renameInput.focus();
    el.renameInput.select();
  }

  document.getElementById('fs-rename-cancel').onclick = hidePopovers;
  document.getElementById('fs-rename-ok').onclick = confirmRename;
  el.renameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') confirmRename();
    if (e.key === 'Escape') hidePopovers();
  });

  async function confirmRename() {
    const item = state.fsItems[state.fsIndex];
    const newBase = el.renameInput.value.trim();
    if (!item || !newBase) return;
    releaseMedia();
    const result = await safeDecide({ folderPath: state.folderPath, filePath: item.path, action: 'rename', extra: newBase });
    hidePopovers();
    if (!result.ok) {
      alert(`Não consegui renomear${result.error ? `: ${result.error}` : ''}. Tenta de novo.`);
      showCurrent();
      return;
    }
    const idx = state.items.findIndex((it) => it.id === item.id);
    const ext = item.name.includes('.') ? item.name.slice(item.name.lastIndexOf('.')) : '';
    const newName = newBase + ext;
    if (idx !== -1) state.items[idx] = { ...state.items[idx], name: newName, path: result.newPath, id: result.newPath };
    state.fsItems[state.fsIndex] = { ...item, name: newName, path: result.newPath, id: result.newPath };
    state.previewCache.delete(item.path);
    showCurrent();
  }

  // ---- folder popover ----

  function openFolderPop() {
    hidePopovers();
    el.folderRecent.innerHTML = '';
    for (const name of state.recentFolders) {
      const b = document.createElement('button');
      b.textContent = name;
      b.onclick = () => confirmFolder(name);
      el.folderRecent.appendChild(b);
    }
    el.folderInput.value = '';
    el.folderPop.hidden = false;
    el.folderInput.focus();
  }

  document.getElementById('fs-folder-cancel').onclick = hidePopovers;
  document.getElementById('fs-folder-ok').onclick = () => confirmFolder(el.folderInput.value.trim());
  el.folderInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') confirmFolder(el.folderInput.value.trim());
    if (e.key === 'Escape') hidePopovers();
  });

  async function confirmFolder(name) {
    if (!name) return;
    const item = state.fsItems[state.fsIndex];
    if (!item) return;
    releaseMedia();
    const result = await safeDecide({ folderPath: state.folderPath, filePath: item.path, action: 'moveTo', extra: name });
    applyDecideResult(item, result);
  }

  function hidePopovers() {
    el.renamePop.hidden = true;
    el.folderPop.hidden = true;
  }

  // ---- keyboard shortcuts ----

  document.addEventListener('keydown', (e) => {
    if (el.fsView.hidden) return;
    const typing = document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
    if (typing) return;

    if (e.key === 'Escape') {
      if (!el.renamePop.hidden || !el.folderPop.hidden) hidePopovers();
      else closeFullscreen();
      return;
    }
    if (e.key === 'ArrowRight') return goToOffset(1);
    if (e.key === 'ArrowLeft') return goToOffset(-1);
    if (e.key === 'a' || e.key === 'A') return handleAction('approve');
    if (e.key === 't' || e.key === 'T') return handleAction('maybe');
    if (e.key === 'Delete' || e.key === 'Backspace') return handleAction('discard');
    if (e.key === 'r' || e.key === 'R') return handleAction('rename');
    if (e.key === ' ') {
      e.preventDefault();
      if (!el.fsVideo.hidden) { el.fsVideo.paused ? el.fsVideo.play() : el.fsVideo.pause(); }
    }
  });
})();
