// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();

  const persisted = vscode.getState() || {};
  const state = {
    orgs: [],
    selectedOrg: null,
    items: [], // {type, name, key (type:name), filePath, files[]}
    objectChildTypes: new Set(), // metadata types that nest under an object (CustomField, …)
    selected: new Set(), // keys
    expandedGroups: new Set(persisted.expandedGroups || []),
    filter: persisted.filter || '',
    typeFilter: new Set(persisted.typeFilter || []), // empty = all
    busy: false,
    busyAction: null,
    progress: null, // { text, startedAt } while an operation runs
    activeFileKey: null,
    statusCards: [],
    cmdLog: [],
    cmdLogCollapsed: !!persisted.cmdLogCollapsed,
    // Fraction of the body given to the Status pane (right/bottom). null = CSS default.
    statusRatio: typeof persisted.statusRatio === 'number' ? persisted.statusRatio : null,
    banner: '',
    // Scan/type-resolution notices get their own slot so they can't overwrite an
    // org error (both used to share the single banner, last writer won).
    scanBanner: '',
    // The exact notice text the user dismissed — the same recurring notice stays
    // hidden across reloads, but any NEW text (different folders/reason) reappears.
    scanBannerDismissed: persisted.scanBannerDismissed || null,
    // Org metadata browse state
    orgKeys: new Set(),      // "Type:Name" keys that exist on the org
    localKeys: new Set(),    // "Type:Name" keys that exist locally
    orgOnlyItems: [],        // { type, name } items on org but not local
    orgLoaded: false,        // has org metadata been fetched this session?
    sourceFilter: 'all',     // 'all' | 'local-only' | 'org-only' | 'both'
    // View mode: one tree, three lenses. 'selected' shows only checked items
    // (replaces the old chip tray), 'changed' only git-modified components.
    viewMode: ['all', 'selected', 'changed'].includes(persisted.viewMode) ? persisted.viewMode : 'all',
    changedKeys: null,       // Set of "Type:Name" with git changes; null = unknown/unavailable
    changedReason: '',       // why change detection is unavailable (when changedKeys is null)
    // Snapshot of the selection taken on ENTERING the Selected lens (IntelliJ
    // commit-window semantics): unchecking a row flips its checkbox but keeps the
    // row visible — instant removal would break double-click (the re-render shifts
    // rows under the cursor mid-gesture) and make an accidental uncheck
    // unrecoverable without hunting the item down in All. Membership refreshes on
    // re-entering the lens. null = rebuild lazily from the live selection.
    selectedLensKeys: null,
  };

  function savePersisted() {
    vscode.setState({
      expandedGroups: Array.from(state.expandedGroups),
      filter: state.filter,
      typeFilter: Array.from(state.typeFilter),
      cmdLogCollapsed: state.cmdLogCollapsed,
      statusRatio: state.statusRatio,
      scanBannerDismissed: state.scanBannerDismissed,
      viewMode: state.viewMode
    });
  }

  const $ = (id) => document.getElementById(id);

  function send(type, payload) { vscode.postMessage({ type, ...(payload || {}) }); }

  // ---- Init ----
  window.addEventListener('message', (ev) => handleMessage(ev.data));
  $('refreshOrgs').addEventListener('click', () => send('refreshOrgs'));
  $('refreshFiles').addEventListener('click', () => send('refreshFiles'));
  $('fetchOrgBtn').addEventListener('click', () => { if (!state.busy) send('fetchOrgMetadata', { username: state.selectedOrg }); });
  $('sourceFilter').addEventListener('change', (e) => { state.sourceFilter = e.target.value; renderTree(); });
  document.querySelectorAll('#viewModes button').forEach((btn) => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
  });
  function setViewMode(mode) {
    if (state.viewMode === mode) return;
    state.viewMode = mode;
    savePersisted();
    // Entering the Selected lens re-snapshots its membership from the live
    // selection, so items unchecked during the previous visit drop out now.
    if (mode === 'selected') state.selectedLensKeys = new Set(state.selected);
    // Recompute against the CURRENT git state every time the lens is opened —
    // edits made since the last scan must show up without a manual rescan.
    if (mode === 'changed') send('refreshChanged');
    renderTree();
  }
  $('orgSelect').addEventListener('change', (e) => { state.selectedOrg = e.target.value || null; send('selectOrg', { username: state.selectedOrg }); });
  // Debounce the filter so a fast typist on a large org-metadata tree doesn't
  // trigger a full re-render on every keystroke.
  let searchTimer = null;
  $('search').addEventListener('input', (e) => {
    const v = e.target.value.toLowerCase();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filter = v; savePersisted(); renderTree(); }, 200);
  });
  $('search').value = state.filter;
  // Mirror the chosen test level to the provider so context-menu and editor
  // right-click deploys honor it too (they don't read this DOM).
  $('testLevel').addEventListener('change', (e) => send('setTestLevel', { testLevel: e.target.value || undefined }));
  $('deployBtn').addEventListener('click', () => action('deploy'));
  $('validateBtn').addEventListener('click', () => action('validate'));
  $('retrieveBtn').addEventListener('click', () => action('retrieve'));
  $('diffBtn').addEventListener('click', () => action('diff'));
  $('cancelBtn').addEventListener('click', () => send('cancel'));
  $('useActive').addEventListener('click', () => send('useActiveFile'));
  $('clearSel').addEventListener('click', () => {
    state.selected.clear();
    state.selectedLensKeys = null; // the Selected lens empties too, not just checkboxes
    renderTree();
    renderActions();
  });
  $('cmdlogHeader').addEventListener('click', () => {
    state.cmdLogCollapsed = !state.cmdLogCollapsed;
    savePersisted();
    renderCmdLog();
  });
  $('clearStatus').addEventListener('click', () => {
    state.statusCards = [];
    send('clearStatusHistory'); // also drop the persisted history, or it resurrects on reload
    renderStatus();
  });
  $('clearCmdLog').addEventListener('click', (e) => {
    e.stopPropagation();   // don't also toggle the log's collapse
    state.cmdLog = [];
    renderCmdLog();
  });
  setupSplitter();
  // Close the right-click menu if the tree scrolls out from under it.
  $('tree').addEventListener('scroll', () => closeContextMenu());
  send('ready');

  function action(kind) {
    if (state.busy) return;
    const keys = Array.from(state.selected);
    if (keys.length === 0) return;
    if (!state.selectedOrg) return;
    // The chosen test level applies to deploy and validate (empty → CLI/host default).
    const testLevel = ($('testLevel') && $('testLevel').value) || undefined;
    if (kind === 'deploy') return send('deploy', { keys, testLevel });
    if (kind === 'validate') return send('deploy', { keys, validateOnly: true, testLevel });
    if (kind === 'retrieve') return send('retrieve', { keys });
    return send('diff', { keys });
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
        state.objectChildTypes = new Set(msg.objectChildTypes || []);
        state.localKeys = new Set(state.items.map(i => `${i.type}:${i.name}`));
        // Recompute org-only items if org metadata is already loaded
        if (state.orgLoaded) {
          state.orgOnlyItems = Array.from(state.orgKeys)
            .filter(k => !state.localKeys.has(k))
            .map(k => { const c = k.indexOf(':'); return { type: k.slice(0, c), name: k.slice(c + 1) }; });
        }
        // Drop selections that no longer exist in either local or org
        const valid = new Set([...state.localKeys, ...state.orgKeys]);
        for (const k of Array.from(state.selected)) if (!valid.has(k)) state.selected.delete(k);
        // Drop stale type-filter entries (allow org types too)
        const allKnownTypes = new Set([...state.items.map(i => i.type), ...state.orgOnlyItems.map(i => i.type)]);
        for (const t of Array.from(state.typeFilter)) if (!allKnownTypes.has(t)) state.typeFilter.delete(t);
        renderTypeFilter();
        renderTree();
        renderActions();
        return;
      case 'orgMetadata':
        state.localKeys = new Set(state.items.map(i => `${i.type}:${i.name}`));
        state.orgKeys = new Set((msg.orgItems || []).map(i => `${i.type}:${i.name}`));
        state.orgOnlyItems = (msg.orgItems || []).filter(i => !state.localKeys.has(`${i.type}:${i.name}`));
        state.orgLoaded = true;
        renderSourceFilter();
        renderTypeFilter();
        renderTree();
        renderActions();
        return;
      case 'orgMetadataReset':
        // Target org changed — drop fetched org membership so badges/filter/org-only
        // rows don't describe a different org than the one now selected.
        state.orgKeys = new Set();
        state.orgOnlyItems = [];
        state.orgLoaded = false;
        state.sourceFilter = 'all';
        if ($('sourceFilter')) $('sourceFilter').value = 'all';
        // Drop any selected org-only keys that no longer exist locally.
        for (const k of Array.from(state.selected)) if (!state.localKeys.has(k)) state.selected.delete(k);
        renderSourceFilter();
        renderTypeFilter();
        renderTree();
        renderActions();
        return;
      case 'banner':
        state.banner = msg.message || '';
        renderBanner();
        return;
      case 'scanBanner':
        state.scanBanner = msg.message || '';
        renderBanner();
        return;
      case 'changed':
        state.changedKeys = msg.keys === null ? null : new Set(msg.keys || []);
        state.changedReason = msg.reason || '';
        renderTree();
        return;
      case 'testLevel':
        if ($('testLevel')) $('testLevel').value = msg.value || '';
        return;
      case 'activeFile':
        state.activeFileKey = msg.key || null;
        if (msg.key && msg.select) {
          // explicit "Use active file" — expand its group path, select it, scroll into view.
          // The Changed lens could hide the row entirely (file unmodified) — the reveal
          // must be visible, and after selecting, the Selected lens shows it too, so
          // only 'changed' needs hopping out of.
          if (state.viewMode === 'changed') { state.viewMode = 'all'; savePersisted(); }
          // In the Selected lens the reveal must be a member to be visible.
          if (state.viewMode === 'selected' && state.selectedLensKeys) state.selectedLensKeys.add(msg.key);
          expandPathForKey(msg.key);
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
        if (state.busy) {
          state.progress = { text: state.busyAction ? `${state.busyAction} running…` : 'Working…', startedAt: Date.now() };
          startProgressTimer();
        } else {
          state.progress = null;
          stopProgressTimer();
        }
        renderActions();
        renderStatus();
        return;
      case 'progress':
        if (state.progress && msg.text) {
          state.progress.text = msg.text;
          renderStatus();
        }
        return;
      case 'status':
        // msg.card = { kind: 'ok'|'err'|'warn', title, meta, lines[], errText, actions[], hint, at }
        state.statusCards.unshift(msg.card);
        if (state.statusCards.length > 50) state.statusCards.length = 50;
        renderStatus();
        return;
      case 'statusHistory':
        // Persisted card history replayed by the provider on ready (newest first) —
        // the Status pane doubles as the deployment history across window reloads.
        state.statusCards = (msg.cards || []).slice(0, 50);
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
    // Keep the select locked if an operation is mid-flight (renderActions owns this too).
    sel.disabled = state.busy;
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
    if (!state.banner) { b.style.display = 'none'; } else { b.style.display = 'block'; b.textContent = state.banner; }
    // Scan notice is informational (folders hidden from the tree) — dismissible,
    // unlike the org banner which reflects live actionable state.
    const sb = $('scanBanner');
    const show = state.scanBanner && state.scanBanner !== state.scanBannerDismissed;
    if (!show) { sb.style.display = 'none'; return; }
    sb.style.display = 'flex';
    sb.replaceChildren();
    const txt = document.createElement('span');
    txt.className = 'banner-text';
    txt.textContent = state.scanBanner;
    const x = document.createElement('button');
    x.className = 'banner-close';
    x.textContent = '✕';
    x.title = 'Dismiss — unresolved folders stay hidden from the tree; details in Output › "SF Org Deploy Wrapper"';
    x.addEventListener('click', () => { state.scanBannerDismissed = state.scanBanner; savePersisted(); renderBanner(); });
    sb.appendChild(txt);
    sb.appendChild(x);
  }

  function renderSourceFilter() {
    const row = $('sourceFilterRow');
    row.style.display = state.orgLoaded ? 'block' : 'none';
  }

  function renderTypeFilter() {
    const row = $('typeFilterRow');
    const list = $('typeFilterList');
    const label = $('typeFilterLabel');
    const types = Array.from(new Set([
      ...state.items.map(i => i.type),
      ...state.orgOnlyItems.map(i => i.type)
    ])).sort();
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
      : state.typeFilter.has('__none__')
        ? `0 of ${types.length} types`
        : `${state.typeFilter.size} of ${types.length} types`;
  }

  function isTypeAllowed(type) {
    if (state.typeFilter.size === 0) return true;
    return state.typeFilter.has(type);
  }

  /** Returns 'local', 'org', or 'both' for a key when org metadata has been loaded. */
  function itemSource(key) {
    if (!state.orgLoaded) return null;
    const isLocal = state.localKeys.has(key);
    const isOrg = state.orgKeys.has(key);
    if (isLocal && isOrg) return 'both';
    if (isLocal) return 'local';
    if (isOrg) return 'org';
    return null;
  }

  function isSourceAllowed(source) {
    if (!state.orgLoaded || state.sourceFilter === 'all') return true;
    if (state.sourceFilter === 'local-only') return source === 'local';
    if (state.sourceFilter === 'org-only') return source === 'org';
    if (state.sourceFilter === 'both') return source === 'both';
    return true;
  }

  /** Merges local items with org-only items into one flat array tagged with _source. */
  function buildMergedItems() {
    const merged = [];
    for (const item of state.items) {
      merged.push({ ...item, _source: itemSource(`${item.type}:${item.name}`) });
    }
    if (state.orgLoaded) {
      for (const item of state.orgOnlyItems) {
        merged.push({ type: item.type, name: item.name, filePath: null, files: [], _source: 'org' });
      }
    }
    return merged;
  }

  // key = "Type:Name"; Name itself may contain ':' on no known type, so split on the first.
  function splitKey(key) {
    const idx = key.indexOf(':');
    return [key.slice(0, idx), key.slice(idx + 1)];
  }

  // Friendly plural label for an object-child type group.
  const CHILD_LABELS = {
    CustomField: 'Fields',
    ValidationRule: 'Validation Rules',
    RecordType: 'Record Types',
    ListView: 'List Views',
    FieldSet: 'Field Sets',
    CompactLayout: 'Compact Layouts',
    WebLink: 'Buttons & Links',
    BusinessProcess: 'Business Processes',
    Index: 'Indexes',
    SharingReason: 'Sharing Reasons'
  };
  function childLabel(type) { return CHILD_LABELS[type] || type; }

  // Expand the group path that reveals `key` (so "Use active file" can scroll to it).
  function expandPathForKey(key) {
    const [type, name] = splitKey(key);
    if (state.objectChildTypes.has(type)) {
      const obj = name.split('.')[0];
      state.expandedGroups.add('__OBJECTS__');
      state.expandedGroups.add('obj/' + obj);
      state.expandedGroups.add('objc/' + obj + '/' + type);
    } else if (type === 'CustomObject') {
      state.expandedGroups.add('__OBJECTS__');
      state.expandedGroups.add('obj/' + name);
    } else {
      state.expandedGroups.add(type);
    }
  }

  // ---- Search matching ----
  // Query = whitespace-separated tokens, ALL of which must match (AND, any order):
  //   type:xxx / t:xxx — constrains the metadata TYPE (substring, e.g. type:flow,
  //                      t:field). Several type: tokens must all hold.
  //   plain token      — substring of "Type Name", OR a match on the name's
  //                      camelCase initials, so "avt" (or a piece of it) finds
  //                      AccountValidationTrigger and "acc trig" finds it too.
  function nameInitials(name) {
    return name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase humps
      .replace(/[^A-Za-z0-9]+/g, ' ')          // ., _, - etc. separate words
      .split(' ')
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .toLowerCase();
  }

  function matchesFilter(item, query) {
    if (!query) return true;
    let hay = null;
    let initials = null;
    for (const raw of query.split(/\s+/)) {
      if (!raw) continue;
      const typeTok = raw.startsWith('type:') ? raw.slice(5) : (raw.startsWith('t:') ? raw.slice(2) : null);
      if (typeTok !== null) {
        if (typeTok && !item.type.toLowerCase().includes(typeTok)) return false;
        continue; // bare "type:" while still typing matches everything
      }
      if (hay === null) {
        hay = `${item.type} ${item.name}`.toLowerCase();
        initials = nameInitials(item.name);
      }
      if (!hay.includes(raw) && !initials.includes(raw)) return false;
    }
    return true;
  }

  // Partition the (filtered) merged item list into the object tree and the flat type groups.
  function buildGroups() {
    const filter = state.filter;
    const objectMap = new Map(); // objectName -> { obj: item|null, children: Map<type, item[]> }
    const flatGroups = new Map(); // type -> item[]
    const getObj = (n) => {
      let o = objectMap.get(n);
      if (!o) { o = { obj: null, children: new Map() }; objectMap.set(n, o); }
      return o;
    };
    for (const item of buildMergedItems()) {
      if (!isTypeAllowed(item.type)) continue;
      if (!isSourceAllowed(item._source)) continue;
      // View-mode lens first (cheap Set lookups), text filter within the lens.
      if (state.viewMode === 'selected') {
        // Lazy rebuild covers a webview restored straight into this lens.
        const lens = state.selectedLensKeys ?? (state.selectedLensKeys = new Set(state.selected));
        if (!lens.has(`${item.type}:${item.name}`)) continue;
      }
      if (state.viewMode === 'changed' && !(state.changedKeys && state.changedKeys.has(`${item.type}:${item.name}`))) continue;
      if (!matchesFilter(item, filter)) continue;
      if (item.type === 'CustomObject') {
        getObj(item.name).obj = item;
      } else if (state.objectChildTypes.has(item.type)) {
        const o = getObj(item.name.split('.')[0]);
        if (!o.children.has(item.type)) o.children.set(item.type, []);
        o.children.get(item.type).push(item);
      } else {
        if (!flatGroups.has(item.type)) flatGroups.set(item.type, []);
        flatGroups.get(item.type).push(item);
      }
    }
    return { objectMap, flatGroups };
  }

  const INDENT = (depth) => `${8 + depth * 14}px`;

  // A collapsible group node with a tri-state select-all checkbox. Returns the wrapper
  // and the body element to append children into (only when expanded).
  function makeGroupNode({ key, label, count, itemKeys, expanded, depth }) {
    const group = document.createElement('div');
    group.className = 'group';
    const header = document.createElement('div');
    header.className = 'group-header';
    header.style.paddingLeft = INDENT(depth);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const sel = itemKeys.filter(k => state.selected.has(k)).length;
    if (sel === 0) { cb.checked = false; cb.indeterminate = false; }
    else if (sel === itemKeys.length) { cb.checked = true; cb.indeterminate = false; }
    else { cb.checked = false; cb.indeterminate = true; }
    cb.title = 'Select/deselect all visible items in this group';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      const all = sel === itemKeys.length;
      for (const k of itemKeys) { if (all) state.selected.delete(k); else state.selected.add(k); }
      renderTree();
      renderActions();
    });
    header.appendChild(cb);

    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = expanded ? '▾' : '▸';
    header.appendChild(caret);
    const lbl = document.createElement('span');
    lbl.textContent = label;
    header.appendChild(lbl);
    const cnt = document.createElement('span');
    cnt.className = 'count';
    cnt.textContent = `(${count})`;
    header.appendChild(cnt);

    header.addEventListener('click', (e) => {
      if (e.target === cb) return;
      if (state.expandedGroups.has(key)) state.expandedGroups.delete(key);
      else state.expandedGroups.add(key);
      savePersisted();
      renderTree();
    });
    // Right-click a folder (group) to deploy/retrieve/diff everything under it.
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, treeMenuSections(itemKeys, `${label} (${itemKeys.length})`));
    });
    group.appendChild(header);
    const body = document.createElement('div');
    group.appendChild(body);
    return { group, body };
  }

  // A selectable leaf row for a single metadata item, indented to `depth`.
  function makeLeafRow(item, displayName, depth) {
    const key = `${item.type}:${item.name}`;
    const isOrgOnly = item._source === 'org';
    const row = document.createElement('div');
    const isActive = key === state.activeFileKey;
    row.className = 'row' + (isActive ? ' focused active-editor' : '') + (isOrgOnly ? ' org-only' : '');
    row.dataset.key = key;
    row.style.paddingLeft = INDENT(depth);
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
    name.textContent = displayName;
    name.title = item.filePath || (isOrgOnly ? 'On org — not retrieved locally' : '');
    row.appendChild(name);
    // Source badge (shown once org metadata has been loaded)
    if (state.orgLoaded && item._source) {
      const srcBadge = document.createElement('span');
      srcBadge.className = `source-badge ${item._source}`;
      const labels = { both: 'local+org', local: 'local', org: 'org' };
      const tips = {
        both: 'Exists locally and on org',
        local: 'Local only — not found on org',
        org: 'On org — not retrieved locally yet'
      };
      srcBadge.textContent = labels[item._source] || item._source;
      srcBadge.title = tips[item._source] || '';
      row.appendChild(srcBadge);
    }
    if (!isOrgOnly && item.files && item.files.length > 1) {
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
    // Right-click a single component to deploy/retrieve/diff it directly.
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, treeMenuSections([key], displayName));
    });
    // Double-click opens the source file (the two single-click checkbox toggles
    // cancel out, so the selection is left as it was).
    row.addEventListener('dblclick', () => send('openFile', { key }));
    return row;
  }

  function keysUnderObject(o) {
    const keys = [];
    if (o.obj) keys.push(`${o.obj.type}:${o.obj.name}`);
    for (const arr of o.children.values()) for (const it of arr) keys.push(`${it.type}:${it.name}`);
    return keys;
  }

  // View-mode tabs: highlight the active lens and show live counts on the other two.
  function renderViewModes() {
    const labels = { all: 'All', selected: 'Selected', changed: 'Changed' };
    document.querySelectorAll('#viewModes button').forEach((btn) => {
      const m = btn.dataset.mode;
      btn.classList.toggle('active', state.viewMode === m);
      const count = m === 'selected' ? state.selected.size
        : (m === 'changed' && state.changedKeys ? state.changedKeys.size : null);
      btn.textContent = count === null || count === 0 ? labels[m] : `${labels[m]} (${count})`;
    });
  }

  // Explains an empty tree honestly for the active lens + filter combination.
  function emptyTreeText(filter) {
    if (state.viewMode === 'selected') {
      const lensEmpty = state.selected.size === 0 && (!state.selectedLensKeys || state.selectedLensKeys.size === 0);
      return lensEmpty
        ? 'Nothing selected — switch to All and tick components.'
        : 'No selected component matches the current filter.';
    }
    if (state.viewMode === 'changed') {
      // null + no reason = the provider simply hasn't answered yet (e.g. webview
      // restored straight into this lens) — don't flash a false "unavailable".
      if (state.changedKeys === null) return state.changedReason || 'Detecting changes…';
      return filter && state.changedKeys.size > 0
        ? 'No changed component matches the current filter.'
        : 'No uncommitted git changes in workspace metadata.';
    }
    return 'No metadata matches the current filter.';
  }

  function renderTree() {
    closeContextMenu();
    renderViewModes();
    const tree = $('tree');
    tree.innerHTML = '';
    const hasLocal = state.items.length > 0;
    const hasOrg = state.orgLoaded && state.orgOnlyItems.length > 0;
    if (!hasLocal && !hasOrg) {
      const d = document.createElement('div');
      d.className = 'status-empty';
      d.textContent = state.orgLoaded
        ? 'No metadata found in workspace or on org.'
        : 'No metadata found in workspace. Open a Salesforce project or click "Fetch Org" to browse org metadata.';
      tree.appendChild(d);
      return;
    }
    const filter = state.filter;
    // The Selected/Changed lenses show small curated lists — auto-expand their
    // groups like an active text filter does (NODE_CAP still bounds the render).
    const forceExpand = state.viewMode !== 'all';
    const { objectMap, flatGroups } = buildGroups();
    // Slim header for the Selected lens: the count and the one action the old
    // chip tray provided that checkboxes don't cover in one click.
    if (state.viewMode === 'selected' && (state.selected.size > 0 || (state.selectedLensKeys && state.selectedLensKeys.size > 0))) {
      const head = document.createElement('div');
      head.className = 'mode-head';
      const lbl = document.createElement('span');
      // Live count — can differ from the visible rows (snapshot semantics: rows
      // unchecked in this visit stay listed until the lens is re-entered).
      lbl.textContent = `${state.selected.size} selected`;
      head.appendChild(lbl);
      const clear = document.createElement('button');
      clear.textContent = 'Clear all';
      clear.title = 'Deselect everything';
      clear.addEventListener('click', () => { state.selected.clear(); state.selectedLensKeys = null; renderTree(); renderActions(); });
      head.appendChild(clear);
      tree.appendChild(head);
    }
    if (objectMap.size === 0 && flatGroups.size === 0) {
      const d = document.createElement('div');
      d.className = 'status-empty';
      d.textContent = emptyTreeText(filter);
      tree.appendChild(d);
      return;
    }

    // Cap the number of DOM nodes built in a single render. On a large org the merged
    // tree can be tens of thousands of components; force-expanding (via filter) and
    // building a node per row would freeze the webview. We stop at NODE_CAP and show a
    // "narrow your filter" notice instead — the data is all still there, just not all
    // painted at once.
    const NODE_CAP = 1000;
    let nodes = 0;
    let truncated = false;
    const budgetLeft = () => nodes < NODE_CAP;

    // ---- Objects super-group: object → child-type sub-groups → rows ----
    if (objectMap.size > 0) {
      const objectNames = Array.from(objectMap.keys()).sort();
      const allKeys = objectNames.flatMap(n => keysUnderObject(objectMap.get(n)));
      const objectsExpanded = state.expandedGroups.has('__OBJECTS__') || !!filter || forceExpand;
      const objectsNode = makeGroupNode({ key: '__OBJECTS__', label: 'Objects', count: objectNames.length, itemKeys: allKeys, expanded: objectsExpanded, depth: 0 });
      tree.appendChild(objectsNode.group); nodes++;
      if (objectsExpanded) {
        for (const name of objectNames) {
          if (!budgetLeft()) { truncated = true; break; }
          const o = objectMap.get(name);
          const objKeys = keysUnderObject(o);
          const objExpanded = state.expandedGroups.has('obj/' + name) || !!filter || forceExpand;
          const objNode = makeGroupNode({ key: 'obj/' + name, label: name, count: objKeys.length, itemKeys: objKeys, expanded: objExpanded, depth: 1 });
          objectsNode.body.appendChild(objNode.group); nodes++;
          if (!objExpanded) continue;
          // The object's own definition (CustomObject) — diff is unsupported, but it
          // can still be deployed/retrieved, so surface it as a selectable row.
          if (o.obj) {
            if (!budgetLeft()) { truncated = true; break; }
            objNode.body.appendChild(makeLeafRow(o.obj, '⊙ object definition', 2)); nodes++;
          }
          for (const ct of Array.from(o.children.keys()).sort()) {
            if (!budgetLeft()) { truncated = true; break; }
            const arr = o.children.get(ct).slice().sort((a, b) => a.name.localeCompare(b.name));
            const ctKeys = arr.map(it => `${it.type}:${it.name}`);
            const ctExpanded = state.expandedGroups.has('objc/' + name + '/' + ct) || !!filter || forceExpand;
            const ctNode = makeGroupNode({ key: 'objc/' + name + '/' + ct, label: childLabel(ct), count: arr.length, itemKeys: ctKeys, expanded: ctExpanded, depth: 2 });
            objNode.body.appendChild(ctNode.group); nodes++;
            if (!ctExpanded) continue;
            for (const it of arr) {
              if (!budgetLeft()) { truncated = true; break; }
              ctNode.body.appendChild(makeLeafRow(it, it.name.slice(name.length + 1), 3)); nodes++;
            }
          }
        }
      }
    }

    // ---- Flat groups for everything that isn't an object or object child ----
    for (const type of Array.from(flatGroups.keys()).sort()) {
      if (!budgetLeft()) { truncated = true; break; }
      const arr = flatGroups.get(type).slice().sort((a, b) => a.name.localeCompare(b.name));
      const keys = arr.map(it => `${it.type}:${it.name}`);
      const expanded = state.expandedGroups.has(type) || !!filter || forceExpand;
      const node = makeGroupNode({ key: type, label: type, count: arr.length, itemKeys: keys, expanded, depth: 0 });
      tree.appendChild(node.group); nodes++;
      if (expanded) for (const it of arr) {
        if (!budgetLeft()) { truncated = true; break; }
        node.body.appendChild(makeLeafRow(it, it.name, 1)); nodes++;
      }
    }

    if (truncated) {
      const d = document.createElement('div');
      d.className = 'status-empty';
      d.textContent = `Showing the first ${NODE_CAP} rows. Narrow with the filter box, type filter, or source filter to see the rest.`;
      tree.appendChild(d);
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
    const hasOrg = !!state.selectedOrg && !state.busy;
    const anySelected = state.selected.size > 0 && hasOrg;
    // Deploy and Diff require at least one locally-present file.
    const hasLocalSelected = anySelected && Array.from(state.selected).some(k => state.localKeys.has(k));
    const allOrgOnly = anySelected && Array.from(state.selected).every(k => !state.localKeys.has(k));
    const deployBtn = $('deployBtn');
    const validateBtn = $('validateBtn');
    const retrieveBtn = $('retrieveBtn');
    const diffBtn = $('diffBtn');
    const cancelBtn = $('cancelBtn');
    const testLevel = $('testLevel');
    const useActive = $('useActive');
    const clearSel = $('clearSel');
    if (state.busy) {
      deployBtn.style.display = 'none';
      if (validateBtn) validateBtn.style.display = 'none';
      retrieveBtn.style.display = 'none';
      diffBtn.style.display = 'none';
      if (testLevel) testLevel.style.display = 'none';
      useActive.style.display = 'none';
      clearSel.style.display = 'none';
      cancelBtn.style.display = '';
      cancelBtn.textContent = state.busyAction ? `Cancel ${state.busyAction}` : 'Cancel';
    } else {
      deployBtn.style.display = '';
      if (validateBtn) validateBtn.style.display = '';
      retrieveBtn.style.display = '';
      diffBtn.style.display = '';
      if (testLevel) { testLevel.style.display = ''; testLevel.disabled = !hasLocalSelected; }
      useActive.style.display = '';
      clearSel.style.display = state.selected.size > 0 ? '' : 'none';
      cancelBtn.style.display = 'none';
      deployBtn.disabled = !hasLocalSelected;
      if (validateBtn) {
        validateBtn.disabled = !hasLocalSelected;
        validateBtn.title = allOrgOnly ? 'Org-only items have no local source — retrieve them first.' : 'Check-only deploy: validate + run tests without deploying. A successful validation can be quick-deployed.';
      }
      retrieveBtn.disabled = !anySelected;
      diffBtn.disabled = !hasLocalSelected;
      deployBtn.title = allOrgOnly ? 'Org-only items have no local source — retrieve them first.' : '';
      diffBtn.title = allOrgOnly ? 'Org-only items have no local file to diff against — retrieve them first.' : '';
    }
    // Lock org switching and fetch/refresh while an operation runs, so an in-flight
    // Fetch Org can't be raced by an org change or a second fetch. Tooltip says WHY
    // the button is dead — a silently-disabled Rescan reads as a broken button.
    const lockTip = state.busy ? `Locked while ${state.busyAction || 'an operation'} is running — cancel it or wait` : '';
    const orgSelect = $('orgSelect');
    if (orgSelect) { orgSelect.disabled = state.busy || state.orgs.length === 0; orgSelect.title = lockTip; }
    $('fetchOrgBtn').disabled = state.busy;
    $('fetchOrgBtn').title = lockTip;
    $('refreshOrgs').disabled = state.busy;
    $('refreshOrgs').title = lockTip;
    $('refreshFiles').disabled = state.busy;
    $('refreshFiles').title = lockTip || 'Rescan workspace files (also retries folders whose type resolution failed)';
  }

  // ---- Progress (busy) card ----
  let progressTimer = null;
  function startProgressTimer() {
    stopProgressTimer();
    progressTimer = setInterval(() => {
      const el = document.getElementById('progressElapsed');
      if (el && state.progress) el.textContent = fmtElapsed(Date.now() - state.progress.startedAt);
    }, 1000);
  }
  function stopProgressTimer() {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  }
  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  }
  function fmtDur(ms) {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  }

  const CARD_ICONS = { ok: '✓', err: '✕', warn: '⚠' };
  const MAX_CARD_LINES = 8;

  // Card timestamp: time-only for today, date + time for older history entries.
  function fmtCardTime(at) {
    const d = new Date(at);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return d.toDateString() === new Date().toDateString()
      ? hm
      : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
  }

  function renderStatus() {
    const st = $('status');
    st.innerHTML = '';
    const csBtn = $('clearStatus'); if (csBtn) csBtn.style.display = state.statusCards.length ? '' : 'none';
    if (state.progress) {
      const el = document.createElement('div');
      el.className = 'status-card progress';
      const t = document.createElement('div');
      t.className = 'title';
      const sp = document.createElement('span');
      sp.className = 'spinner';
      t.appendChild(sp);
      const txt = document.createElement('span');
      txt.textContent = state.progress.text;
      t.appendChild(txt);
      el.appendChild(t);
      const m = document.createElement('div');
      m.className = 'meta';
      m.append('elapsed ');
      const es = document.createElement('span');
      es.id = 'progressElapsed';
      es.textContent = fmtElapsed(Date.now() - state.progress.startedAt);
      m.appendChild(es);
      el.appendChild(m);
      st.appendChild(el);
    }
    if (state.statusCards.length === 0 && !state.progress) {
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
      const ic = document.createElement('span');
      ic.className = `card-icon ${card.kind || 'ok'}`;
      ic.textContent = CARD_ICONS[card.kind] || CARD_ICONS.ok;
      t.appendChild(ic);
      const ttxt = document.createElement('span');
      ttxt.textContent = card.title || '';
      t.appendChild(ttxt);
      if (card.at) {
        const time = document.createElement('span');
        time.className = 'card-time';
        time.textContent = fmtCardTime(card.at);
        time.title = new Date(card.at).toLocaleString();
        t.appendChild(time);
      }
      el.appendChild(t);
      if (card.meta) {
        const m = document.createElement('div');
        m.className = 'meta';
        m.textContent = card.meta;
        el.appendChild(m);
      }
      if (card.lines && card.lines.length) {
        const ul = document.createElement('ul');
        const visible = card.expanded ? card.lines : card.lines.slice(0, MAX_CARD_LINES);
        for (const line of visible) {
          const li = document.createElement('li');
          li.textContent = line;
          ul.appendChild(li);
        }
        el.appendChild(ul);
        if (card.lines.length > MAX_CARD_LINES && !card.expanded) {
          const btn = document.createElement('button');
          btn.className = 'show-more';
          btn.textContent = `Show all ${card.lines.length} lines`;
          btn.addEventListener('click', () => { card.expanded = true; renderStatus(); });
          el.appendChild(btn);
        }
      }
      if (card.errText) {
        const e = document.createElement('div');
        e.className = 'err-text';
        e.textContent = card.errText;
        el.appendChild(e);
      }
      if (card.actions && card.actions.length) {
        const tl = document.createElement('div');
        tl.className = 'try-label';
        tl.textContent = 'Try:';
        el.appendChild(tl);
        const aul = document.createElement('ul');
        for (const a of card.actions) {
          const li = document.createElement('li');
          li.textContent = a;
          aul.appendChild(li);
        }
        el.appendChild(aul);
      }
      if (card.hint) {
        const h = document.createElement('div');
        h.className = 'hint';
        h.textContent = `Hint: ${card.hint}`;
        el.appendChild(h);
      }
      // The card is the durable error record (failures also raise a native VS Code
      // notification) — give it the Copy affordance the old footer used to carry.
      if (card.kind === 'err') {
        const cp = document.createElement('button');
        cp.className = 'card-copy';
        cp.textContent = 'Copy';
        cp.title = 'Copy the full error to the clipboard';
        cp.addEventListener('click', () => {
          const parts = [card.title, card.meta, (card.lines || []).join('\n'), card.errText];
          if (card.actions && card.actions.length) parts.push('Try:\n' + card.actions.map(a => '• ' + a).join('\n'));
          if (card.hint) parts.push('Hint: ' + card.hint);
          send('copyText', { text: parts.filter(Boolean).join('\n\n') });
        });
        el.appendChild(cp);
      }
      // Quick Deploy affordance on a successful validate-only card: deploy the
      // already-validated components without re-running validation or tests.
      if (card.quickDeploy && card.quickDeploy.jobId && !card.quickDeployDone) {
        const qd = document.createElement('button');
        qd.className = 'primary quick-deploy';
        qd.textContent = card.quickDeploy.label || 'Quick Deploy validated components';
        qd.disabled = state.busy;
        qd.title = 'Deploy the validated components — skips validation and the test run.';
        qd.addEventListener('click', () => {
          if (state.busy) return;
          card.quickDeployDone = true;   // one-shot: a validation can be quick-deployed once
          renderStatus();
          send('quickDeploy', { jobId: card.quickDeploy.jobId });
        });
        el.appendChild(qd);
      }
      st.appendChild(el);
    }
  }

  function renderCmdLog() {
    const root = $('cmdlog');
    if (state.cmdLogCollapsed) root.classList.add('collapsed');
    else root.classList.remove('collapsed');
    $('cmdlogCaret').textContent = state.cmdLogCollapsed ? '▸' : '▼';
    const ccBtn = $('clearCmdLog'); if (ccBtn) ccBtn.style.display = state.cmdLog.length ? '' : 'none';
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
      dur.textContent = e.durationMs != null ? fmtDur(e.durationMs) : (e.status === 'run' ? '…' : '');
      row.appendChild(dur);
      body.appendChild(row);
    }
  }

  // ---- Resizable tree/status split ----
  function setupSplitter() {
    const body = document.querySelector('.body');
    const splitter = $('splitter');
    const left = document.querySelector('.left');
    const right = document.querySelector('.right');
    if (!body || !splitter || !left || !right) return;
    // Tree and Status are always stacked (two rows), so the sash is horizontal and
    // the persisted ratio is measured top-to-bottom.
    let dragging = false;

    function applyRatio() {
      const r = state.statusRatio;
      if (r == null) { left.style.flex = ''; right.style.flex = ''; return; }
      const rr = Math.max(0.15, Math.min(0.85, r));
      left.style.flex = String(1 - rr);
      right.style.flex = String(rr);
    }
    applyRatio();

    function onMove(e) {
      if (!dragging) return;
      const rect = body.getBoundingClientRect();
      const frac = 1 - (e.clientY - rect.top) / rect.height;
      state.statusRatio = Math.max(0.15, Math.min(0.85, frac));
      applyRatio();
    }
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      try { splitter.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      document.body.classList.remove('resizing');
      savePersisted();
    }
    splitter.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { splitter.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      document.body.classList.add('resizing');
      e.preventDefault();
    });
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', endDrag);
    splitter.addEventListener('pointercancel', endDrag);
    // Double-click restores the default proportions.
    splitter.addEventListener('dblclick', () => {
      state.statusRatio = null;
      applyRatio();
      savePersisted();
    });
  }

  // ---- Right-click context menu (deploy / retrieve / diff a folder or component) ----
  let ctxMenuEl = null;
  function onCtxOutside(e) { if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeContextMenu(); }
  function onCtxKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeContextMenu(); } }
  function closeContextMenu() {
    if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
    document.removeEventListener('mousedown', onCtxOutside, true);
    document.removeEventListener('keydown', onCtxKey, true);
    window.removeEventListener('blur', closeContextMenu);
    window.removeEventListener('resize', closeContextMenu);
  }

  function showContextMenu(x, y, sections) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    sections.forEach((sec, si) => {
      if (sec.head) {
        const h = document.createElement('div');
        h.className = 'ctx-head';
        h.textContent = sec.head;
        h.title = sec.head;
        menu.appendChild(h);
      }
      for (const it of sec.items) {
        const el = document.createElement('div');
        el.className = 'ctx-item' + (it.disabled ? ' disabled' : '');
        el.textContent = it.label;
        if (it.title) el.title = it.title;
        if (!it.disabled) el.addEventListener('click', () => { closeContextMenu(); it.run(); });
        menu.appendChild(el);
      }
      if (sec.sep && si < sections.length - 1) {
        const s = document.createElement('div');
        s.className = 'ctx-sep';
        menu.appendChild(s);
      }
    });
    // Append off-screen so we can measure, then clamp into the viewport.
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(2, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(2, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
    menu.style.visibility = '';
    ctxMenuEl = menu;
    document.addEventListener('mousedown', onCtxOutside, true);
    document.addEventListener('keydown', onCtxKey, true);
    window.addEventListener('blur', closeContextMenu);
    window.addEventListener('resize', closeContextMenu);
  }

  function runKeys(kind, keys) {
    if (state.busy || !state.selectedOrg || !keys || !keys.length) return;
    if (kind === 'validate') return send('deploy', { keys, validateOnly: true });
    send(kind, { keys });
  }

  // Deploy/Retrieve/Diff menu items for a set of component keys. Deploy and Diff need a
  // local file, so they're disabled when every key is org-only (mirrors the toolbar
  // buttons); the provider would otherwise just skip those keys.
  function actionItems(keys) {
    const arr = Array.from(keys);
    const hasLocal = arr.some(k => state.localKeys.has(k));
    const base = !state.busy && !!state.selectedOrg && arr.length > 0;
    const orgTip = state.selectedOrg ? '' : 'Select an org first';
    const items = [
      { label: 'Deploy', disabled: !base || !hasLocal, title: orgTip || (!hasLocal ? 'Org-only — retrieve it first (no local source to deploy)' : ''), run: () => runKeys('deploy', arr) },
      { label: 'Validate', disabled: !base || !hasLocal, title: orgTip || (!hasLocal ? 'Org-only — nothing local to validate' : 'Check-only deploy: validates and runs tests without deploying'), run: () => runKeys('validate', arr) },
      { label: 'Retrieve', disabled: !base, title: orgTip, run: () => runKeys('retrieve', arr) },
      { label: 'Diff', disabled: !base || !hasLocal, title: orgTip || (!hasLocal ? 'Org-only — nothing local to diff' : ''), run: () => runKeys('diff', arr) },
    ];
    // Single component only — opening N browser tabs for a folder is never the intent.
    if (arr.length === 1) {
      items.push({
        label: 'Open in Org',
        disabled: !base || !hasLocal,
        title: orgTip || (!hasLocal
          ? 'Org-only — retrieve it first (the deep link is derived from the local file)'
          : 'Open this component\'s page in the org (browser). Types without a mapped Setup page open the org home.'),
        run: () => runKeys('openInOrg', arr)
      });
    }
    return items;
  }

  // Sections for a right-clicked tree target. The target (a folder's items, or one
  // component) is primary; the current checkbox selection is offered as a second section
  // when it differs — so "tick several, right-click, deploy" works too.
  function treeMenuSections(targetKeys, targetLabel) {
    const sections = [{ head: targetLabel, items: actionItems(targetKeys), sep: true }];
    const sel = Array.from(state.selected);
    const tset = new Set(targetKeys);
    const sameAsTarget = sel.length === tset.size && sel.every(k => tset.has(k));
    if (sel.length > 0 && !sameAsTarget) {
      sections.push({ head: `Selected (${sel.length})`, items: actionItems(sel) });
    } else {
      sections[0].sep = false;
    }
    return sections;
  }

})();
