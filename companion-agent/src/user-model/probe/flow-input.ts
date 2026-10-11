/**
 * Input checks of the asking flow. Every value a caller passes in is untrusted: these functions
 * run on the one owned snapshot an entrance takes, read nothing else, call nothing supplied by
 * the caller, and report a problem by throwing a reason code (see ReasonCode).
 *
 * Two families of checks:
 * - arguments of a call: a missing required member is 'missing_input', a wrong type or a value
 *   outside a closed list is 'invalid_input', a string or list over its bound is 'input_limit';
 * - members the flow itself stores in the probe state (the ledger, the waiting record, the
 *   members of a pending candidate): only this flow and planning write them, so a missing or
 *   malformed one is damaged data and always 'invalid_input' ('input_limit' when over-long).
 */

import {
  CONTENT_FAMILIES,
  FACET_GROUPS,
  PROBE_MODES,
  type ContentFamily,
  type FacetGroup,
  type ProbeIntention,
} from './facets.ts';
import { isDayKey } from './day-keys.ts';
import { REFRACTORY_MESSAGES_MAX, isWeekKey } from './flow-gates.ts';
import { containsName } from './guards.ts';
import type {
  ActiveOffer,
  FlowTurn,
  ItemState,
  ProbeCandidate,
  ProbeFlowLedger,
  ProbeResearchMark,
  ProbeState,
  SettlementRecord,
} from './types.ts';
import {
  checkState,
  checkedArray,
  checkedText,
  fail,
  nonnegative,
  PROBE_LIMITS,
  type ProbeLimits,
  type ProbeWork,
} from './util.ts';

/** The four research marks; the only values a stored mark may have. */
export const RESEARCH_MARKS = Object.freeze(['none', 'after_negative', 'after_positive', 'both'] as const);

/** The four reasons a facet is chosen; the only values a stored intention may have. */
export const PROBE_INTENTIONS = Object.freeze(['first_evidence', 'discriminate', 'add_family', 'add_day'] as const);

/** The three outcomes of a delivered probe. */
export const PROBE_OUTCOMES = Object.freeze(['answered', 'evasive', 'unanswered'] as const);

/** What the reply step may report about a proposal. */
export const OFFER_DISPOSITIONS = Object.freeze(['used', 'rewritten', 'skipped'] as const);

/** States of the one chance roll of a turn. */
export const CHANCE_ROLLS = Object.freeze(['none', 'passed', 'failed'] as const);

/** Depths a registry row may have. */
const DEPTHS = Object.freeze([1, 2, 3] as const);

/**
 * Most facets one user message may name as "do not talk about this". Provisional: one message
 * names a few at most; 64 equals the smallest list budget of the core.
 */
export const DECLINED_FACETS_MAX = 64;

/** A wording hash is sixteen hexadecimal digits, as simhash64 produces them. */
const WORDING_HASH_PATTERN = /^[0-9a-f]{16}$/i;

/** The waiting record with every member the asking flow writes. */
export interface AwaitedProbe {
  candidateId: string;
  facetId: string;
  deliveredAtMs: number;
  group: FacetGroup;
  family: ContentFamily;
  intention: ProbeIntention;
  discriminatesFrom: string | null;
  research: ProbeResearchMark;
  deliveryRef: string;
}

/** A probe state that passed checkFlowState: the ledger is present and the waiting record complete. */
export interface FlowState extends ProbeState {
  awaitingAnswer: AwaitedProbe | null;
  flow: ProbeFlowLedger;
}

/** A required identifier argument: a string of 1 to 128 UTF-16 units. */
export function identifierText(value: unknown): string {
  const text = checkedText(value, PROBE_LIMITS.key);
  if (text.length === 0) fail('invalid_input');
  return text;
}

/** A required boolean argument. */
export function flagValue(value: unknown): boolean {
  if (value === undefined) fail('missing_input');
  if (typeof value !== 'boolean') fail('invalid_input');
  return value;
}

/** A required roll argument: a finite number at least 0 and below 1. Exactly 1 is invalid. */
export function chanceValue(value: unknown): number {
  if (value === undefined) fail('missing_input');
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('invalid_input');
  if (value < 0 || value >= 1) fail('invalid_input');
  return value;
}

/** A required argument that is null or a member of a closed list. */
export function nullableName<T extends string>(list: readonly T[], value: unknown): T | null {
  if (value === undefined) fail('missing_input');
  if (value === null) return null;
  if (!containsName(list, value)) fail('invalid_input');
  return value as T;
}

/** A required argument that is a member of a closed list. */
export function requiredName<T extends string>(list: readonly T[], value: unknown): T {
  const name = nullableName(list, value);
  if (name === null) fail('invalid_input');
  return name;
}

/** The questions she may still ask in this reply: a whole number from 0 up, or null for "unknown". */
export function questionBudgetValue(value: unknown): number | null {
  if (value === undefined) fail('missing_input');
  if (value === null) return null;
  const budget = nonnegative(value);
  if (!Number.isInteger(budget)) fail('invalid_input');
  return budget;
}

/** A wording hash argument: null, or sixteen hexadecimal digits. */
export function wordingHashValue(value: unknown): string | null {
  if (value === undefined) fail('missing_input');
  if (value === null) return null;
  const hash = checkedText(value, PROBE_LIMITS.key);
  if (!WORDING_HASH_PATTERN.test(hash)) fail('invalid_input');
  return hash;
}

/**
 * A list of distinct identifiers with at most `max` members. The length is checked before any
 * member; a list over the bound is refused, never cut.
 */
export function identifierList(value: unknown, max: number, work: ProbeWork): string[] {
  const list = checkedArray(value as unknown[], max);
  const seen = new Set<string>();
  for (let index = 0; index < list.length; index++) {
    work.steps++;
    const identifier = identifierText(list[index]);
    if (seen.has(identifier)) fail('invalid_input');
    seen.add(identifier);
  }
  return [...seen];
}

/** A stored object: anything but a non-array object is damaged data. */
function storedRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_input');
  return value as Record<string, unknown>;
}

/** A stored identifier: a string of 1 to 128 UTF-16 units. */
function storedIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail('invalid_input');
  if (value.length > PROBE_LIMITS.key) fail('input_limit');
  return value;
}

/** A stored identifier or null. */
function storedOptionalIdentifier(value: unknown): string | null {
  if (value === null) return null;
  return storedIdentifier(value);
}

/** A stored moment: a finite number from 0 to the largest representable moment. */
function storedMoment(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('invalid_input');
  if (value < 0 || value > PROBE_LIMITS.timeMs) fail('invalid_input');
  return value;
}

/** A stored whole number from 0 to `max`. */
function storedCount(value: unknown, max: number = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail('invalid_input');
  if (value < 0 || value > max) fail('invalid_input');
  return value;
}

/** A stored boolean. */
function storedFlag(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('invalid_input');
  return value;
}

/** A stored member of a closed list. */
function storedName<T extends string | number>(list: readonly T[], value: unknown): T {
  for (let index = 0; index < list.length; index++) {
    if (list[index] === value) return list[index];
  }
  return fail('invalid_input');
}

/** The description shared by an offer, the waiting record and a settlement. */
function checkProbeDescription(record: Record<string, unknown>): void {
  storedIdentifier(record.candidateId);
  storedIdentifier(record.facetId);
  storedName(FACET_GROUPS, record.group);
  storedName(CONTENT_FAMILIES, record.family);
  storedName(PROBE_INTENTIONS, record.intention);
  storedOptionalIdentifier(record.discriminatesFrom);
  storedName(RESEARCH_MARKS, record.research);
}

/**
 * One pending candidate. Planning mints complete candidates; the asking flow needs the family, the
 * intention and the neighbour from it (group, mode and depth are read from the registry row when a
 * candidate is proposed, so they are checked only when present). An absent research mark means
 * 'none', as planning reads it.
 */
function checkPendingCandidate(candidate: Record<string, unknown>): void {
  storedIdentifier(candidate.candidateId);
  storedIdentifier(candidate.facetId);
  storedMoment(candidate.validUntilMs);
  if (candidate.group !== undefined) storedName(FACET_GROUPS, candidate.group);
  if (candidate.mode !== undefined) storedName(PROBE_MODES, candidate.mode);
  if (candidate.depth !== undefined) storedName(DEPTHS, candidate.depth);
  storedName(CONTENT_FAMILIES, candidate.family);
  storedName(PROBE_INTENTIONS, candidate.intention);
  storedOptionalIdentifier(candidate.discriminatesFrom);
  if (candidate.research !== undefined) storedName(RESEARCH_MARKS, candidate.research);
  if (candidate.lastOfferedAtMs !== undefined) storedMoment(candidate.lastOfferedAtMs);
}

/** The per-facet record: members planning or the flow wrote; an absent or null member means "none". */
function checkItemState(item: Record<string, unknown>): void {
  if (item.lastDeliveredAtMs !== undefined && item.lastDeliveredAtMs !== null) storedMoment(item.lastDeliveredAtMs);
  if (item.cooldownUntilMs !== undefined && item.cooldownUntilMs !== null) storedMoment(item.cooldownUntilMs);
  if (item.evasiveStreak !== undefined) storedCount(item.evasiveStreak);
  if (item.nextApproachIndex !== undefined) storedCount(item.nextApproachIndex);
}

/**
 * One stored wording fingerprint: a hash of sixteen hexadecimal digits, the facet it was said
 * about and the moment. The delivery report reads every stored entry, so a damaged one is refused
 * here, by every entrance alike, and not when a question that was already said is reported.
 */
function checkFingerprint(value: unknown): void {
  const entry = storedRecord(value);
  if (typeof entry.hash !== 'string' || !WORDING_HASH_PATTERN.test(entry.hash)) fail('invalid_input');
  storedIdentifier(entry.facetId);
  storedMoment(entry.atMs);
}

/**
 * Refuse a state that holds undefined anywhere. The shared snapshot leaves out an undefined member
 * of an object but keeps one inside an array, and every entrance returns a copy of this state:
 * without this walk the value would come back to the caller. The snapshot has already bounded the
 * depth and the number of nodes; one step is counted per member looked at.
 */
function refuseUndefined(value: unknown, work: ProbeWork): void {
  if (value === null || typeof value !== 'object') return;
  const members: unknown[] = Array.isArray(value) ? value : Object.values(value);
  for (let index = 0; index < members.length; index++) {
    work.steps++;
    if (members[index] === undefined) fail('invalid_input');
    refuseUndefined(members[index], work);
  }
}

/** The waiting record: null, or complete and valid. */
function checkAwaited(value: unknown): AwaitedProbe | null {
  if (value === undefined || value === null) return null;
  const record = storedRecord(value);
  checkProbeDescription(record);
  storedMoment(record.deliveredAtMs);
  storedIdentifier(record.deliveryRef);
  return record as unknown as AwaitedProbe;
}

/** A stored settlement: complete and valid. */
function checkSettlement(value: unknown, work: ProbeWork): SettlementRecord {
  const record = storedRecord(value);
  storedIdentifier(record.turnId);
  checkProbeDescription(record);
  storedIdentifier(record.deliveryRef);
  storedMoment(record.deliveredAtMs);
  storedMoment(record.settledAtMs);
  storedName(PROBE_OUTCOMES, record.outcome);
  storedFlag(record.timedOut);
  if (record.elicitation !== 'probe') fail('invalid_input');
  const elicited = record.elicitedFacetIds;
  if (!Array.isArray(elicited) || elicited.length < 1 || elicited.length > 2) fail('invalid_input');
  for (let index = 0; index < elicited.length; index++) {
    work.steps++;
    storedIdentifier(elicited[index]);
  }
  return record as unknown as SettlementRecord;
}

/** The stored turn: null, or complete and valid. */
function checkTurn(value: unknown, work: ProbeWork): FlowTurn | null {
  if (value === null) return null;
  const record = storedRecord(value);
  storedIdentifier(record.turnId);
  storedFlag(record.refusal);
  storedFlag(record.refractory);
  if (record.settlement !== null) checkSettlement(record.settlement, work);
  storedName(CHANCE_ROLLS, record.chanceRoll);
  return record as unknown as FlowTurn;
}

/** The stored offer: null, or complete and valid. */
function checkOffer(value: unknown): ActiveOffer | null {
  if (value === null) return null;
  const record = storedRecord(value);
  storedIdentifier(record.turnId);
  checkProbeDescription(record);
  storedName(PROBE_MODES, record.mode);
  storedName(DEPTHS, record.depth);
  if (record.approachIndex !== null) storedCount(record.approachIndex);
  storedMoment(record.offeredAtMs);
  return record as unknown as ActiveOffer;
}

/** An empty ledger: nothing received, nothing proposed, no pause, no research probes, nothing withdrawn. */
function emptyLedger(): ProbeFlowLedger {
  return {
    turn: null,
    offer: null,
    refractoryLeft: 0,
    research: { weekCounts: {}, lastProbeDayByFacet: {} },
    withdrawn: 0,
  };
}

/** The ledger: an empty one for an absent or null value, else complete and valid. */
function checkLedger(value: unknown, work: ProbeWork): ProbeFlowLedger {
  if (value === undefined || value === null) return emptyLedger();
  const ledger = storedRecord(value);
  checkTurn(ledger.turn, work);
  checkOffer(ledger.offer);
  storedCount(ledger.refractoryLeft, REFRACTORY_MESSAGES_MAX);

  const research = storedRecord(ledger.research);
  const weekCounts = storedRecord(research.weekCounts);
  for (const weekKey of Object.keys(weekCounts)) {
    work.steps++;
    if (!isWeekKey(weekKey)) fail('invalid_input');
    storedCount(weekCounts[weekKey]);
  }
  const lastProbeDays = storedRecord(research.lastProbeDayByFacet);
  for (const facetId of Object.keys(lastProbeDays)) {
    work.steps++;
    if (!isDayKey(lastProbeDays[facetId])) fail('invalid_input');
  }

  storedCount(ledger.withdrawn);
  return ledger as unknown as ProbeFlowLedger;
}

/** A stored counter that older states may lack: absent or null counts as 0. */
function counterOrZero(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return storedCount(value);
}

/**
 * Check the probe state of a flow call and complete it in place (the argument is the entrance's own
 * snapshot, never the caller's object). Runs the shared state check first, then the members the
 * flow depends on, then the invariants:
 * - a proposal and a waiting record never exist together (at most one probe is in flight);
 * - the waiting probe is no longer among the pending candidates;
 * - pending candidates have distinct identifiers.
 * Last, the whole state is walked once and refused when it holds undefined anywhere.
 * A proposal whose candidate planning has meanwhile dropped is valid input; the transitions treat
 * it as skipped. Throws the reason code of the first problem.
 */
export function checkFlowState(state: unknown, work: ProbeWork, limits: ProbeLimits): FlowState {
  checkState(state, work, limits);
  const record = state as unknown as Record<string, unknown>;

  const stats = record.stats as Record<string, unknown>;
  stats.offers = counterOrZero(stats.offers);
  stats.rejectedDeliveries = counterOrZero(stats.rejectedDeliveries);

  const items = record.items as Record<string, Record<string, unknown>>;
  for (const facetId of Object.keys(items)) {
    work.steps++;
    checkItemState(items[facetId]);
  }

  const pendingIds = new Set<string>();
  for (const candidate of record.pending as Record<string, unknown>[]) {
    work.steps++;
    checkPendingCandidate(candidate);
    if (pendingIds.has(candidate.candidateId as string)) fail('invalid_input');
    pendingIds.add(candidate.candidateId as string);
  }

  for (const fingerprint of record.fingerprints as unknown[]) {
    work.steps++;
    checkFingerprint(fingerprint);
  }

  const awaiting = checkAwaited(record.awaitingAnswer);
  record.awaitingAnswer = awaiting;
  const ledger = checkLedger(record.flow, work);
  record.flow = ledger;

  if (ledger.offer !== null && awaiting !== null) fail('invalid_input');
  if (awaiting !== null && pendingIds.has(awaiting.candidateId)) fail('invalid_input');

  refuseUndefined(record, work);
  return record as unknown as FlowState;
}

/** The per-facet record of a facet, created with no delivery, no cooldown and zero counters when absent. */
export function itemStateOf(items: Record<string, ItemState>, facetId: string): ItemState {
  const existing = Object.hasOwn(items, facetId) ? items[facetId] : undefined;
  if (existing !== undefined) return existing;
  const created: ItemState = {
    lastDeliveredAtMs: null,
    cooldownUntilMs: null,
    evasiveStreak: 0,
    nextApproachIndex: 0,
  };
  Object.defineProperty(items, facetId, { value: created, enumerable: true, writable: true, configurable: true });
  return created;
}

/** Position of a candidate in the pending list, or -1. */
export function pendingIndexOf(pending: ProbeCandidate[], candidateId: string, work: ProbeWork): number {
  for (let index = 0; index < pending.length; index++) {
    work.steps++;
    if (pending[index].candidateId === candidateId) return index;
  }
  return -1;
}
