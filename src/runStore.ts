// The Status pane's history: the last N runs, the newest one's full row list
// kept beside them, and a short list of notices. Owns both workspaceState keys,
// the one-time carry-over of the old card history, the rows file, and every
// `runs` post to the webview. No vscode here — the provider hands in what it
// needs, so the harness can drive the store with plain objects.
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  NOTICES_MAX, RunRecord, RunRow, RunStatus, TestRow, clampRunCap, interruptedRun, migrateCardHistory,
  noticeFromCard, normalizeRows, normalizeTests, summarizeRun, trimRuns
} from './runRecords';

/** workspaceState key for the run summaries ({ v: 1, runs }), newest first. */
export const RUNS_KEY = 'statusRuns';
/** workspaceState key for the notices (the status cards that are not runs). */
export const NOTICES_KEY = 'statusCardHistory';
/** The newest run's full list, under the extension's workspace storage folder:
 *  workspaceState is one JSON value per extension, rewritten on every update, so
 *  ten thousand rows never go there. */
export const ROWS_FILE = path.join('status', 'latest-run.json');

/** Live-only additions to the newest run, merged in when it is posted and never
 *  stored: a dependency suggestion's choices, and the Quick Deploy offer. */
export interface RunLive {
  suggest?: { id: string; candidates: unknown[]; unresolved: string[] };
  quick?: { jobId: string; until: number; used?: boolean };
}

export interface RunStoreHost {
  /** The extension's workspaceState. */
  memento?: { get(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> | void };
  /** Folder for the rows file; without one the newest run falls back to its summary. */
  storageDir?: string;
  post(msg: unknown): void;
  log(line: string): void;
  /** The statusHistoryRuns setting, raw — clamped here. */
  cap(): unknown;
  live?(run: RunRecord): RunLive | undefined;
  /** A run this window is still driving; any other run found `running` when the
   *  history loads was cut off by a reload. */
  activeRunId?(): string | undefined;
}

/** A poll tick of a running job: counts only. */
export interface RunProgress {
  orgStatus?: string;
  compDone?: number;
  compTotal?: number;
  testDone?: number;
  testTotal?: number;
  errors?: number;
}

interface FullRows { runId: string; rows: RunRow[]; tests: TestRow[] }

export class RunStore {
  private loaded = false;
  private list: RunRecord[] = [];
  private noticeList: Array<Record<string, unknown>> = [];
  /** The newest run's full rows, when this window has them. */
  private full?: FullRows;
  /** Rows-file writes and deletes, in order — two runs ending close together
   *  must not land their files the wrong way round. */
  private fileChain: Promise<void> = Promise.resolve();

  constructor(private readonly host: RunStoreHost) {}

  /** Read both keys once. The first start after an upgrade carries the old card
   *  history over as notices (see migrateCardHistory) and writes the new shape;
   *  a run still `running` that no job of this window drives is interrupted. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let rawCards: unknown;
    let rawRuns: unknown;
    try {
      rawCards = this.host.memento?.get(NOTICES_KEY);
      rawRuns = this.host.memento?.get(RUNS_KEY);
    } catch (err) {
      this.host.log(`[history] read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { notices, runsState, migrated } = migrateCardHistory(rawCards ?? [], rawRuns);
    this.noticeList = notices;
    const active = this.host.activeRunId?.();
    let interrupted = false;
    this.list = runsState.runs.map(r => {
      if (r.status !== 'running' || r.id === active) return r;
      interrupted = true;
      return interruptedRun(r);
    });
    if (migrated) this.persistNotices();
    if (migrated || interrupted) this.persistRuns();
  }

  runs(): RunRecord[] {
    this.load();
    return this.list;
  }

  notices(): Array<Record<string, unknown>> {
    this.load();
    return this.noticeList;
  }

  /** Keep a status card as a notice: bounded, without buttons, newest first. */
  pushNotice(card: Record<string, unknown>): void {
    this.load();
    this.noticeList = [noticeFromCard(card), ...this.noticeList].slice(0, NOTICES_MAX);
    this.persistNotices();
  }

  /** A run starting: the newest, with every row known before the org answers
   *  (what was sent, what was skipped). */
  begin(run: RunRecord): void {
    this.load();
    this.place(run);
    this.persistRuns();
    this.post(true);
  }

  /** Fields of a run that change without a new status — its job id, once the
   *  org has one. */
  update(id: string, patch: Partial<RunRecord>): void {
    this.load();
    const at = this.list.findIndex(r => r.id === id);
    if (at < 0) return;
    this.list[at] = { ...this.list[at], ...patch };
    this.persistRuns();
  }

  /** A poll tick: posted, never persisted, and only the numbers. */
  progress(id: string, p: RunProgress): void {
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    this.host.post({
      type: 'runProgress', id, orgStatus: typeof p.orgStatus === 'string' ? p.orgStatus : '',
      compDone: n(p.compDone), compTotal: n(p.compTotal), testDone: n(p.testDone), testTotal: n(p.testTotal), errors: n(p.errors)
    });
  }

  /** A run's result: its full record replaces the running one — or joins as the
   *  newest when nothing began it (a reattached job). The rows file is written
   *  for the newest run only. */
  finish(run: RunRecord): void {
    this.load();
    this.place(run);
    this.persistRuns();
    if (this.list[0]?.id === run.id) this.writeRows();
    this.post(true);
  }

  /** End a begun run without an org result (lost contact, a refused submit, a
   *  timeout…): its rows stay what was known at the start. False when the run
   *  is not in the history, so the caller can report some other way. */
  end(id: string, patch: Partial<RunRecord> & { status: RunStatus }): boolean {
    this.load();
    const cur = this.list.find(r => r.id === id);
    if (!cur) return false;
    const known = this.full?.runId === id ? { rows: this.full.rows, tests: this.full.tests, rowsComplete: true } : {};
    this.finish({ ...cur, ...known, finishedAt: Date.now(), ...patch });
    return true;
  }

  /** The rows this window holds for a run: the newest run's full list when it
   *  has it, else what the run's summary kept. */
  rowsOf(id: string): RunRow[] {
    this.load();
    if (this.full?.runId === id) return this.full.rows;
    return this.list.find(r => r.id === id)?.rows ?? [];
  }

  /** A run picked up again (its job still on the org): back to running, with
   *  the rows it still holds. False when the history no longer has it. */
  resume(id: string): boolean {
    this.load();
    const at = this.list.findIndex(r => r.id === id);
    if (at < 0) return false;
    const { finishedAt: _finished, ...rest } = this.list[at];
    this.list[at] = { ...rest, status: 'running' };
    this.persistRuns();
    this.post(true);
    return true;
  }

  /** A run whose job can no longer be picked up: its result was never recorded. */
  interrupt(id: string): void {
    this.load();
    const at = this.list.findIndex(r => r.id === id);
    if (at < 0 || this.list[at].status !== 'running') return;
    this.list[at] = interruptedRun(this.list[at]);
    this.persistRuns();
    this.post(false);
  }

  /** Clear: notices, finished runs and the rows file go; a running run stays —
   *  its result is on its way. */
  async clear(): Promise<void> {
    this.load();
    this.noticeList = [];
    this.list = this.list.filter(r => r.status === 'running');
    if (!this.list.length || this.full?.runId !== this.list[0].id) this.full = undefined;
    this.persistNotices();
    this.persistRuns();
    this.deleteRows();
    await this.fileChain;
    this.post(false);
  }

  /** The setting changed: keep that many (never evicting a running run). */
  setCap(): void {
    this.load();
    this.list = trimRuns(this.list, this.host.cap());
    this.persistRuns();
    this.post(false);
  }

  /** Resolves once every rows-file write or delete issued so far has landed. */
  whenWritten(): Promise<void> {
    return this.fileChain;
  }

  /** Post the history as it stands, e.g. after a live payload changed. */
  postRuns(): void {
    this.load();
    this.post(false);
  }

  /** A rebuilt webview: the history, with the newest run's full list read back
   *  from the rows file when this window does not hold it — only if it belongs
   *  to that same run and passes its guard. */
  async postReady(): Promise<void> {
    this.load();
    const head = this.list[0];
    if (head && this.full?.runId !== head.id) {
      await this.fileChain;
      const read = await this.readRows();
      if (read && read.runId === head.id) this.full = read;
    }
    this.post(true);
  }

  private place(run: RunRecord): void {
    const at = this.list.findIndex(r => r.id === run.id);
    if (at > 0) {
      this.list[at] = summarizeRun(run, { latest: false });
    } else {
      // The run that was newest keeps only what an older run shows.
      if (at < 0 && this.list[0]) this.list[0] = summarizeRun(this.list[0], { latest: false });
      if (at === 0) this.list[0] = summarizeRun(run, { latest: true });
      else this.list.unshift(summarizeRun(run, { latest: true }));
      this.full = { runId: run.id, rows: run.rows, tests: run.tests };
    }
    this.list = trimRuns(this.list, this.host.cap());
    if (this.full && this.list[0]?.id !== this.full.runId) this.full = undefined;
  }

  private post(withRows: boolean): void {
    const [head, ...rest] = this.list;
    const msg: Record<string, unknown> = {
      type: 'runs',
      runs: head ? [{ ...head, ...(this.host.live?.(head) ?? {}) }, ...rest] : [],
      cap: clampRunCap(this.host.cap())
    };
    if (withRows && head && this.full?.runId === head.id) {
      msg.latestRows = { runId: head.id, rows: this.full.rows, tests: this.full.tests };
    }
    this.host.post(msg);
  }

  private persistRuns(): void {
    this.write(RUNS_KEY, { v: 1, runs: this.list });
  }

  private persistNotices(): void {
    this.write(NOTICES_KEY, this.noticeList);
  }

  /** A lost write costs one history entry — logged, never surfaced. */
  private write(key: string, value: unknown): void {
    const m = this.host.memento;
    if (!m) return;
    try {
      void Promise.resolve(m.update(key, value)).then(undefined, err =>
        this.host.log(`[history] ${key} write failed: ${err instanceof Error ? err.message : String(err)}`));
    } catch (err) {
      this.host.log(`[history] ${key} write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private rowsPath(): string | undefined {
    return this.host.storageDir ? path.join(this.host.storageDir, ROWS_FILE) : undefined;
  }

  /** Written whole to a temp file, then renamed over the old one, so a reader
   *  never meets half a file. */
  private writeRows(): void {
    const file = this.rowsPath();
    const full = this.full;
    if (!file || !full) return;
    const body = JSON.stringify({ v: 1, runId: full.runId, rows: full.rows, tests: full.tests });
    this.fileChain = this.fileChain.then(async () => {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, body, 'utf8');
        await fs.rename(tmp, file);
      } catch (err) {
        this.host.log(`[history] rows file write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private deleteRows(): void {
    const file = this.rowsPath();
    if (!file) return;
    this.fileChain = this.fileChain.then(async () => {
      try {
        await fs.rm(file, { force: true });
      } catch (err) {
        this.host.log(`[history] rows file delete failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private async readRows(): Promise<FullRows | undefined> {
    const file = this.rowsPath();
    if (!file) return undefined;
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object' || raw.v !== 1 || typeof raw.runId !== 'string' || !Array.isArray(raw.rows)) return undefined;
      return { runId: raw.runId, rows: normalizeRows(raw.rows), tests: normalizeTests(raw.tests) };
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== 'ENOENT') this.host.log(`[history] rows file read failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
}
