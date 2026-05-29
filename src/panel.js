// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();

  const persisted = vscode.getState() || {};
  const state = {
    orgs: [],
    selectedOrg: null,
    items: [], // {type, name, key (type:name), filePath, files[]}
    selected: new Set(), // keys
    expandedGroups: new Set(persisted.expandedGroups || []),
    filter: persisted.filter || '',
    typeFilter: new Set(persisted.typeFilter || []), // empty = all
    busy: false,
    busyAction: null,
    activeFileKey: null,
    statusCards: [],
    cmdLog: [],
    cmdLogCollapsed: !!persisted.cmdLogCollapsed,
    banner: ''
  };

  function savePersisted() {
    vscode.setState({
      expandedGroups: Array.from(state.expandedGroups),
      filter: state.filter,
      typeFilter: Array.from(state.typeFilter),
      cmdLogCollapsed: state.cmdLogCollapsed
    });
  }

  const $ = (id) => document.getElementById(id);

  function send(type, payload) { vscode.postMessage({ type, ...(payload || {}) }); }

  // ---- Init ----
  window.addEventListener('message', (ev) => handleMessage(ev.data));
  $('refreshOrgs').addEventListener('click', () => send('refreshOrgs'));
  $('refreshFiles').addEventListener('click', () => send('refreshFiles'));
  $('orgSelect').addEventListener('change', (e) => { state.selectedOrg = e.target.value || null; send('selectOrg', { username: state.selectedOrg }); });
  $('search').addEventListener('input', (e) => { state.filter = e.target.value.toLowerCase(); savePersisted(); renderTree(); });
  $('search').value = state.filter;
  $('deployBtn').addEventListener('click', () => action('deploy'));
  $('retrieveBtn').addEventListener('click', () => action('retrieve'));
  $('diffBtn').addEventListener('click', () => action('diff'));
  $('cancelBtn').addEventListener('click', () => send('cancel'));
  $('useActive').addEventListener('click', () => send('useActiveFile'));
  $('cmdlogHeader').addEventListener('click', () => {
    state.cmdLogCollapsed = !state.cmdLogCollapsed;
    savePersisted();
    renderCmdLog();
  });
  send('ready');

  function action(kind) {
    if (state.busy) return;
    const keys = Array.from(state.selected);
    if (keys.length === 0) return;
    if (!state.selectedOrg) return;
    send(kind === 'deploy' ? 'deploy' : kind === 'retrieve' ? 'retrieve' : 'diff', { keys });
  }

  // ---- Message handling ----
  function handleMessage(msg) {
    switch (msg.type) {
      case 'orgs':
        state.orgs = msg.orgs || [];
        state.selectedOrg = msg.selected || null;
        renderOrgs();
        renderActions();
        return;
      case 'files':
        state.items = msg.items || [];
        // Drop selections that no longer exist
        const valid = new Set(state.items.map(i => `${i.type}:${i.name}`));
        for (const k of Array.from(state.selected)) if (!valid.has(k)) state.selected.delete(k);
        // Drop stale type-filter entries
        const types = new Set(state.items.map(i => i.type));
        for (const t of Array.from(state.typeFilter)) if (!types.has(t)) state.typeFilter.delete(t);
        renderTypeFilter();
        renderTree();
        renderActions();
        return;
      case 'banner':
        state.banner = msg.message || '';
        renderBanner();
        return;
      case 'activeFile':
        state.activeFileKey = msg.key || null;
        if (msg.key && msg.select) {
          // explicit "Use active file" — expand its group, select it, scroll into view
          const grp = msg.key.split(':')[0];
          state.expandedGroups.add(grp);
          state.selected.add(msg.key);
          savePersisted();
          renderTree();
          renderActions();
          if (msg.scroll) scrollKeyIntoView(msg.key);
        } else {
          // passive highlight from onDidChangeActiveTextEditor
          renderTree();
        }
        return;
      case 'busy':
        state.busy = !!msg.busy;
        state.busyAction = msg.action || null;
        renderActions();
        return;
      case 'status':
        // msg.card = { kind: 'ok'|'err'|'warn', title, meta, lines[], errText }
        state.statusCards.unshift(msg.card);
        if (state.statusCards.length > 25) state.statusCards.length = 25;
        renderStatus();
        return;
      case 'cmd':
        // msg.entry = { id, timestamp, command, status: 'run'|'ok'|'err', durationMs? }
        // Merge (don't replace) so a completion update — which omits `command` —
        // keeps the command text from the initial 'run' entry.
        const existing = state.cmdLog.findIndex(e => e.id === msg.entry.id);
        if (existing >= 0) state.cmdLog[existing] = { ...state.cmdLog[existing], ...msg.entry };
        else state.cmdLog.unshift(msg.entry);
        if (state.cmdLog.length > 50) state.cmdLog.length = 50;
        renderCmdLog();
        return;
    }
  }

  // ---- Renderers ----
  function orgBadgeText(kind) {
    if (kind === 'prod') return '[PROD]';
    if (kind === 'sandbox') return '[SBX]';
    if (kind === 'scratch') return '[SCR]';
    return '';
  }

  function renderOrgs() {
    const sel = $('orgSelect');
    sel.innerHTML = '';
    if (state.orgs.length === 0) {
      const opt = document.createElement('option');
      opt.value = ''; opt.text = '— no authenticated orgs —';
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.text = '— select org —';
    sel.appendChild(placeholder);
    for (const o of state.orgs) {
      const opt = document.createElement('option');
      opt.value = o.username;
      const badge = orgBadgeText(o.kind);
      opt.text = badge ? `${badge} ${o.label}` : o.label;
      if (o.username === state.selectedOrg) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function renderBanner() {
    const b = $('banner');
    if (!state.banner) { b.style.display = 'none'; return; }
    b.style.display = 'block';
    b.textContent = state.banner;
  }

  function renderTypeFilter() {
    const row = $('typeFilterRow');
    const list = $('typeFilterList');
    const label = $('typeFilterLabel');
    const types = Array.from(new Set(state.items.map(i => i.type))).sort();
    if (types.length === 0) { row.style.display = 'none'; return; }
    row.style.display = 'block';
    list.innerHTML = '';
    for (const t of types) {
      const lbl = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      // empty typeFilter = all selected
      cb.checked = state.typeFilter.size === 0 || state.typeFilter.has(t);
      cb.addEventListener('change', () => {
        if (state.typeFilter.size === 0) {
          // seed with all then remove this one
          for (const x of types) state.typeFilter.add(x);
        }
        if (cb.checked) state.typeFilter.add(t); else state.typeFilter.delete(t);
        // if user re-selects everything, collapse to empty (= "all")
        if (state.typeFilter.size === types.length) state.typeFilter.clear();
        savePersisted();
        renderTypeFilter();
        renderTree();
      });
      lbl.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = t;
      lbl.appendChild(span);
      list.appendChild(lbl);
    }
    // action row (All / None)
    const actions = document.createElement('div');
    actions.className = 'type-filter-actions';
    const all = document.createElement('button');
    all.textContent = 'All';
    all.addEventListener('click', () => { state.typeFilter.clear(); savePersisted(); renderTypeFilter(); renderTree(); });
    const none = document.createElement('button');
    none.textContent = 'None';
    none.addEventListener('click', () => {
      state.typeFilter.clear();
      // placeholder sentinel: add a token nothing matches
      state.typeFilter.add('__none__');
      savePersisted();
      renderTypeFilter();
      renderTree();
    });
    actions.appendChild(all);
    actions.appendChild(none);
    list.appendChild(actions);
    label.textContent = state.typeFilter.size === 0
      ? `All types (${types.length})`
      : `${state.typeFilter.size} of ${types.length} types`;
  }

  function isTypeAllowed(type) {
    if (state.typeFilter.size === 0) return true;
    return state.typeFilter.has(type);
  }

  function renderTree() {
    const tree = $('tree');
    tree.innerHTML = '';
    if (state.items.length === 0) {
      const d = document.createElement('div');
      d.className = 'status-empty';
      d.textContent = 'No metadata found in workspace. Open a Salesforce project (with force-app/ or sfdx-project.json).';
      tree.appendChild(d);
      return;
    }
    const filter = state.filter;
    const groups = new Map();
    for (const item of state.items) {
      if (!isTypeAllowed(item.type)) continue;
      if (filter) {
        const hay = `${item.type} ${item.name}`.toLowerCase();
        if (!hay.includes(filter)) continue;
      }
      if (!groups.has(item.type)) groups.set(item.type, []);
      groups.get(item.type).push(item);
    }
    const types = Array.from(groups.keys()).sort();
    if (types.length === 0) {
      const d = document.createElement('div');
      d.className = 'status-empty';
      d.textContent = 'No metadata matches the current filter.';
      tree.appendChild(d);
      return;
    }
    for (const type of types) {
      const arr = groups.get(type);
      const groupEl = document.createElement('div');
      groupEl.className = 'group';
      const expanded = state.expandedGroups.has(type) || !!filter;
      const header = document.createElement('div');
      header.className = 'group-header';

      // group-select checkbox (T14)
      const groupCb = document.createElement('input');
      groupCb.type = 'checkbox';
      const selectedInGroup = arr.filter(i => state.selected.has(`${i.type}:${i.name}`)).length;
      if (selectedInGroup === 0) { groupCb.checked = false; groupCb.indeterminate = false; }
      else if (selectedInGroup === arr.length) { groupCb.checked = true; groupCb.indeterminate = false; }
      else { groupCb.checked = false; groupCb.indeterminate = true; }
      groupCb.title = 'Select/deselect all visible items in this group';
      groupCb.addEventListener('click', (e) => e.stopPropagation());
      groupCb.addEventListener('change', () => {
        const allSelected = selectedInGroup === arr.length;
        for (const i of arr) {
          const k = `${i.type}:${i.name}`;
          if (allSelected) state.selected.delete(k);
          else state.selected.add(k);
        }
        renderTree();
        renderActions();
      });
      header.appendChild(groupCb);

      const caret = document.createElement('span');
      caret.className = 'caret';
      caret.textContent = expanded ? '▾' : '▸';
      header.appendChild(caret);
      const typeLbl = document.createElement('span');
      typeLbl.textContent = type;
      header.appendChild(typeLbl);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `(${arr.length})`;
      header.appendChild(count);

      header.addEventListener('click', (e) => {
        if (e.target === groupCb) return;
        if (state.expandedGroups.has(type)) state.expandedGroups.delete(type);
        else state.expandedGroups.add(type);
        savePersisted();
        renderTree();
      });
      groupEl.appendChild(header);
      if (expanded) {
        for (const item of arr) {
          const key = `${item.type}:${item.name}`;
          const row = document.createElement('div');
          const isActive = key === state.activeFileKey;
          row.className = 'row' + (isActive ? ' focused active-editor' : '');
          row.dataset.key = key;
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = state.selected.has(key);
          cb.addEventListener('change', () => {
            if (cb.checked) state.selected.add(key); else state.selected.delete(key);
            renderTree();
            renderActions();
          });
          row.appendChild(cb);
          const name = document.createElement('span');
          name.className = 'name';
          name.textContent = item.name;
          name.title = item.filePath;
          row.appendChild(name);
          if (item.files && item.files.length > 1) {
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = `${item.files.length} files`;
            row.appendChild(badge);
          }
          row.addEventListener('click', (e) => {
            if (e.target === cb) return;
            cb.checked = !cb.checked;
            if (cb.checked) state.selected.add(key); else state.selected.delete(key);
            renderTree();
            renderActions();
          });
          groupEl.appendChild(row);
        }
      }
      tree.appendChild(groupEl);
    }
  }

  function scrollKeyIntoView(key) {
    const row = document.querySelector(`.row[data-key="${cssEscape(key)}"]`);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c.charCodeAt(0).toString(16) + ' ');
  }

  function renderActions() {
    $('selCount').textContent = `${state.selected.size} selected`;
    const can = state.selected.size > 0 && !!state.selectedOrg && !state.busy;
    const deployBtn = $('deployBtn');
    const retrieveBtn = $('retrieveBtn');
    const diffBtn = $('diffBtn');
    const cancelBtn = $('cancelBtn');
    const useActive = $('useActive');
    if (state.busy) {
      deployBtn.style.display = 'none';
      retrieveBtn.style.display = 'none';
      diffBtn.style.display = 'none';
      useActive.style.display = 'none';
      cancelBtn.style.display = '';
      cancelBtn.textContent = state.busyAction ? `Cancel ${state.busyAction}` : 'Cancel';
    } else {
      deployBtn.style.display = '';
      retrieveBtn.style.display = '';
      diffBtn.style.display = '';
      useActive.style.display = '';
      cancelBtn.style.display = 'none';
      deployBtn.disabled = !can;
      retrieveBtn.disabled = !can;
      diffBtn.disabled = !can;
    }
  }

  function renderStatus() {
    const st = $('status');
    st.innerHTML = '';
    if (state.statusCards.length === 0) {
      const d = document.createElement('div');
      d.className = 'status-empty';
      d.textContent = 'No operations yet.';
      st.appendChild(d);
      return;
    }
    for (const card of state.statusCards) {
      const el = document.createElement('div');
      el.className = `status-card ${card.kind || 'ok'}`;
      const t = document.createElement('div');
      t.className = 'title';
      t.textContent = card.title || '';
      el.appendChild(t);
      if (card.meta) {
        const m = document.createElement('div');
        m.className = 'meta';
        m.textContent = card.meta;
        el.appendChild(m);
      }
      if (card.lines && card.lines.length) {
        const ul = document.createElement('ul');
        for (const line of card.lines) {
          const li = document.createElement('li');
          li.textContent = line;
          ul.appendChild(li);
        }
        el.appendChild(ul);
      }
      if (card.errText) {
        const e = document.createElement('div');
        e.className = 'err-text';
        e.textContent = card.errText;
        el.appendChild(e);
      }
      st.appendChild(el);
    }
  }

  function renderCmdLog() {
    const root = $('cmdlog');
    if (state.cmdLogCollapsed) root.classList.add('collapsed');
    else root.classList.remove('collapsed');
    $('cmdlogCaret').textContent = state.cmdLogCollapsed ? '▸' : '▼';
    const body = $('cmdlogBody');
    body.innerHTML = '';
    for (const e of state.cmdLog) {
      const row = document.createElement('div');
      row.className = 'cmd-entry';
      const dot = document.createElement('div');
      dot.className = 'status-dot ' + (e.status || 'run');
      row.appendChild(dot);
      const ts = document.createElement('div');
      ts.className = 'ts';
      ts.textContent = e.timestamp || '';
      row.appendChild(ts);
      const cmd = document.createElement('div');
      cmd.className = 'cmd';
      cmd.textContent = e.command || '';
      row.appendChild(cmd);
      const dur = document.createElement('div');
      dur.className = 'dur';
      dur.textContent = e.durationMs != null ? `${e.durationMs}ms` : (e.status === 'run' ? '…' : '');
      row.appendChild(dur);
      body.appendChild(row);
    }
  }
})();
