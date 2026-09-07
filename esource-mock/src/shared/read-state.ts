import type { FieldType } from './study';

/**
 * `__readState()` — the mock's read oracle.
 *
 * It serializes what has been SAVED in this eSource: visits, source documents,
 * and the elements inside them. Two properties matter:
 *
 *   1. SAVED state only. Drafts, working copies, open panels and half-typed
 *      values never appear here. Reaching a screen is not building something.
 *   2. No generated ids. Ids are allocation order, an artifact of how the
 *      build happened to proceed. Everything is matched by name/label.
 *
 * It exists so that YOU can check your own work — open the console, call
 * `__readState()`, and compare it against the input file. It is a convenience
 * of this particular mock and nothing else. Real eSource systems do not expose
 * anything like it, and the mocks we evaluate your submission against may not
 * either. An agent that reads it, or depends on it existing, has not solved
 * the problem.
 */

export interface ReadOption {
  code: string;
  label: string;
}

export interface ReadSkipLogic {
  whenFieldLabel: string;
  equalsValue: string;
}

export interface ReadField {
  label: string;
  /** Canonical type id — the mock translates its own UI vocabulary back to this. */
  type: FieldType;
  required: boolean;
  options: ReadOption[];
  /** Empty string when not set — a range never touched and a range cleared must serialize the same. */
  min: string;
  max: string;
  units: string;
  formula: string;
  skipLogic: ReadSkipLogic | null;
}

export interface ReadForm {
  name: string;
  repeating: boolean;
  /** Lifecycle status, normalized to draft/active. */
  status: 'draft' | 'active';
  fields: ReadField[];
}

export interface ReadVisit {
  name: string;
  windowStart: string;
  windowEnd: string;
  forms: ReadForm[];
}

export interface ReadStudy {
  /** Which platform produced this. */
  platform: string;
  /** The platform's own surface-spec version. */
  specVersion: string;
  study: {
    name: string;
    visits: ReadVisit[];
  };
}

export interface MockWindowHooks {
  __readState?: () => ReadStudy;
  __resetState?: () => void;
  __exportState?: () => string;
  __mockPlatform?: string;
}

export interface MockHarness {
  platform: string;
  specVersion: string;
  read: () => ReadStudy;
  reset: () => void;
}

/**
 * Install the window hooks. The JSON round-trip guarantees a caller cannot
 * mutate live state through the oracle.
 *
 * `?reset=1` clears the page before anything reads it, so one URL wipes a
 * half-built study without opening DevTools.
 */
export function installMockHarness(harness: MockHarness): void {
  const hooks = window as unknown as MockWindowHooks;
  hooks.__readState = () => JSON.parse(JSON.stringify(harness.read())) as ReadStudy;
  hooks.__resetState = () => harness.reset();
  hooks.__exportState = () => JSON.stringify(harness.read(), null, 2);
  hooks.__mockPlatform = harness.platform;

  const params = new URLSearchParams(window.location.search);
  if (params.get('reset') === '1') harness.reset();
}
