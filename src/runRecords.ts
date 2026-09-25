// Run records: what the Status pane knows about one deploy, validation, quick
// deploy or retrieve. The provider builds them from a finished CLI result and
// keeps a short history of them; the webview only ever renders what it is given.
// No vscode here on purpose — this is the part the harness drives directly.
import type { DeployFileResult, DeployResult, DeployTestFailure, RetrieveFileResult, RetrieveResult, TestLevel } from './sfCliService';
import { fileProblem, fileType, retrieveProblem, stripAnsi } from './sfCliService';

export type RunOp = 'deploy' | 'validate' | 'quickDeploy' | 'retrieve';
/** `partial` is the org's SucceededPartial (never requested by this extension —
 *  deploys are all-or-nothing — but read honestly if it ever arrives). */
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'partial'
  | 'cancelled' | 'cancelUnconfirmed' | 'lost' | 'error' | 'timeout' | 'interrupted';
/** What happened to one component. The deploy family and retrieve share
 *  `failed`; `rolledback` and `passed` exist because a failed deploy undoes
 *  everything, so a component that was fine on its own was still not applied.
 *  `pending` is a sent component the org never gave a verdict on: the run
 *  stopped before reaching it, or contact was lost. */
export type Outcome = 'deployed' | 'validated' | 'rolledback' | 'passed' | 'failed' | 'skipped' | 'pending'
  | 'changed' | 'created' | 'unchanged' | 'missing';
export type OrgKind = 'prod' | 'sandbox' | 'scratch' | 'other';
/** Where the rows came from: the user's selection (or a single pointed-at
 *  file), a package.xml, or the org's own report (a reattached job, a quick
 *  deploy) when no selection survives. */
export type RunTarget = 'selection' | 'sourceDir' | 'manifest' | 'report';

export const RUN_OPS: readonly RunOp[] = ['deploy', 'validate', 'quickDeploy', 'retrieve'];
export const RUN_STATUSES: readonly RunStatus[] = ['running', 'succeeded', 'failed', 'partial',
  'cancelled', 'cancelUnconfirmed', 'lost', 'error', 'timeout', 'interrupted'];
export const OUTCOMES: readonly Outcome[] = ['deployed', 'validated', 'rolledback', 'passed', 'failed', 'skipped', 'pending',
  'changed', 'created', 'unchanged', 'missing'];
const ORG_KINDS: readonly OrgKind[] = ['prod', 'sandbox', 'scratch', 'other'];
const TARGETS: readonly RunTarget[] = ['selection', 'sourceDir', 'manifest', 'report'];

/** One component of a run. Short keys: the newest run's full list can be
 *  thousands of rows, and it travels to the webview and to disk. */
export interface RunRow {
  /** Type:Name */
  k: string;
  o: Outcome;
  /** Sent: part of the request, so part of a Retry. Skipped rows never are. */
  s?: 1;
  /** Why a skipped row was skipped: no local file (it exists only on the org),
   *  or a type this panel does not read from the project. */
  why?: 'org' | 'unread';
  /** The org's message (failures), at most ROW_MESSAGE_MAX characters. */
  m?: string;
  /** Line and column of the first reported error. */
  l?: number;
  c?: number;
  /** Leaf file name the error was reported against — display only. */
  f?: string;
}

/** One failed Apex test. Passing tests are counted, never listed. */
export interface TestRow {
  cls: string;
  method: string;
  m: string;
  l?: number;
  c?: number;
}

/** Exact totals, kept even when `rows` is trimmed. An outcome that is absent
 *  (rather than 0) is one this run cannot know — a reattached job has no record
 *  of what was skipped before the reload. */
export type RunCounts = Partial<Record<Outcome, number>> & {
  sent?: number;
  testsRun?: number;
  testsFailed?: number;
  orgDeployed?: number;
  orgTotal?: number;
  orgErrors?: number;
};

/** Everything a Retry needs besides the keys — the keys are the run's own sent
 *  rows, so they are never stored twice. */
export interface RunRetry {
  validateOnly: boolean;
  testLevel?: TestLevel;
  runTests?: string[];
  sourceDir?: string;
  manifest?: string;
}

export interface RunRecord {
  v: 1;
  id: string;
  op: RunOp;
  status: RunStatus;
  org: string;
  orgLabel: string;
  orgKind: OrgKind;
  startedAt: number;
  finishedAt?: number;
  jobId?: string;
  target: RunTarget;
  testLevel?: TestLevel;
  testsRan?: boolean;
  counts: RunCounts;
  rows: RunRow[];
  /** True only when `rows` holds every row of the run. */
  rowsComplete: boolean;
  /** Test failures only. */
  tests: TestRow[];
  /** The org's request-level message, or the CLI's error text. */
  message?: string;
  hint?: string;
  cliActions?: string[];
  notes?: string[];
  retry?: RunRetry;
  /** The failure was the CLI's source-conflict check: offer Retry + overwrite. */
  conflict?: boolean;
  /** Pre-retrieve backup folder, validated again when a button uses it. */
  backupDir?: string;
  /** The dependency suggestion this failure produced; the suggestion itself is
   *  live state the provider merges in when it posts the run. */
  suggestId?: string;
  /** A quick deploy's validation. */
  fromRunId?: string;
}

/** What the workspace keeps: newest run first. */
export interface RunsState {
  v: 1;
  runs: RunRecord[];
}

/** Anything the rows are built from: a resolved selection item or an org row. */
export interface RunItem {
  type: string;
  name: string;
  filePath?: string;
}

export const RUN_ID_RE = /^[a-z0-9]{6,24}$/;
/** A Metadata API deploy id — the only job id a button may hand back to the CLI. */
export const DEPLOY_JOB_ID_RE = /^0Af[A-Za-z0-9]{12,15}$/;

/** Setting bounds for how many runs are kept (sfOrgDeployWrapper.statusHistoryRuns). */
export const RUN_CAP_DEFAULT = 3;
export const RUN_CAP_MAX = 10;
/** Notices (Fetch Org, diff, delete, login…) are kept apart from runs, at most this many. */
export const NOTICES_MAX = 10;

export const ROW_MESSAGE_MAX = 500;
const KEY_MAX = 600;
const LEAF_MAX = 255;
const NOTE_MAX = 500;
const NOTES_MAX = 5;
const PATH_MAX = 1024;

/** Summary caps. The newest run keeps its failures and a taste of its skipped
 *  rows so the card still says something useful when its full list is gone;
 *  older runs are one-liners whose expansion only needs the failures. */
const LATEST_FAILED_ROWS = 100;
const LATEST_SKIPPED_ROWS = 50;
const LATEST_TESTS = 50;
const LATEST_MESSAGE_MAX = 2000;
const OLDER_FAILED_ROWS = 25;
const OLDER_TESTS = 10;
const OLDER_MESSAGE_MAX = 1000;
/** Byte budgets for one persisted summary. workspaceState is a single JSON value
 *  per extension, rewritten on every update, so a heavy history slows every
 *  unrelated write (test level, active job, org cache) and every startup. */
export const LATEST_SUMMARY_MAX_BYTES = 40_000;
export const OLDER_SUMMARY_MAX_BYTES = 10_000;
/** Message length a summary falls back to when its caps alone overshoot the budget. */
const SUMMARY_SHORT_MESSAGE = 200;

/** Size of a value as it would be stored: UTF-8 bytes of its JSON. */
export function packedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/** The setting's value, clamped: VS Code does not enforce a number setting's
 *  minimum/maximum at runtime. */
export function clampRunCap(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return RUN_CAP_DEFAULT;
  return Math.min(RUN_CAP_MAX, Math.max(1, Math.round(raw)));
}

/** A fresh run id: lowercase base-36 time plus a random tail, so two runs in the
 *  same millisecond still differ. */
export function newRunId(now: number = Date.now(), random: () => number = Math.random): string {
  const tail = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0');
  return `r${Math.max(0, Math.floor(now)).toString(36)}${tail}`.slice(0, 24);
}

/** The keys a Retry sends: every row that was part of the request. */
export function sentKeys(run: Pick<RunRecord, 'rows'>): string[] {
  return run.rows.filter(r => r.s === 1).map(r => r.k);
}

/** Per-component success rows of a deploy result across both CLI shapes: prefer
 *  `details.componentSuccesses` when it has rows, else the filtered `files` list.
 *  `.length ?`, not `??` — an empty-but-present detail array must fall through to
 *  `files`, or a shape carrying both silently reports zero successes. Note the
 *  files filter admits any non-Failed state; if a destructive-changes flag is
 *  ever added to deployMetadata, `state: 'Deleted'` rows would count as present
 *  here and need excluding. */
export function deploySuccessRows(result: DeployResult): DeployFileResult[] {
  const detail = result.details?.componentSuccesses ?? [];
  if (detail.length) return detail;
  return (result.files ?? []).filter(f => f.state && f.state !== 'Failed' && !fileProblem(f));
}

/** Cap on the request-level failure text echoed into a card line and fed to the
 *  dependency detector. Org-controlled, so bounded like every other such string;
 *  400 leaves room for the sentence that names the type ("Invalid type: Foo__mdt")
 *  without pasting a whole stack of platform prose into the card. */
const ENVELOPE_PROBLEM_MAX = 400;

/** The org's REQUEST-level failure text (`errorMessage` on the Metadata API deploy
 *  status), flattened and length-bounded; '' when the org didn't send one.
 *  It matters because a deploy CAN fail with no per-component rows at all — the
 *  card then had nothing but "no per-component details" and dependency detection
 *  never ran, even though this string routinely carries the same parseable
 *  "Invalid type: X" wording the per-component problems do. */
export function envelopeProblem(result: DeployResult): string {
  const raw = typeof result.errorMessage === 'string' ? result.errorMessage : '';
  const flat = stripAnsi(raw).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > ENVELOPE_PROBLEM_MAX ? `${flat.slice(0, ENVELOPE_PROBLEM_MAX - 1)}…` : flat;
}

/** Org text bound for storage: ANSI and control characters out (newlines stay —
 *  a test failure's message reads better on its own lines), then capped. */
function orgText(raw: unknown, max: number): string {
  const s = typeof raw === 'string' ? stripAnsi(raw).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ').trim() : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Leaf of a reported path — the row shows a file name, never a full local path. */
function leafName(p: unknown): string | undefined {
  if (typeof p !== 'string' || !p) return undefined;
  const leaf = p.split(/[\\/]/).pop() || '';
  return leaf ? leaf.slice(0, LEAF_MAX) : undefined;
}

function positiveInt(v: unknown): number | undefined {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function isTestLevel(v: unknown): v is TestLevel {
  return v === 'NoTestRun' || v === 'RunSpecifiedTests' || v === 'RunLocalTests' || v === 'RunAllTestsInOrg';
}

/** A failed row built from every failure the org reported against one
 *  component: the messages in order, the position of the first that has one. */
function failedRow(k: string, failures: DeployFileResult[], sent: boolean): RunRow {
  const row: RunRow = { k, o: 'failed' };
  if (sent) row.s = 1;
  const messages = [...new Set(failures.map(f => orgText(fileProblem(f) ?? '', ROW_MESSAGE_MAX)).filter(Boolean))];
  row.m = orgText(messages.join('\n') || 'failed', ROW_MESSAGE_MAX);
  const at = failures.find(f => positiveInt(f.lineNumber));
  if (at) {
    row.l = positiveInt(at.lineNumber);
    const col = positiveInt(at.columnNumber);
    if (col) row.c = col;
  }
  const leaf = leafName((at ?? failures[0])?.filePath);
  if (leaf) row.f = leaf;
  return row;
}

/** A test failure row. The link opens the test class, so the position is the
 *  first stack frame INSIDE that class when there is one (the top frame is often
 *  the class under test), else the top frame. */
function testRow(t: DeployTestFailure): TestRow {
  const cls = typeof t.name === 'string' && t.name ? t.name : '?';
  const row: TestRow = {
    cls,
    method: typeof t.methodName === 'string' && t.methodName ? t.methodName : '?',
    m: orgText(t.message ?? '', ROW_MESSAGE_MAX) || 'failed'
  };
  const stack = typeof t.stackTrace === 'string' ? t.stackTrace : '';
  const own = new RegExp(`Class\\.${cls.replace(/[^A-Za-z0-9_]/g, '')}\\.[^:\\n]*: line (\\d+)(?:, column (\\d+))?`).exec(stack);
  const pos = own ?? /line (\d+)(?:, column (\d+))?/.exec(stack);
  if (pos) {
    row.l = Number(pos[1]);
    if (pos[2]) row.c = Number(pos[2]);
  }
  return row;
}

/** The outcomes a run's chips show, in the order the counts are seeded: a
 *  present 0 is "none", an absent outcome is "not known for this run". */
function seededOutcomes(op: RunOp, status: RunStatus): Outcome[] {
  if (op === 'retrieve') return ['changed', 'created', 'unchanged', 'missing', 'failed'];
  const ok: Outcome = op === 'validate' ? (status === 'succeeded' ? 'validated' : 'passed')
    : (status === 'succeeded' || status === 'partial' ? 'deployed' : 'rolledback');
  return [ok, 'failed'];
}

export interface DeployRunInput {
  id: string;
  op: 'deploy' | 'validate' | 'quickDeploy';
  org: string;
  orgLabel: string;
  orgKind: OrgKind;
  startedAt: number;
  finishedAt: number;
  target: RunTarget;
  /** The resolved items the run sent (selection / sourceDir runs). Report and
   *  manifest runs take their rows from the result instead. */
  items?: ReadonlyArray<RunItem>;
  /** Selected rows with no local file, already split by whether this panel can
   *  read their type. Absent when the run cannot know them (a reattached job). */
  skipped?: { orgOnly: ReadonlyArray<RunItem>; unread: ReadonlyArray<RunItem> };
  /** Maps a failure onto the local component it belongs to (bundle files report
   *  their own name); undefined when nothing local matches. */
  localKeyOf?: (failure: DeployFileResult) => string | undefined;
  testLevel?: TestLevel;
  retry?: RunRetry;
  conflict?: boolean;
  fromRunId?: string;
  notes?: string[];
  jobId?: string;
}

/**
 * A finished deploy, validation or quick deploy as a run record.
 *
 * The verdict follows the same success gate as the result card always has
 * (success, no component errors, no failure rows, no test failures), and every
 * component that did not fail is labelled by what the ORG says happened to it:
 * a validation applies nothing, so its good rows `passed` (or `validated` when
 * the whole run passed); a failed or cancelled deploy is rolled back as a whole,
 * so its good rows are `rolledback`, never `deployed` — unless the org itself
 * reports the job as (partly) succeeded.
 */
export function deployRunFromResult(result: DeployResult, input: DeployRunInput): RunRecord {
  const orgStatus = typeof result.status === 'string' ? result.status : '';
  const detailFailures = result.details?.componentFailures ?? [];
  const fileFailures = (result.files ?? []).filter(f => f.state === 'Failed' || !!fileProblem(f));
  const failures = detailFailures.length ? detailFailures : fileFailures;
  const testFailures: DeployTestFailure[] = result.details?.runTestResult?.failures ?? [];
  const gate = !!result.success
    && (result.numberComponentErrors == null || result.numberComponentErrors === 0)
    && failures.length === 0
    && testFailures.length === 0;
  const status: RunStatus = gate ? 'succeeded'
    : orgStatus === 'Canceled' ? 'cancelled'
      : input.op !== 'validate' && (orgStatus === 'SucceededPartial' || orgStatus === 'Succeeded') ? 'partial'
        : 'failed';
  const okOutcome = seededOutcomes(input.op, status)[0];

  const rows: RunRow[] = [];
  const byKey = new Map<string, RunRow>();
  const add = (row: RunRow): void => { if (!byKey.has(row.k)) { byKey.set(row.k, row); rows.push(row); } };
  const keyOf = (f: DeployFileResult): string => `${fileType(f)}:${f.fullName}`;

  if (input.target === 'report' || input.target === 'manifest') {
    // No selection to lean on: the org's own rows are the run, and every one of
    // them was part of what it deployed.
    const failed = new Map<string, DeployFileResult[]>();
    for (const f of failures) {
      const k = keyOf(f);
      failed.set(k, [...(failed.get(k) ?? []), f]);
    }
    const reported = [...(result.details?.componentSuccesses ?? []), ...detailFailures, ...(result.files ?? [])];
    for (const r of reported) {
      if (!r?.fullName || fileType(r) === '?') continue;
      if (fileType(r) === 'package.xml' || r.fullName === 'package.xml') continue;
      const k = keyOf(r);
      // A failed file row counts even when the detail failure that stands for
      // it spells the component differently (a bundle file, say).
      const fails = failed.get(k) ?? (r.state === 'Failed' || fileProblem(r) ? [r] : undefined);
      add(fails ? failedRow(k, fails, true) : { k, o: okOutcome, s: 1 });
    }
  } else {
    const items = input.items ?? [];
    const sentKeySet = new Set(items.map(i => `${i.type}:${i.name}`));
    // Failures first, grouped by the component they belong to — two errors in
    // one class are one row.
    const failed = new Map<string, DeployFileResult[]>();
    for (const f of failures) {
      const k = input.localKeyOf?.(f) ?? keyOf(f);
      failed.set(k, [...(failed.get(k) ?? []), f]);
    }
    for (const i of items) {
      const k = `${i.type}:${i.name}`;
      const fails = failed.get(k);
      if (!fails) { add({ k, o: okOutcome, s: 1 }); continue; }
      const row = failedRow(k, fails, true);
      if (!row.f) { const leaf = leafName(i.filePath); if (leaf) row.f = leaf; }
      add(row);
    }
    // A failure naming something outside the request (a dependent component the
    // org recompiled, say) is shown, but never retried: it was not sent.
    for (const [k, fails] of failed) if (!sentKeySet.has(k)) add(failedRow(k, fails, false));
  }
  if (input.skipped) {
    for (const i of input.skipped.unread) add({ k: `${i.type}:${i.name}`, o: 'skipped', why: 'unread' });
    for (const i of input.skipped.orgOnly) add({ k: `${i.type}:${i.name}`, o: 'skipped', why: 'org' });
  }

  const counts: RunCounts = {};
  for (const o of seededOutcomes(input.op, status)) counts[o] = 0;
  if (input.skipped) counts.skipped = 0;
  for (const r of rows) counts[r.o] = (counts[r.o] ?? 0) + 1;
  counts.sent = rows.filter(r => r.s === 1).length;
  // The org's own tally, when it has one and the rows could not say it: a
  // reattached report may count components it never itemized.
  const orgDeployed = typeof result.numberComponentsDeployed === 'number' ? result.numberComponentsDeployed : undefined;
  if (input.target === 'report' && orgDeployed !== undefined && orgDeployed > (counts[okOutcome] ?? 0)) counts[okOutcome] = orgDeployed;
  if (orgDeployed !== undefined) counts.orgDeployed = orgDeployed;
  if (typeof result.numberComponentsTotal === 'number') counts.orgTotal = result.numberComponentsTotal;
  if (typeof result.numberComponentErrors === 'number') counts.orgErrors = result.numberComponentErrors;
  const testsTotal = typeof result.numberTestsTotal === 'number' ? result.numberTestsTotal : 0;
  if (testsTotal > 0 || testFailures.length > 0) {
    counts.testsRun = typeof result.numberTestsCompleted === 'number' ? result.numberTestsCompleted : testsTotal;
    counts.testsFailed = Math.max(testFailures.length, typeof result.numberTestErrors === 'number' ? result.numberTestErrors : 0);
  }

  // Whether the org ran tests at all — a validation that didn't cannot be
  // quick-deployed. Older CLI output has no runTestsEnabled; the level decides.
  const testsRan = result.runTestsEnabled == null ? input.testLevel !== 'NoTestRun' : String(result.runTestsEnabled) !== 'false';
  const jobId = input.jobId ?? result.id;
  const message = envelopeProblem(result);
  const run: RunRecord = {
    v: 1, id: input.id, op: input.op, status,
    org: input.org, orgLabel: input.orgLabel, orgKind: input.orgKind,
    startedAt: input.startedAt, finishedAt: input.finishedAt,
    target: input.target,
    testsRan,
    counts, rows, rowsComplete: true,
    tests: testFailures.map(testRow)
  };
  if (typeof jobId === 'string' && DEPLOY_JOB_ID_RE.test(jobId)) run.jobId = jobId;
  if (isTestLevel(input.testLevel)) run.testLevel = input.testLevel;
  if (message) run.message = message;
  const notes = (input.notes ?? []).map(n => orgText(n, NOTE_MAX)).filter(Boolean).slice(0, NOTES_MAX);
  if (notes.length) run.notes = notes;
  if (input.retry) run.retry = { ...input.retry };
  if (input.conflict) run.conflict = true;
  if (input.fromRunId) run.fromRunId = input.fromRunId;
  return run;
}

export interface BeginRunInput {
  id: string;
  op: 'deploy' | 'validate' | 'quickDeploy';
  org: string;
  orgLabel: string;
  orgKind: OrgKind;
  startedAt: number;
  target: RunTarget;
  /** What the run sends (a package.xml run lets the org name them instead). */
  items: ReadonlyArray<RunItem>;
  skipped?: { orgOnly: ReadonlyArray<RunItem>; unread: ReadonlyArray<RunItem> };
  testLevel?: TestLevel;
  retry?: RunRetry;
}

/** A deploy or validation as it starts: every component it sends, still
 *  without a verdict, and every one it skipped — both known before the org
 *  answers. If the run ends without a result (lost contact, a refused submit)
 *  these rows are still what it sent, so a Retry can send them again. */
export function beginDeployRun(input: BeginRunInput): RunRecord {
  const rows: RunRow[] = input.items.map(i => ({ k: `${i.type}:${i.name}`, o: 'pending', s: 1 }));
  const seen = new Set(rows.map(r => r.k));
  const skip = (i: RunItem, why: 'org' | 'unread'): void => {
    const k = `${i.type}:${i.name}`;
    if (!seen.has(k)) { seen.add(k); rows.push({ k, o: 'skipped', why }); }
  };
  for (const i of input.skipped?.unread ?? []) skip(i, 'unread');
  for (const i of input.skipped?.orgOnly ?? []) skip(i, 'org');
  const counts: RunCounts = { pending: input.items.length, sent: input.items.length };
  if (input.skipped) counts.skipped = rows.length - input.items.length;
  const run: RunRecord = {
    v: 1, id: input.id, op: input.op, status: 'running',
    org: input.org, orgLabel: input.orgLabel, orgKind: input.orgKind,
    startedAt: input.startedAt, target: input.target,
    counts, rows, rowsComplete: true, tests: []
  };
  if (isTestLevel(input.testLevel)) run.testLevel = input.testLevel;
  if (input.retry) run.retry = { ...input.retry };
  return run;
}

/** The options a Retry re-runs with, from a run's retry request: never its
 *  keys (they are the run's own sent rows) and never a one-off overwrite. */
export function runRetryFrom(r: { validateOnly?: boolean; testLevel?: TestLevel; runTests?: string[]; sourceDir?: string; manifest?: string } | undefined): RunRetry | undefined {
  if (!r) return undefined;
  const out: RunRetry = { validateOnly: r.validateOnly === true };
  if (isTestLevel(r.testLevel)) out.testLevel = r.testLevel;
  if (r.runTests?.length) out.runTests = [...r.runTests];
  if (r.sourceDir) out.sourceDir = r.sourceDir;
  if (r.manifest) out.manifest = r.manifest;
  return out;
}

export interface RetrieveRunInput {
  id: string;
  org: string;
  orgLabel: string;
  orgKind: OrgKind;
  startedAt: number;
  finishedAt: number;
  target: RunTarget;
  /** What was asked for — anything not returned is `missing`. */
  items: ReadonlyArray<RunItem>;
  backupDir?: string;
  notes?: string[];
}

/** How strongly a retrieve state speaks for a component whose files disagree
 *  (a bundle with one new file and one changed file is `created`). */
const RETRIEVE_RANK: Partial<Record<Outcome, number>> = { failed: 4, created: 3, changed: 2, unchanged: 1 };

/** A finished retrieve as a run record: one row per component, the strongest
 *  state across its files, plus a `missing` row for everything asked for that
 *  the org did not return. */
export function retrieveRunFromResult(result: RetrieveResult, input: RetrieveRunInput): RunRecord {
  const files = (result.inboundFiles ?? result.files ?? []) as RetrieveFileResult[];
  const requested = new Set(input.items.map(i => `${i.type}:${i.name}`));
  const rows: RunRow[] = [];
  const byKey = new Map<string, RunRow>();
  for (const f of files) {
    if (!f?.type || !f?.fullName) continue;
    const k = `${f.type}:${f.fullName}`;
    const problem = retrieveProblem(f);
    const o: Outcome = problem || f.state === 'Failed' ? 'failed'
      : f.state === 'Created' ? 'created'
        : f.state === 'Unchanged' ? 'unchanged'
          : 'changed';
    const row: RunRow = { k, o };
    if (requested.has(k)) row.s = 1;
    if (o === 'failed') row.m = orgText(problem ?? 'failed', ROW_MESSAGE_MAX);
    const seen = byKey.get(k);
    if (!seen) { byKey.set(k, row); rows.push(row); continue; }
    if ((RETRIEVE_RANK[o] ?? 0) > (RETRIEVE_RANK[seen.o] ?? 0)) Object.assign(seen, row);
  }
  for (const i of input.items) {
    const k = `${i.type}:${i.name}`;
    // A package.xml wildcard names no single component that could go missing.
    if (byKey.has(k) || i.name.includes('*')) continue;
    const row: RunRow = { k, o: 'missing', s: 1 };
    byKey.set(k, row);
    rows.push(row);
  }
  const counts: RunCounts = {};
  for (const o of seededOutcomes('retrieve', 'succeeded')) counts[o] = 0;
  for (const r of rows) counts[r.o] = (counts[r.o] ?? 0) + 1;
  counts.sent = rows.filter(r => r.s === 1).length;
  const failed = counts.failed ?? 0;
  const ok = (counts.changed ?? 0) + (counts.created ?? 0) + (counts.unchanged ?? 0);
  const status: RunStatus = failed === 0 ? 'succeeded' : ok > 0 ? 'partial' : 'failed';
  // Org-level messages ("entity of type X named Y cannot be found") explain an
  // empty or short result better than the bare missing list.
  const orgNotes = (result.messages ?? []).filter(m => m?.problem).map(m => `${m.fileName ?? '?'}: ${m.problem}`);
  const notes = [...(input.notes ?? []), ...orgNotes].map(n => orgText(n, NOTE_MAX)).filter(Boolean).slice(0, NOTES_MAX);
  const run: RunRecord = {
    v: 1, id: input.id, op: 'retrieve', status,
    org: input.org, orgLabel: input.orgLabel, orgKind: input.orgKind,
    startedAt: input.startedAt, finishedAt: input.finishedAt,
    target: input.target,
    counts, rows, rowsComplete: true, tests: []
  };
  if (notes.length) run.notes = notes;
  if (input.backupDir) run.backupDir = input.backupDir;
  return run;
}

/**
 * The copy of a run that is kept across reloads. The newest run keeps its
 * failures, a taste of its skipped rows, and what its buttons need (retry
 * options, backup folder, suggestion id); an older run keeps only what its
 * one-line summary and read-only expansion show. Counts stay exact either way;
 * the full list of the newest run is kept separately. Live-only fields (the
 * suggestion payload, the quick-deploy offer) never survive.
 */
export function summarizeRun(run: RunRecord, opts: { latest: boolean }): RunRecord {
  const latest = opts.latest;
  const failed = run.rows.filter(r => r.o === 'failed');
  const skipped = run.rows.filter(r => r.o === 'skipped');
  const rows = latest
    ? [...failed.slice(0, LATEST_FAILED_ROWS), ...skipped.slice(0, LATEST_SKIPPED_ROWS)]
    : failed.slice(0, OLDER_FAILED_ROWS);
  const out: RunRecord = {
    v: 1, id: run.id, op: run.op, status: run.status,
    org: run.org, orgLabel: run.orgLabel, orgKind: run.orgKind,
    startedAt: run.startedAt,
    target: run.target,
    counts: { ...run.counts },
    rows: rows.map(r => ({ ...r })),
    rowsComplete: false,
    tests: run.tests.slice(0, latest ? LATEST_TESTS : OLDER_TESTS).map(t => ({ ...t }))
  };
  if (run.finishedAt !== undefined) out.finishedAt = run.finishedAt;
  if (run.jobId) out.jobId = run.jobId;
  if (run.testLevel) out.testLevel = run.testLevel;
  if (run.testsRan !== undefined) out.testsRan = run.testsRan;
  if (run.fromRunId) out.fromRunId = run.fromRunId;
  const messageMax = latest ? LATEST_MESSAGE_MAX : OLDER_MESSAGE_MAX;
  if (run.message) out.message = run.message.length > messageMax ? `${run.message.slice(0, messageMax - 1)}…` : run.message;
  if (latest) {
    if (run.hint) out.hint = orgText(run.hint, NOTE_MAX);
    if (run.cliActions?.length) out.cliActions = run.cliActions.slice(0, NOTES_MAX).map(a => orgText(a, NOTE_MAX));
    if (run.notes?.length) out.notes = run.notes.slice(0, NOTES_MAX).map(n => orgText(n, NOTE_MAX));
    if (run.retry) out.retry = { ...run.retry };
    if (run.conflict) out.conflict = true;
    if (run.backupDir) out.backupDir = run.backupDir;
    if (run.suggestId) out.suggestId = run.suggestId;
  }
  // The caps bound the counts of things; a pathological run (hundreds of long
  // messages) can still overshoot the byte budget. Shorten messages first, then
  // give up rows from the end (skipped before failed), then tests.
  const budget = latest ? LATEST_SUMMARY_MAX_BYTES : OLDER_SUMMARY_MAX_BYTES;
  if (packedSize(out) > budget) {
    const short = (m: string): string => (m.length > SUMMARY_SHORT_MESSAGE ? `${m.slice(0, SUMMARY_SHORT_MESSAGE - 1)}…` : m);
    for (const r of out.rows) if (r.m) r.m = short(r.m);
    for (const t of out.tests) t.m = short(t.m);
    if (out.message) out.message = short(out.message);
  }
  while (packedSize(out) > budget && (out.rows.length || out.tests.length)) {
    if (out.rows.length) out.rows.pop(); else out.tests.pop();
  }
  if (packedSize(out) > budget) { delete out.notes; delete out.cliActions; }
  out.rowsComplete = out.rows.length === run.rows.length && run.rowsComplete
    && out.rows.every((r, i) => r.k === run.rows[i].k && r.m === run.rows[i].m);
  return out;
}

/** A run found still `running` when the window starts again, with no job of
 *  this window polling it: its result was never recorded. */
export function interruptedRun(run: RunRecord): RunRecord {
  const note = run.op === 'retrieve'
    ? "The window closed while this ran; its result wasn't recorded, and files may be partly written."
    : "The window closed while this ran; its result wasn't recorded. Check Deployment Status in the org.";
  return { ...run, status: 'interrupted', notes: [note, ...(run.notes ?? [])].slice(0, NOTES_MAX) };
}

/** The newest `cap` runs (the setting, clamped). A run still `running` is never
 *  evicted — its result is on its way and has nowhere else to land. */
export function trimRuns(runs: RunRecord[], cap: unknown): RunRecord[] {
  const n = clampRunCap(cap);
  return [...runs.slice(0, n), ...runs.slice(n).filter(r => r.status === 'running')];
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0') ? v : undefined;
}

function cappedText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const s = v.replace(/\0/g, '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Rows read back from storage, junk dropped (see normalizeRun). */
export function normalizeRows(raw: unknown): RunRow[] {
  return Array.isArray(raw) ? raw.map(normalizeRow).filter((x): x is RunRow => !!x) : [];
}

/** Test rows read back from storage, junk dropped. */
export function normalizeTests(raw: unknown): TestRow[] {
  return Array.isArray(raw) ? raw.map(normalizeTest).filter((x): x is TestRow => !!x) : [];
}

function normalizeRow(raw: unknown): RunRow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const k = str(r.k, KEY_MAX);
  if (!k || !/^[A-Za-z0-9_]+:./.test(k)) return undefined;
  if (!OUTCOMES.includes(r.o as Outcome)) return undefined;
  const row: RunRow = { k, o: r.o as Outcome };
  if (r.s === 1 && row.o !== 'skipped') row.s = 1;
  if (row.o === 'skipped' && (r.why === 'org' || r.why === 'unread')) row.why = r.why;
  const m = cappedText(r.m, ROW_MESSAGE_MAX);
  if (m) row.m = m;
  const l = positiveInt(r.l);
  if (l) row.l = l;
  const c = positiveInt(r.c);
  if (c) row.c = c;
  const f = str(r.f, LEAF_MAX);
  if (f && !/[\\/]/.test(f)) row.f = f;
  return row;
}

function normalizeTest(raw: unknown): TestRow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const cls = str(t.cls, LEAF_MAX);
  const method = str(t.method, LEAF_MAX);
  if (!cls || !method) return undefined;
  const row: TestRow = { cls, method, m: cappedText(t.m, ROW_MESSAGE_MAX) ?? 'failed' };
  const l = positiveInt(t.l);
  if (l) row.l = l;
  const c = positiveInt(t.c);
  if (c) row.c = c;
  return row;
}

const COUNT_KEYS: readonly string[] = [...OUTCOMES, 'sent', 'testsRun', 'testsFailed', 'orgDeployed', 'orgTotal', 'orgErrors'];

function stringList(v: unknown, max: number, each: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(x => cappedText(x, each)).filter((x): x is string => !!x).slice(0, max);
  return out.length ? out : undefined;
}

/** One persisted run, shape- and charset-guarded like the persisted active job:
 *  the state DB can hand back anything after corruption or a hand edit, and
 *  `org`, `jobId` and the retry options end up on a CLI command line when a
 *  button is clicked. A security-relevant field that fails its guard drops the
 *  whole run; anything else is repaired or left out. */
export function normalizeRun(raw: unknown): RunRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return undefined;
  if (typeof r.id !== 'string' || !RUN_ID_RE.test(r.id)) return undefined;
  if (!RUN_OPS.includes(r.op as RunOp) || !RUN_STATUSES.includes(r.status as RunStatus)) return undefined;
  if (!TARGETS.includes(r.target as RunTarget)) return undefined;
  const org = str(r.org, 255);
  if (!org || org.startsWith('-') || /\s/.test(org)) return undefined;
  const orgLabel = str(r.orgLabel, 255);
  if (!orgLabel) return undefined;
  if (typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt)) return undefined;
  if (r.jobId !== undefined && (typeof r.jobId !== 'string' || !DEPLOY_JOB_ID_RE.test(r.jobId))) return undefined;
  const run: RunRecord = {
    v: 1, id: r.id, op: r.op as RunOp, status: r.status as RunStatus,
    org, orgLabel, orgKind: ORG_KINDS.includes(r.orgKind as OrgKind) ? r.orgKind as OrgKind : 'other',
    startedAt: r.startedAt, target: r.target as RunTarget,
    counts: {},
    rows: Array.isArray(r.rows) ? r.rows.map(normalizeRow).filter((x): x is RunRow => !!x) : [],
    rowsComplete: false,
    tests: Array.isArray(r.tests) ? r.tests.map(normalizeTest).filter((x): x is TestRow => !!x) : []
  };
  run.rowsComplete = r.rowsComplete === true && Array.isArray(r.rows) && run.rows.length === r.rows.length;
  if (typeof r.jobId === 'string') run.jobId = r.jobId;
  if (typeof r.finishedAt === 'number' && Number.isFinite(r.finishedAt)) run.finishedAt = r.finishedAt;
  if (isTestLevel(r.testLevel)) run.testLevel = r.testLevel;
  if (typeof r.testsRan === 'boolean') run.testsRan = r.testsRan;
  if (r.counts && typeof r.counts === 'object') {
    const c = r.counts as Record<string, unknown>;
    for (const k of COUNT_KEYS) {
      const v = c[k];
      if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) (run.counts as Record<string, number>)[k] = v;
    }
  }
  const message = cappedText(r.message, LATEST_MESSAGE_MAX);
  if (message) run.message = message;
  const hint = cappedText(r.hint, NOTE_MAX);
  if (hint) run.hint = hint;
  const cliActions = stringList(r.cliActions, NOTES_MAX, NOTE_MAX);
  if (cliActions) run.cliActions = cliActions;
  const notes = stringList(r.notes, NOTES_MAX, NOTE_MAX);
  if (notes) run.notes = notes;
  if (r.retry !== undefined) {
    if (!r.retry || typeof r.retry !== 'object') return undefined;
    const q = r.retry as Record<string, unknown>;
    const retry: RunRetry = { validateOnly: q.validateOnly === true };
    if (isTestLevel(q.testLevel)) retry.testLevel = q.testLevel;
    if (q.runTests !== undefined) {
      if (!Array.isArray(q.runTests) || !q.runTests.every(t => typeof t === 'string' && /^[A-Za-z0-9_.]{1,255}$/.test(t))) return undefined;
      if (q.runTests.length) retry.runTests = q.runTests.slice(0, 500) as string[];
    }
    for (const k of ['sourceDir', 'manifest'] as const) {
      if (q[k] === undefined) continue;
      const p = str(q[k], PATH_MAX);
      if (!p) return undefined;
      retry[k] = p;
    }
    run.retry = retry;
  }
  if (r.conflict === true) run.conflict = true;
  if (r.backupDir !== undefined) {
    const dir = str(r.backupDir, PATH_MAX);
    if (!dir) return undefined;
    run.backupDir = dir;
  }
  if (r.suggestId !== undefined) {
    if (typeof r.suggestId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(r.suggestId)) return undefined;
    run.suggestId = r.suggestId;
  }
  if (r.fromRunId !== undefined) {
    if (typeof r.fromRunId !== 'string' || !RUN_ID_RE.test(r.fromRunId)) return undefined;
    run.fromRunId = r.fromRunId;
  }
  return run;
}

/** The persisted run history, guarded: anything that is not the expected shape
 *  degrades to an empty history (never a throw), junk runs drop out, duplicate
 *  ids keep their first copy, newest first, at most RUN_CAP_MAX. */
export function normalizeRunsState(raw: unknown): RunsState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { v: 1, runs: [] };
  const s = raw as Record<string, unknown>;
  if (s.v !== 1 || !Array.isArray(s.runs)) return { v: 1, runs: [] };
  const seen = new Set<string>();
  const runs: RunRecord[] = [];
  for (const x of s.runs) {
    const run = normalizeRun(x);
    if (!run || seen.has(run.id)) continue;
    seen.add(run.id);
    runs.push(run);
  }
  runs.sort((a, b) => b.startedAt - a.startedAt);
  return { v: 1, runs: runs.slice(0, RUN_CAP_MAX) };
}

/** Bounds on a notice kept across reloads: a card's error text can carry a full
 *  CLI stderr, and its lines can list hundreds of components. */
const NOTICE_ERRTEXT_MAX = 8_000;
const NOTICE_LINES_MAX = 100;

/** A status card as it is kept: no buttons, no Quick Deploy — the actions of a
 *  run live on the newest run alone, and a notice is only a record — and bounded.
 *  The live card posted to the webview keeps everything. */
export function noticeFromCard(card: Record<string, unknown>): Record<string, unknown> {
  const { buttons: _buttons, quickDeploy: _quick, ...rest } = card;
  if (typeof rest.errText === 'string' && rest.errText.length > NOTICE_ERRTEXT_MAX) {
    rest.errText = `${rest.errText.slice(0, NOTICE_ERRTEXT_MAX)}\n… (truncated in history)`;
  }
  // > max + 1: a card whose own list was capped already ends in a one-line
  // summary of the rest; re-cutting at the plain max would replace that
  // summary with this less useful one.
  if (Array.isArray(rest.lines) && rest.lines.length > NOTICE_LINES_MAX + 1) {
    rest.lines = [...rest.lines.slice(0, NOTICE_LINES_MAX), `… ${rest.lines.length - NOTICE_LINES_MAX} more (truncated in history)`];
  }
  return rest;
}

/**
 * The notices and runs to start from, given what workspaceState holds.
 *
 * With no run history yet (the first start after an upgrade) the old card
 * history is carried over as notices: the newest NOTICES_MAX, with their buttons
 * stripped — a card never becomes a run, its text is not parsed back into one —
 * and an empty run history is created (`migrated`, so the caller writes it).
 * Every later start reads the same way minus the write, so older cards that
 * still carry buttons heal on read and running it twice changes nothing.
 */
export function migrateCardHistory(rawCards: unknown, rawRuns: unknown): { notices: Array<Record<string, unknown>>; runsState: RunsState; migrated: boolean } {
  const cards = Array.isArray(rawCards)
    ? rawCards.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c))
    : [];
  const notices = cards.slice(0, NOTICES_MAX).map(noticeFromCard);
  if (rawRuns === undefined) return { notices, runsState: { v: 1, runs: [] }, migrated: true };
  return { notices, runsState: normalizeRunsState(rawRuns), migrated: false };
}
