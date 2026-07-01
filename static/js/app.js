/* =========================================================
   Second Brain — Vanilla JS Frontend (Flask API backend)
   ========================================================= */
(function () {
  'use strict';

  const CFG = window.__CFG__ || { hotkeys: {}, theme: 'dark' };

  // Parse hotkey strings like "Ctrl+S"
  function parseHotkey(s) {
    if (!s) return null;
    const parts = s.split('+').map(p => p.trim().toLowerCase());
    return {
      ctrl: parts.includes('ctrl'),
      shift: parts.includes('shift'),
      alt: parts.includes('alt'),
      key: parts.filter(p => !['ctrl','shift','alt','meta'].includes(p)).pop() || ''
    };
  }
  const HK = {
    save: parseHotkey(CFG.hotkeys.save_note),
    toggle: parseHotkey(CFG.hotkeys.toggle_preview),
    newNote: parseHotkey(CFG.hotkeys.create_note),
    close: parseHotkey(CFG.hotkeys.close_tab),
    graph: parseHotkey(CFG.hotkeys.open_graph),
  };

  // ------------------------------------------------------------- state
  const state = {
    tree: [],                // root folder list (recursive children)
    flat: [],                // all notes (for autocomplete & graph)
    links: [],               // all links (for graph)
    openTabs: [],
    activeId: null,
    mode: 'source',
    showGraph: false,
    expanded: new Set(),
    dirty: false,
    draggedNodeId: null,
  };

  // ------------------------------------------------------------- DOM
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const treeEl = $('#tree');
  const tabsEl = $('#tabs');
  const editorWrap = $('#editor-wrap');
  const editorEl = $('#editor');
  const previewEl = $('#preview');
  const welcomeEl = $('#welcome');
  const graphCanvas = $('#graph-canvas');
  const backlinksEl = $('#backlinks');
  const ctxmenuEl = $('#ctxmenu');
  const modalEl = $('#modal');
  const modalInput = $('#modal-input');
  const modalTitle = $('#modal-title');
  const suggestEl = $('#suggest');
  const toastEl = $('#toast');
  const statsEl = $('#stats');

  // ------------------------------------------------------------- API helpers
  async function api(url, opts = {}) {
    const o = Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts);
    if (o.body && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
    const r = await fetch(url, o);
    if (!r.ok) {
      let msg = r.statusText;
      try { const j = await r.json(); msg = j.error || msg; } catch(_) {}
      throw new Error(msg);
    }
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) return r.json();
    return r.text();
  }
  const GET  = (u) => api(u);
  const POST = (u, b) => api(u, { method: 'POST', body: b });
  const PUT  = (u, b) => api(u, { method: 'PUT', body: b });
  const DEL  = (u) => api(u, { method: 'DELETE' });

  // ------------------------------------------------------------- Tree utils (local traversal)
  function flattenTree(nodes, out = []) {
    for (const n of nodes) {
      out.push(n);
      if (n.children && n.children.length) flattenTree(n.children, out);
    }
    return out;
  }
  function findInTree(nodes, id) {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children) { const r = findInTree(n.children, id); if (r) return r; }
    }
    return null;
  }
  function findParent(nodes, id, parent = null) {
    for (const n of nodes) {
      if (n.id === id) return parent;
      if (n.children) {
        const r = findParent(n.children, id, n);
        if (r !== undefined && r !== null) return r;
        if (r === null && n.children.some(c => c.id === id)) return n;
      }
    }
    return null;
  }
  function getDescendantIds(node) {
    const ids = [node.id];
    const walk = (arr) => arr.forEach(c => { ids.push(c.id); if (c.children) walk(c.children); });
    if (node.children) walk(node.children);
    return ids;
  }

  // ------------------------------------------------------------- Load initial
  async function boot() {
    try {
      const [tree, flat, session] = await Promise.all([
        GET('/api/nodes'),
        GET('/api/flat'),
        GET('/api/session'),
      ]);
      state.tree = tree;
      state.flat = flat.nodes;
      state.links = flat.links;
      // restore tabs
      state.openTabs = [];
      state.activeId = null;
      for (const t of session) {
        if (state.flat.find(n => n.id === t.node_id)) {
          state.openTabs.push({ node_id: t.node_id });
          if (t.is_active) state.activeId = t.node_id;
        }
      }
      renderTree();
      renderTabs();
      if (state.activeId) await loadActive();
      renderEditor();
      renderBacklinks();
      setMode('source', false);
    } catch (e) {
      toast('Ошибка загрузки: ' + e.message, true);
    }
  }

  // ------------------------------------------------------------- Tree render
  function renderTree() {
    treeEl.innerHTML = '';
    const ul = document.createElement('ul');
    buildLevel(state.tree, ul);
    treeEl.appendChild(ul);
    const notes = state.flat.filter(n => !n.is_folder).length;
    const folders = state.flat.filter(n => n.is_folder).length;
    statsEl.textContent = `${notes} заметок · ${folders} папок · ${state.links.length} связей`;
  }
  function buildLevel(list, parentUl) {
    for (const node of list) {
      const li = document.createElement('li');
      const div = document.createElement('div');
      div.className = 'node ' + (node.is_folder ? 'folder' : 'note');
      if (node.is_folder) {
        div.classList.add(state.expanded.has(node.id) ? 'expanded' : 'collapsed');
      }
      if (node.id === state.activeId && !state.showGraph) div.classList.add('active');
      div.dataset.id = node.id;
      div.draggable = true;
      const caret = document.createElement('span');
      caret.className = 'caret'; caret.textContent = '▾';
      const ico = document.createElement('span');
      ico.className = 'ico'; ico.textContent = node.is_folder ? '📁' : '📄';
      const nm = document.createElement('span');
      nm.className = 'nm'; nm.textContent = node.title;
      div.append(caret, ico, nm);
      li.appendChild(div);
      if (node.is_folder) {
        const childUl = document.createElement('ul');
        if (state.expanded.has(node.id)) buildLevel(node.children || [], childUl);
        li.appendChild(childUl);
      }
      parentUl.appendChild(li);

      div.addEventListener('click', (e) => {
        e.stopPropagation();
        if (node.is_folder) {
          if (state.expanded.has(node.id)) state.expanded.delete(node.id);
          else state.expanded.add(node.id);
          renderTree();
        } else {
          openNote(node.id);
        }
      });
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (node.is_folder) state.expanded.add(node.id);
        showContextMenu(e.clientX, e.clientY, node);
      });
      div.addEventListener('dragstart', (e) => {
        state.draggedNodeId = node.id;
        div.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', String(node.id)); } catch(_) {}
        e.dataTransfer.effectAllowed = 'move';
      });
      div.addEventListener('dragend', () => {
        div.classList.remove('dragging');
        state.draggedNodeId = null;
        $$('.node.drag-over').forEach(n => n.classList.remove('drag-over'));
      });
      div.addEventListener('dragover', (e) => {
        if (state.draggedNodeId == null || state.draggedNodeId === node.id) return;
        e.preventDefault(); e.stopPropagation();
        if (node.is_folder) {
          const dragged = findInTree(state.tree, state.draggedNodeId);
          if (!dragged) return;
          const desc = getDescendantIds(dragged);
          if (desc.includes(node.id)) return;
        }
        div.classList.add('drag-over');
      });
      div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
      div.addEventListener('drop', async (e) => {
        e.preventDefault(); e.stopPropagation();
        div.classList.remove('drag-over');
        const did = state.draggedNodeId;
        if (!did || did === node.id) return;
        let new_parent;
        if (node.is_folder) {
          const dragged = findInTree(state.tree, did);
          if (dragged) {
            const desc = getDescendantIds(dragged);
            if (desc.includes(node.id)) { toast('Нельзя переместить в свою подпапку', true); return; }
          }
          new_parent = node.id;
        } else {
          const parent = findParent(state.tree, node.id);
          new_parent = parent ? parent.id : null;
        }
        try {
          await PUT('/api/nodes/' + did, { parent_id: new_parent });
          await refreshTree();
          if (node.is_folder) state.expanded.add(node.id);
          renderTree();
        } catch (err) { toast(err.message, true); }
      });
    }
  }

  async function refreshTree() {
    const [tree, flat] = await Promise.all([GET('/api/nodes'), GET('/api/flat')]);
    state.tree = tree;
    state.flat = flat.nodes;
    state.links = flat.links;
  }

  // ------------------------------------------------------------- Tabs
  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const t of state.openTabs) {
      const node = state.flat.find(n => n.id === t.node_id);
      if (!node) continue;
      const div = document.createElement('div');
      div.className = 'tab';
      if (t.node_id === state.activeId && !state.showGraph) div.classList.add('active');
      const ttl = document.createElement('span');
      ttl.className = 'ttl'; ttl.textContent = node.title;
      const x = document.createElement('span');
      x.className = 'x'; x.textContent = '×';
      div.append(ttl, x);
      div.addEventListener('click', (e) => {
        if (e.target === x) closeTab(t.node_id);
        else { state.showGraph = false; activateTab(t.node_id); }
      });
      tabsEl.appendChild(div);
    }
  }

  async function openNote(id) {
    state.showGraph = false;
    if (!state.openTabs.find(t => t.node_id === id)) {
      state.openTabs.push({ node_id: id });
    }
    await activateTab(id);
  }

  async function activateTab(id) {
    if (state.activeId && state.dirty) await saveActive();
    state.activeId = id;
    await loadActive();
    renderTabs(); renderTree(); renderEditor(); renderBacklinks();
    persistSession();
  }

  async function closeTab(id) {
    if (state.activeId === id && state.dirty) await saveActive();
    state.openTabs = state.openTabs.filter(t => t.node_id !== id);
    if (state.activeId === id) {
      const last = state.openTabs[state.openTabs.length - 1];
      state.activeId = last ? last.node_id : null;
    }
    if (state.activeId) await loadActive();
    renderTabs(); renderTree(); renderEditor(); renderBacklinks();
    persistSession();
  }

  async function loadActive() {
    if (state.activeId == null) { editorEl.value = ''; state.dirty = false; return; }
    const n = await GET('/api/nodes/' + state.activeId);
    editorEl.value = n.content || '';
    state.dirty = false;
  }

  async function saveActive() {
    if (state.activeId == null) return;
    try {
      await PUT('/api/nodes/' + state.activeId, { content: editorEl.value });
      state.dirty = false;
      const flat = await GET('/api/flat');
      state.flat = flat.nodes;
      state.links = flat.links;
      renderTree(); // title may be unchanged but counts/links update
    } catch (e) { toast(e.message, true); }
  }

  function persistSession() {
    const body = {
      tabs: state.openTabs.map((t, i) => ({
        node_id: t.node_id,
        position_order: i,
        is_active: t.node_id === state.activeId,
      }))
    };
    POST('/api/session', body).catch(e => toast(e.message, true));
  }

  // ------------------------------------------------------------- Editor rendering
  function renderEditor() {
    if (state.showGraph) {
      editorWrap.style.display = 'none';
      welcomeEl.style.display = 'none';
      graphCanvas.style.display = 'block';
      backlinksEl.style.display = 'none';
      startGraph();
      return;
    } else {
      graphCanvas.style.display = 'none';
      stopGraph();
    }
    if (state.activeId == null) {
      editorWrap.style.display = 'none';
      welcomeEl.style.display = 'flex';
      backlinksEl.style.display = 'none';
      return;
    }
    editorWrap.style.display = 'flex';
    backlinksEl.style.display = '';
    welcomeEl.style.display = 'none';
    const wrap = editorWrap.parentElement;
    wrap.classList.remove('mode-source','mode-preview','mode-live');
    wrap.classList.add('mode-' + state.mode);
    if (state.mode !== 'source') renderPreview();
  }

  function renderPreview() {
    previewEl.innerHTML = renderMarkdown(editorEl.value);
    previewEl.querySelectorAll('a.wiki').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const id = a.dataset.id;
        if (id) { openNote(parseInt(id, 10)); return; }
        const t = a.dataset.title;
        if (t && confirm('Заметка "' + t + '" не найдена. Создать?')) createNote(null, t);
      });
    });
  }

  async function renderBacklinks() {
    backlinksEl.innerHTML = '<h4>Обратные ссылки</h4>';
    if (state.activeId == null || state.showGraph) { backlinksEl.style.display = 'none'; return; }
    try {
      const n = await GET('/api/nodes/' + state.activeId);
      const bls = n.backlinks || [];
      if (bls.length === 0) {
        const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Нет ссылок';
        backlinksEl.appendChild(e);
        return;
      }
      for (const b of bls) {
        const d = document.createElement('div');
        d.className = 'bl'; d.textContent = '↩ ' + b.title;
        d.addEventListener('click', () => openNote(b.id));
        backlinksEl.appendChild(d);
      }
    } catch(e) { /* ignore */ }
  }

  // ------------------------------------------------------------- Markdown
  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function renderMarkdown(src) {
    if (!src) return '';
    const lines = src.split('\n');
    let out = '', inCode = false, codeBuf = [], listType = null, paraBuf = [];
    const flushPara = () => { if (paraBuf.length) { out += '<p>' + inline(paraBuf.join(' ')) + '</p>'; paraBuf = []; } };
    const closeList = () => { if (listType) { out += '</' + listType + '>'; listType = null; } };

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (inCode) {
        if (ln.trimStart().startsWith('```')) {
          out += '<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>';
          codeBuf = []; inCode = false;
        } else codeBuf.push(ln);
        continue;
      }
      if (ln.trimStart().startsWith('```')) { flushPara(); closeList(); inCode = true; continue; }
      const h = ln.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushPara(); closeList(); out += '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'; continue; }
      if (/^\s*---+\s*$/.test(ln)) { flushPara(); closeList(); out += '<hr/>'; continue; }
      if (/^\s*>\s?/.test(ln)) {
        flushPara(); closeList();
        const buf = [ln.replace(/^\s*>\s?/, '')];
        while (i+1 < lines.length && /^\s*>/.test(lines[i+1])) { i++; buf.push(lines[i].replace(/^\s*>\s?/, '')); }
        out += '<blockquote>' + inline(buf.join(' ')) + '</blockquote>'; continue;
      }
      const ulm = ln.match(/^(\s*)[-*+]\s+(.*)$/);
      if (ulm) {
        flushPara();
        if (listType !== 'ul') { closeList(); out += '<ul>'; listType = 'ul'; }
        out += '<li>' + inline(ulm[2]) + '</li>'; continue;
      }
      const olm = ln.match(/^(\s*)\d+\.\s+(.*)$/);
      if (olm) {
        flushPara();
        if (listType !== 'ol') { closeList(); out += '<ol>'; listType = 'ol'; }
        out += '<li>' + inline(olm[2]) + '</li>'; continue;
      }
      if (ln.trim() === '') { flushPara(); closeList(); continue; }
      paraBuf.push(ln);
    }
    flushPara(); closeList();
    if (inCode) out += '<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>';
    return out;
  }
  function inline(s) {
    s = escapeHtml(s);
    s = s.replace(/`([^`]+?)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
    s = s.replace(/\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]/g, (m, tgt, alias) => {
      tgt = tgt.trim(); alias = (alias || '').trim();
      const label = alias || tgt;
      const found = state.flat.find(n => !n.is_folder && n.title.toLowerCase() === tgt.toLowerCase());
      if (found) return '<a href="#" class="wiki" data-id="' + found.id + '">' + label + '</a>';
      return '<a href="#" class="wiki broken" data-title="' + tgt.replace(/"/g,'&quot;') + '">' + label + ' ⚠</a>';
    });
    s = s.replace(/(^|\s)(#)([\w\-а-яА-ЯёЁ]+)/g, '$1<span class="tag">#$3</span>');
    return s;
  }

  // ------------------------------------------------------------- Editor events
  editorEl.addEventListener('input', () => {
    state.dirty = true;
    if (state.mode !== 'source') renderPreview();
    handleSuggest();
  });
  editorEl.addEventListener('keydown', (e) => {
    if (suggestOpen && suggestHandleKey(e)) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = editorEl.selectionStart, en = editorEl.selectionEnd;
      editorEl.value = editorEl.value.slice(0, s) + '  ' + editorEl.value.slice(en);
      editorEl.selectionStart = editorEl.selectionEnd = s + 2;
      state.dirty = true;
    }
  });
  editorEl.addEventListener('focus', () => {
    if (state.mode === 'live') editorWrap.parentElement.classList.add('live-editing');
  });
  editorEl.addEventListener('blur', () => {
    if (state.mode === 'live') {
      renderPreview();
      editorWrap.parentElement.classList.remove('live-editing');
    }
  });

  // Auto-save
  setInterval(() => { if (state.dirty && state.activeId != null) saveActive().then(renderBacklinks); }, 3000);
  window.addEventListener('beforeunload', () => {
    if (state.dirty && state.activeId != null) {
      // Use sendBeacon? Simple synchronous XHR not allowed. We do best effort via fetch keepalive.
      try {
        fetch('/api/nodes/' + state.activeId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: editorEl.value }),
          keepalive: true,
        });
      } catch(_) {}
    }
    persistSession();
  });

  // ------------------------------------------------------------- Autocomplete
  let suggestOpen = false;
  let suggestContext = null;
  const mirrorDiv = document.createElement('div');
  (function initMirror() {
    mirrorDiv.style.position = 'absolute';
    mirrorDiv.style.visibility = 'hidden';
    mirrorDiv.style.whiteSpace = 'pre-wrap';
    mirrorDiv.style.wordWrap = 'break-word';
    mirrorDiv.style.overflow = 'hidden';
    mirrorDiv.style.top = '0'; mirrorDiv.style.left = '-9999px';
    document.body.appendChild(mirrorDiv);
  })();
  function syncMirror() {
    const cs = getComputedStyle(editorEl);
    ['fontFamily','fontSize','fontWeight','fontStyle','letterSpacing','lineHeight',
     'padding','paddingTop','paddingRight','paddingBottom','paddingLeft',
     'border','borderTop','borderRight','borderBottom','borderLeft',
     'boxSizing','tabSize','MozTabSize'].forEach(p => mirrorDiv.style[p] = cs[p]);
    mirrorDiv.style.width = editorEl.offsetWidth + 'px';
  }
  function getCaretCoordinates(pos) {
    syncMirror();
    const before = editorEl.value.slice(0, pos);
    const after = editorEl.value.slice(pos);
    mirrorDiv.textContent = before;
    const span = document.createElement('span');
    span.textContent = after || '.';
    mirrorDiv.appendChild(span);
    const coords = { top: span.offsetTop - editorEl.scrollTop, left: span.offsetLeft - editorEl.scrollLeft };
    mirrorDiv.textContent = '';
    return coords;
  }
  function closeSuggest() { suggestOpen = false; suggestContext = null; suggestEl.style.display = 'none'; }

  function handleSuggest() {
    if (state.mode === 'preview') { closeSuggest(); return; }
    const pos = editorEl.selectionStart;
    const before = editorEl.value.slice(0, pos);
    const wm = before.match(/\[\[([^\[\]\n]*)$/);
    if (wm) {
      const q = wm[1];
      const start = pos - q.length;
      const items = state.flat.filter(n => !n.is_folder).map(n => n.title)
        .filter(t => t.toLowerCase().includes(q.toLowerCase())).slice(0, 50);
      openSuggest('wiki', start, q, items);
      return;
    }
    // tags
    const tm = before.match(/(?:^|\s)#([\w\-а-яА-ЯёЁ]*)$/);
    if (tm) {
      const q = tm[1], start = pos - q.length;
      const tags = new Set();
      state.flat.forEach(n => {
        if (!n.is_folder && n.content) {
          const re = /#([\w\-а-яА-ЯёЁ]+)/g;
          let m; while ((m = re.exec(n.content))) tags.add(m[1]);
        }
      });
      const items = [...tags].filter(t => t.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
      openSuggest('tag', start, q, items);
      return;
    }
    closeSuggest();
  }
  function openSuggest(type, start, q, items) {
    suggestContext = { type, start, q, items, sel: 0 };
    renderSuggest();
    suggestOpen = true;
    positionSuggest();
  }
  function positionSuggest() {
    const area = $('#editor-area');
    const rect = area.getBoundingClientRect();
    const c = getCaretCoordinates(editorEl.selectionStart);
    suggestEl.style.left = (rect.left + c.left + 40) + 'px';  // +40 to account for editor padding
    suggestEl.style.top = (rect.top + c.top + 42) + 'px';
    suggestEl.style.display = 'block';
  }
  function renderSuggest() {
    suggestEl.innerHTML = '';
    if (!suggestContext) return;
    const { items, type, q } = suggestContext;
    if (items.length === 0) {
      if (type === 'wiki' && q.trim().length > 0) {
        const div = document.createElement('div');
        div.className = 'it';
        div.innerHTML = 'Создать: <b>' + q + '</b>';
        div.addEventListener('mousedown', (e) => { e.preventDefault(); createFromSuggest(); });
        suggestEl.appendChild(div);
      } else {
        const div = document.createElement('div');
        div.className = 'it'; div.style.color = 'var(--text-dim)'; div.textContent = 'Нет совпадений';
        suggestEl.appendChild(div);
      }
      return;
    }
    items.forEach((t, i) => {
      const div = document.createElement('div');
      div.className = 'it' + (i === suggestContext.sel ? ' sel' : '');
      div.textContent = t;
      div.addEventListener('mousedown', (e) => { e.preventDefault(); suggestContext.sel = i; commitSuggest(); });
      div.addEventListener('mouseenter', () => { suggestContext.sel = i; renderSuggest(); });
      suggestEl.appendChild(div);
    });
  }
  function suggestHandleKey(e) {
    if (!suggestContext) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const max = suggestContext.items.length || 1;
      suggestContext.sel = Math.min(max - 1, suggestContext.sel + 1);
      renderSuggest(); return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault(); suggestContext.sel = Math.max(0, suggestContext.sel - 1); renderSuggest(); return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commitSuggest(); return true; }
    if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); return true; }
    return false;
  }
  function commitSuggest() {
    if (!suggestContext) return;
    const { items, type, start } = suggestContext;
    if (items.length === 0 && type === 'wiki') { createFromSuggest(); return; }
    const chosen = items[suggestContext.sel];
    if (!chosen) { closeSuggest(); return; }
    const pos = editorEl.selectionStart;
    const val = editorEl.value;
    let newVal, newPos;
    if (type === 'wiki') {
      newVal = val.slice(0, start - 2) + '[[' + chosen + ']]' + val.slice(pos);
      newPos = start - 2 + chosen.length + 4;
    } else {
      newVal = val.slice(0, start - 1) + chosen + val.slice(pos);
      newPos = start - 1 + chosen.length;
    }
    editorEl.value = newVal;
    editorEl.selectionStart = editorEl.selectionEnd = newPos;
    state.dirty = true;
    if (state.mode !== 'source') renderPreview();
    closeSuggest();
  }
  async function createFromSuggest() {
    const title = suggestContext.q.trim();
    closeSuggest();
    if (!title) return;
    if (state.dirty) await saveActive();
    try {
      const res = await POST('/api/nodes', { parent_id: null, title, is_folder: false });
      await refreshTree();
      renderTree();
      openNote(res.id);
    } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------- Node CRUD (user actions)
  async function createNode(parent_id, title, is_folder) {
    try {
      const res = await POST('/api/nodes', { parent_id, title, is_folder: !!is_folder });
      await refreshTree();
      if (parent_id) state.expanded.add(parent_id);
      renderTree();
      if (!is_folder) openNote(res.id);
    } catch (e) { toast(e.message, true); }
  }
  function createNote(parent_id, title) {
    if (title !== undefined) return createNode(parent_id, title, false);
    promptModal('Новая заметка', 'Название заметки...', async (val) => {
      if (!val) return;
      await createNode(parent_id, val.trim(), false);
    });
  }
  function createFolder(parent_id) {
    promptModal('Новая папка', 'Название папки...', async (val) => {
      if (!val) return;
      await createNode(parent_id, val.trim(), true);
    });
  }
  async function deleteNode(id) {
    const node = findInTree(state.tree, id); if (!node) return;
    const labels = {
      folder: 'папку', note: 'заметку'
    };
    const what = node.is_folder ? 'папку' : 'заметку';
    if (!confirm('Удалить ' + what + ' "' + node.title + '"' + (node.is_folder ? ' и все вложенные элементы' : '') + '?')) return;
    try {
      await DEL('/api/nodes/' + id);
      // clean local state
      state.openTabs = state.openTabs.filter(t => t.node_id !== id);
      if (state.activeId === id) {
        const last = state.openTabs[state.openTabs.length - 1];
        state.activeId = last ? last.node_id : null;
      }
      state.expanded.delete(id);
      await refreshTree();
      renderTree(); renderTabs(); renderEditor();
      if (state.activeId) { await loadActive(); renderBacklinks(); } else { backlinksEl.innerHTML = ''; }
      persistSession();
      toast('Удалено');
    } catch (e) { toast(e.message, true); }
  }
  function renameNode(id) {
    const node = findInTree(state.tree, id); if (!node) return;
    promptModal('Переименовать', 'Новое имя...', async (val) => {
      if (!val || val === node.title) return;
      try {
        await PUT('/api/nodes/' + id, { title: val.trim() });
        await refreshTree();
        renderTree(); renderTabs();
      } catch (e) { toast(e.message, true); }
    }, node.title);
  }

  // ------------------------------------------------------------- Context menu
  function showContextMenu(x, y, node) {
    ctxmenuEl.innerHTML = '';
    const add = (label, fn, danger) => {
      const d = document.createElement('div');
      d.className = 'it' + (danger ? ' danger' : '');
      d.textContent = label;
      d.addEventListener('click', () => { hideContextMenu(); fn(); });
      ctxmenuEl.appendChild(d);
    };
    const sep = () => { const s = document.createElement('div'); s.className = 'sep'; ctxmenuEl.appendChild(s); };
    if (node.is_folder) {
      add('＋ Новая заметка', () => createNote(node.id));
      add('＋ Новая папка', () => createFolder(node.id));
      sep();
    }
    add('✎ Переименовать', () => renameNode(node.id));
    if (node.is_folder) add('↻ Развернуть', () => { state.expanded.add(node.id); renderTree(); });
    sep();
    add('🗑 Удалить', () => deleteNode(node.id), true);
    ctxmenuEl.style.left = Math.min(x, window.innerWidth - 220) + 'px';
    ctxmenuEl.style.top = Math.min(y, window.innerHeight - 220) + 'px';
    ctxmenuEl.style.display = 'block';
  }
  function hideContextMenu() { ctxmenuEl.style.display = 'none'; }
  document.addEventListener('click', hideContextMenu);
  document.addEventListener('scroll', hideContextMenu, true);

  // ------------------------------------------------------------- Modal
  let modalCallback = null;
  function promptModal(title, placeholder, cb, initial = '') {
    modalTitle.textContent = title;
    modalInput.placeholder = placeholder;
    modalInput.value = initial || '';
    modalCallback = cb;
    modalEl.classList.add('show');
    setTimeout(() => modalInput.focus(), 40);
  }
  function closeModal(v) {
    modalEl.classList.remove('show');
    if (modalCallback) modalCallback(v);
    modalCallback = null;
  }
  $('#modal-cancel').addEventListener('click', () => closeModal(null));
  $('#modal-ok').addEventListener('click', () => closeModal(modalInput.value.trim()));
  modalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') closeModal(modalInput.value.trim());
    if (e.key === 'Escape') closeModal(null);
  });

  // ------------------------------------------------------------- Toast
  let toastTimer;
  function toast(msg, err = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('error', !!err);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  // ------------------------------------------------------------- Toolbar
  function setMode(m, render = true) {
    state.mode = m;
    $('#btn-mode-source').classList.toggle('active', m === 'source');
    $('#btn-mode-live').classList.toggle('active', m === 'live');
    $('#btn-mode-preview').classList.toggle('active', m === 'preview');
    if (render) renderEditor();
  }
  $('#btn-mode-source').addEventListener('click', () => setMode('source'));
  $('#btn-mode-live').addEventListener('click', () => setMode('live'));
  $('#btn-mode-preview').addEventListener('click', () => setMode('preview'));
  $('#btn-new-note').addEventListener('click', () => createNote(null));
  $('#btn-new-folder').addEventListener('click', () => createFolder(null));
  $('#btn-add-root').addEventListener('click', () => {
    const c = confirm('ОК — новая заметка, Отмена — новая папка');
    if (c) createNote(null); else createFolder(null);
  });
  $('#btn-graph').addEventListener('click', toggleGraph);
  $('#btn-export').addEventListener('click', () => {
    window.location.href = '/api/export';
  });
  const fileInput = $('#file-import');
  $('#btn-import').addEventListener('click', () => {
    const mode = confirm(
      'ОК — добавить архив к текущей базе (merge),\n' +
      'Отмена — полностью заменить содержимое (replace).'
    ) ? 'merge' : 'replace';
    fileInput.dataset.mode = mode;
    fileInput.value = '';
    fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const mode = fileInput.dataset.mode || 'merge';
    if (mode === 'replace' && !confirm('Полная замена: все текущие заметки будут удалены. Продолжить?')) {
      fileInput.value = ''; return;
    }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mode', mode);
    try {
      const r = await fetch('/api/import', { method: 'POST', body: fd });
      if (!r.ok) {
        let msg = r.statusText;
        try { const j = await r.json(); msg = j.error || msg; } catch(_) {}
        throw new Error(msg);
      }
      toast('Импорт завершён');
      await boot();
    } catch (e) {
      toast('Ошибка импорта: ' + e.message, true);
    } finally {
      fileInput.value = '';
    }
  });
  $('#btn-theme').addEventListener('click', () => {
    const cur = document.body.getAttribute('data-theme') || 'dark';
    const nxt = cur === 'dark' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', nxt);
    localStorage.setItem('sb_theme', nxt);
  });
  const savedTheme = localStorage.getItem('sb_theme');
  if (savedTheme) document.body.setAttribute('data-theme', savedTheme);

  async function toggleGraph() {
    if (state.dirty && state.activeId != null) await saveActive();
    state.showGraph = !state.showGraph;
    $('#btn-graph').classList.toggle('active', state.showGraph);
    renderTabs(); renderTree(); renderEditor();
  }

  // ------------------------------------------------------------- Hotkeys
  function matchHotkey(e, hk) {
    if (!hk) return false;
    return (e.ctrlKey || e.metaKey) === !!hk.ctrl &&
           e.shiftKey === !!hk.shift &&
           e.altKey === !!hk.alt &&
           e.key.toLowerCase() === (hk.key || '').toLowerCase();
  }
  document.addEventListener('keydown', async (e) => {
    if (modalEl.classList.contains('show')) return;
    if (matchHotkey(e, HK.save)) {
      e.preventDefault();
      if (state.activeId != null) { await saveActive(); renderBacklinks(); toast('Сохранено'); }
    } else if (matchHotkey(e, HK.newNote)) { e.preventDefault(); createNote(null); }
    else if (matchHotkey(e, HK.close)) { e.preventDefault(); if (state.activeId != null) closeTab(state.activeId); }
    else if (matchHotkey(e, HK.toggle)) { e.preventDefault(); setMode(state.mode === 'source' ? 'preview' : state.mode === 'preview' ? 'live' : 'source'); }
    else if (matchHotkey(e, HK.graph)) { e.preventDefault(); toggleGraph(); }
  });

  /* =============================================================
     Graph View — Force-directed on Canvas
     ============================================================= */
  let graphAnimId = null;
  let gNodes = [], gLinks = [];
  let gT = { x: 0, y: 0, scale: 1 };
  let gDrag = null, gPan = null, gHover = null;
  let gMouse = { x: 0, y: 0 }, rect = null;

  function startGraph() {
    stopGraph();
    buildGraphData();
    resizeGraph();
    gT = { x: rect.width / 2, y: rect.height / 2, scale: 1 };
    loopGraph();
  }
  function stopGraph() { if (graphAnimId) cancelAnimationFrame(graphAnimId); graphAnimId = null; }
  function resizeGraph() {
    const r = graphCanvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    graphCanvas.width = r.width * dpr;
    graphCanvas.height = r.height * dpr;
    graphCanvas.style.width = r.width + 'px';
    graphCanvas.style.height = r.height + 'px';
    const ctx = graphCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rect = r;
  }
  window.addEventListener('resize', () => { if (state.showGraph) resizeGraph(); });

  function buildGraphData() {
    const map = new Map();
    const linkCount = new Map();
    for (const l of state.links) {
      linkCount.set(l.source_id, (linkCount.get(l.source_id) || 0) + 1);
      linkCount.set(l.target_id, (linkCount.get(l.target_id) || 0) + 1);
    }
    for (const n of state.flat) if (!n.is_folder) {
      map.set(n.id, {
        id: n.id, title: n.title,
        x: (Math.random() - 0.5) * 300,
        y: (Math.random() - 0.5) * 300,
        vx: 0, vy: 0,
        radius: 6 + Math.min(12, linkCount.get(n.id) || 0)
      });
    }
    gNodes = [...map.values()];
    gLinks = [];
    const seen = new Set();
    for (const l of state.links) {
      if (map.has(l.source_id) && map.has(l.target_id)) {
        const k = Math.min(l.source_id, l.target_id) + '-' + Math.max(l.source_id, l.target_id);
        if (seen.has(k)) continue;
        seen.add(k);
        gLinks.push({ s: map.get(l.source_id), t: map.get(l.target_id) });
      }
    }
  }
  function screenToWorld(sx, sy) {
    return { x: (sx - gT.x) / gT.scale, y: (sy - gT.y) / gT.scale };
  }
  function isDark() { return (document.body.getAttribute('data-theme') || 'dark') === 'dark'; }
  function tick() {
    const REP = 1500, ATT = 0.01, REST = 90, DAMP = 0.82, CG = 0.004;
    for (let i = 0; i < gNodes.length; i++) {
      for (let j = i + 1; j < gNodes.length; j++) {
        const a = gNodes[i], b = gNodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx*dx + dy*dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx*dx + dy*dy; }
        const d = Math.sqrt(d2), f = REP / d2;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
    }
    for (const l of gLinks) {
      const a = l.s, b = l.t;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx*dx + dy*dy) || 0.01;
      const f = (d - REST) * ATT;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (const n of gNodes) {
      n.vx -= n.x * CG; n.vy -= n.y * CG;
      if (gDrag && gDrag.node.id === n.id) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= DAMP; n.vy *= DAMP;
      n.x += n.vx; n.y += n.vy;
    }
    if (gDrag) {
      const w = screenToWorld(gDrag.x, gDrag.y);
      gDrag.node.x = w.x; gDrag.node.y = w.y;
    }
  }
  function draw() {
    const ctx = graphCanvas.getContext('2d');
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.save();
    ctx.translate(gT.x, gT.y); ctx.scale(gT.scale, gT.scale);
    const dark = isDark();
    const hlNodes = new Set(), hlLinks = new Set();
    if (gHover) {
      hlNodes.add(gHover.id);
      for (const l of gLinks) {
        if (l.s.id === gHover.id) { hlNodes.add(l.t.id); hlLinks.add(l); }
        if (l.t.id === gHover.id) { hlNodes.add(l.s.id); hlLinks.add(l); }
      }
    }
    for (const l of gLinks) {
      ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y);
      if (hlLinks.has(l)) { ctx.strokeStyle = '#6c8cff'; ctx.lineWidth = 2; }
      else if (gHover) { ctx.strokeStyle = dark ? 'rgba(80,80,100,0.25)' : 'rgba(100,100,120,0.25)'; ctx.lineWidth = 1; }
      else { ctx.strokeStyle = dark ? 'rgba(130,130,150,0.45)' : 'rgba(90,90,110,0.5)'; ctx.lineWidth = 1; }
      ctx.stroke();
    }
    for (const n of gNodes) {
      const isHov = gHover && n.id === gHover.id;
      const isHl = gHover && hlNodes.has(n.id);
      let fill = dark ? '#6c8cff' : '#2a5db0', alpha = 1;
      if (gHover) {
        if (isHl) fill = isHov ? '#ff6c8c' : '#6cffb0';
        else alpha = 0.25;
      }
      ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = dark ? '#25252b' : '#ffffff'; ctx.stroke();
      if (isHl || !gHover || n.radius > 10) {
        ctx.fillStyle = dark ? '#e0e0e6' : '#1e1e22';
        ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(n.title, n.x, n.y + n.radius + 3);
      }
    }
    ctx.globalAlpha = 1; ctx.restore();
    if (gHover) {
      const tw = ctx.measureText(gHover.title).width + 14;
      const lx = gMouse.x + 14, ly = gMouse.y + 14;
      ctx.save();
      ctx.fillStyle = dark ? 'rgba(30,30,34,0.92)' : 'rgba(255,255,255,0.95)';
      ctx.strokeStyle = dark ? '#6c8cff' : '#2a5db0'; ctx.lineWidth = 1;
      ctx.fillRect(lx, ly, tw, 22); ctx.strokeRect(lx, ly, tw, 22);
      ctx.fillStyle = dark ? '#fff' : '#1e1e22';
      ctx.font = 'bold 12px ' + getComputedStyle(document.body).fontFamily;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(gHover.title, lx + 7, ly + 11);
      ctx.restore();
    }
  }
  function loopGraph() { tick(); draw(); graphAnimId = requestAnimationFrame(loopGraph); }

  graphCanvas.addEventListener('mousedown', (e) => {
    const r = graphCanvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const w = screenToWorld(sx, sy);
    let picked = null;
    for (let i = gNodes.length - 1; i >= 0; i--) {
      const n = gNodes[i];
      const dx = n.x - w.x, dy = n.y - w.y;
      if (dx*dx + dy*dy <= (n.radius + 3) ** 2) { picked = n; break; }
    }
    if (picked) gDrag = { node: picked, x: sx, y: sy, startX: sx, startY: sy, moved: false };
    else gPan = { sx, sy, ox: gT.x, oy: gT.y, moved: false };
  });
  graphCanvas.addEventListener('mousemove', (e) => {
    const r = graphCanvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    gMouse.x = sx; gMouse.y = sy;
    if (gDrag) {
      gDrag.x = sx; gDrag.y = sy;
      if (Math.abs(sx - gDrag.startX) + Math.abs(sy - gDrag.startY) > 3) gDrag.moved = true;
    } else if (gPan) {
      gT.x = gPan.ox + (sx - gPan.sx);
      gT.y = gPan.oy + (sy - gPan.sy);
      if (Math.abs(sx - gPan.sx) + Math.abs(sy - gPan.sy) > 3) gPan.moved = true;
    } else {
      const w = screenToWorld(sx, sy);
      let picked = null;
      for (const n of gNodes) {
        const dx = n.x - w.x, dy = n.y - w.y;
        if (dx*dx + dy*dy <= (n.radius + 2) ** 2) { picked = n; break; }
      }
      gHover = picked;
      graphCanvas.style.cursor = picked ? 'pointer' : 'grab';
    }
  });
  graphCanvas.addEventListener('mouseup', () => { gDrag = null; gPan = null; });
  graphCanvas.addEventListener('dblclick', (e) => {
    const r = graphCanvas.getBoundingClientRect();
    const w = screenToWorld(e.clientX - r.left, e.clientY - r.top);
    for (const n of gNodes) {
      const dx = n.x - w.x, dy = n.y - w.y;
      if (dx*dx + dy*dy <= (n.radius + 4) ** 2) {
        state.showGraph = false;
        $('#btn-graph').classList.remove('active');
        openNote(n.id);
        return;
      }
    }
  });
  graphCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = graphCanvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const delta = e.deltaY < 0 ? 1.1 : 0.9;
    const before = screenToWorld(sx, sy);
    gT.scale = Math.max(0.2, Math.min(4, gT.scale * delta));
    const afterX = before.x * gT.scale + gT.x;
    const afterY = before.y * gT.scale + gT.y;
    gT.x += sx - afterX;
    gT.y += sy - afterY;
  }, { passive: false });

  // ------------------------------------------------------------- Start
  boot();
})();
