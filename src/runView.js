// @ts-nocheck
// Pure view logic for the Status pane's run cards: the outcome vocabulary, the
// verdict line, the count chips, the rows of the virtual list, the actions of
// the newest run and the text Copy puts on the clipboard. No DOM here — panel.js
// draws what these return, and the harnesses call them directly. Loaded by its
// own script tag before panel.js (window.RunView), or with require() in node.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RunView = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // ---- vocabulary ----
  // One label, colour and meaning per outcome, so the verdict, the chips, the
  // groups and the copied text can never disagree. Keys match runRecords.ts.
  const OUTCOMES = {
    deployed: { label: 'Deployed', kind: 'ok' },
    validated: { label: 'Validated', kind: 'ok' },
    rolledback: { label: 'Rolled back', kind: 'skip' },
    passed: { label: 'Passed', kind: 'skip' },
    failed: { label: 'Failed', kind: 'err' },
    skipped: { label: 'Skipped', kind: 'warn' },
    pending: { label: 'No result', kind: 'skip' },
    changed: { label: 'Updated', kind: 'ok' },
    created: { label: 'New', kind: 'info' },
    unchanged: { label: 'Unchanged', kind: 'skip' },
    missing: { label: 'Not on org', kind: 'warn' }
  };
  // Chip order, fixed per family: what landed first, then what didn't.
  const DEPLOY_CHIPS = ['deployed', 'validated', 'failed', 'rolledback', 'passed', 'pending', 'skipped'];
  const RETRIEVE_CHIPS = ['changed', 'created', 'unchanged', 'missing', 'failed', 'pending'];
  /** Fixed row heights (px) — the list is virtual, so every row's place is
   *  computed, never measured. A row with a message shows it on two lines. */
  const ROW_H = { section: 22, group: 24, leaf: 22, tall: 54, test: 54, note: 22 };
  /** Up to this many listed rows every group starts open; past it only the
   *  groups holding a failure do, so a 9,000-row success opens on its types. */
  const DEFAULT_OPEN_MAX = 300;
  /** Search appears once the list is longer than a glance. */
  const SEARCH_MIN_ROWS = 20;
  const GLYPH = { ok: '✓', err: '✗', skip: '•', warn: '•', info: '+', all: '•' };

  // ---- formatting ----
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtN(n) { return Number(n || 0).toLocaleString('en-US'); }
  function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }
  /** "today 14:02", "yesterday 14:02", else "Sep 2, 14:02" — 24-hour, so the
   *  same run reads the same in every locale. */
  function fmtWhen(at, now) {
    const d = new Date(at);
    const n = new Date(now === undefined ? Date.now() : now);
    const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (d.toDateString() === n.toDateString()) return 'today ' + hm;
    const y = new Date(n);
    y.setDate(n.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'yesterday ' + hm;
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + hm;
  }
  function fmtDate(at) { const d = new Date(at); return MONTHS[d.getMonth()] + ' ' + d.getDate(); }
  /** "0.4s", "41.0s", "4m 12s", "1h 03m". */
  function fmtDuration(ms) {
    if (!(ms >= 0)) return '';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    const s = Math.round(ms / 1000);
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + pad2(Math.floor((s % 3600) / 60)) + 'm';
  }
  /** "45s", "3m 12s" — the running clock. */
  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's';
  }
  function splitKey(k) {
    const c = k.indexOf(':');
    return c < 0 ? { type: '', name: k } : { type: k.slice(0, c), name: k.slice(c + 1) };
  }

  // ---- what a run did ----
  const VERB = {
    deploy: { Noun: 'Deploy', noun: 'deploy', ing: 'Deploying to', done: 'Deployed', prep: 'to' },
    validate: { Noun: 'Validation', noun: 'validation', ing: 'Validating on', done: 'Validated', prep: 'on' },
    quickDeploy: { Noun: 'Quick Deploy', noun: 'quick deploy', ing: 'Quick-deploying to', done: 'Quick-deployed', prep: 'to' },
    retrieve: { Noun: 'Retrieve', noun: 'retrieve', ing: 'Retrieving from', done: 'Retrieved', prep: 'from' }
  };
  const verbOf = (run) => VERB[run.op] || VERB.deploy;
  const cnt = (run, k) => ((run.counts || {})[k] || 0);
  /** The org marker inside a title's parts — panel.js draws it as the org name
   *  plus its PROD / sandbox / scratch pill. */
  const ORG = { org: true };

  /** A chip's or group's label. A row with no verdict from the org reads as not
   *  deployed when the run stopped before reaching it, and as no result when
   *  the org may still be working on it. */
  function outcomeLabel(o, run) {
    if (o === 'pending' && run && run.status === 'error') return run.op === 'validate' ? 'Not validated' : run.op === 'retrieve' ? 'Not retrieved' : 'Not deployed';
    if (o === 'pending' && run && run.status === 'running') return run.op === 'retrieve' ? 'Requested' : 'Sent';
    return (OUTCOMES[o] || { label: o }).label;
  }
  const outcomeKind = (o) => (OUTCOMES[o] || { kind: 'skip' }).kind;

  /**
   * The one-glance answer: glyph, a title (strings plus the ORG marker), a
   * sub-line (when · how long · tests — the chips carry the counts) and plain
   * lines for what the counts cannot say (all-or-nothing, the org's own
   * message, what to do next).
   */
  function verdictFor(run, ctx) {
    ctx = ctx || {};
    const v = verbOf(run);
    const org = run.orgLabel;
    const failedN = cnt(run, 'failed');
    const testsFailed = cnt(run, 'testsFailed');
    const out = { kind: 'neutral', glyph: '•', title: [], sub: '', plain: [] };
    const subParts = [];
    const when = fmtWhen(run.startedAt, ctx.now);
    if (run.status === 'running') {
      out.kind = 'run'; out.glyph = null;
      out.title = ctx.cancelRequested ? ['Cancelling on ', ORG, '…'] : [v.ing + ' ', ORG, '…'];
      out.sub = 'started ' + when;
      if (ctx.cancelRequested) out.plain.push({ kind: 'warn', text: 'The org was asked to stop; whatever it already processed is rolled back.' });
      return withNotes(out, run);
    }
    subParts.push(when);
    if (typeof run.finishedAt === 'number') subParts.push(fmtDuration(run.finishedAt - run.startedAt));
    if (typeof (run.counts || {}).testsRun === 'number' && run.counts.testsRun > 0) {
      subParts.push(fmtN(run.counts.testsRun - testsFailed) + '/' + fmtN(run.counts.testsRun) + ' tests passed');
    } else if (run.op === 'validate' && run.testsRan === false) subParts.push('no tests run');
    out.sub = subParts.join(' · ');
    const message = run.message ? { kind: 'err', text: run.message } : null;
    switch (run.status) {
      case 'succeeded':
        out.kind = 'ok'; out.glyph = '✓';
        if (run.op === 'validate') {
          out.title = ['Validated on ', ORG, ' — nothing deployed yet'];
          if (ctx.quick && ctx.quick.until) out.plain.push({ kind: '', text: 'Quick Deploy applies exactly this set without re-running tests — available until ' + fmtDate(ctx.quick.until) + '.' });
        } else if (run.op === 'retrieve') {
          const got = cnt(run, 'changed') + cnt(run, 'created') + cnt(run, 'unchanged');
          out.glyph = '↓';
          if (got === 0) { out.kind = 'warn'; out.title = ['Nothing retrieved from ', ORG]; } else out.title = ['Retrieved from ', ORG];
          if (run.backupDir) out.plain.push({ kind: '', text: 'Your local copies were backed up before being overwritten — Restore or Discard below.' });
        } else if (run.op === 'quickDeploy') {
          out.title = ['Quick-deployed to ', ORG];
          out.plain.push({ kind: '', text: 'Applied the set validated ' + (ctx.fromRun ? fmtWhen(ctx.fromRun.startedAt, ctx.now) : 'earlier') + ' — no tests were re-run.' });
        } else out.title = ['Deployed to ', ORG];
        break;
      case 'partial':
        out.kind = 'warn'; out.glyph = '⚠';
        if (run.op === 'retrieve') {
          out.glyph = '↓';
          out.title = ['Retrieved from ', ORG, ' — ' + fmtN(failedN) + ' ' + plural(failedN, 'component') + ' failed'];
          if (run.backupDir) out.plain.push({ kind: '', text: 'Your local copies were backed up before being overwritten — Restore or Discard below.' });
        } else {
          out.title = ['Partly deployed to ', ORG];
          out.plain.push({ kind: 'warn', text: org + ' applied some of these and rejected others.' });
        }
        if (message) out.plain.push(message);
        break;
      case 'failed':
        out.kind = 'err'; out.glyph = '✗';
        if (run.op === 'retrieve') out.title = ['Retrieve from ', ORG, ' failed'];
        else if (run.op === 'quickDeploy') {
          out.title = ['Quick Deploy failed on ', ORG];
          out.plain.push({ kind: 'err', text: 'The validation may have expired (validated deployments are valid for about 10 days; the org may also have changed).' });
        } else {
          const not = run.op === 'validate' ? 'Not validated' : 'Not deployed';
          out.title = testsFailed > 0 && failedN === 0 ? [not + ' — tests failed on ', ORG] : [not + ' — ', ORG, ' rejected the ' + v.noun];
          out.plain.push({ kind: 'err', text: run.op === 'validate'
            ? 'Nothing is deployed by a validation; fix the failures and validate again.'
            : 'Nothing changed on ' + org + ': a deploy is all-or-nothing.' });
        }
        if (message) out.plain.push(message);
        break;
      case 'cancelled':
        out.glyph = '⊘';
        out.title = run.op === 'retrieve' ? ['Retrieve from ', ORG, ' cancelled'] : ['Cancelled — nothing changed on ', ORG];
        if (typeof (run.counts || {}).orgTotal === 'number' && run.op !== 'retrieve') {
          out.plain.push({ kind: '', text: fmtN(cnt(run, 'orgDeployed')) + ' of ' + fmtN(run.counts.orgTotal) + ' components had been processed when the org stopped and rolled back.' });
        }
        break;
      case 'cancelUnconfirmed':
        out.kind = 'warn'; out.glyph = '⊘';
        out.title = ['Cancel requested — ', ORG, ' may still finish'];
        // A note says it in its own words (the submit was stopped, the cancel is
        // still finishing…); the general line is for a run without one.
        if (!(run.notes || []).length) out.plain.push({ kind: 'warn', text: "The org was asked to stop, but its final state couldn't be confirmed — check Deployment Status in the org." });
        break;
      case 'lost':
        out.kind = 'warn'; out.glyph = '⚠';
        out.title = ['Lost contact with the ' + v.noun + ' ' + v.prep + ' ', ORG];
        out.plain.push({ kind: 'warn', text: 'It may still be running. Resume monitoring checks the same job — it does not deploy again.' });
        break;
      case 'timeout':
        out.kind = 'warn'; out.glyph = '⚠';
        out.title = ['Timed out waiting for ', ORG];
        // A retrieve's hint says what its timeout means for local files.
        if (run.op !== 'retrieve') out.plain.push({ kind: 'warn', text: 'Stopping the wait did not stop the org — it may still finish this. Check Deployment Status in the org.' });
        if (message) out.plain.push(message);
        if (run.hint) out.plain.push({ kind: 'muted', text: 'Hint: ' + run.hint });
        break;
      case 'error':
        out.kind = 'err'; out.glyph = '✗';
        out.title = run.op === 'retrieve' ? ['Retrieve from ', ORG, ' failed — nothing was retrieved'] : [v.Noun + ' ' + v.prep + ' ', ORG, " didn't start"];
        if (message) out.plain.push(message);
        if (run.hint) out.plain.push({ kind: 'warn', text: 'Hint: ' + run.hint });
        for (const a of run.cliActions || []) out.plain.push({ kind: 'muted', text: 'Try: ' + a });
        break;
      case 'interrupted':
        out.glyph = '⊘';
        out.title = ['Interrupted — ', ORG];
        break;
      default:
        out.title = [run.status + ' — ', ORG];
    }
    return withNotes(out, run);
  }
  function withNotes(out, run) {
    for (const n of run.notes || []) out.plain.push({ kind: 'muted', text: n });
    return out;
  }
  /** The title as plain text (Copy, tooltips). */
  function titleText(run, ctx) {
    return verdictFor(run, ctx).title.map((p) => (p === ORG ? run.orgLabel : p)).join('');
  }

  /** One chip per outcome the run has rows of, plus test failures, after
   *  "All". Failed stays as a disabled "Failed 0" — the one zero worth
   *  reading; any other zero, and an outcome the run cannot know (no count at
   *  all), gets no chip: the pane is short. */
  function chipDefs(run) {
    const c = run.counts || {};
    const order = run.op === 'retrieve' ? RETRIEVE_CHIPS : DEPLOY_CHIPS;
    const chips = [];
    let all = 0;
    for (const o of order) {
      if (typeof c[o] !== 'number' || (c[o] === 0 && o !== 'failed')) continue;
      chips.push({ id: o, label: outcomeLabel(o, run), n: c[o], kind: outcomeKind(o), disabled: c[o] === 0 });
      all += c[o];
    }
    if (typeof c.testsFailed === 'number' && c.testsFailed > 0) {
      chips.push({ id: 'tests', label: 'Tests failed', n: c.testsFailed, kind: 'err', disabled: false });
      all += c.testsFailed;
    }
    return [{ id: 'all', label: 'All', n: all, kind: 'all', disabled: all === 0 }].concat(chips);
  }

  /** Why skipped rows were skipped, in the words the result card has used: a
   *  type this panel cannot read from the project may be there unseen, so it
   *  is never called org-only. Counts come from the rows (unread ones lead). */
  function skippedSentences(run, rows) {
    const total = cnt(run, 'skipped');
    const unreadRows = (rows || []).filter((r) => r.o === 'skipped' && r.why === 'unread');
    const unread = unreadRows.length;
    const orgOnly = Math.max(0, total - unread);
    const out = [];
    if (unread) {
      const types = [...new Set(unreadRows.map((r) => splitKey(r.k).type))].sort();
      out.push(unread + ' skipped — this panel can\'t read ' + types.join(', ') + ' from your project: if you have ' + (unread === 1 ? 'it' : 'them') + ' locally, ' + (unread === 1 ? 'it was' : 'they were') + ' NOT deployed — deploy them from the Explorer (right-click the -meta.xml) or with a package.xml.');
    }
    if (orgOnly) out.push(orgOnly + ' skipped — selected, but ' + (orgOnly === 1 ? 'it exists' : 'they exist') + ' only on the org, so there was no local file to deploy.');
    return out.join(' ');
  }

  /**
   * The line under the chips: what the active filter means, or — with no
   * filter — one legend line for the labels that need words: rolled back
   * first (a failed deploy's most surprising word), then passed, then skipped.
   * Returns { lead, text, more? }: each `lead` is drawn bold; `more` continues
   * the same line. An empty `text` means there is nothing to say.
   */
  function explainFor(run, filter, rows) {
    const org = run.orgLabel;
    const v = verbOf(run);
    const c = run.counts || {};
    const none = { lead: '', text: '' };
    switch (filter || 'all') {
      case 'all': {
        const parts = [];
        if (c.rolledback) parts.push({ lead: 'Rolled back', text: ' = fine on its own, but not applied: a deploy is all-or-nothing.' });
        if (c.passed) parts.push({ lead: 'Passed', text: ' = checked fine on its own; a validation applies nothing either way.' });
        if (c.skipped) parts.push({ lead: 'Skipped', text: ' = never sent, so neither deployed nor failed — the Skipped chip says why.' });
        if (!parts.length) return none;
        return parts.length > 1 ? Object.assign({}, parts[0], { more: parts.slice(1) }) : parts[0];
      }
      case 'deployed': return { lead: '', text: 'Live on ' + org + ' now.' };
      case 'validated': return { lead: '', text: 'Would deploy cleanly. Nothing has been sent to ' + org + ' yet.' };
      case 'failed':
        if (run.op === 'retrieve') return { lead: '', text: org + ' could not return these.' };
        if (run.op === 'validate') return { lead: '', text: org + ' rejected these, so the validation failed.' };
        if (run.status === 'partial') return { lead: '', text: org + ' rejected these; the rest were applied.' };
        return { lead: '', text: org + ' rejected these. A deploy is all-or-nothing, so nothing from this run was applied.' };
      case 'rolledback': {
        const why = c.failed ? fmtN(c.failed) + ' ' + plural(c.failed, 'component') + ' failed'
          : c.testsFailed ? 'tests failed'
            : run.status === 'cancelled' ? 'the deploy was cancelled' : 'the deploy failed';
        return { lead: '', text: 'Fine on their own, but a deploy is all-or-nothing: because ' + why + ', none of these were applied. ' + org + ' is unchanged.' };
      }
      case 'passed': return { lead: '', text: 'Checked fine on their own. A validation applies nothing, and this one failed, so there is nothing to quick-deploy.' };
      case 'skipped': return { lead: '', text: skippedSentences(run, rows) };
      case 'pending':
        if (run.op === 'retrieve') {
          if (run.status === 'error') return { lead: '', text: 'The retrieve stopped before ' + org + ' returned anything — nothing was written.' };
          if (run.status === 'running') return { lead: '', text: 'Requested from ' + org + '; the files arrive when the retrieve finishes.' };
          return { lead: '', text: 'Requested from ' + org + ', but no result came back — files may be partly written. Check your working tree.' };
        }
        if (run.status === 'error') return { lead: '', text: 'The ' + v.noun + ' stopped before reaching ' + org + ' — nothing from this run was applied.' };
        if (run.status === 'running') return { lead: '', text: 'Sent to ' + org + '; each component\'s result arrives when the org finishes.' };
        return { lead: '', text: 'Sent to ' + org + ', but no result came back — the org may still apply them. Check Deployment Status in the org.' };
      case 'changed': return { lead: '', text: 'Local files overwritten with the ' + org + ' version.' + (run.backupDir ? ' The old copies were backed up first.' : '') };
      case 'created': return { lead: '', text: 'Files that did not exist in the project before.' };
      case 'unchanged': return { lead: '', text: 'Identical to ' + org + ' — nothing was written.' };
      case 'missing': return { lead: '', text: 'Asked for, but ' + org + ' has no such component — nothing to retrieve.' };
      case 'tests': return { lead: '', text: 'These Apex tests failed on ' + org + ' while it ran the tests for this ' + v.noun + (run.op === 'validate' ? '.' : '; the whole deploy was rolled back.') };
      default: return none;
    }
  }

  /** The reason column of a row, when its label needs one. */
  function whyText(row) {
    if (row.o === 'skipped') return row.why === 'unread' ? 'not read from your project (right-click its -meta.xml to deploy)' : 'no local source (retrieve first)';
    if (row.o === 'missing') return 'not on the org';
    return '';
  }

  /** "Deployed 9,047 → acme-dev · 2,535 skipped" — an older run in one line. */
  function histLabel(run) {
    const org = run.orgLabel;
    const v = verbOf(run);
    const skipped = cnt(run, 'skipped');
    const skip = skipped ? ' · ' + fmtN(skipped) + ' skipped' : '';
    const errs = () => (cnt(run, 'testsFailed') && !cnt(run, 'failed') ? fmtN(cnt(run, 'testsFailed')) + ' ' + plural(cnt(run, 'testsFailed'), 'test') + ' failed' : fmtN(cnt(run, 'failed')) + ' ' + plural(cnt(run, 'failed'), 'error'));
    const arrow = run.op === 'retrieve' ? ' ← ' : ' → ';
    switch (run.status) {
      case 'running': return { kind: 'info', glyph: '◐', text: v.ing + ' ' + org + '…' };
      case 'cancelled': return { kind: 'skip', glyph: '⊘', text: 'Cancelled ' + v.noun + arrow + org };
      case 'cancelUnconfirmed': return { kind: 'warn', glyph: '⊘', text: 'Cancel unconfirmed' + arrow + org };
      case 'lost': return { kind: 'warn', glyph: '⚠', text: 'Lost contact' + arrow + org };
      case 'timeout': return { kind: 'warn', glyph: '⚠', text: 'Timed out' + arrow + org };
      case 'interrupted': return { kind: 'skip', glyph: '⊘', text: 'Interrupted ' + v.noun + arrow + org };
      case 'error': return { kind: 'err', glyph: '✗', text: v.Noun + (run.op === 'retrieve' ? ' failed' : ' didn\'t start') + arrow + org };
    }
    if (run.op === 'retrieve') {
      const got = cnt(run, 'changed') + cnt(run, 'created') + cnt(run, 'unchanged');
      const failed = cnt(run, 'failed');
      const missing = cnt(run, 'missing');
      return {
        kind: failed ? 'err' : got ? 'ok' : 'warn', glyph: '↓',
        text: (got || failed ? 'Retrieved ' + fmtN(got) : 'Nothing retrieved') + arrow + org + (failed ? ' · ' + fmtN(failed) + ' failed' : '') + (missing ? ' · ' + fmtN(missing) + ' not on org' : '')
      };
    }
    if (run.status === 'succeeded') {
      if (run.op === 'validate') return { kind: 'ok', glyph: '✓', text: 'Validated ' + fmtN(cnt(run, 'validated')) + ' on ' + org + (run.testsRan === false ? ' · no tests' : '') + skip };
      return { kind: 'ok', glyph: '✓', text: v.done + ' ' + fmtN(cnt(run, 'deployed')) + arrow + org + skip };
    }
    if (run.status === 'partial') return { kind: 'warn', glyph: '⚠', text: 'Partly deployed' + arrow + org + ' · ' + errs() };
    const what = run.op === 'validate' ? 'Validation failed on ' : run.op === 'quickDeploy' ? 'Quick Deploy failed' + arrow : 'Deploy failed' + arrow;
    return { kind: 'err', glyph: '✗', text: what + org + ' · ' + errs() };
  }

  // ---- the list ----
  function terms(q) { return String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean); }
  function matches(t, hay) {
    const s = hay.toLowerCase();
    for (const x of t) if (!s.includes(x)) return false;
    return true;
  }
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  /** Group the rows the filter and search leave — cached on the inputs, so a
   *  fold or a scroll never re-sorts ten thousand rows. */
  function groupRows(run, rows, tests, filter, q, cache) {
    if (cache && cache.rows === rows && cache.tests === tests && cache.filter === filter && cache.q === q && cache.run === run) return cache.grouped;
    const t = terms(q);
    const visible = [];
    const visibleTests = [];
    const types = new Map();
    let listed = 0;
    let skippedListed = 0;
    if (filter !== 'tests') {
      for (const r of rows) {
        if (filter !== 'all' && r.o !== filter) continue;
        listed++;
        if (r.o === 'skipped') skippedListed++;
        const { type, name } = splitKey(r.k);
        if (t.length && !matches(t, name + ' ' + type + ' ' + (r.m || '') + ' ' + (r.f || ''))) continue;
        let g = types.get(type);
        if (!g) { g = { type, items: [], counts: {}, failed: 0 }; types.set(type, g); }
        g.items.push({ row: r, name });
        g.counts[r.o] = (g.counts[r.o] || 0) + 1;
        if (r.o === 'failed') g.failed++;
        visible.push(r);
      }
    }
    const groups = [...types.values()].sort((a, b) => b.failed - a.failed || b.items.length - a.items.length || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
    for (const g of groups) g.items.sort((a, b) => (b.row.o === 'failed') - (a.row.o === 'failed') || byName(a, b));
    const classes = new Map();
    if ((filter === 'all' || filter === 'tests') && tests.length) {
      for (const x of tests) {
        if (t.length && !matches(t, x.cls + ' ' + x.method + ' ' + (x.m || ''))) continue;
        let g = classes.get(x.cls);
        if (!g) { g = { cls: x.cls, items: [] }; classes.set(x.cls, g); }
        g.items.push(x);
        visibleTests.push(x);
      }
    }
    const tgroups = [...classes.values()].sort((a, b) => b.items.length - a.items.length || (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : 0));
    for (const g of tgroups) g.items.sort((a, b) => (a.method < b.method ? -1 : a.method > b.method ? 1 : 0));
    const grouped = { groups, tgroups, visible, visibleTests, listed, skippedListed };
    if (cache) Object.assign(cache, { rows, tests, filter, q, run, grouped });
    return grouped;
  }

  /**
   * The flat rows of the virtual list for the current filter, search and
   * folds: sections, type groups (most failures first, then biggest), leaves
   * (failures first, then by name), the "Apex test failures" section grouped
   * by class, and a note when the counts say more exists than is listed.
   * `offsets[i]` is where row i starts; `totalH` is the list's height.
   */
  function buildRows(run, rows, tests, ui, opts) {
    opts = opts || {};
    rows = rows || [];
    tests = tests || [];
    const filter = ui.filter || 'all';
    const folds = ui.folds || {};
    const g = groupRows(run, rows, tests, filter, ui.q || '', opts.cache);
    const leaves = g.visible.length + g.visibleTests.length;
    const autoOpen = leaves <= DEFAULT_OPEN_MAX;
    const out = [];
    const isOpen = (id, dflt) => (id in folds ? folds[id] : ui.openAll !== undefined ? ui.openAll : dflt);
    if (g.groups.length && g.tgroups.length) out.push({ k: 'section', h: ROW_H.section, label: 'Components', n: g.visible.length });
    for (const grp of g.groups) {
      const id = filter + '|c|' + grp.type;
      const open = isOpen(id, autoOpen || grp.failed > 0);
      out.push({ k: 'group', h: ROW_H.group, id, label: grp.type, n: grp.items.length, counts: grp.counts, failed: grp.failed, open });
      if (open) for (const it of grp.items) out.push({ k: 'leaf', h: it.row.m ? ROW_H.tall : ROW_H.leaf, row: it.row, name: it.name, type: grp.type });
    }
    // Rows the counts know about but the list does not hold: a summary kept
    // across a reload, or an org report that counted without itemizing.
    if (!String(ui.q || '').trim() && filter !== 'tests') {
      const c = run.counts || {};
      const order = run.op === 'retrieve' ? RETRIEVE_CHIPS : DEPLOY_CHIPS;
      const known = filter === 'all' ? order.reduce((s, o) => s + (typeof c[o] === 'number' ? c[o] : 0), 0) : (c[filter] || 0);
      const missingRows = known - g.listed;
      // A run picked up again after a reload keeps only some of the rows it
      // skipped before the reload; it knows the rest by count.
      const skippedGap = opts.complete && (filter === 'all' || filter === 'skipped')
        ? Math.min(missingRows, (typeof c.skipped === 'number' ? c.skipped : 0) - g.skippedListed) : 0;
      if (skippedGap > 0) {
        out.push({ k: 'note', h: ROW_H.note, text: fmtN(skippedGap) + ' more skipped ' + plural(skippedGap, 'row') + ' not listed — only ' + fmtN(g.skippedListed) + ' were kept across the window reload.' });
      }
      const otherGap = missingRows - Math.max(0, skippedGap);
      if (otherGap > 0) {
        out.push({ k: 'note', h: ROW_H.note, text: fmtN(otherGap) + ' more ' + plural(otherGap, 'row') + ' not listed — ' + (opts.complete
          ? 'the org counted them without itemizing them.'
          : 'the full list is kept for the newest run only, and was not available after the window reloaded.') });
      }
    }
    if (g.tgroups.length) {
      if (g.groups.length || filter === 'all') out.push({ k: 'section', h: ROW_H.section, label: 'Apex test failures', n: g.visibleTests.length });
      for (const grp of g.tgroups) {
        const id = filter + '|t|' + grp.cls;
        const open = isOpen(id, true);
        out.push({ k: 'tgroup', h: ROW_H.group, id, label: grp.cls, n: grp.items.length, failed: grp.items.length, open });
        if (open) for (const x of grp.items) out.push({ k: 'test', h: ROW_H.test, test: x });
      }
    }
    if ((filter === 'all' || filter === 'tests') && !String(ui.q || '').trim()) {
      const moreTests = cnt(run, 'testsFailed') - tests.length;
      if (moreTests > 0) out.push({ k: 'note', h: ROW_H.note, text: fmtN(moreTests) + ' more test ' + plural(moreTests, 'failure') + ' not listed.' });
    }
    const offsets = new Array(out.length + 1);
    let y = 0;
    for (let i = 0; i < out.length; i++) { offsets[i] = y; y += out[i].h; }
    offsets[out.length] = y;
    return { rows: out, offsets, totalH: y, visible: g.visible, visibleTests: g.visibleTests, leaves, groups: g.groups.length + g.tgroups.length };
  }

  /**
   * The slice of rows to put in the DOM: every row that intersects
   * [top, top + height) — in list coordinates — plus `overscan` rows either
   * side. Returns [first, end) with `end` exclusive.
   */
  function visibleRange(offsets, count, top, height, overscan) {
    if (!count) return [0, 0];
    let first = 0;
    let lo = 0, hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= top) { first = mid; lo = mid + 1; } else hi = mid - 1;
    }
    let last = first;
    while (last + 1 < count && offsets[last + 1] < top + height) last++;
    return [Math.max(0, first - overscan), Math.min(count, last + 1 + overscan)];
  }

  // ---- actions ----
  /**
   * The buttons of a run card and, when an expected action is missing, the
   * one-line reason. Only the newest run acts; any other run can only be
   * copied. Gating mirrors the toolbar: an action that takes the operation
   * slot waits for the answer to the previous click (`pending`) and for the
   * slot (`busy`) — except Retry, which queues while busy like Deploy does.
   *
   * ctx: { isLatest, busy, pending, busyAction, complete (the list holds every
   *   row), sent (keys the run sent), selectKeys (visible rows with local
   *   source), filterLabel, quick, suggest, quickUsed, suggestDone }
   * Each button: { id, label, primary, message, via: 'action'|'send'|'open'|'copy', disabled, title }
   */
  function actionsFor(run, ctx) {
    ctx = ctx || {};
    const buttons = [];
    let why = '';
    if (run.status === 'running') return { buttons, why };
    const copy = { id: 'copy', label: ctx.filterLabel ? 'Copy ' + ctx.filterLabel + ' rows' : 'Copy list', via: 'copy', disabled: false, title: 'Copy the rows shown, with file names and messages, as text' };
    if (!ctx.isLatest) return { buttons: [copy], why };
    const slotBusy = !!(ctx.busy || ctx.pending);
    const slotTitle = (t) => (ctx.pending ? 'Sending…' : ctx.busy ? 'Locked while ' + (ctx.busyAction || 'an operation') + ' is running' : t);
    const deployFamily = run.op === 'deploy' || run.op === 'validate';
    // Retry: the same set again, with the options it ran with.
    if (deployFamily && (run.status === 'failed' || run.status === 'error') && run.retry) {
      const manifest = !!run.retry.manifest;
      const keys = ctx.sent || [];
      if (!manifest && (!ctx.complete || !keys.length)) {
        why = 'Retry needs the full list of what this run sent, and it wasn\'t kept after the window reloaded — select the components and deploy again.';
      } else {
        const request = Object.assign({}, run.retry);
        if (!manifest) request.keys = keys.slice();
        const queueTitle = ctx.pending ? 'Sending…' : ctx.busy ? 'Will queue behind ' + (ctx.busyAction || 'the running operation') : 'Run the same set again';
        buttons.push({ id: 'retry', label: run.retry.validateOnly ? 'Retry validation' : 'Retry deploy', primary: true, message: { type: 'retryDeploy', request }, via: 'action', disabled: !!ctx.pending, title: queueTitle });
        if (run.conflict && !run.retry.validateOnly) {
          buttons.push({ id: 'retryOverwrite', label: 'Retry + overwrite', message: { type: 'retryDeploy', request: Object.assign({}, request, { ignoreConflicts: true }) }, via: 'action', disabled: !!ctx.pending, title: ctx.pending ? 'Sending…' : 'Run it again with --ignore-conflicts: newer changes in the org are replaced' });
        }
      }
    }
    if (ctx.suggest && ctx.suggest.candidates && ctx.suggest.candidates.length && !ctx.suggestDone && (run.status === 'failed' || run.status === 'error')) {
      buttons.push({ id: 'suggest', label: 'Try with dependencies (' + ctx.suggest.candidates.length + ')', via: 'open', disabled: false, title: 'Review the missing components this failure references and retry with a selection of them.' });
    }
    if (run.op === 'validate' && run.status === 'succeeded') {
      if (ctx.quick && ctx.quick.jobId && !ctx.quickUsed) {
        buttons.push({ id: 'quickDeploy', label: 'Quick Deploy ' + fmtN(cnt(run, 'validated')) + ' to ' + run.orgLabel, primary: true, message: { type: 'quickDeploy', jobId: ctx.quick.jobId }, via: 'action', disabled: slotBusy, title: slotTitle('Deploy the validated set — skips validation and the test run') });
      } else if (!ctx.quickUsed) {
        why = run.testsRan === false
          ? 'Quick Deploy isn\'t possible: no Apex tests ran in this validation, and the org only quick-deploys one that ran them — validate again with a test level.'
          : 'Quick Deploy isn\'t offered after the window reloads — validate again to deploy this set without re-running tests.';
      }
    }
    if (run.status === 'lost' && run.jobId) {
      buttons.push({ id: 'resume', label: 'Resume monitoring', primary: true, message: { type: 'resumeDeploy', jobId: run.jobId }, via: 'action', disabled: slotBusy, title: slotTitle('Check the same job again — it does not deploy again') });
    }
    if (run.op === 'retrieve' && run.backupDir && run.status !== 'error') {
      buttons.push({ id: 'restore', label: 'Restore backup…', message: { type: 'restoreBackup', dir: run.backupDir }, via: 'action', disabled: slotBusy, title: slotTitle('Put the overwritten local files back') });
      buttons.push({ id: 'discard', label: 'Discard backup', message: { type: 'discardBackup', dir: run.backupDir }, via: 'action', disabled: slotBusy, title: slotTitle('Delete the backup of the overwritten files') });
    }
    const selectable = run.status === 'succeeded' || run.status === 'failed' || run.status === 'partial' || run.status === 'error';
    const keys = ctx.selectKeys || [];
    if (selectable && keys.length) {
      buttons.push({ id: 'select', label: 'Select ' + fmtN(keys.length) + (ctx.filterLabel ? ' ' + ctx.filterLabel : '') + ' in tree', message: { type: 'selectDeployed', keys: keys.slice() }, via: 'send', disabled: false, title: 'Tick exactly these rows in the component tree' });
    }
    buttons.push(copy);
    return { buttons, why };
  }

  // ---- copy ----
  function rowCopyText(row, run) {
    const { type, name } = splitKey(row.k);
    const parts = [type + ':' + name, outcomeLabel(row.o, run)];
    if (row.f || row.l) parts.push((row.f || name) + (row.l ? ':' + row.l + (row.c ? ':' + row.c : '') : ''));
    if (row.m) parts.push(row.m.replace(/\s*\n\s*/g, ' · '));
    const why = whyText(row);
    if (why) parts.push(why);
    return parts.join(' — ');
  }
  function testCopyText(t) {
    return [t.cls + '.' + t.method, t.l ? 'line ' + t.l + (t.c ? ', column ' + t.c : '') : '', t.m].filter(Boolean).join(' — ');
  }
  /** The rows shown, as text: the verdict, then one block per type and one for
   *  test failures. */
  function copyText(run, rows, tests, ctx) {
    const v = verdictFor(run, ctx);
    const out = [titleText(run, ctx) + (v.sub ? ' · ' + v.sub : '')];
    for (const p of v.plain) out.push(p.text);
    const byType = new Map();
    for (const r of rows || []) {
      const type = splitKey(r.k).type;
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(r);
    }
    for (const [type, list] of byType) {
      out.push('', type + ' (' + list.length + ')');
      for (const r of list) out.push('  ' + rowCopyText(r, run));
    }
    if (tests && tests.length) {
      out.push('', 'Apex test failures (' + tests.length + ')');
      for (const t of tests) out.push('  ' + testCopyText(t));
    }
    return out.join('\n');
  }

  return {
    OUTCOMES, DEPLOY_CHIPS, RETRIEVE_CHIPS, ROW_H, DEFAULT_OPEN_MAX, SEARCH_MIN_ROWS, GLYPH, ORG,
    fmtN, fmtWhen, fmtDate, fmtDuration, fmtElapsed, plural, splitKey,
    outcomeLabel, outcomeKind, verdictFor, titleText, chipDefs, explainFor, whyText, histLabel,
    buildRows, visibleRange, actionsFor, rowCopyText, testCopyText, copyText
  };
});
