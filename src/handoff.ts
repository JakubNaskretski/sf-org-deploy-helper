/**
 * The contract behind `sfOrgDeployWrapper.deployComponents` — the command a
 * sibling extension (sf-test-runner's "Deploy first" offer, run right before
 * it tries to test classes this workspace hasn't deployed yet) calls to hand
 * this plugin a set of Apex classes/triggers to deploy. A contributed command
 * is callable by ANY extension, so everything it hands over is validated here
 * before any of it reaches a component lookup or the org store.
 *
 * Pure: the known-org check takes the caller's already-loaded org usernames
 * rather than reaching for the org list itself, so this stays unit testable.
 */
const CLASS_NAME = /^\w+$/;
const MAX_CLASS_NAMES = 200;

export interface HandoffArgs {
  classNames: string[];
  targetOrg: string;
}

export type HandoffShapeResult =
  | { ok: true; value: HandoffArgs }
  | { ok: false; message: string };

export type HandoffParseResult = HandoffShapeResult;

/**
 * Everything about the args EXCEPT whether `targetOrg` is a known org — split
 * out so deployComponents, whose org list might be stale, can reload it and
 * re-check membership without re-validating the rest from scratch.
 */
export function parseHandoffShape(raw: unknown): HandoffShapeResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'Expected an object with classNames and targetOrg.' };
  }
  const { classNames, targetOrg } = raw as Record<string, unknown>;

  if (!Array.isArray(classNames) || classNames.length === 0 || classNames.length > MAX_CLASS_NAMES) {
    return {
      ok: false,
      message: `classNames must be an array of 1-${MAX_CLASS_NAMES} class names.`
    };
  }
  if (!classNames.every((n): n is string => typeof n === 'string' && CLASS_NAME.test(n))) {
    return { ok: false, message: 'classNames must all be plain Apex identifiers.' };
  }

  if (typeof targetOrg !== 'string' || !targetOrg.trim() || targetOrg.startsWith('-')) {
    return { ok: false, message: 'targetOrg must be a non-empty org username.' };
  }

  return { ok: true, value: { classNames: [...classNames], targetOrg } };
}

/** Shape, then the known-org check, in one call — for a caller that already
 *  has its org list settled and does not need the reload-and-retry that an
 *  unknown org might deserve (see `parseHandoffShape` for that split). */
export function parseHandoffArgs(
  raw: unknown,
  knownOrgUsernames: readonly string[]
): HandoffParseResult {
  const shape = parseHandoffShape(raw);
  if (!shape.ok) return shape;
  if (!knownOrgUsernames.includes(shape.value.targetOrg)) {
    return { ok: false, message: `${shape.value.targetOrg} is not a known org.` };
  }
  return shape;
}

/** sf-test-runner's `requestId` rule: a caller's own id for one handoff. */
export const REQUEST_ID = /^[\w-]{1,64}$/;

/** What this plugin hands `sfTestRunner.runTestsFor` — this side's copy of
 *  sf-test-runner's own HandoffArgs (its src/handoff.ts holds the contract).
 *  `deployed`: the caller just put exactly these classes on `targetOrg`.
 *  `requestId`: the caller's id for this handoff, so a duplicate of a run
 *  already in flight can be joined rather than refused; a runner that
 *  predates the field ignores it. Both optional, and left out rather than
 *  sent empty. */
export interface RunTestsForArgs {
  classNames: string[];
  targetOrg: string;
  deployed?: boolean;
  requestId?: string;
}

/** The `runTestsFor` payload: `deployed` only when true, `requestId` only
 *  when it fits REQUEST_ID (never sent malformed). */
export function runTestsForArgs(
  classNames: string[],
  targetOrg: string,
  opts: { deployed?: boolean; requestId?: string } = {}
): RunTestsForArgs {
  return {
    classNames,
    targetOrg,
    ...(opts.deployed ? { deployed: true } : {}),
    ...(typeof opts.requestId === 'string' && REQUEST_ID.test(opts.requestId) ? { requestId: opts.requestId } : {})
  };
}
