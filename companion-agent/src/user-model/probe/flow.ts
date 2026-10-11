/**
 * The asking flow: the life of one probe as a pure state machine.
 *
 *   pending  --offerProbe-->  offered  --settleOffer(used | rewritten)-->  delivered
 *   delivered  --receiveUserTurn-->  answered | evasive | unanswered
 *
 * Four entrances, one per event:
 * - receiveUserTurn: a user message was accepted; settles the probe that waited for it.
 * - offerProbe: asks whether a pending candidate may be proposed in this turn, and which.
 * - settleOffer: reports what the reply step did with the proposal, after the host accepted her reply.
 * - withdrawDelivery: her message that carried the question is no longer valid.
 *
 * Every entrance takes one owned snapshot of its input, never changes the caller's objects, and
 * returns a new state (null on failure: the caller keeps the state it had). There is no clock, no
 * randomness, no storage and no text here: moments, keys, identifiers and rolls come in as
 * arguments, and outputs carry identifiers, closed-list values, numbers and booleans only.
 *
 * What stops what:
 * - The learning switch stops everything and drops what is in flight; it never erases what was learned.
 * - The distress window, the universal situations, a refusal and the other gates of offerProbe stop
 *   only her asking. receiveUserTurn has no such inputs on purpose: a settlement and its
 *   elicitation mark are produced in every situation, because passive collection never stops
 *   while learning is on.
 */

import { facetGateCore, type FacetGateReason } from './facet-rules.ts';
import {
  UNIVERSAL_SITUATIONS,
  type FacetGroup,
  type FacetView,
  type PlanGates,
  type RegistryRow,
} from './facets.ts';
import { flowConfigOf, researchMarkOfCore, type ProbeFlowConfig } from './flow-gates.ts';
import {
  DECLINED_FACETS_MAX,
  OFFER_DISPOSITIONS,
  PROBE_OUTCOMES,
  chanceValue,
  checkFlowState,
  flagValue,
  identifierList,
  identifierText,
  itemStateOf,
  nullableName,
  pendingIndexOf,
  questionBudgetValue,
  requiredName,
  wordingHashValue,
  type AwaitedProbe,
  type FlowState,
} from './flow-input.ts';
import { containsName } from './guards.ts';
import {
  archetypeEligibleCore,
  capacityLeftCore,
  effectiveMinIntervalDaysCore,
  noteScheduledCore,
  timeEligibleCore,
} from './schedule.ts';
import { validateSelectCore } from './select-facets.ts';
import type {
  ActiveOffer,
  CountStat,
  OfferOutcome,
  ProbeCandidate,
  ProbeOutcome,
  ProbeResearchMark,
  ProbeState,
  SettlementRecord,
  TurnContext,
} from './types.ts';
import {
  boundedCopy,
  checkContext,
  checkedText,
  copyCore,
  dataObject,
  fail,
  limitsFor,
  newWork,
  nonnegative,
  ownValue,
  PROBE_LIMITS,
  reasonOf,
  type ProbeWork,
  type ReasonCode,
} from './util.ts';

/** Milliseconds in one day; the unit of a registry row's minimum gap. */
const DAY_MS = 86_400_000;

/**
 * A valid day key handed to the shared selection check, which insists on one, while the registry,
 * the views and the gates are checked. The real day key is checked afterwards with the context,
 * so that the reason code follows the declared order of the members.
 */
const PLACEHOLDER_DAY = '2000-01-01';

/** Set an own data property; safe for keys such as "__proto__" and "constructor". */
function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

/** The counters of one key, created as four zeros when absent. */
function countStatOf(record: Record<string, CountStat>, key: string): CountStat {
  const existing = ownValue(record, key);
  if (existing !== undefined) return existing;
  const created: CountStat = { delivered: 0, answered: 0, evasive: 0, unanswered: 0 };
  setOwn(record, key, created);
  return created;
}

/** Add one to a counter; a counter an older state left null or absent starts at 0. */
function addOne(stat: CountStat, member: keyof CountStat): void {
  stat[member] = (stat[member] ?? 0) + 1;
}

/** Add one to the same counter of the totals, the facet and the facet's group. */
function countEverywhere(state: FlowState, facetId: string, group: FacetGroup, member: keyof CountStat): void {
  addOne(state.stats.totals, member);
  addOne(countStatOf(state.stats.byItem, facetId), member);
  addOne(countStatOf(state.groupStats as Record<string, CountStat>, group), member);
}

/**
 * Stop everything for a user who switched learning off: nothing stays pending, proposed or
 * waiting, and the waiting probe is dropped without an outcome. What was learned stays: the
 * per-facet records, the counters, the coverage, the fingerprints, the schedule counts, the
 * research ledger and the pause countdown are not touched. Erasing is never done here; it is a
 * manual operation of the user on the backend page.
 * Returns the identifiers of the dropped candidates in their pending order.
 */
function stopForLearningOffCore(state: FlowState, work: ProbeWork): string[] {
  const dropped: string[] = [];
  for (const candidate of state.pending) {
    work.steps++;
    dropped.push(candidate.candidateId);
  }
  state.pending = [];
  state.readyScores = [];
  state.awaitingAnswer = null;
  state.flow.offer = null;
  // No turn counts as received while learning is off: a later offer needs a new user turn.
  state.flow.turn = null;
  return dropped;
}

// ---------------------------------------------------------------------------------------------
// receiveUserTurn
// ---------------------------------------------------------------------------------------------

export interface ReceiveUserTurnInput {
  state: ProbeState;
  /** Identifier of the accepted user message; 1 to 128 UTF-16 units. */
  turnId: string;
  /** The moment of the message in milliseconds, 0 to 8,640,000,000,000,000. */
  nowMs: number;
  /** The consent switch of the user; false stops everything. Nothing said in chat changes it. */
  learningEnabled: boolean;
  /**
   * The judgement of an earlier model step on whether this message answers the waiting probe;
   * null when there is no judgement. Ignored when no probe waits.
   */
  answer: ProbeOutcome | null;
  /**
   * True when this message refuses her asking in any way: he does not want to talk about
   * something, wants her to ask less or not at all, wants her to leave him alone for now, or
   * rejects the probe just asked. Decided by an earlier model step; no text is read here.
   */
  refusal: boolean;
  /** Facets he named in this message as not to be talked about; at most 64 distinct identifiers. */
  declinedFacetIds: string[];
  /** A roll at least 0 and below 1 that picks the length of the pause after a settled probe. */
  spanChance: number;
  cfg?: ProbeFlowConfig | null;
}

export interface ReceiveUserTurnResult {
  /**
   * 'received': a new turn was processed. 'duplicate': the same turn again, nothing changed.
   * 'learning_disabled': learning is off, everything in flight was dropped. 'failed': invalid input.
   */
  status: 'received' | 'duplicate' | 'learning_disabled' | 'failed';
  /** The new state; null exactly when status is 'failed'. */
  state: ProbeState | null;
  /** The settlement of the probe this turn settled (on a duplicate: the stored one), or null. */
  settlement: SettlementRecord | null;
  /** Candidates removed from the pending list in this call, in their pending order. */
  droppedCandidateIds: string[];
  /** null unless status is 'failed'. */
  reasonCode: ReasonCode;
  work: ProbeWork;
}

interface ReceiveArguments {
  state: FlowState;
  turnId: string;
  nowMs: number;
  learningEnabled: boolean;
  answer: ProbeOutcome | null;
  refusal: boolean;
  declinedFacetIds: string[];
  spanChance: number;
  cfg: ProbeFlowConfig;
}

/**
 * Length of the pause after a settled probe, in user messages: the minimum plus a whole number
 * from 0 to (maximum - minimum), picked by the roll. A roll below 1 never exceeds the maximum.
 */
function refractorySpanCore(spanChance: number, cfg: ProbeFlowConfig): number {
  const choices = cfg.refractoryMaxMessages - cfg.refractoryMinMessages + 1;
  return cfg.refractoryMinMessages + Math.floor(spanChance * choices);
}

/**
 * Settle the waiting probe with the first user message after its delivery and return the record.
 * The outcome is the given judgement when the message came within the waiting time, else
 * 'unanswered'. Counts the outcome and keeps the evasive streak of the facet.
 */
function settleAwaitedCore(
  state: FlowState,
  awaiting: AwaitedProbe,
  turn: ReceiveArguments,
): SettlementRecord {
  const elapsedMs = turn.nowMs - awaiting.deliveredAtMs;
  // A negative time means the clock went backwards: nothing can be decided, so nothing is claimed.
  const timedOut = elapsedMs > turn.cfg.awaitingAnswerTtlMs || elapsedMs < 0;
  const outcome: ProbeOutcome = timedOut || turn.answer === null ? 'unanswered' : turn.answer;

  countEverywhere(state, awaiting.facetId, awaiting.group, outcome);

  // The streak only spaces out her asking about one facet. It is not a reading of the user.
  const item = itemStateOf(state.items, awaiting.facetId);
  if (outcome === 'evasive') {
    item.evasiveStreak = (item.evasiveStreak ?? 0) + 1;
    if (item.evasiveStreak >= turn.cfg.maxEvasiveStreak) {
      item.cooldownUntilMs = turn.nowMs + turn.cfg.evasiveCooldownMs;
      item.evasiveStreak = 0;
    }
  }
  if (outcome === 'answered') item.evasiveStreak = 0;

  // The mark is the same for all three outcomes, a late message included: whatever this message
  // says about these facets was asked for, and must never be counted as spontaneous.
  const elicitedFacetIds = [awaiting.facetId];
  if (awaiting.discriminatesFrom !== null && awaiting.discriminatesFrom !== awaiting.facetId) {
    elicitedFacetIds.push(awaiting.discriminatesFrom);
  }

  state.awaitingAnswer = null;
  return {
    turnId: turn.turnId,
    candidateId: awaiting.candidateId,
    facetId: awaiting.facetId,
    group: awaiting.group,
    family: awaiting.family,
    intention: awaiting.intention,
    discriminatesFrom: awaiting.discriminatesFrom,
    research: awaiting.research,
    deliveryRef: awaiting.deliveryRef,
    deliveredAtMs: awaiting.deliveredAtMs,
    settledAtMs: turn.nowMs,
    outcome,
    timedOut,
    elicitation: 'probe',
    elicitedFacetIds,
  };
}

/**
 * Remove the pending candidates of the facets he does not want to talk about, with their
 * prescores. The fact "declined" itself is not kept here: a later package stores it and hands it
 * back in the facet view, so that there is one authority for it.
 */
function dropDeclinedCore(state: FlowState, declinedFacetIds: string[], work: ProbeWork): string[] {
  if (declinedFacetIds.length === 0) return [];
  const declined = new Set(declinedFacetIds);
  const dropped: string[] = [];
  const kept: ProbeCandidate[] = [];
  for (const candidate of state.pending) {
    work.steps++;
    if (declined.has(candidate.facetId)) dropped.push(candidate.candidateId);
    else kept.push(candidate);
  }
  const droppedIds = new Set(dropped);
  state.pending = kept;
  state.readyScores = state.readyScores.filter((score) => {
    work.steps++;
    return !declined.has(score.facetId) && !droppedIds.has(score.candidateId);
  });
  return dropped;
}

/** The transition of receiveUserTurn on checked arguments; changes the owned state in place. */
export function receiveUserTurnCore(
  turn: ReceiveArguments,
  work: ProbeWork,
): Pick<ReceiveUserTurnResult, 'status' | 'settlement' | 'droppedCandidateIds'> {
  const state = turn.state;
  const flow = state.flow;

  // The consent switch comes before everything else, a repeated turn included.
  if (!turn.learningEnabled) {
    const dropped = stopForLearningOffCore(state, work);
    return { status: 'learning_disabled', settlement: null, droppedCandidateIds: dropped };
  }

  // The same user message again (a regenerated reply): nothing is settled or counted twice.
  if (flow.turn !== null && flow.turn.turnId === turn.turnId) {
    return { status: 'duplicate', settlement: flow.turn.settlement, droppedCandidateIds: [] };
  }

  // A proposal nobody reported on belongs to a reply that was never accepted: it counts as skipped.
  flow.offer = null;

  let settlement: SettlementRecord | null = null;
  let refractory = false;
  if (state.awaitingAnswer !== null) {
    settlement = settleAwaitedCore(state, state.awaitingAnswer, turn);
    // The pause starts after any outcome. The settling turn itself is closed by its settlement.
    flow.refractoryLeft = refractorySpanCore(turn.spanChance, turn.cfg);
  } else {
    refractory = flow.refractoryLeft > 0;
    if (refractory) flow.refractoryLeft -= 1;
  }

  const dropped = dropDeclinedCore(state, turn.declinedFacetIds, work);

  flow.turn = {
    turnId: turn.turnId,
    refusal: turn.refusal || turn.declinedFacetIds.length > 0,
    refractory,
    settlement,
    chanceRoll: 'none',
  };
  return { status: 'received', settlement, droppedCandidateIds: dropped };
}

/**
 * A user message was accepted. In this order: stop everything when learning is off; return the
 * stored result for a repeated turn; drop an unreported proposal; settle the waiting probe (or
 * count down the pause); drop the candidates of declined facets; remember the turn.
 * Never throws. On invalid input: status 'failed', state null, a reason code.
 */
export function receiveUserTurn(input: ReceiveUserTurnInput): ReceiveUserTurnResult {
  const work = newWork();
  try {
    dataObject(input);
    const limits = limitsFor();
    const owned = boundedCopy(input, work, limits, true) as unknown as Record<string, unknown>;

    const state = checkFlowState(owned.state, work, limits);
    const turnId = identifierText(owned.turnId);
    const nowMs = nonnegative(owned.nowMs, PROBE_LIMITS.timeMs);
    const learningEnabled = flagValue(owned.learningEnabled);
    const answer = nullableName(PROBE_OUTCOMES, owned.answer);
    const refusal = flagValue(owned.refusal);
    const declinedFacetIds = identifierList(owned.declinedFacetIds, DECLINED_FACETS_MAX, work);
    const spanChance = chanceValue(owned.spanChance);
    const cfg = flowConfigOf(owned.cfg, limits);
    if (nowMs + cfg.evasiveCooldownMs > PROBE_LIMITS.timeMs) fail('input_limit');

    const outcome = receiveUserTurnCore(
      { state, turnId, nowMs, learningEnabled, answer, refusal, declinedFacetIds, spanChance, cfg },
      work,
    );
    return {
      status: outcome.status,
      state: copyCore(state, work),
      settlement: copyCore(outcome.settlement, work),
      droppedCandidateIds: outcome.droppedCandidateIds,
      reasonCode: null,
      work,
    };
  } catch (error) {
    return {
      status: 'failed',
      state: null,
      settlement: null,
      droppedCandidateIds: [],
      reasonCode: reasonOf(error),
      work,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// offerProbe
// ---------------------------------------------------------------------------------------------

/** The call-level gate that closed a proposal, in the order in which the gates are checked. */
export type OfferClosedBy =
  | 'learning_disabled' | 'turn_not_received' | 'distress_window' | 'universal_situation'
  | 'refusal' | 'settled_this_turn' | 'awaiting_answer' | 'question_budget'
  | 'refractory' | 'no_capacity' | 'no_candidate' | 'chance';

/** Why one pending candidate is not proposed now; the first failing check supplies the reason. */
export type OfferRejectReason =
  | 'expired' | 'offer_cooldown' | 'no_row' | FacetGateReason
  | 'research_ceiling' | 'item_cooldown' | 'interval' | 'context';

export interface OfferProbeInput {
  state: ProbeState;
  /** The user turn the reply is written for; it must be the turn receiveUserTurn saw last. */
  turnId: string;
  /** The registry and the facet views, as for planning; there may not be more views than rows. */
  registry: RegistryRow[];
  facets: FacetView[];
  gates: PlanGates;
  ctx: TurnContext;
  /** The seed planning uses for the per-facet interval; at most 128 UTF-16 units. */
  seed: string;
  /** Questions she may still ask in this reply: a whole number, or null when unknown (then none). */
  questionBudgetRemaining: number | null;
  /** A roll at least 0 and below 1; a candidate is proposed when it is below cfg.passProbability. */
  chance: number;
  cfg?: ProbeFlowConfig | null;
}

export interface OfferProbeResult {
  /**
   * 'offered': a candidate is proposed. 'duplicate': the proposal of this turn again.
   * 'closed': nothing is proposed, closedBy says why. 'failed': invalid input.
   */
  status: 'offered' | 'duplicate' | 'closed' | 'failed';
  /** The new state; null exactly when status is 'failed'. */
  state: ProbeState | null;
  offer: ActiveOffer | null;
  /** Set exactly when status is 'closed'. */
  closedBy: OfferClosedBy | null;
  /** The candidates looked at and refused before the decision, in the order they were looked at. */
  rejected: { candidateId: string; reason: OfferRejectReason }[];
  /** null unless status is 'failed'. */
  reasonCode: ReasonCode;
  work: ProbeWork;
}

interface OfferArguments {
  state: FlowState;
  turnId: string;
  registry: RegistryRow[];
  facets: FacetView[];
  gates: PlanGates;
  ctx: TurnContext;
  seed: string;
  questionBudgetRemaining: number | null;
  chance: number;
  cfg: ProbeFlowConfig;
}

/** Lookups built once per call, so that no candidate scans the whole registry. */
interface OfferScene {
  rowById: Map<string, RegistryRow>;
  viewById: Map<string, FacetView>;
}

/**
 * Check one pending candidate in fixed order and return the first reason against proposing it
 * now, or null. This is the check before speaking: up to 72 hours pass between planning and a
 * proposal, in which he may have declined the facet, given feedback or corrected an entry, so the
 * single-facet gate runs again on the current view.
 */
function candidateRejectionCore(
  candidate: ProbeCandidate,
  offer: OfferArguments,
  scene: OfferScene,
  work: ProbeWork,
): OfferRejectReason | null {
  const nowMs = offer.ctx.nowMs;
  if (candidate.validUntilMs <= nowMs) return 'expired';

  // A skipped candidate is kept for a better moment, but not pushed again right away.
  const lastOfferedAtMs = candidate.lastOfferedAtMs;
  if (lastOfferedAtMs !== undefined && nowMs - lastOfferedAtMs < offer.cfg.offerCooldownMs) return 'offer_cooldown';

  const row = scene.rowById.get(candidate.facetId);
  if (row === undefined) return 'no_row';

  const view = scene.viewById.get(candidate.facetId);
  const gate = facetGateCore({
    row,
    facet: view,
    gates: offer.gates,
    today: offer.ctx.dayKey,
    work,
    bandOf: (facetId) => scene.viewById.get(facetId)?.band,
  });
  if (!gate.eligible) return gate.reason;

  // A facet under review draws on the weekly research ceiling. The quiet period and the gap
  // between two research probes about one facet were checked by the gate above.
  const research = offer.gates.research;
  if (researchMarkOfCore(view) !== 'none') {
    if (research === null || research.perWeekTotal - research.probesThisWeek <= 0) return 'research_ceiling';
  }

  // No record for the facet means it was never asked about: no cooldown and no interval apply.
  const item = ownValue(offer.state.items, candidate.facetId);
  const cooldownUntilMs = item?.cooldownUntilMs ?? null;
  if (cooldownUntilMs !== null && cooldownUntilMs > nowMs) return 'item_cooldown';

  const lastDeliveredAtMs = item?.lastDeliveredAtMs ?? null;
  if (lastDeliveredAtMs !== null) {
    const intervalDays = effectiveMinIntervalDaysCore(
      candidate.facetId,
      row.minGapDays,
      offer.seed,
      work,
      offer.cfg.jitterFraction,
    );
    if (nowMs - lastDeliveredAtMs < intervalDays * DAY_MS) return 'interval';
  }

  // The weekly rotation of forms is a filter of planning and is not repeated here: a candidate
  // planned late in one week may still be proposed early in the next.
  if (!archetypeEligibleCore(row, offer.ctx, work)) return 'context';
  if (!timeEligibleCore(row, offer.ctx, work)) return 'context';
  return null;
}

/** The index into the row's approach hints for this proposal, or null when the row has none. */
function approachIndexCore(row: RegistryRow, state: FlowState, facetId: string): number | null {
  if (row.approachHints.length === 0) return null;
  const nextIndex = ownValue(state.items, facetId)?.nextApproachIndex ?? 0;
  return nextIndex % row.approachHints.length;
}

/** The decision of offerProbeCore, before the entrance adds the state copy and the work counters. */
type OfferDecision = Pick<OfferProbeResult, 'status' | 'offer' | 'closedBy' | 'rejected'>;

/** The transition of offerProbe on checked arguments; changes the owned state in place. */
export function offerProbeCore(offer: OfferArguments, work: ProbeWork): OfferDecision {
  const state = offer.state;
  const flow = state.flow;
  const rejected: { candidateId: string; reason: OfferRejectReason }[] = [];
  const closed = (closedBy: OfferClosedBy): OfferDecision => {
    return { status: 'closed', offer: null, closedBy, rejected };
  };

  if (!offer.gates.learningEnabled) {
    stopForLearningOffCore(state, work);
    return closed('learning_disabled');
  }

  // Proposals happen on user turns only: her own contact never starts with a probe.
  const turn = flow.turn;
  if (turn === null || turn.turnId !== offer.turnId) return closed('turn_not_received');

  // A proposal of another turn, or one whose candidate planning has dropped, counts as skipped.
  if (flow.offer !== null) {
    const stillPending = pendingIndexOf(state.pending, flow.offer.candidateId, work) >= 0;
    if (flow.offer.turnId !== offer.turnId || !stillPending) flow.offer = null;
  }
  if (flow.offer !== null) return { status: 'duplicate', offer: flow.offer, closedBy: null, rejected };

  // From here to the capacity check a closed gate changes nothing: these moments stop her asking
  // only, and what is pending or waiting stays as it is.
  const archetypes = offer.ctx.archetypes ?? [];
  if (offer.gates.distressWindow || archetypes.includes('distress_moment')) return closed('distress_window');

  for (let index = 0; index < offer.gates.situations.length; index++) {
    work.steps++;
    // Advisory situations are not in this list and close nothing.
    if (containsName(UNIVERSAL_SITUATIONS, offer.gates.situations[index])) return closed('universal_situation');
  }

  if (turn.refusal) return closed('refusal');
  if (turn.settlement !== null) return closed('settled_this_turn');
  if (state.awaitingAnswer !== null) return closed('awaiting_answer');

  // An unknown budget is a gate that cannot be decided, and such a gate is closed.
  const budget = offer.questionBudgetRemaining;
  if (budget === null || budget <= 0) return closed('question_budget');
  if (turn.refractory) return closed('refractory');

  // The ceiling counts deliveries. Pending candidates do not use it up, or nothing could be proposed.
  if (capacityLeftCore(state, offer.ctx, offer.cfg.schedule, work) <= 0) return closed('no_capacity');

  const scene: OfferScene = { rowById: new Map(), viewById: new Map() };
  for (const row of offer.registry) {
    work.steps++;
    scene.rowById.set(row.facetId, row);
  }
  for (const view of offer.facets) {
    work.steps++;
    scene.viewById.set(view.facetId, view);
  }

  // The first candidate in pending order that passes every check is the one; later ones are not looked at.
  let chosen: ProbeCandidate | null = null;
  for (const candidate of state.pending) {
    work.steps++;
    const reason = candidateRejectionCore(candidate, offer, scene, work);
    if (reason === null) {
      chosen = candidate;
      break;
    }
    rejected.push({ candidateId: candidate.candidateId, reason });
  }
  if (chosen === null) return closed('no_candidate');

  // One roll per user turn: a regenerated reply reads the stored result instead of rolling again,
  // so that regenerating cannot raise the probability of a probe.
  if (turn.chanceRoll === 'none') turn.chanceRoll = offer.chance < offer.cfg.passProbability ? 'passed' : 'failed';
  if (turn.chanceRoll === 'failed') return closed('chance');

  // A proposal registers nothing: the reply may still drop the question. Only three things change.
  const row = scene.rowById.get(chosen.facetId) as RegistryRow;
  const proposal: ActiveOffer = {
    turnId: offer.turnId,
    candidateId: chosen.candidateId,
    facetId: chosen.facetId,
    group: row.group,
    mode: row.mode,
    depth: row.depth,
    family: chosen.family,
    intention: chosen.intention,
    discriminatesFrom: chosen.discriminatesFrom,
    research: researchMarkOfCore(scene.viewById.get(chosen.facetId)),
    approachIndex: approachIndexCore(row, state, chosen.facetId),
    offeredAtMs: offer.ctx.nowMs,
  };
  chosen.lastOfferedAtMs = offer.ctx.nowMs;
  flow.offer = proposal;
  state.stats.offers += 1;
  return { status: 'offered', offer: proposal, closedBy: null, rejected };
}

/**
 * Ask whether a pending candidate may be proposed in this turn. The call-level gates are checked
 * in the order of OfferClosedBy and the first closed one names closedBy; then the pending
 * candidates are checked in their order and the first that passes is proposed, subject to one
 * chance roll per turn. A proposal changes only the candidate's lastOfferedAtMs, the stored offer
 * and the offers counter; a delivery is registered by settleOffer.
 * Never throws. On invalid input: status 'failed', state null, a reason code.
 */
export function offerProbe(input: OfferProbeInput): OfferProbeResult {
  const work = newWork();
  try {
    dataObject(input);
    const limits = limitsFor();
    const owned = boundedCopy(input, work, limits, true) as unknown as Record<string, unknown>;

    const state = checkFlowState(owned.state, work, limits);
    const turnId = identifierText(owned.turnId);
    for (const member of ['registry', 'facets', 'gates'] as const) {
      if (owned[member] === undefined) fail('missing_input');
    }
    const validated = validateSelectCore(
      {
        registry: owned.registry,
        facets: owned.facets,
        gates: owned.gates,
        today: PLACEHOLDER_DAY,
        capacity: 1,
        pendingResearch: 0,
        groupLastCoveredMs: {},
        allowedDepth: {},
        blocked: [],
      },
      work,
    );
    if (!validated.ok) fail(validated.reason);
    const ctx = owned.ctx as TurnContext;
    checkContext(ctx);
    const seed = checkedText(owned.seed, PROBE_LIMITS.key);
    const questionBudgetRemaining = questionBudgetValue(owned.questionBudgetRemaining);
    const chance = chanceValue(owned.chance);
    const cfg = flowConfigOf(owned.cfg, limits);

    const outcome = offerProbeCore(
      {
        state,
        turnId,
        registry: validated.value.registry,
        facets: validated.value.facets,
        gates: validated.value.gates,
        ctx,
        seed,
        questionBudgetRemaining,
        chance,
        cfg,
      },
      work,
    );
    return {
      status: outcome.status,
      state: copyCore(state, work),
      offer: copyCore(outcome.offer, work),
      closedBy: outcome.closedBy,
      rejected: outcome.rejected,
      reasonCode: null,
      work,
    };
  } catch (error) {
    return {
      status: 'failed',
      state: null,
      offer: null,
      closedBy: null,
      rejected: [],
      reasonCode: reasonOf(error),
      work,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// settleOffer
// ---------------------------------------------------------------------------------------------

export interface SettleOfferInput {
  state: ProbeState;
  /** The turn and the candidate of the proposal that is reported on. */
  turnId: string;
  candidateId: string;
  /**
   * 'used' or 'rewritten': her reply with the question was accepted by the host.
   * 'skipped': the reply did not ask it.
   */
  disposition: OfferOutcome;
  /** Identifier of her accepted message; required for 'used' and 'rewritten', null for 'skipped'. */
  deliveryRef: string | null;
  /** The 16-digit hexadecimal hash of the wording, computed by the caller, or null. */
  wordingHash: string | null;
  /** The moment and the local day and week of the accepted reply. */
  ctx: TurnContext;
  learningEnabled: boolean;
  cfg?: ProbeFlowConfig | null;
}

/** What a delivery registered, for the question log a later package keeps. Identifiers and numbers only. */
export interface DeliveryRegistration {
  candidateId: string;
  facetId: string;
  group: FacetGroup;
  family: ActiveOffer['family'];
  intention: ActiveOffer['intention'];
  discriminatesFrom: string | null;
  research: ProbeResearchMark;
  deliveryRef: string;
  deliveredAtMs: number;
  dayKey: string;
  weekKey: string;
  approachIndex: number | null;
  wordingHash: string | null;
  disposition: 'used' | 'rewritten';
}

export interface SettleOfferResult {
  /**
   * 'delivered': the delivery is registered. 'skipped': the proposal is closed, the candidate stays.
   * 'duplicate': this delivery was already registered. 'rejected': the report matches no proposal.
   * 'learning_disabled': learning is off, everything in flight was dropped. 'failed': invalid input.
   */
  status: 'delivered' | 'skipped' | 'duplicate' | 'rejected' | 'learning_disabled' | 'failed';
  /** The new state; null exactly when status is 'failed'. */
  state: ProbeState | null;
  /** Set exactly when status is 'delivered'. */
  registration: DeliveryRegistration | null;
  /** null unless status is 'failed'. */
  reasonCode: ReasonCode;
  work: ProbeWork;
}

interface SettleArguments {
  state: FlowState;
  turnId: string;
  candidateId: string;
  disposition: OfferOutcome;
  deliveryRef: string | null;
  wordingHash: string | null;
  ctx: TurnContext;
  learningEnabled: boolean;
}

/**
 * Add the wording hash of a delivered question and keep at most ten per facet: when the facet has
 * more, its own oldest entries (first in the list) go. Entries of other facets are never removed,
 * not even when they carry the same hash.
 */
function noteWordingCore(state: FlowState, facetId: string, hash: string, atMs: number, work: ProbeWork): void {
  state.fingerprints.push({ hash, facetId, atMs });
  let ofFacet = 0;
  for (const entry of state.fingerprints) {
    work.steps++;
    if (entry.facetId === facetId) ofFacet += 1;
  }
  let surplus = ofFacet - PROBE_LIMITS.perItem;
  if (surplus <= 0) return;
  state.fingerprints = state.fingerprints.filter((entry) => {
    work.steps++;
    if (entry.facetId !== facetId || surplus <= 0) return true;
    surplus -= 1;
    return false;
  });
}

/** Count one delivered research probe in its week and remember its day for the facet. */
function noteResearchProbeCore(state: FlowState, facetId: string, ctx: TurnContext, work: ProbeWork): void {
  const research = state.flow.research;
  setOwn(research.weekCounts, ctx.weekKey, (ownValue(research.weekCounts, ctx.weekKey) ?? 0) + 1);
  setOwn(research.lastProbeDayByFacet, facetId, ctx.dayKey);

  // Week keys sort in time order as text; only the latest weeks are kept so the ledger stays bounded.
  const weekKeys = Object.keys(research.weekCounts).sort((first, second) => {
    work.comparisons++;
    if (first < second) return -1;
    return first > second ? 1 : 0;
  });
  for (const weekKey of weekKeys.slice(0, Math.max(0, weekKeys.length - PROBE_LIMITS.retainedWeeks))) {
    work.steps++;
    delete research.weekCounts[weekKey];
  }
}

/**
 * Register a delivery. This is the only place where a probe is counted as asked: the host has
 * accepted her message, so no gate is consulted again. A question that was said is a fact.
 */
function registerDeliveryCore(
  report: SettleArguments,
  proposal: ActiveOffer,
  pendingIndex: number,
  deliveryRef: string,
  work: ProbeWork,
): DeliveryRegistration {
  const state = report.state;
  const nowMs = report.ctx.nowMs;
  const facetId = proposal.facetId;

  state.pending.splice(pendingIndex, 1);
  state.readyScores = state.readyScores.filter((score) => {
    work.steps++;
    return score.candidateId !== proposal.candidateId;
  });

  const item = itemStateOf(state.items, facetId);
  item.lastDeliveredAtMs = nowMs;
  // A rewritten question did not use the proposed approach, so the rotation does not move on.
  if (report.disposition === 'used' && proposal.approachIndex !== null) {
    item.nextApproachIndex = proposal.approachIndex + 1;
  }

  state.awaitingAnswer = {
    candidateId: proposal.candidateId,
    facetId,
    deliveredAtMs: nowMs,
    group: proposal.group,
    family: proposal.family,
    intention: proposal.intention,
    discriminatesFrom: proposal.discriminatesFrom,
    research: proposal.research,
    deliveryRef,
  };

  setOwn(state.coverage as Record<string, number>, proposal.group, nowMs);
  countEverywhere(state, facetId, proposal.group, 'delivered');
  noteScheduledCore(state, report.ctx, work);
  if (report.wordingHash !== null) noteWordingCore(state, facetId, report.wordingHash, nowMs, work);
  if (proposal.research !== 'none') noteResearchProbeCore(state, facetId, report.ctx, work);
  state.flow.offer = null;

  return {
    candidateId: proposal.candidateId,
    facetId,
    group: proposal.group,
    family: proposal.family,
    intention: proposal.intention,
    discriminatesFrom: proposal.discriminatesFrom,
    research: proposal.research,
    deliveryRef,
    deliveredAtMs: nowMs,
    dayKey: report.ctx.dayKey,
    weekKey: report.ctx.weekKey,
    approachIndex: proposal.approachIndex,
    wordingHash: report.wordingHash,
    disposition: report.disposition === 'rewritten' ? 'rewritten' : 'used',
  };
}

/** The transition of settleOffer on checked arguments; changes the owned state in place. */
export function settleOfferCore(
  report: SettleArguments,
  work: ProbeWork,
): Pick<SettleOfferResult, 'status' | 'registration'> {
  const state = report.state;
  const flow = state.flow;

  if (!report.learningEnabled) {
    stopForLearningOffCore(state, work);
    return { status: 'learning_disabled', registration: null };
  }

  // The same accepted message reported again registers nothing a second time.
  const awaiting = state.awaitingAnswer;
  if (awaiting !== null && report.deliveryRef !== null && awaiting.deliveryRef === report.deliveryRef) {
    return { status: 'duplicate', registration: null };
  }

  const proposal = flow.offer;
  const matches = proposal !== null
    && proposal.turnId === report.turnId
    && proposal.candidateId === report.candidateId;

  if (report.disposition === 'skipped') {
    if (!matches) return { status: 'rejected', registration: null };
    // The candidate stays pending with its lastOfferedAtMs, so it rests before it is proposed again.
    flow.offer = null;
    return { status: 'skipped', registration: null };
  }

  const pendingIndex = matches ? pendingIndexOf(state.pending, report.candidateId, work) : -1;
  if (proposal === null || !matches || pendingIndex < 0 || report.deliveryRef === null) {
    state.stats.rejectedDeliveries += 1;
    // A matching proposal whose candidate planning has dropped is closed here like a skipped one.
    if (matches) flow.offer = null;
    return { status: 'rejected', registration: null };
  }

  const registration = registerDeliveryCore(report, proposal, pendingIndex, report.deliveryRef, work);
  return { status: 'delivered', registration };
}

/**
 * Report what the reply step did with the proposal of a turn. Call it for 'used' and 'rewritten'
 * only after the host accepted her message. A delivery removes the candidate from the pending
 * list, starts the wait for the answer and counts the probe (per facet, group, day and week, and
 * in the research ledger when the facet is under review). 'skipped' only closes the proposal.
 * Never throws. On invalid input: status 'failed', state null, a reason code.
 */
export function settleOffer(input: SettleOfferInput): SettleOfferResult {
  const work = newWork();
  try {
    dataObject(input);
    const limits = limitsFor();
    const owned = boundedCopy(input, work, limits, true) as unknown as Record<string, unknown>;

    const state = checkFlowState(owned.state, work, limits);
    const turnId = identifierText(owned.turnId);
    const candidateId = identifierText(owned.candidateId);
    const disposition = requiredName(OFFER_DISPOSITIONS, owned.disposition);
    let deliveryRef: string | null = null;
    if (disposition === 'skipped') {
      if (owned.deliveryRef === undefined) fail('missing_input');
      if (owned.deliveryRef !== null) fail('invalid_input');
    } else {
      deliveryRef = identifierText(owned.deliveryRef);
    }
    const wordingHash = wordingHashValue(owned.wordingHash);
    const ctx = owned.ctx as TurnContext;
    checkContext(ctx);
    const learningEnabled = flagValue(owned.learningEnabled);
    flowConfigOf(owned.cfg, limits);

    const outcome = settleOfferCore(
      { state, turnId, candidateId, disposition, deliveryRef, wordingHash, ctx, learningEnabled },
      work,
    );
    return {
      status: outcome.status,
      state: copyCore(state, work),
      registration: outcome.registration,
      reasonCode: null,
      work,
    };
  } catch (error) {
    return { status: 'failed', state: null, registration: null, reasonCode: reasonOf(error), work };
  }
}

// ---------------------------------------------------------------------------------------------
// withdrawDelivery
// ---------------------------------------------------------------------------------------------

export interface WithdrawDeliveryInput {
  state: ProbeState;
  /** Identifier of her message that is no longer valid (deleted, regenerated, another branch). */
  deliveryRef: string;
}

export interface WithdrawDeliveryResult {
  /**
   * 'withdrawn': the wait for the answer to that message ended. 'not_awaiting': no probe waits
   * for that message, nothing changed. 'failed': invalid input.
   */
  status: 'withdrawn' | 'not_awaiting' | 'failed';
  /** The new state; null exactly when status is 'failed'. */
  state: ProbeState | null;
  /** null unless status is 'failed'. */
  reasonCode: ReasonCode;
  work: ProbeWork;
}

/** The transition of withdrawDelivery on checked arguments; changes the owned state in place. */
export function withdrawDeliveryCore(state: FlowState, deliveryRef: string): WithdrawDeliveryResult['status'] {
  const awaiting = state.awaitingAnswer;
  if (awaiting === null || awaiting.deliveryRef !== deliveryRef) return 'not_awaiting';

  // Only the wait ends. He may already have read the question, so nothing counted at delivery is
  // given back: the daily and weekly counts, the facet's interval and the research ledger stay.
  // No outcome is produced and no pause starts.
  state.awaitingAnswer = null;
  state.flow.withdrawn += 1;
  return 'withdrawn';
}

/**
 * Her message that carried the question is no longer valid. Ends the wait for its answer when the
 * waiting probe belongs to that message; otherwise nothing changes. Evidence of a probe that was
 * already settled is handled by the package that stores it, not here.
 * Never throws. On invalid input: status 'failed', state null, a reason code.
 */
export function withdrawDelivery(input: WithdrawDeliveryInput): WithdrawDeliveryResult {
  const work = newWork();
  try {
    dataObject(input);
    const limits = limitsFor();
    const owned = boundedCopy(input, work, limits, true) as unknown as Record<string, unknown>;

    const state = checkFlowState(owned.state, work, limits);
    const deliveryRef = identifierText(owned.deliveryRef);

    const status = withdrawDeliveryCore(state, deliveryRef);
    return { status, state: copyCore(state, work), reasonCode: null, work };
  } catch (error) {
    return { status: 'failed', state: null, reasonCode: reasonOf(error), work };
  }
}
