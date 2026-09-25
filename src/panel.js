// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  // Run-card view logic (src/runView.js), loaded by its own script tag first.
  const RV = window.RunView;

  // Cap on status cards kept in the webview — mirrors the provider's
  // CARD_HISTORY_MAX (panelProvider.ts) so the live view and the persisted history
  // trim to the same length. Used by both the live 'status' unshift and the
  // 'statusHistory' replay below.
  const STATUS_HISTORY_MAX = 50;

  // Cap on the SELECTION copy written to webview state. One click on the Objects
  // group checkbox ticks every field of every object, and this object is
  // re-serialized on every subsequent toggle — an unbounded key list is the same
  // state weight the provider refuses for card buttons (HISTORY_BUTTON_KEYS_MAX,
  // panelProvider.ts). Past the cap the key list is OMITTED rather than trimmed:
  // restoring a silently smaller selection than the user ticked is worse than
  // restoring none, and the in-memory Set is untouched either way.
  const PERSISTED_SELECTION_MAX = 2000;

  // Type-filter sentinel. The persisted typeFilter is one of: empty (= every
  // type), this token ALONE (= no type), or plain type names — never the token
  // mixed with names (normalizeTypeFilter enforces that).
  const TYPE_NONE = '__none__';

  const persisted = vscode.getState() || {};
  const state = {
    orgs: [],
    orgsLoading: false, // ⟳ request in flight; only the provider's `orgsRefreshed` reply clears it
    filesLoading: false, // Rescan in flight; only the provider's `filesRefreshed` reply clears it
    // A slot-taking click has been sent and the provider's `busy` reply isn't
    // back yet (see sendAction). Every guarded button locks meanwhile — that
    // round trip is the only window in which a double-click's second click
    // could send a twin.
    pendingAction: null,
    selectedOrg: null,
    items: [], // {type, name, key (type:name), filePath, files[]}
    objectChildTypes: new Set(), // metadata types that nest under an object (CustomField, …)
    // Checkbox selection, persisted like the filter/lens state: it is the most
    // expensive thing in this panel to rebuild by hand, and a webview rebuild
    // (sidebar collapsed, window reloaded) used to silently throw it away. Keys
    // that no longer exist are pruned when the scan lands ('files' below), so a
    // component deleted between sessions can't linger in the selection.
    selected: new Set(Array.isArray(persisted.selected) ? persisted.selected : []), // keys
    expandedGroups: new Set(persisted.expandedGroups || []),
    filter: persisted.filter || '',
    typeFilter: new Set(persisted.typeFilter || []), // empty = all
    // Every type this webview has ever seen, local or org, persisted so a type
    // that first APPEARS later can be told from one merely restored (see
    // noteNewTypes). Append-only: a type missing from the ready scan but back
    // with the org fetch must not masquerade as new on every reload.
    seenTypes: new Set(persisted.seenTypes || []),
    // Whether the previous session recorded a baseline at all. Without one
    // (state written before seenTypes existed, or a fresh install) "new" is
    // undecidable, so this whole session only seeds — it never widens the filter.
    seenTypesBaseline: Array.isArray(persisted.seenTypes) && persisted.seenTypes.length > 0,
    busy: false,
    busyAction: null,
    // The running operation is being cancelled: the button reads "Cancelling…"
    // and ignores repeats. Set on click for instant feedback, then owned by the
    // provider's `busy` posts (`cancelling`), which say whether the click actually
    // consumed a cancel handler — see the click handler and the busy case.
    cancelRequested: false,
    progress: null, // { text, startedAt } while an operation runs
    activeFileKey: null,
    statusCards: [],
    // Deploy / validate / quick-deploy / retrieve runs, newest first, exactly as
    // the provider keeps them. With none, the Status pane is the card list above
    // it always was; with some, the newest run is drawn in full and everything
    // else — older runs and statusCards alike — is a one-liner.
    runs: [],
    runCap: 3,
    // The newest run's full row list, when the provider sent it; the run itself
    // may carry only a summary (failures and a few skipped rows).
    latestRows: null,
    // The running run's live counts (runProgress): five numbers, never rows.
    runProgress: null,
    // How the newest run's list is being looked at: chip filter, search, folds,
    // keyboard focus. In memory only, and reset when another run becomes newest.
    runUi: { runId: null, filter: 'all', q: '', folds: {}, openAll: undefined, focus: -1 },
    // Per run id: Quick Deploy used, the suggestion view's state, and whether an
    // older run is expanded in the Earlier block.
    runLocal: {},
    earlierOpen: false,
    cmdLog: [],
    // Collapsed unless the user opened it. A new key: the old `cmdLogCollapsed`
    // was written as false on every save, so it would keep the log open for
    // everyone who never touched it.
    cmdLogCollapsed: !persisted.cmdLogOpen,
    // Fraction of the body given to the Status pane (right/bottom). null = CSS default.
    statusRatio: typeof persisted.statusRatio === 'number' ? persisted.statusRatio : null,
    banner: '',
    // RunSpecifiedTests class list, mirrored here like `filter` so it survives a
    // webview rebuild via savePersisted/getState — the provider keeps its OWN copy
    // (this.runTests) for context-menu deploys, kept in sync via setTestLevel.
    testClasses: persisted.testClasses || '',
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
    // Has a non-silent `files` already been pruned against this session? The
    // FIRST one lands BEFORE org membership does (the provider's `ready` posts
    // `files`, then `orgMetadata`), so it cannot vouch for an org-only key — see
    // the prune in the `files` handler.
    scannedOnce: false,
    orgAsOf: null,           // ms — when the membership on screen was listed (snapshot stamp, or now)
    sourceFilter: 'all',     // 'all' | 'local' | 'local-only' | 'org-only' | 'both'
    // View mode: one tree, three lenses. 'selected' shows only checked items
    // (replaces the old chip tray), 'changed' only git-modified components.
    viewMode: ['all', 'selected', 'changed'].includes(persisted.viewMode) ? persisted.viewMode : 'all',
    changedKeys: null,       // Set of "Type:Name" with git changes; null = unknown/unavailable
    changedReason: '',       // why change detection is unavailable (when changedKeys is null)
    changedBase: '',         // git ref the Changed lens compares against ('' = uncommitted only)
    changedAuto: false,      // true when that comparison is this branch's own commits
    changedNote: '',         // why the automatic comparison gave up, when it did
    changedBranch: '',       // the branch the automatic comparison is showing, named in the header
    changedUncommitted: null,// Set of keys with uncommitted edits (the lens's first section)
    changedCommits: [],      // [{hash, short, subject, keys}] newest first — one section each
    expandedSections: new Set(['uncommitted']), // open Changed sections; in-memory, unlike expandedGroups
    // expandedGroups records what the user OPENED; under a lens or a filter every
    // group is open to begin with, so folding one has to be recorded as a
    // closure instead. In-memory and section-scoped (keys carry the section id),
    // so a type folded inside one commit stays open in the next.
    collapsedGroups: new Set(),
    // Signatures of the last APPLIED 'files' / 'changed' payloads (see
    // filesSignature / changedSignature). Every render replaces the tree's
    // innerHTML — scroll position and keyboard focus go with it — and the package
    // directories are now watched, so a payload identical to the one already on
    // screen arrives whenever anything at all is written under them. null = nothing
    // rendered yet, so the first payload of each kind always renders.
    filesSig: null,
    changedSig: null,
    // Snapshot of the selection taken on ENTERING the Selected lens (IntelliJ
    // commit-window semantics): unchecking a row flips its checkbox but keeps the
    // row visible — instant removal would break double-click (the re-render shifts
    // rows under the cursor mid-gesture) and make an accidental uncheck
    // unrecoverable without hunting the item down in All. Membership refreshes on
    // re-entering the lens. null = rebuild lazily from the live selection.
    selectedLensKeys: null,
    // Deploy-queue strip mirror (Feature: deploy queue) — purely a passive
    // display of the provider's `deployQueue`; every change arrives via a fresh
    // 'queue' message (also replayed on 'ready'), so this is never persisted
    // here either. Each item: { id, noun, orgLabel }.
    queue: [],
    // Machine-scoped provider setting. Never persisted in webview state: the
    // provider re-sends the authoritative value on ready and on Settings changes.
    ignoreDeployConflicts: false,
  };

  function savePersisted() {
    vscode.setState({
      expandedGroups: Array.from(state.expandedGroups),
      filter: state.filter,
      typeFilter: Array.from(state.typeFilter),
      seenTypes: Array.from(state.seenTypes),
      cmdLogOpen: !state.cmdLogCollapsed,
      statusRatio: state.statusRatio,
      scanBannerDismissed: state.scanBannerDismissed,
      viewMode: state.viewMode,
      testClasses: state.testClasses,
      ...(state.selected.size <= PERSISTED_SELECTION_MAX ? { selected: Array.from(state.selected) } : {})
    });
  }

  // Every selection change goes through here: persist first, then repaint the tree
  // (checkboxes, group tri-states) and the action bar (enabled-ness, count). Having
  // one funnel is what keeps the persisted copy from drifting out of sync with the
  // checkboxes on screen.
  function selectionChanged() {
    savePersisted();
    renderTree();
    renderActions();
  }

  const $ = (id) => document.getElementById(id);

  function send(type, payload) { vscode.postMessage({ type, ...(payload || {}) }); }

  // debugTiming (sfOrgDeployWrapper.debugTiming): host tells us on 'ready'/config
  // change (see the 'debugTiming' case below) whether to stamp and log. Off by
  // default — every sendAction still stamps clickedAt/clickSpan on the message
  // (cheap, and the host ignores them when its own copy of the setting is off),
  // but only logs to console when this is true.
  let debugTiming = false;

  // The funnel for every click that takes (or asks for) the operation slot —
  // toolbar, context menu and card buttons alike. The provider answers EVERY
  // message with a `busy` post once its handler is done (reserved, refused,
  // invalid, or thrown), and until that lands the clicked control stays locked:
  // without it the second click of a double-click sent a twin — a second modal,
  // a duplicate queue entry, or a misleading "already running" toast.
  // Deploy/Validate/Retry stay clickable while BUSY (they queue), never while
  // PENDING. Returns false when the previous click is still unanswered.
  //
  // debugTiming: stamped here (clickedAt/clickSpan) so a slow confirmation can be
  // measured end to end (see panelProvider.ts's [timing] log). `send()` — the
  // postMessage call — fires BEFORE renderActions()/renderStatus(): those are
  // pure DOM work with no bearing on whether the message went out, and used to
  // run first, on the critical path between the click and the host receiving it.
  // Deferring them (rAF, falling back to setTimeout(0) if unavailable) lets the
  // click handler return right after postMessage.
  const deferRender = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
  function sendAction(type, payload) {
    const t0 = performance.now();
    if (state.pendingAction) return false;
    state.pendingAction = type;
    const clickSpan = performance.now() - t0;
    const clickedAt = Date.now();
    send(type, { ...(payload || {}), clickedAt, clickSpan });
    if (debugTiming) console.log(`[timing] ${type}: clickedAt=${clickedAt} clickSpan=${clickSpan.toFixed(2)}ms`);
    deferRender(() => { renderActions(); renderStatus(); });
    return true;
  }

  // ---- Init ----
  window.addEventListener('message', (ev) => handleMessage(ev.data));
  // ⟳ locks itself until the provider's `orgsRefreshed` reply (sent when THIS
  // request finishes, success or failure — not on any `orgs` broadcast, which an
  // org switch mid-listing would trigger early), so repeat clicks can't stack
  // `sf org list` spawns, and the spin shows the click landed — a re-rendered
  // identical dropdown doesn't.
  $('refreshOrgs').addEventListener('click', () => {
    if (state.orgsLoading) return;
    state.orgsLoading = true;
    renderActions();
    send('refreshOrgs');
  });
  // Authenticate a new org (sf org login web) — busy-guarded like the other toolbar
  // buttons so it can't be fired into a running operation.
  $('addOrg').addEventListener('click', () => { if (!state.busy) sendAction('loginOrg'); });
  // Rescan locks like ⟳: freed only by the provider's `filesRefreshed` reply to
  // this request, so a double-click can't pay for two full scans.
  $('refreshFiles').addEventListener('click', () => {
    if (state.filesLoading) return;
    state.filesLoading = true;
    renderActions();
    send('refreshFiles');
  });
  $('fetchOrgBtn').addEventListener('click', () => { if (!state.busy) sendAction('fetchOrgMetadata', { username: state.selectedOrg }); });
  $('sourceFilter').addEventListener('change', (e) => { state.sourceFilter = e.target.value; renderTree(); });
  // Type filter All / None: a static row above the scrolling list (panelHtml.ts),
  // bound once like every other toolbar control.
  $('typeFilterAll').addEventListener('click', () => applyTypeFilter(new Set(knownTypes())));
  $('typeFilterNone').addEventListener('click', () => applyTypeFilter(new Set()));
  // Tree Expand all / Collapse all (static row above the tree, panelHtml.ts).
  $('expandAll').addEventListener('click', () => setAllGroups(true));
  $('collapseAll').addEventListener('click', () => setAllGroups(false));
  // Select all (All view): additive, like the Changed header's — every row the
  // filters leave, org-only included, the same keys ticking each group would.
  $('selectAllRows').addEventListener('click', () => {
    const { objectMap, flatGroups } = buildGroups();
    for (const k of keysInGroups(objectMap, flatGroups)) state.selected.add(k);
    selectionChanged();
  });
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
    sizeSearch(e.target);
    // Groups open for a new search — a fold made under the previous one would
    // otherwise hide this one's matches. Immediate, not in the debounced body:
    // the fold set has to be gone before anything renders, whatever renders it.
    if (v !== state.filter) state.collapsedGroups.clear();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filter = v; savePersisted(); renderTree(); }, 200);
  });
  $('search').value = state.filter;
  sizeSearch($('search'));
  if ($('testClasses')) $('testClasses').value = state.testClasses;
  syncTestClassesVisibility();
  // Mirror the chosen test level (+ RunSpecifiedTests classes) to the provider so
  // context-menu and editor right-click deploys honor it too (they don't read this DOM).
  $('testLevel').addEventListener('change', (e) => {
    syncTestClassesVisibility();
    send('setTestLevel', { testLevel: e.target.value || undefined, runTests: parseTestClasses() });
  });
  // Debounced like the search box: keeps the provider mirror current as the user
  // types without a round-trip per keystroke.
  let testClassesTimer = null;
  if ($('testClasses')) {
    $('testClasses').addEventListener('input', (e) => {
      const v = e.target.value;
      if (testClassesTimer) clearTimeout(testClassesTimer);
      testClassesTimer = setTimeout(() => {
        state.testClasses = v;
        savePersisted();
        send('setTestLevel', { testLevel: $('testLevel').value || undefined, runTests: parseTestClasses() });
      }, 200);
    });
  }
  $('ignoreDeployConflicts').addEventListener('change', (e) => {
    state.ignoreDeployConflicts = e.target.checked === true;
    renderIgnoreDeployConflicts();
    send('setIgnoreDeployConflicts', { enabled: state.ignoreDeployConflicts });
  });
  $('deployBtn').addEventListener('click', () => action('deploy'));
  $('validateBtn').addEventListener('click', () => action('validate'));
  $('retrieveBtn').addEventListener('click', () => action('retrieve'));
  $('diffBtn').addEventListener('click', () => action('diff'));
  // One Cancel per operation. sendAction's pending lock is the wrong shape here:
  // the provider answers the message in milliseconds while the cancel itself
  // takes seconds. The lock set here holds until a `busy` post says otherwise —
  // `cancelling: true` keeps it until the op ends; `false` (nothing to cancel,
  // e.g. a picker holding the slot) releases it at once.
  $('cancelBtn').addEventListener('click', () => {
    if (state.cancelRequested) return;
    state.cancelRequested = true;
    send('cancel');
    renderActions();
    // A running run's card says "Cancelling…" too — the provider's confirming
    // `busy` post changes nothing it would repaint for.
    if (state.runs.length && state.runs[0].status === 'running') renderStatus();
  });
  $('useActive').addEventListener('click', () => send('useActiveFile'));
  $('useOpenTabs').addEventListener('click', () => send('useOpenTabs'));
  $('clearSel').addEventListener('click', () => {
    state.selected.clear();
    state.selectedLensKeys = null; // the Selected lens empties too, not just checkboxes
    selectionChanged();
  });
  $('cmdlogHeader').addEventListener('click', () => {
    state.cmdLogCollapsed = !state.cmdLogCollapsed;
    savePersisted();
    renderCmdLog();
  });
  renderCmdLog(); // the markup's default must not win until the first command
  $('clearStatus').addEventListener('click', () => {
    state.statusCards = [];
    // A run still running stays: its result is on its way and lands on it.
    state.runs = state.runs.filter(r => r.status === 'running');
    if (!state.runs.length) state.latestRows = null;
    state.runLocal = {};
    send('clearStatusHistory'); // also drop the persisted history, or it resurrects on reload
    renderStatus();
  });
  // Earlier (k): older runs and notices, one line each, above the newest run.
  if ($('statusEarlier')) {
    $('statusEarlier').addEventListener('click', () => {
      state.earlierOpen = !state.earlierOpen;
      renderStatus();
    });
  }
  // The run list is virtual and the whole pane is its scroller: every scroll
  // repaints the rows in view (once per frame).
  $('status').addEventListener('scroll', () => { if (runList) scheduleRunPaint(); });
  $('clearCmdLog').addEventListener('click', (e) => {
    e.stopPropagation();   // don't also toggle the log's collapse
    state.cmdLog = [];
    renderCmdLog();
  });
  setupSplitter();
  // Close the right-click menu if the tree scrolls out from under it.
  $('tree').addEventListener('scroll', () => closeContextMenu());
  send('ready');

  // Show/hide the RunSpecifiedTests class-list input to match the current select
  // value — called on user change AND on the provider's 'testLevel' restore, so a
  // reload landing straight on RunSpecifiedTests doesn't hide the box it needs.
  function syncTestClassesVisibility() {
    const sel = $('testLevel');
    const box = $('testClasses');
    if (!sel || !box) return;
    box.style.display = sel.value === 'RunSpecifiedTests' ? '' : 'none';
  }

  // Comma-separated → trimmed, empties dropped. The provider does the actual
  // CLI-argv-safety check (regex); this is just splitting user input.
  function parseTestClasses() {
    const box = $('testClasses');
    if (!box) return [];
    return box.value.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // An empty RunSpecifiedTests class list would just fail the deploy on the org —
  // refuse locally instead, and make the problem obvious rather than a silent no-op.
  function flagTestClassesError() {
    const box = $('testClasses');
    if (!box) return;
    box.focus();
    box.title = 'Enter at least one Apex test class name (comma-separated) to run RunSpecifiedTests.';
    box.classList.add('input-error');
    setTimeout(() => box.classList.remove('input-error'), 2000);
  }

  function action(kind) {
    // Deploy/Validate stay usable while busy — the click still sends; the
    // provider queues it behind whatever's running instead of refusing (see
    // renderActions above and the provider's runDeploy). Retrieve/Diff still
    // need the slot free.
    const queueableWhileBusy = kind === 'deploy' || kind === 'validate';
    if (state.pendingAction || (state.busy && !queueableWhileBusy)) return;
    const keys = Array.from(state.selected);
    if (keys.length === 0) return;
    if (!state.selectedOrg) return;
    if (kind === 'retrieve') return sendAction('retrieve', { keys });
    if (kind === 'diff') return sendAction('diff', { keys });
    // deploy / validate: the chosen test level applies (empty → provider's default).
    const testLevel = ($('testLevel') && $('testLevel').value) || undefined;
    let runTests;
    if (testLevel === 'RunSpecifiedTests') {
      runTests = parseTestClasses();
      if (runTests.length === 0) { flagTestClassesError(); return; }
    }
    if (kind === 'deploy') return sendAction('deploy', { keys, testLevel, runTests });
    return sendAction('deploy', { keys, validateOnly: true, testLevel, runTests });
  }

  // ---- Message handling ----

  // Identity of an item list AS THE TREE RENDERS IT: the key, plus the two fields a
  // row actually shows — the file path (row tooltip) and how many files back the
  // component (the "N files" badge). Deliberately not a deep compare of whole
  // objects: this runs on every scan, and being wrong in the "not equal" direction
  // only costs the render that used to happen unconditionally anyway. JSON quoting
  // is what keeps two different lists from spelling the same signature.
  function filesSignature(items) {
    return JSON.stringify(items.map(i => [i.type, i.name, i.filePath || '', (i.files || []).length]));
  }

  // Identity of a 'changed' payload. Sorted, because the Changed lens is a SET —
  // two orderings of the same keys render the same rows, and git has no reason to
  // report them in a stable order. `null` keys (change detection unavailable) is a
  // state of its own, never an empty list.
  function changedSignature(msg) {
    const keys = msg.keys === null ? null : Array.from(msg.keys || []).sort();
    // The sections are part of what's drawn: the same key set split differently
    // (a commit made, an edit staged) has to repaint.
    const commits = (msg.commits || []).map(c => [c.hash, c.author || '', (c.keys || []).slice().sort()]);
    return JSON.stringify([keys, msg.reason || '', msg.base || '', !!msg.auto, msg.note || '', msg.branch || '',
      Array.from(msg.uncommitted || []).sort(), commits]);
  }

  // Drop selected keys that neither the local scan nor org membership vouches for.
  // Both callers have already established there is something to prune against.
  // Returns true when anything went.
  function pruneSelection() {
    const valid = new Set([...state.localKeys, ...state.orgKeys]);
    let pruned = false;
    for (const k of Array.from(state.selected)) if (!valid.has(k)) { state.selected.delete(k); pruned = true; }
    return pruned;
  }

  // Drop expandedGroups keys that no longer name a group. The set is persisted and
  // only ever grew (expandPathForKey adds without checking, "Collapse all" was the
  // one way out), so every deleted or renamed object stayed in webview state for
  // good. Same key grammar renderTree reads: '<type>' | '__OBJECTS__' |
  // 'obj/<object>' | 'objc/<object>/<childType>'.
  function pruneExpandedGroups() {
    const types = new Set();
    const objects = new Set();     // objects with a group of their own (definition or children)
    const objChildren = new Set(); // '<object>/<childType>'
    for (const item of [...state.items, ...state.orgOnlyItems]) {
      types.add(item.type);
      if (item.type === 'CustomObject') objects.add(item.name);
      else if (state.objectChildTypes.has(item.type)) {
        const obj = item.name.split('.')[0];
        objects.add(obj);
        objChildren.add(obj + '/' + item.type);
      }
    }
    for (const k of Array.from(state.expandedGroups)) {
      const exists = k === '__OBJECTS__' ? objects.size > 0
        : k.startsWith('obj/') ? objects.has(k.slice(4))
          : k.startsWith('objc/') ? objChildren.has(k.slice(5))
            : types.has(k);
      if (!exists) state.expandedGroups.delete(k);
    }
  }

  // Every prune a trusted scan owes (see the `files` handler): the selection, the
  // persisted expandedGroups set and the type filter, all against local ∪ org.
  // Returns true when the selection or the type filter changed — the two that
  // can change what renders.
  function pruneState() {
    let pruned = pruneSelection();
    pruneExpandedGroups();
    // Drop stale type-filter entries (allow org types too). The None sentinel is
    // not a type name: pruning it as one turned a deliberate "no types" into
    // "all types" on every webview rebuild.
    const types = knownTypes();
    for (const t of Array.from(state.typeFilter)) if (t !== TYPE_NONE && !types.includes(t)) { state.typeFilter.delete(t); pruned = true; }
    if (normalizeTypeFilter(types)) pruned = true;
    return pruned;
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'orgs':
        state.orgs = msg.orgs || [];
        state.selectedOrg = msg.selected || null;
        renderOrgs();
        renderActions();
        return;
      case 'orgsRefreshed':
        state.orgsLoading = false;
        renderActions();
        return;
      case 'filesRefreshed':
        state.filesLoading = false;
        renderActions();
        return;
      case 'files': {
        const sig = filesSignature(msg.items || []);
        const sameList = state.filesSig !== null && sig === state.filesSig;
        state.filesSig = sig;
        state.items = msg.items || [];
        state.objectChildTypes = new Set(msg.objectChildTypes || []);
        state.localKeys = new Set(state.items.map(i => `${i.type}:${i.name}`));
        // Recompute org-only items if org metadata is already loaded
        if (state.orgLoaded) {
          state.orgOnlyItems = Array.from(state.orgKeys)
            .filter(k => !state.localKeys.has(k))
            .map(k => { const c = k.indexOf(':'); return { type: k.slice(0, c), name: k.slice(c + 1) }; });
        }
        // Drop selections that no longer exist in either local or org. This is also
        // what vets a selection RESTORED from webview state: it is written back
        // pruned below, so a key deleted between sessions can't survive another reload.
        // Three scans may NOT do that:
        //   - one that found NOTHING. The provider posts `files` with an empty item
        //     list when project discovery fails (multi-root workspace,
        //     sfdx-project.json not synced yet) and org membership is empty on a
        //     fresh webview, so pruning against nothing would delete every restored
        //     key AND persist the deletion — destroying the selection exactly when
        //     the workspace hiccups, with no way back.
        //   - a SILENT one (`msg.silent`), i.e. the package-directory watcher's
        //     background rescan. Nobody asked for it, and it can catch the tree
        //     mid-write — a checkout, a branch switch, a bulk write — where a
        //     PARTIAL list is indistinguishable from a real deletion. Deleting a
        //     selection the user built by hand on that evidence, and persisting it,
        //     is unrecoverable; the next explicit Refresh Metadata Files prunes.
        //   - the FIRST one of a webview that has no org membership yet. A rebuild
        //     replays `files` BEFORE `orgMetadata`, so orgKeys is still empty here
        //     and every restored org-only key — the ones ticked from the Org lens
        //     to retrieve — would be dropped, and the drop persisted, seconds
        //     before membership arrives. `orgMetadata` runs the same prune once it
        //     does; every later scan prunes as it always did.
        // Keeping stale keys costs nothing: Deploy/Validate stay disabled until a
        // key is in localKeys, and every inbound key is re-resolved against the
        // provider's own scan anyway.
        let pruned = false;
        if (!msg.silent && (state.items.length > 0 || state.orgKeys.size > 0)) {
          // The same deferral covers the expandedGroups and type-filter prunes: an
          // expanded org-only object group, or a filter naming an org-only type,
          // would otherwise be dropped by a scan that has not seen the org yet.
          if (state.scannedOnce || state.orgLoaded) pruned = pruneState();
          // The filter's persisted SHAPE (normalizeTypeFilter) is repaired on every
          // scan, as it always was — only the judging of names waits.
          else if (normalizeTypeFilter(knownTypes())) pruned = true;
          state.scannedOnce = true;
          savePersisted(); // the prunes above are now the persisted truth too
        }
        // A type seen for the first time joins a plain-names filter so it shows
        // (noteNewTypes). It can't change an item list identical to the last one,
        // so the render skip below stays honest.
        noteNewTypes(knownTypes());
        // Nothing about the tree changed: the same components, the same rows, and no
        // prune took anything out of the selection or the type filter. Rendering
        // anyway would replace the tree's innerHTML — losing scroll position and
        // moving focus out of the tree — for an identical result. That used to be
        // rare (four explicit paths rebuilt the list); with the package directories
        // watched it happens on any write under them, which is most of a working day.
        if (sameList && !pruned) return;
        renderTypeFilter();
        renderTree();
        renderActions();
        // Error-card navigation depends on localKeys too. A rescan can add,
        // remove, or rename source files, so refresh existing cards immediately
        // instead of leaving a stale clickable row until the panel is reopened.
        renderStatus();
        return;
      }
      case 'orgMetadata':
        // Remember which org this membership came from — every message derived
        // from it (empty states, badge tooltips) names the org, so a delayed
        // arrival after another quick org switch is never ambiguous.
        state.orgMetaLabel = msg.orgLabel || null;
        // A persisted snapshot carries its listing time; a fresh fetch is "now".
        state.orgAsOf = typeof msg.asOf === 'number' ? msg.asOf : Date.now();
        state.localKeys = new Set(state.items.map(i => `${i.type}:${i.name}`));
        state.orgKeys = new Set((msg.orgItems || []).map(i => `${i.type}:${i.name}`));
        state.orgOnlyItems = (msg.orgItems || []).filter(i => !state.localKeys.has(`${i.type}:${i.name}`));
        state.orgLoaded = true;
        // The scan before this message could not prune an org-only key — nothing
        // vouched for one yet. Membership is in now, so the prune the `files`
        // handler skipped happens here, against local ∪ org. Gated on a scan that
        // FOUND something, like every other prune: membership alone is no proof a
        // local component is gone (project discovery may simply have failed).
        if (state.items.length > 0 && pruneState()) savePersisted();
        noteNewTypes(knownTypes());
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
        state.orgMetaLabel = null;
        state.orgAsOf = null;
        state.sourceFilter = 'all';
        if ($('sourceFilter')) $('sourceFilter').value = 'all';
        // Drop any selected org-only keys that no longer exist locally — but only
        // once a scan has established what "locally" means, for the same reason
        // the `files` handler above refuses to prune against an empty scan. This
        // is not hypothetical: a failed project discovery posts THIS message
        // first and the empty `files` second, so on a fresh webview localKeys is
        // still empty here and an unguarded prune would wipe the whole restored
        // selection before the guarded handler ever ran.
        if (state.items.length > 0) {
          for (const k of Array.from(state.selected)) if (!state.localKeys.has(k)) state.selected.delete(k);
          savePersisted();
        }
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
      case 'changed': {
        const sig = changedSignature(msg);
        const same = state.changedSig !== null && sig === state.changedSig;
        state.changedSig = sig;
        state.changedKeys = msg.keys === null ? null : new Set(msg.keys || []);
        state.changedReason = msg.reason || '';
        // Base ref (Feature 2): when the provider compares against a git ref it tags
        // the message with `base`; empty/absent = the default uncommitted-only lens.
        state.changedBase = msg.base || '';
        state.changedAuto = !!msg.auto;
        state.changedNote = msg.note || '';
        state.changedBranch = msg.branch || '';
        state.changedUncommitted = msg.keys === null ? null : new Set(msg.uncommitted || []);
        state.changedCommits = msg.keys === null ? [] : (msg.commits || []);
        // Every scan ends by recomputing this lens, so a background rescan would
        // rebuild the tree here even when the `files` handler above correctly
        // declined to — same scroll and focus loss, one message later. An identical
        // change set renders identical rows, so there is nothing to repaint.
        if (same) return;
        renderTree();
        return;
      }
      case 'selectKeys': {
        // Batch selection (e.g. "Use open tabs") — same reveal rules as the
        // single-key activeFile select: visible lens, expanded paths, scroll to first.
        const keys = msg.keys || [];
        if (!keys.length) return;
        // `transient` (a suggestion accept, before its own retry deploy settles):
        // reveal what was added WITHOUT joining the persisted selection — a plain
        // Deploy click right after must not silently pick these up, and the user
        // stays in whatever lens they were already looking at.
        if (msg.transient) {
          for (const k of keys) expandPathForKey(k);
          clearFiltersHiding(keys); // a reveal nobody can see reveals nothing
          renderTree();
          if (msg.scroll) scrollKeyIntoView(keys[0]);
          return;
        }
        // `replace` (a success card's "Select these N") means the selection BECOMES
        // that run instead of growing by it — the button names a count, and diffing
        // or retrieving "what just went up" is wrong against a union with whatever
        // was ticked for unrelated work. Everything else here stays additive.
        if (msg.replace) { state.selected.clear(); state.selectedLensKeys = null; }
        if (state.viewMode === 'changed') { state.viewMode = 'all'; savePersisted(); }
        for (const k of keys) {
          if (state.viewMode === 'selected' && state.selectedLensKeys) state.selectedLensKeys.add(k);
          expandPathForKey(k);
          state.selected.add(k);
        }
        clearFiltersHiding(keys);
        selectionChanged();
        if (msg.scroll) scrollKeyIntoView(keys[0]);
        return;
      }
      case 'testLevel':
        if ($('testLevel')) $('testLevel').value = msg.value || '';
        syncTestClassesVisibility();
        return;
      case 'ignoreDeployConflicts':
        state.ignoreDeployConflicts = msg.enabled === true;
        renderIgnoreDeployConflicts();
        return;
      case 'debugTiming':
        debugTiming = msg.enabled === true;
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
          clearFiltersHiding([msg.key]);
          selectionChanged();
          if (msg.scroll) scrollKeyIntoView(msg.key);
        } else {
          // passive highlight from onDidChangeActiveTextEditor
          renderTree();
        }
        return;
      case 'suggestionReset': {
        // The provider refused or the confirm modal was dismissed — nothing ran.
        // Un-fold the card so the suggestion stays actionable instead of lying
        // "Retrying…" forever.
        if (typeof msg.id !== 'string') return;
        for (const c of state.statusCards) {
          if (c.suggest && c.suggest.id === msg.id) {
            c.suggestDone = undefined;
            c.suggestOpen = false;
          }
        }
        const latest = state.runs[0];
        if (latest && latest.suggest && latest.suggest.id === msg.id) {
          const local = runLocalFor(latest.id);
          local.suggestDone = undefined;
          local.suggestOpen = false;
        }
        renderStatus();
        return;
      }
      case 'runs': {
        // The provider's run history, newest first. `latestRows` (the newest
        // run's full list) comes with a run's result and on a rebuild; any other
        // post keeps the list already here — but only while the same run is
        // still the newest one.
        const runs = (Array.isArray(msg.runs) ? msg.runs : []).filter(r => r && typeof r === 'object'
          && typeof r.id === 'string' && typeof r.op === 'string' && typeof r.status === 'string'
          && typeof r.orgLabel === 'string' && typeof r.startedAt === 'number');
        for (const r of runs) {
          if (!Array.isArray(r.rows)) r.rows = [];
          if (!Array.isArray(r.tests)) r.tests = [];
          if (!r.counts || typeof r.counts !== 'object') r.counts = {};
        }
        state.runs = runs;
        if (typeof msg.cap === 'number') state.runCap = msg.cap;
        const latest = runs[0];
        const lr = msg.latestRows;
        if (latest && lr && lr.runId === latest.id && Array.isArray(lr.rows)) {
          state.latestRows = { runId: lr.runId, rows: lr.rows, tests: Array.isArray(lr.tests) ? lr.tests : [] };
        } else if (!latest || !state.latestRows || state.latestRows.runId !== latest.id) {
          state.latestRows = null;
        }
        if (!latest || latest.status !== 'running' || !state.runProgress || state.runProgress.id !== latest.id) state.runProgress = null;
        const ids = new Set(runs.map(r => r.id));
        for (const id of Object.keys(state.runLocal)) if (!ids.has(id)) delete state.runLocal[id];
        renderStatus();
        return;
      }
      case 'runProgress': {
        // A poll tick of the running run: counts only, drawn in place.
        const latest = state.runs[0];
        if (!latest || latest.status !== 'running' || msg.id !== latest.id) return;
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
        state.runProgress = {
          id: msg.id, orgStatus: typeof msg.orgStatus === 'string' ? msg.orgStatus : '',
          compDone: num(msg.compDone), compTotal: num(msg.compTotal),
          testDone: num(msg.testDone), testTotal: num(msg.testTotal), errors: num(msg.errors)
        };
        if (runProg && runProg.parentNode) {
          const fresh = runProgressEl(latest);
          runProg.parentNode.insertBefore(fresh, runProg);
          runProg.remove();
          runProg = fresh;
        } else renderStatus();
        return;
      }
      case 'suggestionRestore': {
        // Sent on 'ready' for every suggestion still alive server-side: the
        // persisted history copy this card came back as dropped the live payload
        // (provider's stripSuggestForHistory) and carries only `suggestId` — merge
        // the payload back in so the "Try with dependencies" button reappears.
        if (typeof msg.id !== 'string') return;
        for (const c of state.statusCards) {
          if (c.suggestId === msg.id && !c.suggest) {
            c.suggest = { id: msg.id, candidates: msg.candidates || [], unresolved: msg.unresolved || [] };
          }
        }
        renderStatus();
        return;
      }
      case 'busy': {
        // Every `busy` post answers an outstanding click (sendAction): the
        // provider re-syncs after each handled message, so this is where the
        // pending lock clears. Only a real transition touches the progress card
        // and repaints — a mid-op re-sync must not wipe the live progress text,
        // restart the elapsed clock, or rebuild the Status pane under the user.
        const hadPending = !!state.pendingAction;
        state.pendingAction = null;
        const busy = !!msg.busy;
        const busyAction = msg.action || null;
        const changed = busy !== state.busy || busyAction !== state.busyAction;
        // The provider's word on the Cancel lock (see the cancelBtn click handler):
        // a re-sync that consumed no handler unlocks a click that hit nothing, the
        // notification's Cancel locks the panel's button too, and the op ending
        // (setBusy always posts cancelling:false) releases it.
        const cancelling = !!msg.cancelling;
        const lockChanged = cancelling !== state.cancelRequested;
        state.busy = busy;
        state.busyAction = busyAction;
        state.cancelRequested = cancelling;
        if (changed) {
          if (busy) {
            state.progress = { text: busyAction ? `${busyAction} running…` : 'Working…', startedAt: Date.now() };
            startProgressTimer();
          } else {
            state.progress = null;
            stopProgressTimer();
          }
        }
        if (changed || hadPending || lockChanged) {
          renderActions();
          renderStatus();
        }
        return;
      }
      case 'progress':
        if (state.progress && msg.text) {
          state.progress.text = msg.text;
          renderStatus();
        }
        return;
      case 'status':
        // msg.card = { kind: 'ok'|'err'|'warn', title, meta, lines[], errText, actions[], hint, at }
        state.statusCards.unshift(msg.card);
        if (state.statusCards.length > STATUS_HISTORY_MAX) state.statusCards.length = STATUS_HISTORY_MAX;
        renderStatus();
        return;
      case 'statusHistory':
        // Persisted card history replayed by the provider on ready (newest first) —
        // the Status pane doubles as the deployment history across window reloads.
        state.statusCards = (msg.cards || []).slice(0, STATUS_HISTORY_MAX);
        renderStatus();
        return;
      case 'cmd':
        // msg.entry = { id, timestamp, command, status: 'run'|'ok'|'err', durationMs? }
        // Merge (don't replace) so a completion update — which omits `command` —
        // keeps the command text from the initial 'run' entry.
        const existing = state.cmdLog.findIndex(e => e.id === msg.entry.id);
        if (existing >= 0) state.cmdLog[existing] = { ...state.cmdLog[existing], ...msg.entry };
        // An end entry with nothing to merge into (its id already fell off the
        // 50-cap) has no command text: a blank row, not worth a line.
        else if (msg.entry.command) state.cmdLog.unshift(msg.entry);
        if (state.cmdLog.length > 50) state.cmdLog.length = 50;
        renderCmdLog();
        return;
      case 'queue':
        // msg.items = [{ id, noun, orgLabel }] — the provider's deployQueue,
        // authoritative and re-sent on every change (incl. 'ready').
        state.queue = msg.items || [];
        renderQueue();
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
    row.style.display = state.orgLoaded ? 'flex' : 'none';
    // The snapshot's age sits where the badges are read — a day-old listing must
    // not pass for live.
    const note = $('orgAsOf');
    if (note) {
      note.textContent = state.orgLoaded && state.orgAsOf ? `org as of ${fmtAsOf(state.orgAsOf)}` : '';
      note.title = state.orgAsOf ? `${state.orgMetaLabel || 'Org'} metadata listed ${new Date(state.orgAsOf).toLocaleString()} — Fetch Org re-lists it` : '';
    }
  }

  function renderTypeFilter() {
    const row = $('typeFilterRow');
    const list = $('typeFilterList');
    const label = $('typeFilterLabel');
    const types = knownTypes();
    if (types.length === 0) { row.style.display = 'none'; return; }
    row.style.display = 'block';
    list.innerHTML = '';
    for (const t of types) {
      const tr = document.createElement('div');
      tr.className = 'type-row';
      const lbl = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      // empty typeFilter = all selected
      cb.checked = state.typeFilter.size === 0 || state.typeFilter.has(t);
      cb.addEventListener('change', () => {
        const next = allowedTypes(types);
        if (cb.checked) next.add(t); else next.delete(t);
        applyTypeFilter(next);
      });
      lbl.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = typeLabel(t);
      lbl.appendChild(span);
      tr.appendChild(lbl);
      // "only": one click narrows the tree to this type — with ~95 types the
      // alternative was unticking the other 94 by hand. Outside the <label> so
      // the click can't double as a checkbox toggle.
      const only = document.createElement('button');
      only.type = 'button';
      only.className = 'type-only';
      only.textContent = 'only';
      only.title = `Show only ${t}`;
      only.addEventListener('click', () => applyTypeFilter(new Set([t])));
      tr.appendChild(only);
      list.appendChild(tr);
    }
    // All / None live in the static row ABOVE the list (panelHtml.ts) so they
    // stay in view however long the list scrolls; here they only learn whether
    // they have anything left to do.
    $('typeFilterAll').disabled = state.typeFilter.size === 0;
    $('typeFilterNone').disabled = state.typeFilter.has(TYPE_NONE);
    label.textContent = state.typeFilter.size === 0
      ? `All types (${types.length})`
      : state.typeFilter.has(TYPE_NONE)
        ? `0 of ${types.length} types`
        : `${state.typeFilter.size} of ${types.length} types`;
  }

  // The types on screen right now (local ∪ org-only), sorted — what the filter
  // list shows and what the persisted contract is normalized against.
  function knownTypes() {
    return Array.from(new Set([...state.items.map(i => i.type), ...state.orgOnlyItems.map(i => i.type)])).sort();
  }
  // The types currently VISIBLE, expanded from the persisted contract (empty =
  // every known type) so a caller can add/remove one and hand it back.
  function allowedTypes(types) {
    return state.typeFilter.size === 0 ? new Set(types) : new Set(Array.from(state.typeFilter).filter(t => t !== TYPE_NONE));
  }
  // Rewrites state.typeFilter to the persisted contract for the given known
  // types: empty stays empty (all); every known type present → empty; no names →
  // the sentinel alone; otherwise plain names with the sentinel dropped. Returns
  // true when anything changed.
  function normalizeTypeFilter(types) {
    if (state.typeFilter.size === 0) return false;
    const names = Array.from(state.typeFilter).filter(t => t !== TYPE_NONE);
    let next;
    if (names.length === 0) next = new Set([TYPE_NONE]);
    else if (types.length > 0 && types.every(t => names.includes(t))) next = new Set();
    else next = new Set(names);
    const changed = next.size !== state.typeFilter.size || Array.from(next).some(t => !state.typeFilter.has(t));
    state.typeFilter = next;
    return changed;
  }
  // Single write funnel: `visible` is the set of types that should show; empty
  // means none. All / None / only / every checkbox land here, so the persisted
  // contract can't drift (the old per-button writes mixed the sentinel with
  // names and read two of three ticked types as "all").
  function applyTypeFilter(visible) {
    state.typeFilter = visible.size === 0 ? new Set([TYPE_NONE]) : new Set(visible);
    normalizeTypeFilter(knownTypes());
    savePersisted();
    renderTypeFilter();
    renderTree();
  }
  // New-type visibility. A persisted plain-names filter would otherwise hide any
  // type that first appears later — OmniUiCard once the org gains OmniStudio, a
  // new folder after a retrieve — with nothing to say so (its checkbox is simply
  // unticked in a list nobody reopens). A type never seen before joins the
  // filter, so it shows; None is an explicit choice and is kept. Without a
  // baseline from the previous session (seenTypesBaseline) new and restored are
  // indistinguishable, so this session only records what it sees.
  function noteNewTypes(types) {
    const fresh = Array.from(new Set(types)).filter(t => !state.seenTypes.has(t));
    if (fresh.length === 0) return;
    for (const t of fresh) state.seenTypes.add(t);
    if (state.seenTypesBaseline && state.typeFilter.size > 0 && !state.typeFilter.has(TYPE_NONE)) {
      for (const t of fresh) state.typeFilter.add(t);
      normalizeTypeFilter(knownTypes()); // the newcomer may complete the set (= All)
    }
    savePersisted();
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
    if (state.sourceFilter === 'local') return source !== 'org'; // everything in the project
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

  // User-facing names for API types nobody searches by: OmniStudio calls an
  // OmniUiCard a FlexCard and an OmniDataTransform a DataRaptor. Matched by the
  // search box and shown in parentheses on group headers and filter rows.
  const TYPE_ALIASES = {
    OmniUiCard: 'FlexCard',
    OmniScript: 'OmniScript',
    OmniIntegrationProcedure: 'Integration Procedure',
    OmniDataTransform: 'DataRaptor'
  };
  function typeAlias(type) { return TYPE_ALIASES[type] || ''; }
  // 'OmniUiCard (FlexCard)' — only where the alias adds a name the type lacks.
  function typeLabel(type) {
    const alias = typeAlias(type);
    return alias && alias !== type ? `${type} (${alias})` : type;
  }

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

  // Every group key the current lens + filters would draw — the same partition
  // renderTree paints, same key grammar (type | '__OBJECTS__' | 'obj/<o>' |
  // 'objc/<o>/<childType>') — so "Expand all" opens exactly what is on screen
  // and leaves hidden groups' state alone.
  function groupKeysInGroups(objectMap, flatGroups) {
    const keys = [];
    if (objectMap.size > 0) {
      keys.push('__OBJECTS__');
      for (const [name, o] of objectMap) {
        keys.push('obj/' + name);
        for (const ct of o.children.keys()) keys.push('objc/' + name + '/' + ct);
      }
    }
    for (const type of flatGroups.keys()) keys.push(type);
    return keys;
  }
  // Expand all = every visible group; Collapse all = EVERY key, visible or not
  // (a group hidden by today's lens would otherwise reopen by itself later).
  // Under a lens or a filter the render forces groups open, so there the two
  // buttons drive the in-memory closure set — the same buttons, the same
  // meaning, a different set.
  function setAllGroups(expand) {
    if (state.viewMode !== 'all' || state.filter) {
      // A filtered All view still writes the persisted set underneath, so the
      // buttons mean the same thing once the filter is cleared.
      const persists = state.viewMode === 'all';
      if (expand) {
        state.collapsedGroups.clear();
        for (const sec of changedSections() || []) state.expandedSections.add(sec.id);
        if (persists) {
          const { objectMap, flatGroups } = buildGroups();
          for (const k of groupKeysInGroups(objectMap, flatGroups)) state.expandedGroups.add(k);
          savePersisted();
        }
      } else {
        if (persists) { state.expandedGroups.clear(); savePersisted(); }
        const sections = changedSections();
        if (sections) {
          // Closing the sections IS collapsing everything here; their contents
          // stay as they were for when one is opened again.
          for (const sec of sections) state.expandedSections.delete(sec.id);
        } else {
          const { objectMap, flatGroups } = buildGroups();
          for (const k of groupKeysInGroups(objectMap, flatGroups)) state.collapsedGroups.add(state.viewMode + '/' + k);
        }
      }
      renderTree();
      return;
    }
    if (expand) {
      const { objectMap, flatGroups } = buildGroups();
      for (const k of groupKeysInGroups(objectMap, flatGroups)) state.expandedGroups.add(k);
    } else {
      state.expandedGroups.clear();
    }
    savePersisted();
    renderTree();
  }

  // ---- Search matching ----
  // A LIST of names is OR-ed: clauses are split on commas, semicolons or
  // newlines (a pasted error list). A clause naming a component (namesIn)
  // matches it by equality, so "Account, Contact" does not drag in
  // AccountService; a clause naming nothing falls back to the single-clause
  // grammar below, so a partial in the list still finds something.
  // A single clause = whitespace-separated tokens, ALL of which must match (AND, any order):
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

  // Lowercased names and Type:Name keys of everything the tree can show, built
  // once per items/org delivery (the arrays are replaced, never mutated in
  // place) — a Changed render calls buildGroups once per section.
  let namesCache = null;
  function knownNames() {
    const c = namesCache;
    if (c && c.items === state.items && c.org === state.orgOnlyItems && c.loaded === state.orgLoaded) return c.set;
    const set = new Set();
    const add = (it) => { set.add(it.name.toLowerCase()); set.add(`${it.type}:${it.name}`.toLowerCase()); };
    for (const it of state.items) add(it);
    if (state.orgLoaded) for (const it of state.orgOnlyItems) add(it);
    namesCache = { items: state.items, org: state.orgOnlyItems, loaded: state.orgLoaded, set };
    return set;
  }

  // A pasted line rarely holds a bare name: "- 'AccountService.cls'", a path,
  // "AccountService.cls-meta.xml", or a deploy-error row ("ApexClass
  // AccountService  Variable does not exist  12:5"). Whatever on the line is a
  // known component's name (or Type:Name key) is the match; bullets, quotes,
  // the directory, the -meta.xml tail and a file extension are peeled off.
  // The extension has to be plain letters/digits: "Account.Foo__c" is a field.
  function namesIn(text, known) {
    const out = [];
    for (const raw of text.split(/\s+/)) {
      let s = raw.replace(/^[-*•'"`(\[]+|[,;:'"`)\]]+$/g, '').replace(/-meta\.xml$/, '');
      s = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
      if (known.has(s)) { out.push(s); continue; }
      const stem = s.replace(/\.[a-z0-9]+$/, '');
      if (stem && known.has(stem)) out.push(stem);
    }
    return out;
  }

  // The predicate for a query — compiled once per render, not once per item.
  function compileFilter(query) {
    const clauses = (query || '').toLowerCase().split(/[,;\n]+/).map(c => c.trim()).filter(Boolean);
    if (clauses.length === 0) return () => true;
    const known = knownNames();
    const exact = new Set();
    const loose = [];
    for (const c of clauses) {
      // A type: qualifier keeps the single-clause grammar: a match on the bare
      // name would drop the scope the user just typed.
      const found = /(^|\s)(type|t):/.test(c) ? [] : namesIn(c, known);
      for (const n of found) exact.add(n);
      // A single line is also a search in that grammar, kept ALONGSIDE the
      // names it holds: "account case" still finds AccountCaseSync, and one
      // pasted error row finds its class. In a list, a line naming something
      // is exact and a line naming nothing searches.
      if (clauses.length === 1 || found.length === 0) loose.push(c);
    }
    return (item) => exact.has(item.name.toLowerCase()) || exact.has(`${item.type}:${item.name}`.toLowerCase())
      || loose.some(c => matchesClause(item, c));
  }

  // The box grows with a pasted list (up to a few rows, then scrolls) and
  // shrinks back when it is cleared.
  function sizeSearch(el) {
    el.rows = Math.min(6, Math.max(1, (el.value || '').split('\n').length));
  }

  function matchesClause(item, query) {
    if (!query) return true;
    let hay = null;
    let initials = null;
    for (const raw of query.split(/\s+/)) {
      if (!raw) continue;
      const typeTok = raw.startsWith('type:') ? raw.slice(5) : (raw.startsWith('t:') ? raw.slice(2) : null);
      if (typeTok !== null) {
        if (typeTok && !`${item.type} ${typeAlias(item.type)}`.toLowerCase().includes(typeTok)) return false;
        continue; // bare "type:" while still typing matches everything
      }
      if (hay === null) {
        hay = `${item.type} ${typeAlias(item.type)} ${item.name}`.toLowerCase();
        initials = nameInitials(item.name);
      }
      if (!hay.includes(raw) && !initials.includes(raw)) return false;
    }
    return true;
  }

  // A selection made FOR the user (Use active file, Use open tabs, a card's
  // "Select these N", a suggestion's retry) has to be visible: with a filter on,
  // the count changed and nothing else did, and Deploy later sent a component that
  // was never on screen. Any filter hiding one of the keys just ticked is reset —
  // the others are left alone, and a reveal nothing hides changes nothing.
  function clearFiltersHiding(keys) {
    // A folded group hides a row exactly like a filter does, and the fold set is
    // in-memory and cheap to rebuild, so a reveal simply drops every fold rather
    // than working out which one is in the way (a key can sit under several
    // sections at once).
    if (keys.some(k => state.localKeys.has(k) || state.orgKeys.has(k))) state.collapsedGroups.clear();
    let text = false, type = false, source = false;
    const matches = state.filter ? compileFilter(state.filter) : null;
    for (const k of keys) {
      // A key that renders nothing (a card naming a since-deleted component) is
      // no reason to touch the filters.
      if (!state.localKeys.has(k) && !state.orgKeys.has(k)) continue;
      const [t, name] = splitKey(k);
      // The Selected lens ignores the type and source filters (buildGroups), so
      // neither can hide a row there.
      if (state.viewMode !== 'selected') {
        if (!isTypeAllowed(t)) type = true;
        if (!isSourceAllowed(itemSource(k))) source = true;
      }
      if (matches && !matches({ type: t, name })) text = true;
    }
    if (!text && !type && !source) return;
    if (text) { state.filter = ''; if ($('search')) { $('search').value = ''; sizeSearch($('search')); } }
    if (type) state.typeFilter = new Set();
    if (source) { state.sourceFilter = 'all'; if ($('sourceFilter')) $('sourceFilter').value = 'all'; }
    savePersisted();
    if (type) renderTypeFilter();
  }

  // Partition the (filtered) merged item list into the object tree and the flat type groups.
  // `onlyKeys` (a Set) narrows the build to one Changed-view section; the lens's
  // own membership test still applies, so a section can never widen it. `merged`
  // is the merged item list, built ONCE per render and passed in: it allocates an
  // object per component, and a sectioned render calls this once per section —
  // on every checkbox tick, since selectionChanged re-renders.
  function buildGroups(onlyKeys, merged) {
    const filter = state.filter;
    const matches = compileFilter(filter);
    const objectMap = new Map(); // objectName -> { obj: item|null, children: Map<type, item[]> }
    const flatGroups = new Map(); // type -> item[]
    const getObj = (n) => {
      let o = objectMap.get(n);
      if (!o) { o = { obj: null, children: new Map() }; objectMap.set(n, o); }
      return o;
    };
    // The Selected lens lists what a Deploy would send, so the type and source
    // filters — tools for FINDING components in All — do not apply to it: with
    // them on, "N selected" stood above a list that couldn't account for it. The
    // text filter stays; it is the user's own search WITHIN the lens.
    const isSelectedLens = state.viewMode === 'selected';
    for (const item of merged || buildMergedItems()) {
      if (!isSelectedLens && !isTypeAllowed(item.type)) continue;
      if (!isSelectedLens && !isSourceAllowed(item._source)) continue;
      // View-mode lens first (cheap Set lookups), text filter within the lens.
      if (isSelectedLens) {
        // Lazy rebuild covers a webview restored straight into this lens.
        const lens = state.selectedLensKeys ?? (state.selectedLensKeys = new Set(state.selected));
        if (!lens.has(`${item.type}:${item.name}`)) continue;
      }
      if (state.viewMode === 'changed' && !(state.changedKeys && state.changedKeys.has(`${item.type}:${item.name}`))) continue;
      if (onlyKeys && !onlyKeys.has(`${item.type}:${item.name}`)) continue;
      if (!matches(item)) continue;
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
  function makeGroupNode({ key, label, count, itemKeys, expanded, depth, toggle, title }) {
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
      selectionChanged();
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

    if (title) header.title = title;
    header.addEventListener('click', (e) => {
      if (e.target === cb) return;
      if (toggle) { toggle(); renderTree(); return; }
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
      selectionChanged();
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
        both: `Exists locally and on ${state.orgMetaLabel || 'org'}`,
        local: `Local only — not found on ${state.orgMetaLabel || 'org'}`,
        org: `On ${state.orgMetaLabel || 'org'} — not retrieved locally yet`
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
      selectionChanged();
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

  // Every key the current lens + filters put in the tree, gated to components that
  // exist locally — an org-only row has no source to deploy, so a bulk select must
  // not tick it (same localKeys gate as the toolbar's Deploy button). Reads the
  // GROUP data rather than the DOM, so the render's NODE_CAP doesn't silently
  // shrink the set the button promises.
  function localKeysInGroups(objectMap, flatGroups) {
    return keysInGroups(objectMap, flatGroups).filter(k => state.localKeys.has(k));
  }

  function keysInGroups(objectMap, flatGroups) {
    const keys = [];
    for (const o of objectMap.values()) keys.push(...keysUnderObject(o));
    for (const arr of flatGroups.values()) for (const it of arr) keys.push(`${it.type}:${it.name}`);
    return keys;
  }

  // View-mode tabs: highlight the active lens and show live counts on the other two.
  function visibleKeyCount(keys) {
    let n = 0;
    for (const k of keys) if (isTypeAllowed(k.slice(0, k.indexOf(':')))) n++;
    return n;
  }

  function renderViewModes() {
    const labels = { all: 'All', selected: 'Selected', changed: 'Changed' };
    document.querySelectorAll('#viewModes button').forEach((btn) => {
      const m = btn.dataset.mode;
      btn.classList.toggle('active', state.viewMode === m);
      // Each count is what its lens would draw. Changed honours the type filter,
      // like its rows do — a key is `Type:Name` (split on the FIRST colon), so no
      // item lookup is needed — otherwise "Changed (3)" sat above a tree showing
      // one row. Selected ignores it, because the lens does (buildGroups).
      const count = m === 'selected' ? state.selected.size
        : (m === 'changed' && state.changedKeys ? visibleKeyCount(state.changedKeys) : null);
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
      // Any active filter — text, type or source — may be what hid the rows;
      // blaming git for that sends the user to the wrong place.
      if (state.changedKeys.size > 0 && (filter || state.typeFilter.size > 0 || state.sourceFilter !== 'all')) return 'No changed component matches the current filter.';
      // With a base ref the lens answers "what differs from <ref>"; without it, the
      // uncommitted-only default.
      return state.changedBase
        ? `No components differ from ${state.changedBase}.`
        : 'No uncommitted git changes in workspace metadata.';
    }
    return 'No metadata matches the current filter.';
  }

  // Expand all / Collapse all row above the tree (static markup, panelHtml.ts).
  // Hidden when there is nothing to expand; disabled — not hidden — while the
  // tree is force-expanded (Selected/Changed lens, or a search filter), with
  // the reason in the tooltip.
  function renderTreeTools(objectMap, flatGroups) {
    const tools = $('treeTools');
    if (!tools) return;
    tools.style.display = (objectMap.size > 0 || flatGroups.size > 0) ? 'flex' : 'none';
    const ex = $('expandAll');
    const co = $('collapseAll');
    // Groups start open under a lens or a filter, but they fold — so do these.
    ex.disabled = false;
    co.disabled = false;
    ex.title = 'Expand every group';
    co.title = state.viewMode === 'changed' && changedSections() ? 'Collapse every section' : 'Collapse every group';
    // All view only: Changed has its own in its header, Selected is the selection.
    const sa = $('selectAllRows');
    const n = state.viewMode === 'all' ? keysInGroups(objectMap, flatGroups).length : 0;
    sa.style.display = n ? '' : 'none';
    sa.textContent = `Select all (${n})`;
  }

  function renderTree() {
    closeContextMenu();
    renderViewModes();
    const tree = $('tree');
    tree.innerHTML = '';
    const hasLocal = state.items.length > 0;
    const hasOrg = state.orgLoaded && state.orgOnlyItems.length > 0;
    if (!hasLocal && !hasOrg) {
      renderTreeTools(new Map(), new Map());
      const d = document.createElement('div');
      d.className = 'status-empty';
      d.textContent = state.orgLoaded
        ? `No metadata found in workspace or on ${state.orgMetaLabel || 'the org'}.`
        : 'No metadata found in workspace. Open a Salesforce project or click "Fetch Org" to browse org metadata.';
      tree.appendChild(d);
      return;
    }
    const filter = state.filter;
    // The Selected/Changed lenses show small curated lists — auto-expand their
    // groups like an active text filter does (NODE_CAP still bounds the render).
    const merged = buildMergedItems();
    const { objectMap, flatGroups } = buildGroups(undefined, merged);
    renderTreeTools(objectMap, flatGroups);
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
      clear.addEventListener('click', () => { state.selected.clear(); state.selectedLensKeys = null; selectionChanged(); });
      head.appendChild(clear);
      tree.appendChild(head);
    }
    // Changed lens header — rendered whenever the lens is active, not only when a
    // base ref is configured: with the default (empty) changedBaseRef the lens used
    // to show no header at all, so its one bulk action had nowhere to live. The
    // label states which comparison is on screen, mirroring the empty-state text.
    if (state.viewMode === 'changed') {
      const head = document.createElement('div');
      head.className = 'mode-head';
      const lbl = document.createElement('button');
      // `changedNote` means the automatic comparison gave up (a trunk-only
      // checkout, or too long a branch): say what IS on screen rather than let
      // the label claim a comparison that isn't happening.
      // Name the branch when we know it: "This branch" told the user nothing
      // they couldn't already see, and nothing about WHICH branch.
      lbl.textContent = state.changedAuto && !state.changedNote ? (state.changedBranch || 'This branch')
        : state.changedBase ? `vs ${state.changedBase}` : 'Uncommitted only';
      lbl.title = state.changedNote
        ? `${state.changedNote}\nClick to change what this view compares against.`
        : state.changedAuto && state.changedBranch
          ? `Showing your work on ${state.changedBranch} — click to compare against something else`
          : 'What this view compares against — click to change';
      lbl.addEventListener('click', () => send('pickChangedBase'));
      head.appendChild(lbl);
      // Select all, mirroring the Selected lens's Clear all. Additive: it ticks the
      // rows this lens is showing (filters included) and touches nothing else.
      const selectable = localKeysInGroups(objectMap, flatGroups);
      if (selectable.length) {
        const selectAll = document.createElement('button');
        selectAll.textContent = `Select all (${selectable.length})`;
        selectAll.title = 'Select every changed component listed here';
        selectAll.addEventListener('click', () => {
          for (const k of selectable) state.selected.add(k);
          selectionChanged();
        });
        head.appendChild(selectAll);
      }
      if (state.selected.size > 0) {
        const clear = document.createElement('button');
        // Global count in the label: this clears the WHOLE selection (matching the
        // toolbar ✕ and the Selected lens's Clear all), while its neighbour
        // "Select all (N)" is lens-scoped — the differing counts disclose that.
        clear.textContent = `Clear selection (${state.selected.size})`;
        clear.title = 'Deselect everything';
        clear.addEventListener('click', () => { state.selected.clear(); state.selectedLensKeys = null; selectionChanged(); });
        head.appendChild(clear);
      }
      tree.appendChild(head);
    }
    if (objectMap.size === 0 && flatGroups.size === 0) {
      const d = document.createElement('div');
      d.className = 'status-empty';
      d.textContent = emptyTreeText(filter);
      tree.appendChild(d);
      return;
    }

    const budget = { nodes: 0, truncated: false };
    const sections = changedSections();
    if (sections) renderSections(tree, sections, budget, merged);
    else renderGroups(tree, objectMap, flatGroups, budget, 0, state.viewMode + '/');
    if (budget.truncated) {
      const d = document.createElement('div');
      d.className = 'status-empty';
      d.textContent = `Showing the first ${NODE_CAP} rows. Narrow with the filter box, type filter, or source filter to see the rest.`;
      tree.appendChild(d);
    }
  }

  // The Changed view's sections, newest work first: the uncommitted edits, then one
  // per commit that touched a component, then whatever the base diff reports that no
  // listed commit accounts for (a merge, or history past the commit cap). Null when
  // the lens isn't sectioned — another view, or nothing committed to show — and the
  // tree renders flat exactly as before.
  function changedSections() {
    if (state.viewMode !== 'changed' || !state.changedKeys) return null;
    if (!state.changedCommits.length) return null;
    const out = [];
    const accounted = new Set();
    const uncommitted = [];
    for (const k of state.changedUncommitted || []) { uncommitted.push(k); accounted.add(k); }
    if (uncommitted.length) out.push({ id: 'uncommitted', label: 'Uncommitted', keys: new Set(uncommitted) });
    for (const c of state.changedCommits) {
      const keys = (c.keys || []).filter(k => state.changedKeys.has(k));
      if (!keys.length) continue;
      for (const k of keys) accounted.add(k);
      // The author shows only when the provider says the commit isn't yours —
      // on a branch of your own every section would otherwise carry your name.
      out.push({
        id: 'c/' + c.hash,
        // "(by X)", not "— X": commit subjects use dashes themselves, and an
        // attribution that reads as part of the subject discloses nothing.
        label: c.author ? `${c.short} ${c.subject} (by ${c.author})` : `${c.short} ${c.subject}`,
        keys: new Set(keys)
      });
    }
    const rest = [];
    for (const k of state.changedKeys) if (!accounted.has(k)) rest.push(k);
    // Not "earlier commits": under an explicit ref this is simply everything the
    // comparison reports that no listed commit accounts for (a merge, or history
    // past the cap).
    if (rest.length) out.push({ id: 'earlier', label: 'Other changes', keys: new Set(rest) });
    return out.length ? out : null;
  }

  // Paint the Changed view's sections: a collapsible header per section over the
  // ordinary type/object groups, built from that section's keys alone.
  function renderSections(tree, sections, budget, merged) {
    let painted = 0;
    for (const sec of sections) {
      const { objectMap, flatGroups } = buildGroups(sec.keys, merged);
      if (objectMap.size === 0 && flatGroups.size === 0) continue; // filtered away
      const itemKeys = localKeysInGroups(objectMap, flatGroups);
      const expanded = state.expandedSections.has(sec.id);
      const node = makeGroupNode({
        key: 'sec/' + sec.id,
        label: sec.label,
        count: itemKeys.length,
        itemKeys,
        expanded,
        depth: 0,
        title: sec.label,
        toggle: () => {
          if (state.expandedSections.has(sec.id)) state.expandedSections.delete(sec.id);
          else state.expandedSections.add(sec.id);
        }
      });
      node.group.classList.add('section');
      tree.appendChild(node.group); budget.nodes++; painted++;
      if (expanded) renderGroups(node.body, objectMap, flatGroups, budget, 1, state.viewMode + '/' + sec.id + '/');
    }
    if (painted === 0) {
      const d = document.createElement('div');
      d.className = 'status-empty';
      d.textContent = emptyTreeText(state.filter);
      tree.appendChild(d);
    }
  }

  // Cap the number of DOM nodes built in a single render. On a large org the merged
  // tree can be tens of thousands of components; force-expanding (via filter) and
  // building a node per row would freeze the webview. We stop at NODE_CAP and show a
  // "narrow your filter" notice instead — the data is all still there, just not all
  // painted at once.
  const NODE_CAP = 1000;

  // Paint one group set into `container`. `budget` is shared across every call of a
  // single render, so the cap bounds the whole tree rather than each Changed-view
  // section; `depth` indents a section's contents under its header.
  function renderGroups(container, objectMap, flatGroups, budget, depth, prefix = '') {
    const filter = state.filter;
    const forced = state.viewMode !== 'all' || !!filter;
    const budgetLeft = () => budget.nodes < NODE_CAP;
    // Open unless folded when the render forces groups open; the persisted
    // "what did the user open" set otherwise.
    const isOpen = (key) => (forced ? !state.collapsedGroups.has(prefix + key) : state.expandedGroups.has(key));
    // Only forced groups need the in-memory closure; the rest toggle the
    // persisted set exactly as before (makeGroupNode's default).
    const fold = (key) => (forced ? () => {
      const k = prefix + key;
      if (state.collapsedGroups.has(k)) state.collapsedGroups.delete(k);
      else state.collapsedGroups.add(k);
    } : undefined);

    // ---- Objects super-group: object → child-type sub-groups → rows ----
    if (objectMap.size > 0) {
      const objectNames = Array.from(objectMap.keys()).sort();
      const allKeys = objectNames.flatMap(n => keysUnderObject(objectMap.get(n)));
      const objectsExpanded = isOpen('__OBJECTS__');
      const objectsNode = makeGroupNode({ key: '__OBJECTS__', label: 'Objects', count: objectNames.length, itemKeys: allKeys, expanded: objectsExpanded, depth: depth, toggle: fold('__OBJECTS__') });
      container.appendChild(objectsNode.group); budget.nodes++;
      if (objectsExpanded) {
        for (const name of objectNames) {
          if (!budgetLeft()) { budget.truncated = true; break; }
          const o = objectMap.get(name);
          const objKeys = keysUnderObject(o);
          const objExpanded = isOpen('obj/' + name);
          const objNode = makeGroupNode({ key: 'obj/' + name, label: name, count: objKeys.length, itemKeys: objKeys, expanded: objExpanded, depth: depth + 1, toggle: fold('obj/' + name) });
          objectsNode.body.appendChild(objNode.group); budget.nodes++;
          if (!objExpanded) continue;
          // The object's own definition (CustomObject) — diff is unsupported, but it
          // can still be deployed/retrieved, so surface it as a selectable row.
          if (o.obj) {
            if (!budgetLeft()) { budget.truncated = true; break; }
            objNode.body.appendChild(makeLeafRow(o.obj, '⊙ object definition', depth + 2)); budget.nodes++;
          }
          for (const ct of Array.from(o.children.keys()).sort()) {
            if (!budgetLeft()) { budget.truncated = true; break; }
            const arr = o.children.get(ct).slice().sort((a, b) => a.name.localeCompare(b.name));
            const ctKeys = arr.map(it => `${it.type}:${it.name}`);
            const ctExpanded = isOpen('objc/' + name + '/' + ct);
            const ctNode = makeGroupNode({ key: 'objc/' + name + '/' + ct, label: childLabel(ct), count: arr.length, itemKeys: ctKeys, expanded: ctExpanded, depth: depth + 2, toggle: fold('objc/' + name + '/' + ct) });
            objNode.body.appendChild(ctNode.group); budget.nodes++;
            if (!ctExpanded) continue;
            for (const it of arr) {
              if (!budgetLeft()) { budget.truncated = true; break; }
              ctNode.body.appendChild(makeLeafRow(it, it.name.slice(name.length + 1), depth + 3)); budget.nodes++;
            }
          }
        }
      }
    }

    // ---- Flat groups for everything that isn't an object or object child ----
    for (const type of Array.from(flatGroups.keys()).sort()) {
      if (!budgetLeft()) { budget.truncated = true; break; }
      const arr = flatGroups.get(type).slice().sort((a, b) => a.name.localeCompare(b.name));
      const keys = arr.map(it => `${it.type}:${it.name}`);
      const expanded = isOpen(type);
      const node = makeGroupNode({ key: type, label: typeLabel(type), count: arr.length, itemKeys: keys, expanded, depth: depth, toggle: fold(type) });
      container.appendChild(node.group); budget.nodes++;
      if (expanded) for (const it of arr) {
        if (!budgetLeft()) { budget.truncated = true; break; }
        node.body.appendChild(makeLeafRow(it, it.name, depth + 1)); budget.nodes++;
      }
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
    const hasOrg = !!state.selectedOrg;
    // Deploy/Validate stay usable while busy — a click still sends; the provider
    // queues it behind whatever's running instead of refusing (see action() /
    // runKeys() below, and the provider's runDeploy). Retrieve/Diff still need
    // the slot free, so THEIR enabled-ness keeps gating on !state.busy.
    const anySelectedNow = state.selected.size > 0 && hasOrg;
    const anySelectedIdle = anySelectedNow && !state.busy;
    const hasLocalSelectedNow = anySelectedNow && Array.from(state.selected).some(k => state.localKeys.has(k));
    const hasLocalSelectedIdle = anySelectedIdle && Array.from(state.selected).some(k => state.localKeys.has(k));
    const allOrgOnly = anySelectedNow && Array.from(state.selected).every(k => !state.localKeys.has(k));
    // A click is out and unanswered (sendAction): every slot-taking control
    // locks, Deploy/Validate included — queueable while busy, never while pending.
    const pending = !!state.pendingAction;
    const pendingTip = pending ? 'Sending…' : '';
    const deployBtn = $('deployBtn');
    const validateBtn = $('validateBtn');
    const retrieveBtn = $('retrieveBtn');
    const diffBtn = $('diffBtn');
    const cancelBtn = $('cancelBtn');
    const testLevel = $('testLevel');
    const useActive = $('useActive');
    const useOpenTabs = $('useOpenTabs');
    const clearSel = $('clearSel');
    const ignoreConflicts = $('ignoreDeployConflicts');
    const ignoreConflictsControl = $('ignoreConflictsControl');

    if (ignoreConflicts) ignoreConflicts.disabled = state.busy;
    if (ignoreConflictsControl) ignoreConflictsControl.classList.toggle('disabled', state.busy);

    // Deploy/Validate: always visible, enabled purely on selection+org+local-file
    // — independent of state.busy, since a click while busy queues instead of
    // being refused.
    deployBtn.style.display = '';
    if (validateBtn) validateBtn.style.display = '';
    deployBtn.disabled = !hasLocalSelectedNow || pending;
    if (validateBtn) validateBtn.disabled = !hasLocalSelectedNow || pending;
    const orgOnlyTip = allOrgOnly ? 'Org-only items have no local source — retrieve them first.' : '';
    const queueTip = state.busy && hasLocalSelectedNow ? `Will queue behind ${state.busyAction || 'the current operation'}` : '';
    deployBtn.title = pendingTip || queueTip || orgOnlyTip;
    if (validateBtn) {
      validateBtn.title = pendingTip || queueTip || orgOnlyTip || 'Check-only deploy: nothing is deployed. With a test level it runs the tests and can be quick-deployed; with no tests it cannot.';
    }

    // Selection helpers stay VISIBLE while busy, just disabled — a control that
    // vanishes reads as gone/broken, and "Use open tabs" previously stayed fully
    // clickable while "Use active file" disappeared, which read as two different
    // features rather than one busy panel.
    const busyTip = state.busy ? `Locked while ${state.busyAction || 'an operation'} is running` : '';
    useActive.disabled = state.busy;
    useActive.title = state.busy ? busyTip : 'Select the file currently open in editor';
    useOpenTabs.disabled = state.busy;
    useOpenTabs.title = state.busy ? busyTip : 'Select every open editor tab that maps to a metadata component';
    if (state.busy) {
      retrieveBtn.style.display = 'none';
      retrieveBtn.disabled = true;
      diffBtn.style.display = 'none';
      diffBtn.disabled = true;
      if (testLevel) testLevel.style.display = 'none';
      clearSel.style.display = 'none';
      cancelBtn.style.display = '';
      cancelBtn.disabled = state.cancelRequested;
      cancelBtn.textContent = state.cancelRequested ? 'Cancelling…' : (state.busyAction ? `Cancel ${state.busyAction}` : 'Cancel');
    } else {
      retrieveBtn.style.display = '';
      diffBtn.style.display = '';
      if (testLevel) { testLevel.style.display = ''; testLevel.disabled = !hasLocalSelectedIdle; }
      clearSel.style.display = state.selected.size > 0 ? '' : 'none';
      cancelBtn.style.display = 'none';
      retrieveBtn.disabled = !anySelectedIdle || pending;
      retrieveBtn.title = pendingTip;
      diffBtn.disabled = !hasLocalSelectedIdle || pending;
      diffBtn.title = pendingTip || (allOrgOnly ? 'Org-only items have no local file to diff against — retrieve them first.' : '');
    }
    // Lock org switching and fetch/refresh while an operation runs, so an in-flight
    // Fetch Org can't be raced by an org change or a second fetch. Tooltip says WHY
    // the button is dead — a silently-disabled Rescan reads as a broken button.
    const lockTip = state.busy ? `Locked while ${state.busyAction || 'an operation'} is running — cancel it or wait` : '';
    const orgSelect = $('orgSelect');
    if (orgSelect) { orgSelect.disabled = state.busy || state.orgs.length === 0; orgSelect.title = lockTip; }
    $('fetchOrgBtn').disabled = state.busy || pending;
    $('fetchOrgBtn').title = pendingTip || lockTip || (state.orgLoaded && state.orgAsOf
      ? `Re-list ${state.orgMetaLabel || 'the org'} — badges are as of ${fmtAsOf(state.orgAsOf)}`
      : 'Fetch all metadata from the connected org and merge with local workspace');
    const refreshOrgs = $('refreshOrgs');
    refreshOrgs.disabled = state.busy || state.orgsLoading;
    refreshOrgs.title = lockTip || (state.orgsLoading ? 'Refreshing org list…' : 'Refresh org list');
    refreshOrgs.classList.toggle('loading', state.orgsLoading);
    $('addOrg').disabled = state.busy || pending;
    $('addOrg').title = pendingTip || lockTip || 'Authenticate a new org (sf org login web)';
    $('refreshFiles').disabled = state.busy || pending || state.filesLoading;
    $('refreshFiles').title = pendingTip || lockTip || (state.filesLoading ? 'Rescanning…' : 'Rescan workspace files (also retries folders whose type resolution failed)');
  }

  function renderIgnoreDeployConflicts() {
    const checkbox = $('ignoreDeployConflicts');
    const control = $('ignoreConflictsControl');
    if (!checkbox || !control) return;
    checkbox.checked = state.ignoreDeployConflicts;
    control.classList.toggle('enabled', state.ignoreDeployConflicts);
    control.title = state.ignoreDeployConflicts
      ? 'Overwrite mode is ON. Deploys use --ignore-conflicts and can replace newer changes in the selected org.'
      : 'Deploy with --ignore-conflicts. Local source can overwrite newer changes in the selected org.';
  }

  // ---- Deploy queue strip (Feature: deploy queue) ----
  // Slim list of deploys/validations deferred behind the single busy slot,
  // between the action bar and the Status pane. Purely a passive display: all
  // ordering/org-pinning/cap logic lives server-side (panelProvider's
  // deployQueue/drainQueue) — a row's ✕ just asks the provider to remove it,
  // and the provider re-posts the authoritative list either way.
  function renderQueue() {
    const strip = $('queueStrip');
    if (!strip) return;
    strip.innerHTML = '';
    if (state.queue.length === 0) { strip.style.display = 'none'; return; }
    strip.style.display = 'flex';
    for (const item of state.queue) {
      // Reuses .mode-head's row styling (see the Selected-lens header above)
      // rather than inventing a new look for a second "slim strip with a label
      // and a subtle button" row.
      const row = document.createElement('div');
      row.className = 'mode-head';
      const lbl = document.createElement('span');
      lbl.textContent = `⏳ ${item.noun} → ${item.orgLabel}`;
      row.appendChild(lbl);
      const x = document.createElement('button');
      x.textContent = '✕';
      x.title = 'Remove from queue';
      x.addEventListener('click', () => send('cancelQueued', { id: item.id }));
      row.appendChild(x);
      strip.appendChild(row);
    }
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
  /** "17:42" today, "yesterday 17:42", else "Sep 2, 17:42" — the browser's
   *  locale time, so the note reads like the user's own clock. */
  function fmtAsOf(at) {
    const d = new Date(at);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return time;
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  }

  function fmtCardTime(at) {
    const d = new Date(at);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return d.toDateString() === new Date().toDateString()
      ? hm
      : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
  }

  /** A card's `lines` list (capped at MAX_CARD_LINES with a "Show all" button) —
   *  shared by the normal card body and renderSuggestOpen (state B), so the org's
   *  own error text stays visible while the user is deciding on the suggestion
   *  instead of being replaced wholesale by the checkbox list. */
  function renderCardLines(card, el) {
    if (!card.lines || !card.lines.length) return;
    const ul = document.createElement('ul');
    const visible = card.expanded ? card.lines : card.lines.slice(0, MAX_CARD_LINES);
    for (const line of visible) {
      const li = document.createElement('li');
      // Lines are plain strings, or {text, key, line?, column?} — the object
      // form is clickable and opens the source at the error position.
      if (line && typeof line === 'object') {
        li.textContent = line.text || '';
        // A CLI failure can name org/package-level metadata that has no local
        // source file. Only advertise navigation when the current workspace
        // scan says the key is local; older persisted cards may still carry
        // keys created before the provider began filtering them.
        if (line.key && state.localKeys.has(line.key)) {
          li.classList.add('nav');
          li.title = `Open ${line.key}${line.line ? ` at line ${line.line}` : ''}`;
          li.addEventListener('click', () => send('openFile', { key: line.key, line: line.line, column: line.column }));
        }
      } else {
        li.textContent = line;
      }
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

  function renderStatus() {
    if (RV && state.runs.length) { renderRunStatus(); return; }
    // No run history: the pane is the plain card list, newest first.
    releaseRunList();
    const st = $('status');
    st.innerHTML = '';
    const csBtn = $('clearStatus'); if (csBtn) csBtn.style.display = state.statusCards.length ? '' : 'none';
    const earlierBtn = $('statusEarlier'); if (earlierBtn) earlierBtn.style.display = 'none';
    if (state.progress) st.appendChild(progressCardEl());
    if (state.statusCards.length === 0 && !state.progress) {
      const d = document.createElement('div');
      d.className = 'status-empty';
      d.textContent = 'No operations yet.';
      st.appendChild(d);
      return;
    }
    for (const card of state.statusCards) st.appendChild(statusCardEl(card, true));
  }

  /** The generic spinner card of a running operation. */
  function progressCardEl() {
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
    return el;
  }

  /** One status card. `withTitle` false is a notice expanded under its own
   *  one-line title, so the body alone follows. */
  function statusCardEl(card, withTitle) {
    const el = document.createElement('div');
    el.className = `status-card ${card.kind || 'ok'}`;
    // Suggestion view (state B): the card keeps its error list (so the
    // decision has evidence) and swaps its buttons for checkbox rows. Plain
    // local state, same pattern as card.expanded.
    if (card.suggest && card.suggestOpen && !card.suggestDone) {
      renderSuggestOpen(card, el);
      return el;
    }
    if (withTitle) {
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
    }
    if (card.meta) {
      const m = document.createElement('div');
      m.className = 'meta';
      m.textContent = card.meta;
      el.appendChild(m);
    }
    renderCardLines(card, el);
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
        // Lines can be {text, key, line} objects (clickable error rows) — a raw
        // join stringifies those to "[object Object]"; copy their text instead.
        const lineText = (l) => (l && typeof l === 'object' ? l.text || '' : l);
        const parts = [card.title, card.meta, (card.lines || []).map(lineText).join('\n'), card.errText];
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
      qd.disabled = state.busy || !!state.pendingAction;
      qd.title = 'Deploy the validated components — skips validation and the test run.';
      qd.addEventListener('click', () => {
        if (state.busy || state.pendingAction) return;
        card.quickDeployDone = true;   // one-shot: a validation can be quick-deployed once
        renderStatus();
        send('quickDeploy', { jobId: card.quickDeploy.jobId });
      });
      el.appendChild(qd);
    }
    // Card-defined action buttons (e.g. Restore backup… / Discard backup on a
    // retrieve result) — each posts its own `send` payload verbatim, spread
    // through the same send() every toolbar/tree control uses. Disabled while
    // busy, like the toolbar, so a click can't race a running operation.
    // The suggestion's "Try with dependencies" entry point is independent of
    // card.buttons — a card can carry a suggestion with no other buttons at
    // all (an envelope-level failure with no retry key list to extend still
    // offers one when it resolved locally), so the wrap can't be gated on
    // card.buttons alone.
    if ((card.buttons && card.buttons.length) || (card.suggest && !card.suggestDone)) {
      const bwrap = document.createElement('div');
      bwrap.className = 'card-buttons';
      for (const b of card.buttons || []) {
        const cb = document.createElement('button');
        cb.className = 'card-btn';
        cb.textContent = b.label || '';
        // Retry (plain or +changed-vs-branch) rides the deploy pipeline, which
        // QUEUES while busy — keeping it clickable matches the Deploy/Validate
        // buttons. Resume monitoring and the restore/discard actions need the
        // single operation slot themselves. "Select these N" only ticks tree
        // rows — no org call, no operation slot — so busy never gates it.
        const queueable = b.send && (b.send.type === 'retryDeploy' || b.send.type === 'retryDeployChanged');
        const selectionOnly = b.send && b.send.type === 'selectDeployed';
        // Everything but the selection-only button also waits for the
        // provider's answer to the previous click (sendAction).
        const pending = !!state.pendingAction && !selectionOnly;
        cb.disabled = (state.busy && !queueable && !selectionOnly) || pending;
        if (pending) cb.title = 'Sending…';
        else if (state.busy && queueable) cb.title = `Will queue behind ${state.busyAction || 'the running operation'}`;
        cb.addEventListener('click', () => {
          if (state.busy && !queueable && !selectionOnly) return;
          if (selectionOnly) send(b.send.type, b.send);
          else sendAction(b.send.type, b.send);
        });
        bwrap.appendChild(cb);
      }
      // State-A entry into the suggestion view, alongside the retry buttons.
      // Opening is purely local (plus a log ping) — nothing deploys yet, so
      // it stays enabled even while busy.
      if (card.suggest && !card.suggestDone) {
        const sb = document.createElement('button');
        sb.className = 'card-btn suggest-open-btn';
        sb.textContent = `Try with dependencies (${card.suggest.candidates.length})`;
        sb.title = 'Review the missing components this failure references and retry with a selection of them.';
        sb.addEventListener('click', () => {
          card.suggestOpen = true;
          // Reopening supersedes an earlier Back — the verdict question would
          // otherwise linger under a live suggestion view.
          card.suggestDeclined = false;
          send('suggestionOpened', { id: card.suggest.id });
          renderStatus();
        });
        bwrap.appendChild(sb);
      }
      el.appendChild(bwrap);
    }
    renderSuggestAfter(card, card.suggest, el);
    return el;
  }

  /** After the suggestion view: the "retrying…" note, or — once, after Back —
   *  a small in-card question about whether the suggestion was off. `holder`
   *  keeps the view's state (a card, or a run's local state). */
  function renderSuggestAfter(holder, suggest, el) {
    if (holder.suggestDone) {
      const d = document.createElement('div');
      d.className = 'suggest-summary';
      d.textContent = holder.suggestDone;
      el.appendChild(d);
    }
    if (holder.suggestDeclined && !holder.suggestVerdictDone && !holder.suggestDone && suggest) {
      const fb = document.createElement('div');
      fb.className = 'suggest-feedback';
      fb.append('Was this suggestion off? ');
      for (const [label, bad] of [['Yes — off', true], ['No, made sense', false]]) {
        const b = document.createElement('button');
        b.className = 'card-btn small';
        b.textContent = label;
        b.addEventListener('click', () => {
          holder.suggestVerdictDone = true;
          send('suggestionVerdict', { id: suggest.id, bad });
          renderStatus();
        });
        fb.appendChild(b);
      }
      el.appendChild(fb);
    }
  }

  /** State B of a failure card: the org's error lines stay up (renderCardLines),
   *  with checkbox rows for the suggested components below them, replacing the
   *  buttons. Selection state lives on the card object (card.suggestSel),
   *  surviving re-renders exactly like card.expanded. */
  function renderSuggestOpen(card, el) {
    const t = document.createElement('div');
    t.className = 'title';
    const ic = document.createElement('span');
    ic.className = `card-icon ${card.kind || 'ok'}`;
    ic.textContent = CARD_ICONS[card.kind] || CARD_ICONS.ok;
    t.appendChild(ic);
    const ttxt = document.createElement('span');
    ttxt.textContent = 'Retry with missing dependencies?';
    t.appendChild(ttxt);
    el.appendChild(t);
    const m = document.createElement('div');
    m.className = 'meta';
    m.textContent = 'Referenced by the failed components and present in your workspace — untick any you don’t want.';
    el.appendChild(m);
    // The org's own error lines stay visible while deciding — swapping the whole
    // card body for the checkbox list hid exactly the evidence the decision
    // needs. Same list, same cap, as the normal card body (state A).
    renderCardLines(card, el);
    renderSuggestChoices(card, card.suggest, el, 'result arrives as its own card');
  }

  /** The suggestion's checkbox rows (pre-checked) and its Deploy with N / Back
   *  buttons. `holder` keeps the selection and the view state; `doneNote` says
   *  where the retry's result will show up. */
  function renderSuggestChoices(holder, suggest, el, doneNote) {
    holder.suggestSel = holder.suggestSel || {};
    for (const c of suggest.candidates) {
      if (!(c.key in holder.suggestSel)) holder.suggestSel[c.key] = true; // pre-checked
    }
    const ul = document.createElement('ul');
    ul.className = 'suggest-rows';
    for (const c of suggest.candidates) {
      const li = document.createElement('li');
      const lbl = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!holder.suggestSel[c.key];
      cb.addEventListener('change', () => { holder.suggestSel[c.key] = cb.checked; renderStatus(); });
      lbl.appendChild(cb);
      const txt = document.createElement('span');
      // "OrderSvc -> add CustomObject:Billing__mdt": cause first, fix second.
      txt.textContent = `${c.from ? c.from + '  →  ' : ''}add ${c.key}`;
      lbl.appendChild(txt);
      li.appendChild(lbl);
      // The org sentence that produced this candidate — the "why", so a
      // pre-checked box doesn't have to be taken purely on faith.
      if (c.why) {
        const why = document.createElement('div');
        why.className = 'suggest-why';
        why.textContent = c.why;
        li.appendChild(why);
      }
      ul.appendChild(li);
    }
    el.appendChild(ul);
    // Referents that exist nowhere locally: context, not choices.
    if (suggest.unresolved && suggest.unresolved.length) {
      const u = document.createElement('div');
      u.className = 'suggest-unresolved';
      u.textContent = `Not found in your workspace (retrieve it, or its type is not scanned): ${suggest.unresolved.join(', ')}`;
      el.appendChild(u);
    }

    const n = suggest.candidates.filter(c => holder.suggestSel[c.key]).length;
    const bwrap = document.createElement('div');
    bwrap.className = 'card-buttons';
    const dep = document.createElement('button');
    dep.className = 'card-btn primary';
    dep.textContent = `Deploy with ${n} selected`;
    // Deliberately NOT queue-tolerant: a queued suggestion retry would be logged
    // "not run" while actually running later — the provider refuses while busy,
    // so disable here too instead of promising a queue slot.
    dep.disabled = n === 0 || state.busy;
    if (state.busy && n > 0) dep.title = `Wait for ${state.busyAction || 'the running operation'} to finish`;
    dep.addEventListener('click', () => {
      if (n === 0) return;
      const keys = suggest.candidates.map(c => c.key).filter(k => holder.suggestSel[k]);
      holder.suggestDone = `Retrying with ${keys.length} added component${keys.length === 1 ? '' : 's'}… (${doneNote})`;
      holder.suggestOpen = false;
      send('suggestionDeploy', { id: suggest.id, keys });
      renderStatus();
    });
    bwrap.appendChild(dep);
    const back = document.createElement('button');
    back.className = 'card-btn';
    back.textContent = 'Back';
    back.addEventListener('click', () => {
      holder.suggestOpen = false;
      holder.suggestDeclined = true;
      send('suggestionDeclined', { id: suggest.id });
      renderStatus();
    });
    bwrap.appendChild(back);
    el.appendChild(bwrap);
  }

  // ---- Run cards ----
  // With a run history the pane shows the newest deploy / validation / quick
  // deploy / retrieve in full — verdict, count chips that filter, its actions,
  // and every component in a virtual list — and everything older (runs and
  // notices alike) as one-liners behind the header's Earlier toggle. What to
  // say and which rows exist is src/runView.js (window.RunView); this is only
  // the DOM, and every org-derived string reaches it as textContent.
  const RUN_OVERSCAN = 6;      // rows kept in the DOM beyond each edge of the view
  const NEWER_NOTICES_SHOWN = 3;
  const OLDER_FAILURES_SHOWN = 25;
  const OLDER_TESTS_SHOWN = 10;
  let runList = null;          // the newest run's list (role=tree), a child of #status
  let runHead = null;          // everything above the list: its height moves the list
  let runActs = null;
  let runProg = null;
  let runElapsed = null;
  let runSearch = null;
  let runModel = null;         // RV.buildRows for the newest run
  let runSrc = null;           // { rows, tests, complete } that list is built from
  let runGroupCache = {};
  let runPaintQueued = false;
  let runResize = null;
  let runClock = null;
  let runSearchTimer = null;
  const runTiming = { build: 0, paint: 0 };

  function mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function runLocalFor(id) { return (state.runLocal[id] ||= {}); }
  /** The newest run's view state, reset when another run becomes the newest. */
  function runUiFor(run) {
    if (state.runUi.runId !== run.id) {
      state.runUi = { runId: run.id, filter: 'all', q: '', folds: {}, openAll: undefined, focus: -1 };
      runGroupCache = {};
    }
    return state.runUi;
  }
  /** What the newest run's list is built from: its full rows when the provider
   *  sent them for THIS run, else the summary the run itself carries. */
  function runSource(run) {
    const lr = state.latestRows;
    if (lr && lr.runId === run.id) return { rows: lr.rows, tests: lr.tests, complete: true };
    return { rows: run.rows, tests: run.tests, complete: run.rowsComplete === true };
  }
  function releaseRunList() {
    runList = runHead = runActs = runProg = runElapsed = runSearch = null;
    runModel = runSrc = null;
    if (runResize) runResize.disconnect();
    syncRunClock(null);
  }

  function renderRunStatus() {
    const st = $('status');
    const latest = state.runs[0];
    const ui = runUiFor(latest);
    // A re-render replaces the pane's content; where it was scrolled to, and
    // which of its controls had the keyboard, carry over.
    const scroll = st.scrollTop;
    const listFocused = !!runList && document.activeElement === runList;
    const searchCaret = runSearch && document.activeElement === runSearch ? [runSearch.selectionStart, runSearch.selectionEnd] : null;
    releaseRunList();
    st.innerHTML = '';
    // Notices since the newest run lead, a few at most, so the run stays in
    // reach of a short pane; the rest join the older entries behind Earlier.
    const newer = state.statusCards.filter(c => (c.at || 0) > latest.startedAt).slice(0, NEWER_NOTICES_SHOWN);
    const earlier = [
      ...state.runs.slice(1).map(run => ({ run, at: run.startedAt })),
      ...state.statusCards.filter(c => !newer.includes(c)).map(card => ({ card, at: card.at || 0 }))
    ].sort((a, b) => b.at - a.at);
    const csBtn = $('clearStatus');
    if (csBtn) csBtn.style.display = state.statusCards.length || state.runs.some(r => r.status !== 'running') ? '' : 'none';
    const earlierBtn = $('statusEarlier');
    if (earlierBtn) {
      earlierBtn.style.display = earlier.length ? '' : 'none';
      earlierBtn.textContent = `Earlier (${earlier.length}) ${state.earlierOpen ? '▾' : '▸'}`;
      earlierBtn.setAttribute('aria-expanded', state.earlierOpen ? 'true' : 'false');
      earlierBtn.title = state.earlierOpen ? 'Hide older runs and notices' : 'Show older runs and notices';
    }
    // The generic spinner card is for everything that isn't a run; a running
    // run shows its own progress.
    if (state.progress && latest.status !== 'running') st.appendChild(progressCardEl());
    if (state.earlierOpen && earlier.length) {
      const box = mk('div', 'run-earlier');
      for (const e of earlier) box.appendChild(e.run ? olderRunEl(e.run) : noticeEl(e.card));
      st.appendChild(box);
    }
    for (const card of newer) st.appendChild(noticeEl(card));
    st.appendChild(runHeroEl(latest, ui));
    st.scrollTop = scroll;
    paintRunList();
    if (listFocused) runList.focus();
    if (searchCaret && runSearch) {
      runSearch.focus();
      try { runSearch.setSelectionRange(searchCaret[0], searchCaret[1]); } catch (_) { /* not a text input any more */ }
    }
    if (typeof ResizeObserver === 'function') {
      // The pane resizing (splitter, sidebar width) or anything above the list
      // changing height moves the window the list must paint.
      if (!runResize) runResize = new ResizeObserver(() => { if (runList) scheduleRunPaint(); });
      runResize.observe(st);
      if (runHead) runResize.observe(runHead);
    }
    syncRunClock(latest);
  }

  /** A one-line entry (older run or notice) that expands in place. */
  function hrowEl(kind, glyph, text, when, open) {
    const b = mk('button', 'run-hrow');
    b.type = 'button';
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    b.title = text;
    b.appendChild(mk('span', 'run-caret', open ? '▾' : '▸'));
    const g = mk('span', `run-rglyph g-${kind}`, glyph);
    g.setAttribute('aria-hidden', 'true');
    b.appendChild(g);
    b.appendChild(mk('span', 'run-htxt', text));
    b.appendChild(mk('span', 'run-when', when));
    return b;
  }

  function noticeEl(card) {
    const wrap = mk('div', 'run-notice');
    const b = hrowEl(card.kind || 'ok', CARD_ICONS[card.kind] || CARD_ICONS.ok, card.title || '', card.at ? fmtCardTime(card.at) : '', !!card.noticeOpen);
    b.addEventListener('click', () => { card.noticeOpen = !card.noticeOpen; renderStatus(); });
    wrap.appendChild(b);
    if (card.noticeOpen) wrap.appendChild(statusCardEl(card, false));
    return wrap;
  }

  /** An older run: its one-line summary, and when expanded a read-only record —
   *  verdict, counts, message, the failures it kept, and Copy. */
  function olderRunEl(run) {
    const local = runLocalFor(run.id);
    const wrap = mk('div', 'run-older');
    const l = RV.histLabel(run);
    const b = hrowEl(l.kind, l.glyph, l.text, RV.fmtWhen(run.startedAt), !!local.open);
    b.addEventListener('click', () => { local.open = !local.open; renderStatus(); });
    wrap.appendChild(b);
    if (!local.open) return wrap;
    const ctx = { now: Date.now(), fromRun: run.fromRunId ? state.runs.find(r => r.id === run.fromRunId) : null };
    const v = RV.verdictFor(run, ctx);
    const body = mk('div', 'run-older-body');
    body.appendChild(runVerdictEl(run, v));
    const counts = RV.chipDefs(run).filter(c => c.id !== 'all' && c.n > 0).map(c => `${RV.fmtN(c.n)} ${c.label.toLowerCase()}`);
    if (counts.length) body.appendChild(mk('div', 'run-sub', counts.join(' · ')));
    const failures = run.rows.filter(r => r.o === 'failed').slice(0, OLDER_FAILURES_SHOWN);
    const tests = run.tests.slice(0, OLDER_TESTS_SHOWN);
    if (failures.length || tests.length) {
      const ul = mk('ul', 'run-older-rows');
      for (const r of failures) ul.appendChild(olderRowEl(r.k, `${r.k}${r.m ? ' — ' + r.m.split('\n')[0] : ''}`, r.l, r.c));
      for (const t of tests) ul.appendChild(olderRowEl(`ApexClass:${t.cls}`, `${t.cls}.${t.method} — ${t.m.split('\n')[0]}`, t.l, t.c));
      body.appendChild(ul);
    }
    const acts = mk('div', 'run-acts');
    for (const a of RV.actionsFor(run, { isLatest: false }).buttons) {
      const btn = mk('button', 'run-btn', a.label);
      btn.type = 'button';
      btn.title = a.title || '';
      btn.addEventListener('click', () => send('copyText', { text: RV.copyText(run, run.rows, run.tests, ctx) }));
      acts.appendChild(btn);
    }
    body.appendChild(acts);
    body.appendChild(mk('div', 'run-foot', 'Actions are on the newest run only.'));
    wrap.appendChild(body);
    return wrap;
  }
  function olderRowEl(key, text, line, column) {
    const li = mk('li', '', text);
    li.title = text;
    // Only a component with local source opens — org-only rows name nothing
    // the editor could show.
    if (state.localKeys.has(key)) {
      li.classList.add('nav');
      li.addEventListener('click', () => openRunKey(key, line, column));
    }
    return li;
  }
  /** Open a row's source: only for a key the workspace scan has. */
  function openRunKey(key, line, column) {
    if (!state.localKeys.has(key)) return;
    send('openFile', { key, line, column });
  }

  function runOrgEl(run) {
    const s = mk('span', 'run-org', run.orgLabel);
    const pill = run.orgKind === 'prod' ? ['prod', 'PROD'] : run.orgKind === 'sandbox' ? ['sandbox', 'sandbox'] : run.orgKind === 'scratch' ? ['scratch', 'scratch'] : null;
    if (pill) {
      const p = mk('span', `run-pill ${pill[0]}`, pill[1]);
      p.title = pill[0] === 'prod' ? 'Production org' : `${pill[1]} org`;
      s.appendChild(p);
    }
    return s;
  }

  function runVerdictEl(run, v) {
    const box = mk('div', 'run-verdict');
    const g = mk('span', `run-glyph ${v.kind}`);
    g.setAttribute('aria-hidden', 'true');
    if (v.glyph === null) g.appendChild(mk('span', 'spinner')); else g.textContent = v.glyph;
    box.appendChild(g);
    const text = mk('div', 'run-vtext');
    const title = mk('div', 'run-title');
    for (const p of v.title) title.append(p === RV.ORG ? runOrgEl(run) : p);
    text.appendChild(title);
    const sub = mk('div', 'run-sub', v.sub);
    sub.title = new Date(run.startedAt).toLocaleString();
    text.appendChild(sub);
    for (const p of v.plain) {
      const line = mk('div', `run-plain${p.kind ? ' ' + p.kind : ''}`, p.text);
      line.title = p.text;
      text.appendChild(line);
    }
    box.appendChild(text);
    return box;
  }

  /** Components and tests bars, the elapsed clock, and errors so far. */
  function runProgressEl(run) {
    const p = state.runProgress && state.runProgress.id === run.id ? state.runProgress : null;
    const box = mk('div', 'run-prog');
    const bar = (label, done, total, waiting, note) => {
      const row = mk('div', 'run-prow');
      row.appendChild(mk('span', 'run-plbl', label));
      const track = mk('span', 'run-bar' + (waiting ? ' indet' : ''));
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', label);
      const fill = mk('i');
      if (!waiting && total) {
        fill.style.width = `${Math.min(100, (100 * done) / total)}%`;
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', String(total));
        track.setAttribute('aria-valuenow', String(done));
      }
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(mk('span', 'run-pn', note));
      return row;
    };
    if (!p) box.appendChild(bar('Components', 0, 0, true, 'waiting for the org'));
    else {
      box.appendChild(bar('Components', p.compDone, p.compTotal, !p.compTotal, `${RV.fmtN(p.compDone)}/${RV.fmtN(p.compTotal)}`));
      // Tests run after the components are in, so until then they are queued.
      if (p.testTotal) {
        const queued = p.testDone === 0 && p.compDone < p.compTotal;
        box.appendChild(bar('Tests', p.testDone, p.testTotal, queued, queued ? `${RV.fmtN(p.testTotal)} queued` : `${RV.fmtN(p.testDone)}/${RV.fmtN(p.testTotal)}`));
      }
    }
    const foot = mk('div', 'run-prow');
    foot.appendChild(mk('span', 'run-plbl', 'Elapsed'));
    runElapsed = mk('span', 'run-pn', RV.fmtElapsed(Date.now() - run.startedAt));
    foot.appendChild(runElapsed);
    if (p && p.errors) foot.appendChild(mk('span', 'run-perr', `${RV.fmtN(p.errors)} ${RV.plural(p.errors, 'error')} so far`));
    box.appendChild(foot);
    return box;
  }
  /** The running run's clock ticks once a second; nothing else runs a timer. */
  function syncRunClock(run) {
    const want = !!run && run.status === 'running';
    if (!want) { if (runClock) { clearInterval(runClock); runClock = null; } return; }
    if (!runClock) {
      runClock = setInterval(() => {
        const r = state.runs[0];
        if (runElapsed && r && r.status === 'running') runElapsed.textContent = RV.fmtElapsed(Date.now() - r.startedAt);
      }, 1000);
    }
  }

  function runHeroEl(run, ui) {
    const local = runLocalFor(run.id);
    const ctx = {
      // The offer is one-shot: once used, "available until" has nothing left to say.
      now: Date.now(), quick: local.quickUsed ? undefined : run.quick,
      fromRun: run.fromRunId ? state.runs.find(r => r.id === run.fromRunId) : null,
      cancelRequested: run.status === 'running' && state.cancelRequested
    };
    const v = RV.verdictFor(run, ctx);
    runSrc = runSource(run);
    const chips = RV.chipDefs(run);
    // A filter whose rows are gone (a chip now at 0, or absent) falls back to All.
    const active = chips.find(c => c.id === ui.filter);
    if (!active || active.disabled) ui.filter = 'all';
    buildRunModel(run, ui);

    const card = mk('div', `run-card ${v.kind}`);
    runHead = mk('div', 'run-head');
    runHead.appendChild(runVerdictEl(run, v));
    if (run.status === 'running') { runProg = runProgressEl(run); runHead.appendChild(runProg); }

    const chipBox = mk('div', 'run-chips');
    chipBox.setAttribute('role', 'group');
    chipBox.setAttribute('aria-label', 'Filter the list by outcome');
    for (const c of chips) {
      const b = mk('button', `run-chip k-${c.kind}`);
      b.type = 'button';
      b.dataset.chip = c.id;
      b.setAttribute('aria-pressed', ui.filter === c.id ? 'true' : 'false');
      b.disabled = !!c.disabled;
      b.title = c.id === 'all' ? 'Everything this run reported'
        : c.disabled ? `None ${c.label.toLowerCase()} in this run`
          : RV.explainFor(run, c.id, runSrc.rows).text || `Show only ${c.label.toLowerCase()}`;
      const dot = mk('span', 'run-dot');
      dot.setAttribute('aria-hidden', 'true');
      b.appendChild(dot);
      b.append(c.label);
      b.appendChild(mk('span', 'run-n', RV.fmtN(c.n)));
      b.addEventListener('click', () => {
        if (b.disabled) return;
        ui.filter = c.id;
        ui.focus = -1;
        ui.openAll = undefined;
        renderStatus();
      });
      chipBox.appendChild(b);
    }
    runHead.appendChild(chipBox);

    const ex = RV.explainFor(run, ui.filter, runSrc.rows);
    if (ex.text) {
      const kind = ui.filter === 'all' ? '' : (chips.find(c => c.id === ui.filter) || {}).kind || '';
      const line = mk('div', `run-explain${kind ? ' k-' + kind : ''}`);
      if (ex.lead) line.appendChild(mk('b', '', ex.lead));
      line.append(ex.text);
      runHead.appendChild(line);
    }

    runActs = mk('div', 'run-acts');
    renderRunActs(run);
    runHead.appendChild(runActs);

    // Suggestion state B: the choices sit between the actions and the list,
    // and the failures stay in view below them as the evidence.
    if (run.suggest && local.suggestOpen && !local.suggestDone) {
      const box = mk('div', 'run-suggest');
      box.appendChild(mk('div', 'run-suggest-title', 'Retry with missing dependencies?'));
      box.appendChild(mk('div', 'run-sub', 'Referenced by the failed components and present in your workspace — untick any you don’t want.'));
      renderSuggestChoices(local, run.suggest, box, 'the retry becomes the newest run');
      runHead.appendChild(box);
    } else {
      const after = mk('div', 'run-suggest-after');
      renderSuggestAfter(local, run.suggest, after);
      if (after.children.length) runHead.appendChild(after);
    }

    if (runSrc.rows.length + runSrc.tests.length > RV.SEARCH_MIN_ROWS) runHead.appendChild(runToolsEl(ui));
    card.appendChild(runHead);

    runList = mk('div', 'run-list');
    runList.setAttribute('role', 'tree');
    runList.setAttribute('aria-label', 'Run results');
    runList.tabIndex = 0;
    runList.style.height = `${runModel.rows.length ? runModel.totalH : 0}px`;
    runList.addEventListener('keydown', onRunListKey);
    runList.addEventListener('focus', () => {
      // Tabbing in lands on the first row in view — never a jump back to the top.
      if (state.runUi.focus >= 0 || !runModel || !runModel.rows.length) return;
      const st = $('status');
      const [lo] = RV.visibleRange(runModel.offsets, runModel.rows.length, st.scrollTop - runList.offsetTop, st.clientHeight, 0);
      setRunFocus(runStep(lo - 1, 1), false);
    });
    card.appendChild(runList);
    return card;
  }

  function buildRunModel(run, ui) {
    const t0 = performance.now();
    runModel = RV.buildRows(run, runSrc.rows, runSrc.tests, ui, { cache: runGroupCache, complete: runSrc.complete });
    runTiming.build = performance.now() - t0;
    if (ui.focus >= runModel.rows.length) ui.focus = -1;
  }

  /** The newest run's buttons (RV.actionsFor) for what the list shows now. */
  function renderRunActs(run) {
    if (!runActs) return;
    runActs.replaceChildren();
    const local = runLocalFor(run.id);
    const ui = state.runUi;
    const chip = ui.filter === 'all' ? null : RV.chipDefs(run).find(c => c.id === ui.filter);
    const selectKeys = [...new Set(runModel.visible.map(r => r.k).filter(k => state.localKeys.has(k)))];
    const { buttons, why } = RV.actionsFor(run, {
      isLatest: true, busy: state.busy, pending: !!state.pendingAction, busyAction: state.busyAction,
      complete: runSrc.complete, sent: runSrc.rows.filter(r => r.s === 1).map(r => r.k), selectKeys,
      filterLabel: chip ? chip.label.toLowerCase() : '',
      quick: run.quick, suggest: run.suggest, quickUsed: !!local.quickUsed, suggestDone: !!local.suggestDone
    });
    for (const b of buttons) {
      const btn = mk('button', `run-btn${b.primary ? ' primary' : ''}`, b.label);
      btn.type = 'button';
      btn.dataset.act = b.id;
      btn.title = b.title || '';
      btn.disabled = !!b.disabled;
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        if (b.via === 'copy') send('copyText', { text: RV.copyText(run, runModel.visible, runModel.visibleTests, { now: Date.now(), quick: run.quick }) });
        else if (b.via === 'send') send(b.message.type, b.message);
        else if (b.via === 'open') {
          local.suggestOpen = true;
          // Reopening supersedes an earlier Back.
          local.suggestDeclined = false;
          send('suggestionOpened', { id: run.suggest.id });
          renderStatus();
        } else if (sendAction(b.message.type, b.message) && b.id === 'quickDeploy') {
          local.quickUsed = true; // one-shot: a validation can be quick-deployed once
        }
      });
      runActs.appendChild(btn);
    }
    if (why) runActs.appendChild(mk('div', 'run-why', why));
    runActs.style.display = buttons.length || why ? '' : 'none';
  }

  function runToolsEl(ui) {
    const box = mk('div', 'run-tools');
    const input = mk('input', 'run-search');
    input.type = 'search';
    input.placeholder = 'Filter by name, type, message or file…';
    input.setAttribute('aria-label', 'Filter the run results');
    input.spellcheck = false;
    input.value = ui.q;
    input.addEventListener('input', () => {
      if (runSearchTimer) clearTimeout(runSearchTimer);
      runSearchTimer = setTimeout(() => {
        // A new search opens its own matches: folds made under the last one go.
        ui.q = input.value;
        ui.focus = -1;
        ui.folds = {};
        ui.openAll = undefined;
        refreshRunList();
      }, 100);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !input.value) return;
      input.value = '';
      ui.q = '';
      ui.folds = {};
      refreshRunList();
    });
    runSearch = input;
    box.appendChild(input);
    for (const [label, open] of [['Expand', true], ['Collapse', false]]) {
      const b = mk('button', 'run-btn', label);
      b.type = 'button';
      b.title = `${label} every group`;
      b.addEventListener('click', () => { ui.openAll = open; ui.folds = {}; ui.focus = -1; refreshRunList(); });
      box.appendChild(b);
    }
    return box;
  }

  /** Rebuild the list (and the buttons that count it) after a search, fold or
   *  Expand/Collapse, leaving the rest of the card — and the search box's
   *  caret — alone. */
  function refreshRunList() {
    const run = state.runs[0];
    if (!run || !runList || !RV) return;
    buildRunModel(run, state.runUi);
    renderRunActs(run);
    runList.style.height = `${runModel.rows.length ? runModel.totalH : 0}px`;
    paintRunList();
  }

  function scheduleRunPaint() {
    if (runPaintQueued) return;
    runPaintQueued = true;
    deferRender(paintRunList);
  }

  /** Put the rows in view (plus RUN_OVERSCAN either side) into the DOM. The
   *  list scrolls with the whole pane, so the view is the pane's viewport in
   *  list coordinates; offsetTop is read on every paint because anything
   *  above the list can move it. */
  function paintRunList() {
    runPaintQueued = false;
    if (!runList || !runModel) return;
    const t0 = performance.now();
    const rows = runModel.rows;
    if (!rows.length) {
      const ui = state.runUi;
      const run = state.runs[0];
      runList.replaceChildren(mk('div', 'run-empty', ui.q.trim() ? `No row matches "${ui.q.trim()}".`
        : run && run.status === 'running' ? 'Results land here when the org finishes.' : 'Nothing in this view.'));
      runList.removeAttribute('aria-activedescendant');
      return;
    }
    const st = $('status');
    const [lo, hi] = RV.visibleRange(runModel.offsets, rows.length, st.scrollTop - runList.offsetTop, st.clientHeight, RUN_OVERSCAN);
    const nodes = [];
    for (let i = lo; i < hi; i++) nodes.push(runRowEl(rows[i], i));
    runList.replaceChildren(...nodes);
    const focus = state.runUi.focus;
    if (focus >= 0) runList.setAttribute('aria-activedescendant', `run-row-${focus}`); else runList.removeAttribute('aria-activedescendant');
    runTiming.paint = performance.now() - t0;
    if (debugTiming) console.log(`[timing] runs: build ${runTiming.build.toFixed(1)}ms (${rows.length} rows) · paint ${runTiming.paint.toFixed(1)}ms (${hi - lo} nodes)`);
  }

  function runRowEl(r, i) {
    const row = mk('div', `run-row ${r.k}${(r.k === 'leaf' && r.row.m) || r.k === 'test' ? ' tall' : ''}${i === state.runUi.focus ? ' focused' : ''}`);
    row.id = `run-row-${i}`;
    row.style.top = `${runModel.offsets[i]}px`;
    row.style.height = `${r.h}px`;
    const run = state.runs[0];
    const glyph = (kind) => { const g = mk('span', `run-rglyph g-${kind}`, RV.GLYPH[kind] || '•'); g.setAttribute('aria-hidden', 'true'); return g; };
    const copyBtn = (text) => {
      const b = mk('button', 'run-mini', 'copy');
      b.type = 'button';
      b.tabIndex = -1;
      b.title = 'Copy this row (c)';
      b.addEventListener('click', (e) => { e.stopPropagation(); send('copyText', { text }); });
      return b;
    };
    const location = (key, text, line, column) => {
      // A link only for a component with local source — the same gate the old
      // cards used; anything else is plain text.
      if (!state.localKeys.has(key)) return mk('span', 'run-loc', text);
      const a = mk('button', 'run-link', text);
      a.type = 'button';
      a.tabIndex = -1;
      a.title = `Open ${key}${line ? ` at line ${line}` : ''}`;
      a.addEventListener('click', (e) => { e.stopPropagation(); setRunFocus(i, false); openRunKey(key, line, column); });
      return a;
    };
    switch (r.k) {
      case 'section':
      case 'note':
        row.setAttribute('role', 'presentation');
        row.appendChild(mk('span', r.k === 'note' ? 'run-note' : 'run-name', r.k === 'note' ? r.text : r.label));
        if (r.k === 'section') row.appendChild(mk('span', 'run-cnt', RV.fmtN(r.n)));
        return row;
      case 'group':
      case 'tgroup': {
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', '1');
        row.setAttribute('aria-expanded', r.open ? 'true' : 'false');
        row.title = `${r.open ? 'Collapse' : 'Expand'} ${r.label}`;
        row.appendChild(mk('span', 'run-caret', r.open ? '▾' : '▸'));
        const kinds = r.k === 'tgroup' ? ['failed'] : Object.keys(r.counts);
        row.appendChild(glyph(r.failed ? 'err' : kinds.length === 1 ? RV.outcomeKind(kinds[0]) : 'ok'));
        row.appendChild(mk('span', 'run-name', r.label));
        const n = mk('span', 'run-cnt');
        const parts = [];
        let told = 0;
        if (r.failed) { parts.push(mk('span', 'bad', `${RV.fmtN(r.failed)} failed`)); told += r.failed; }
        if (r.k === 'group' && state.runUi.filter === 'all') {
          for (const o of ['skipped', 'rolledback', 'passed']) {
            if (r.counts[o]) { parts.push(`${RV.fmtN(r.counts[o])} ${RV.outcomeLabel(o, run).toLowerCase()}`); told += r.counts[o]; }
          }
        }
        // The size, unless the parts already add up to it.
        if (r.k === 'group' && told !== r.n) parts.push(RV.fmtN(r.n));
        parts.forEach((p, k) => { if (k) n.append(' · '); n.append(p); });
        row.appendChild(n);
        row.addEventListener('click', () => { setRunFocus(i, false); toggleRunGroup(i); });
        return row;
      }
      case 'leaf': {
        const x = r.row;
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', '2');
        row.appendChild(glyph(RV.outcomeKind(x.o)));
        const body = mk('div', 'run-body');
        const l1 = mk('div', 'run-l1');
        const name = mk('span', 'run-name', r.name);
        name.title = `${x.k} — ${RV.outcomeLabel(x.o, run)}`;
        l1.appendChild(name);
        if (x.f || x.l) l1.appendChild(location(x.k, `${x.f || r.name}${x.l ? `:${x.l}${x.c ? `:${x.c}` : ''}` : ''}`, x.l, x.c));
        const why = RV.whyText(x);
        if (why) l1.appendChild(mk('span', 'run-why-col', why));
        l1.appendChild(copyBtn(RV.rowCopyText(x, run)));
        body.appendChild(l1);
        if (x.m) {
          const m = mk('div', 'run-msg', x.m);
          m.title = x.m;
          body.appendChild(m);
        }
        row.appendChild(body);
        if (state.localKeys.has(x.k)) row.title = `Open ${x.k}`;
        row.addEventListener('click', () => { setRunFocus(i, false); openRunKey(x.k, x.l, x.c); });
        return row;
      }
      case 'test': {
        const t = r.test;
        const key = `ApexClass:${t.cls}`;
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', '2');
        row.appendChild(glyph('err'));
        const body = mk('div', 'run-body');
        const l1 = mk('div', 'run-l1');
        const name = mk('span', 'run-name', `${t.cls}.${t.method}`);
        name.title = name.textContent;
        l1.appendChild(name);
        if (t.l) l1.appendChild(location(key, `${t.cls}:${t.l}`, t.l, t.c));
        l1.appendChild(copyBtn(RV.testCopyText(t)));
        body.appendChild(l1);
        const m = mk('div', 'run-msg', t.m);
        m.title = t.m;
        body.appendChild(m);
        row.appendChild(body);
        row.addEventListener('click', () => { setRunFocus(i, false); openRunKey(key, t.l, t.c); });
        return row;
      }
    }
    return row;
  }

  function toggleRunGroup(i) {
    const r = runModel && runModel.rows[i];
    if (!r || (r.k !== 'group' && r.k !== 'tgroup')) return;
    state.runUi.folds[r.id] = !r.open;
    state.runUi.focus = i; // rows above a group never move when it folds
    refreshRunList();
  }

  const runFocusable = (i) => !!runModel && i >= 0 && i < runModel.rows.length && runModel.rows[i].k !== 'section' && runModel.rows[i].k !== 'note';
  function runStep(from, dir) {
    let j = from + dir;
    while (j >= 0 && j < runModel.rows.length && !runFocusable(j)) j += dir;
    return j >= 0 && j < runModel.rows.length ? j : from;
  }
  /** Move the keyboard focus to row i, scrolling the pane just enough to show it. */
  function setRunFocus(i, scroll) {
    if (!runFocusable(i)) return;
    state.runUi.focus = i;
    if (scroll !== false) {
      const st = $('status');
      const top = runList.offsetTop + runModel.offsets[i];
      const bottom = top + runModel.rows[i].h;
      if (top < st.scrollTop) st.scrollTop = top;
      else if (bottom > st.scrollTop + st.clientHeight) st.scrollTop = bottom - st.clientHeight;
    }
    paintRunList();
  }
  function activateRunRow(i) {
    const r = runModel.rows[i];
    if (!r) return;
    if (r.k === 'group' || r.k === 'tgroup') toggleRunGroup(i);
    else if (r.k === 'leaf') openRunKey(r.row.k, r.row.l, r.row.c);
    else if (r.k === 'test') openRunKey(`ApexClass:${r.test.cls}`, r.test.l, r.test.c);
  }
  function copyRunRow(i) {
    const r = runModel.rows[i];
    const run = state.runs[0];
    if (!r || !run) return;
    const text = r.k === 'leaf' ? RV.rowCopyText(r.row, run)
      : r.k === 'test' ? RV.testCopyText(r.test)
        : r.k === 'group' || r.k === 'tgroup' ? `${r.label} (${r.n})` : '';
    if (text) send('copyText', { text });
  }
  /** Tree keyboard: ↑↓ Home End PgUp PgDn move, ← → fold, Enter opens, c copies. */
  function onRunListKey(e) {
    if (!runModel || !runModel.rows.length) return;
    const i = state.runUi.focus;
    if (i < 0) {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(e.key)) { setRunFocus(runStep(-1, 1)); e.preventDefault(); }
      return;
    }
    const r = runModel.rows[i];
    const isGroup = (x) => x && (x.k === 'group' || x.k === 'tgroup');
    const page = Math.max(1, Math.floor($('status').clientHeight / RV.ROW_H.leaf));
    switch (e.key) {
      case 'ArrowDown': setRunFocus(runStep(i, 1)); break;
      case 'ArrowUp': setRunFocus(runStep(i, -1)); break;
      case 'PageDown': { let n = i; for (let k = 0; k < page; k++) n = runStep(n, 1); setRunFocus(n); break; }
      case 'PageUp': { let n = i; for (let k = 0; k < page; k++) n = runStep(n, -1); setRunFocus(n); break; }
      case 'Home': setRunFocus(runStep(-1, 1)); break;
      case 'End': setRunFocus(runStep(runModel.rows.length, -1)); break;
      case 'ArrowRight':
        if (isGroup(r)) { if (!r.open) toggleRunGroup(i); else setRunFocus(runStep(i, 1)); }
        break;
      case 'ArrowLeft':
        if (isGroup(r) && r.open) toggleRunGroup(i);
        else { let p = i - 1; while (p >= 0 && !isGroup(runModel.rows[p])) p--; if (p >= 0) setRunFocus(p); }
        break;
      case 'Enter': case ' ': activateRunRow(i); break;
      case 'c': case 'C': copyRunRow(i); break;
      default: return;
    }
    e.preventDefault();
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
        // `danger` paints destructive items (Delete from Org…) red via var(--err).
        el.className = 'ctx-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '');
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
    // Deploy/Validate queue behind a running op instead of refusing (mirrors
    // action() above); Retrieve/Diff/Delete/Open-in-Org still need the slot free.
    const queueableWhileBusy = kind === 'deploy' || kind === 'validate';
    if (state.pendingAction || (state.busy && !queueableWhileBusy) || !state.selectedOrg || !keys || !keys.length) return;
    if (kind === 'validate') return sendAction('deploy', { keys, validateOnly: true });
    sendAction(kind, { keys });
  }

  // Delete from Org: the provider previews (dry-run) and shows a destructive confirm
  // before anything is removed. Org-only rows ARE valid targets (unlike deploy/diff),
  // so there's no local-file gate here — only busy / no-org.
  function runDelete(keys) {
    if (state.pendingAction || state.busy || !state.selectedOrg || !keys || !keys.length) return;
    sendAction('deleteFromOrg', { keys });
  }

  // Deploy/Retrieve/Diff menu items for a set of component keys. Deploy and Diff need a
  // local file, so they're disabled when every key is org-only (mirrors the toolbar
  // buttons); the provider would otherwise just skip those keys.
  function actionItems(keys) {
    const arr = Array.from(keys);
    const hasLocal = arr.some(k => state.localKeys.has(k));
    const hasOrgAndKeys = !!state.selectedOrg && arr.length > 0;
    // Retrieve/Diff/Open-in-Org still need the slot free; Deploy/Validate can
    // queue behind a running op instead (queueBase — mirrors the toolbar's
    // busy-tolerant Deploy/Validate buttons in renderActions).
    const base = !state.busy && hasOrgAndKeys;
    const queueBase = hasOrgAndKeys;
    const orgTip = state.selectedOrg ? '' : 'Select an org first';
    const queueTip = state.busy ? `Will queue behind ${state.busyAction || 'the current operation'}` : '';
    const items = [
      { label: 'Deploy', disabled: !queueBase || !hasLocal, title: orgTip || (!hasLocal ? 'Org-only — retrieve it first (no local source to deploy)' : queueTip), run: () => runKeys('deploy', arr) },
      { label: 'Validate', disabled: !queueBase || !hasLocal, title: orgTip || (!hasLocal ? 'Org-only — nothing local to validate' : (queueTip || 'Check-only deploy: nothing is deployed; the Tests picker decides which tests run')), run: () => runKeys('validate', arr) },
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

  // The destructive Delete-from-Org item, kept in its own section (see
  // treeMenuSections). No local-file gate — org-only components are valid targets;
  // only busy / no-org disables it. The '…' signals a confirm step follows.
  function deleteItems(keys) {
    const arr = Array.from(keys);
    const base = !state.busy && !!state.selectedOrg && arr.length > 0;
    return [{
      label: 'Delete from Org…',
      danger: true,
      disabled: !base,
      title: state.selectedOrg
        ? 'Deletes the component(s) from the org AND removes the local source files. Cannot be undone by the plugin.'
        : 'Select an org first',
      run: () => runDelete(arr)
    }];
  }

  // Sections for a right-clicked tree target. The target (a folder's items, or one
  // component) is primary; the current checkbox selection is offered as a second section
  // when it differs — so "tick several, right-click, deploy" works too. A separated
  // danger section for Delete-from-Org always sits last, acting on the SAME target keys
  // Deploy uses (the right-clicked target).
  function treeMenuSections(targetKeys, targetLabel) {
    const sections = [{ head: targetLabel, items: actionItems(targetKeys), sep: true }];
    const sel = Array.from(state.selected);
    const tset = new Set(targetKeys);
    const sameAsTarget = sel.length === tset.size && sel.every(k => tset.has(k));
    if (sel.length > 0 && !sameAsTarget) {
      sections.push({ head: `Selected (${sel.length})`, items: actionItems(sel), sep: true });
    }
    // Danger zone — separated from the actions above, targets the right-clicked keys.
    sections.push({ items: deleteItems(targetKeys) });
    return sections;
  }

})();
