/**
 * Settings, deadlines and gate values of the asking flow. Pure functions only: no clock, no
 * randomness, no storage. Moments, day keys and week keys are passed in by the caller, and every
 * input is treated as untrusted data.
 *
 * Nothing here decides what the user is like. The numbers shape how often and when she may ask;
 * all of them are provisional defaults that wait for calibration against the owner's own ratings.
 */

import { addDaysCore, dayOnOrAfter, isDayKey } from './day-keys.ts';
import type { DayKey, FacetReview, FacetView, PlanGates } from './facets.ts';
import { DEFAULT_SCHEDULE_CONFIG, checkScheduleConfig, type ScheduleConfig } from './schedule.ts';
import type { ProbeResearchMark } from './types.ts';
import {
  boundedCopy,
  checkedText,
  dataObject,
  fail,
  limitsFor,
  newWork,
  nonnegative,
  ownValue,
  PROBE_LIMITS,
  reasonOf,
  type ProbeLimits,
  type ProbeWork,
  type ReasonCode,
} from './util.ts';

/** Milliseconds in one hour and in one day. */
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Largest number of local days a deadline setting may span: ten years. */
const DEADLINE_DAYS_MAX = 3650;

/** Largest refractory span in user messages; also the bound of the stored countdown. */
export const REFRACTORY_MESSAGES_MAX = 10_000;

/** Shape of a local week key, YYYY-Www with weeks 01 to 53. */
const WEEK_KEY_PATTERN = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;

/** True for a string of the form YYYY-Www. Calendar agreement with a day key is not checked. */
export function isWeekKey(value: unknown): value is string {
  return typeof value === 'string' && WEEK_KEY_PATTERN.test(value);
}

/**
 * Settings of the asking flow. A caller either passes none (the defaults apply) or a complete
 * object; a partial object is refused.
 */
export interface ProbeFlowConfig {
  /**
   * How long a delivered probe waits for the next user message, in milliseconds, 0 to 2,147,483,647.
   * A user message that arrives later settles the probe as unanswered.
   */
  awaitingAnswerTtlMs: number;
  /** Shortest time between two proposals of the same candidate, in milliseconds, 0 to 2,147,483,647. */
  offerCooldownMs: number;
  /** Evasive answers in a row to one facet that start its cooldown; an integer from 1 to 100. */
  maxEvasiveStreak: number;
  /** Length of that cooldown in milliseconds, 0 to 2,147,483,647. */
  evasiveCooldownMs: number;
  /** Probability from 0 to 1 that an eligible candidate is proposed in a turn; 1 switches the roll off. */
  passProbability: number;
  /** Fewest and most user messages without a probe after a settled one; integers from 0 to 10,000. */
  refractoryMinMessages: number;
  refractoryMaxMessages: number;
  /**
   * After a feedback the facet may be asked about again on the day this many local days later
   * (with 14: not on the feedback day nor on the 13 days after it); an integer from 0 to 3,650.
   */
  feedbackQuietDays: number;
  /** Local days between two research probes about one facet; an integer from 0 to 3,650. */
  researchPerFacetMinGapDays: number;
  /** Research probes per local week over all facets under review; an integer from 0 to 64. */
  researchPerWeekTotal: number;
  /** Local days without probes about a facet after a correction, and after a deletion; 0 to 3,650. */
  correctionCoolingDays: number;
  deletionCoolingDays: number;
  /** How long the distress window stays closed after the last distress, in milliseconds. */
  distressAfterMs: number;
  /** Spread of the per-facet minimum interval, 0 to 1; must equal the value planning uses. */
  jitterFraction: number;
  /** Daily and weekly delivery ceilings, shared with planning. */
  schedule: ScheduleConfig;
}

/**
 * Default settings, deeply frozen. Every value is provisional and waits for calibration.
 * - awaitingAnswerTtlMs 24 hours, offerCooldownMs 15 minutes, maxEvasiveStreak 2 and
 *   evasiveCooldownMs 7 days are the defaults of the module this core was ported from.
 * - passProbability 0.5 and the refractory span of 8 to 20 user messages come from the design of
 *   how a probe is asked.
 * - feedbackQuietDays 14, researchPerFacetMinGapDays 5, researchPerWeekTotal 2 and the two cooling
 *   periods of 30 days come from the design of feedback, review and correction.
 * - distressAfterMs 24 hours is the product rule that she does not ask during distress and for the
 *   24 hours after it.
 * - jitterFraction 0.15 and the schedule (2 per day, 6 per week) are the values planning uses.
 */
export const DEFAULT_FLOW_CONFIG: ProbeFlowConfig = Object.freeze({
  awaitingAnswerTtlMs: DAY_MS,
  offerCooldownMs: 15 * 60_000,
  maxEvasiveStreak: 2,
  evasiveCooldownMs: 7 * DAY_MS,
  passProbability: 0.5,
  refractoryMinMessages: 8,
  refractoryMaxMessages: 20,
  feedbackQuietDays: 14,
  researchPerFacetMinGapDays: 5,
  researchPerWeekTotal: 2,
  correctionCoolingDays: 30,
  deletionCoolingDays: 30,
  distressAfterMs: DAY_MS,
  jitterFraction: 0.15,
  schedule: Object.freeze({ ...DEFAULT_SCHEDULE_CONFIG }),
});

/** A whole number from `min` to `max`; a fraction or a value below `min` is invalid, above `max` over the limit. */
function boundedInteger(value: unknown, min: number, max: number): number {
  const checked = nonnegative(value, max);
  if (!Number.isInteger(checked) || checked < min) fail('invalid_input');
  return checked;
}

/**
 * Check a complete settings object, member by member in declaration order; the first failing
 * member supplies the reason code that is thrown. Returns the same object, typed.
 */
export function checkFlowConfig(cfg: unknown, limits: ProbeLimits = limitsFor()): ProbeFlowConfig {
  dataObject(cfg);
  nonnegative(cfg.awaitingAnswerTtlMs, PROBE_LIMITS.delayMs);
  nonnegative(cfg.offerCooldownMs, PROBE_LIMITS.delayMs);
  boundedInteger(cfg.maxEvasiveStreak, 1, 100);
  nonnegative(cfg.evasiveCooldownMs, PROBE_LIMITS.delayMs);
  nonnegative(cfg.passProbability, 1);
  const refractoryMin = boundedInteger(cfg.refractoryMinMessages, 0, REFRACTORY_MESSAGES_MAX);
  const refractoryMax = boundedInteger(cfg.refractoryMaxMessages, 0, REFRACTORY_MESSAGES_MAX);
  if (refractoryMin > refractoryMax) fail('invalid_input');
  boundedInteger(cfg.feedbackQuietDays, 0, DEADLINE_DAYS_MAX);
  boundedInteger(cfg.researchPerFacetMinGapDays, 0, DEADLINE_DAYS_MAX);
  boundedInteger(cfg.researchPerWeekTotal, 0, 64);
  boundedInteger(cfg.correctionCoolingDays, 0, DEADLINE_DAYS_MAX);
  boundedInteger(cfg.deletionCoolingDays, 0, DEADLINE_DAYS_MAX);
  nonnegative(cfg.distressAfterMs, PROBE_LIMITS.delayMs);
  nonnegative(cfg.jitterFraction, 1);
  checkScheduleConfig(cfg.schedule as ScheduleConfig, limits);
  return cfg as unknown as ProbeFlowConfig;
}

/** The settings of a call: the frozen defaults for null or an omitted value, else the checked object. */
export function flowConfigOf(cfg: unknown, limits: ProbeLimits = limitsFor()): ProbeFlowConfig {
  if (cfg === undefined || cfg === null) return DEFAULT_FLOW_CONFIG;
  return checkFlowConfig(cfg, limits);
}

/** A fact day of a facet: null for "never", else a valid day key. Throws the reason code otherwise. */
function factDay(value: unknown): DayKey | null {
  if (value === undefined) fail('missing_input');
  if (value === null) return null;
  if (!isDayKey(value)) fail('invalid_input');
  return value;
}

/** The day `days` days after `day`; a result beyond the last valid day key cannot be compared and fails. */
function deadlineAfter(day: DayKey, days: number): DayKey {
  const deadline = addDaysCore(day, days);
  if (deadline === null) fail('invalid_context');
  return deadline;
}

/** The later of two day keys, where null means "none". */
function laterDay(first: DayKey | null, second: DayKey | null): DayKey | null {
  if (first === null) return second;
  if (second === null) return first;
  return first >= second ? first : second;
}

/** How a facet under review may be studied today. */
export type FacetStudy = 'not_under_review' | 'passive_only' | 'research_within_caps';

/** The single-facet gate members derived from facts; they fit directly into a facet view. */
export interface DerivedFacetGates {
  declined: boolean | null;
  coolingEndsDay: DayKey | null;
  review: FacetReview | null;
}

/** Facts about one facet, supplied by the later wiring; null means the event never happened. */
export interface DeriveFacetGatesInput {
  /** The user has said he does not want to talk about this facet. */
  declined: boolean;
  /** Local day of the latest feedback of each sign among the review marks that are still open. */
  negativeFeedbackDay: DayKey | null;
  positiveFeedbackDay: DayKey | null;
  /** Local day of the latest correction and of the latest deletion of the facet's entry. */
  lastCorrectionDay: DayKey | null;
  lastDeletionDay: DayKey | null;
  /** Local day of the last delivered research probe about the facet. */
  lastResearchProbeDay: DayKey | null;
  /** Today's local day key. */
  today: DayKey;
  cfg?: ProbeFlowConfig | null;
}

export interface DeriveFacetGatesResult {
  gates: DerivedFacetGates;
  study: FacetStudy;
  reasonCode: ReasonCode;
  work: ProbeWork;
}

/** Core of deriveFacetGates on checked values; throws 'invalid_context' when a deadline leaves the calendar. */
export function deriveFacetGatesCore(
  facts: {
    declined: boolean;
    negativeFeedbackDay: DayKey | null;
    positiveFeedbackDay: DayKey | null;
    lastCorrectionDay: DayKey | null;
    lastDeletionDay: DayKey | null;
    lastResearchProbeDay: DayKey | null;
    today: DayKey;
  },
  cfg: ProbeFlowConfig,
): { gates: DerivedFacetGates; study: FacetStudy } {
  // The quiet period ends on the day that many days after the feedback day, and that day is open:
  // with 14 days and a feedback on 2026-10-11 the facet is closed on the feedback day and the 13
  // days after it (through 2026-10-24) and may be asked about from 2026-10-25.
  const negative = facts.negativeFeedbackDay === null
    ? null
    : { quietEndsDay: deadlineAfter(facts.negativeFeedbackDay, cfg.feedbackQuietDays) };
  const positive = facts.positiveFeedbackDay === null
    ? null
    : { quietEndsDay: deadlineAfter(facts.positiveFeedbackDay, cfg.feedbackQuietDays) };

  const review = negative === null && positive === null
    ? null
    : { negative, positive, lastResearchProbeDay: facts.lastResearchProbeDay };

  const correctionEnds = facts.lastCorrectionDay === null
    ? null
    : deadlineAfter(facts.lastCorrectionDay, cfg.correctionCoolingDays);
  const deletionEnds = facts.lastDeletionDay === null
    ? null
    : deadlineAfter(facts.lastDeletionDay, cfg.deletionCoolingDays);

  let study: FacetStudy = 'not_under_review';
  if (review !== null) {
    const negativeEnded = negative === null || dayOnOrAfter(facts.today, negative.quietEndsDay);
    const positiveEnded = positive === null || dayOnOrAfter(facts.today, positive.quietEndsDay);
    study = negativeEnded && positiveEnded ? 'research_within_caps' : 'passive_only';
  }

  return {
    gates: {
      // Declining has no deadline: it ends only when the fact itself changes back.
      declined: facts.declined,
      coolingEndsDay: laterDay(correctionEnds, deletionEnds),
      review,
    },
    study,
  };
}

/**
 * Derive the single-facet gate members (declined, coolingEndsDay, review) and the way the facet
 * may be studied today from dated facts.
 * - A feedback of either sign closes the facet from the feedback day until the day
 *   cfg.feedbackQuietDays local days later, which is the first open day again; during that time
 *   study is 'passive_only' (only what he says by himself is collected), afterwards
 *   'research_within_caps'. Without an open review mark it is 'not_under_review'.
 * - coolingEndsDay is the later of correction day plus cfg.correctionCoolingDays and deletion day
 *   plus cfg.deletionCoolingDays; null when neither happened.
 * On invalid input the result closes the facet without stating a fact about the user: declined is
 * null (the facet gate opens only for exactly false), study is 'passive_only', and reasonCode is set.
 */
export function deriveFacetGates(input: DeriveFacetGatesInput): DeriveFacetGatesResult {
  const work = newWork();
  try {
    dataObject(input);
    const limits = limitsFor();
    const owned = boundedCopy(input, work, limits, true) as unknown as Record<string, unknown>;

    if (owned.declined === undefined) fail('missing_input');
    if (typeof owned.declined !== 'boolean') fail('invalid_input');
    const facts = {
      declined: owned.declined,
      negativeFeedbackDay: factDay(owned.negativeFeedbackDay),
      positiveFeedbackDay: factDay(owned.positiveFeedbackDay),
      lastCorrectionDay: factDay(owned.lastCorrectionDay),
      lastDeletionDay: factDay(owned.lastDeletionDay),
      lastResearchProbeDay: factDay(owned.lastResearchProbeDay),
      today: checkedText(owned.today, PROBE_LIMITS.key),
    };
    if (!isDayKey(facts.today)) fail('invalid_context');
    const cfg = flowConfigOf(owned.cfg, limits);

    const derived = deriveFacetGatesCore(facts, cfg);
    return { gates: derived.gates, study: derived.study, reasonCode: null, work };
  } catch (error) {
    return {
      gates: { declined: null, coolingEndsDay: null, review: null },
      study: 'passive_only',
      reasonCode: reasonOf(error),
      work,
    };
  }
}

/**
 * Research mark of a facet view: 'none' without a review or with both sides null, else which
 * sides are open. Read from the current view, never from a value stored at planning time.
 */
export function researchMarkOfCore(view: FacetView | undefined): ProbeResearchMark {
  const review = view?.review;
  if (review === undefined || review === null) return 'none';
  const negative = review.negative !== null;
  const positive = review.positive !== null;
  if (negative && positive) return 'both';
  if (negative) return 'after_negative';
  if (positive) return 'after_positive';
  return 'none';
}

export interface ResearchGateInput {
  /** The flow ledger of the probe state; null or omitted counts as no research probe delivered. */
  ledger: { research: { weekCounts: Record<string, number> } } | null | undefined;
  /** The current local week key, YYYY-Www. */
  weekKey: string;
  cfg?: ProbeFlowConfig | null;
}

export interface ResearchGateResult {
  /** The value for PlanGates.research; null means that no research probe may be proposed. */
  research: PlanGates['research'];
  reasonCode: ReasonCode;
  work: ProbeWork;
}

/**
 * The ceiling for probes about facets under review, in the shape planning and the asking flow read:
 * the per-facet gap and the weekly total from the settings, and the number of research probes
 * delivered in the given week according to the ledger (0 when the week has no entry).
 * Research probes are part of the overall daily and weekly ceilings, not an extra allowance.
 * On invalid input research is null, which forbids research probes, and reasonCode is set.
 */
export function researchGateOf(input: ResearchGateInput): ResearchGateResult {
  const work = newWork();
  try {
    dataObject(input);
    const limits = limitsFor();
    const owned = boundedCopy(input, work, limits, true) as unknown as Record<string, unknown>;

    let weekCounts: Record<string, unknown> = {};
    const ledger = owned.ledger;
    if (ledger !== undefined && ledger !== null) {
      dataObject(ledger);
      const research = ledger.research;
      dataObject(research);
      dataObject(research.weekCounts);
      weekCounts = research.weekCounts;
    }
    const weekKey = checkedText(owned.weekKey, PROBE_LIMITS.key);
    if (!isWeekKey(weekKey)) fail('invalid_context');

    let probesThisWeek = 0;
    const counted = ownValue(weekCounts, weekKey);
    if (counted !== undefined) {
      if (typeof counted !== 'number' || !Number.isInteger(counted) || counted < 0) fail('invalid_input');
      probesThisWeek = counted;
    }
    const cfg = flowConfigOf(owned.cfg, limits);

    return {
      research: {
        perFacetMinGapDays: cfg.researchPerFacetMinGapDays,
        perWeekTotal: cfg.researchPerWeekTotal,
        probesThisWeek,
      },
      reasonCode: null,
      work,
    };
  } catch (error) {
    return { research: null, reasonCode: reasonOf(error), work };
  }
}

/**
 * The time arithmetic of the distress window on checked values. It holds while he is in distress
 * now, and after the last distress until afterMs milliseconds have passed. A last distress that
 * lies in the future means the clock went backwards: nothing can be decided, so the window holds.
 */
export function distressWindowHoldsCore(
  distressNow: boolean,
  lastDistressAtMs: number | null,
  nowMs: number,
  afterMs: number,
): boolean {
  if (distressNow) return true;
  if (lastDistressAtMs === null) return false;
  if (nowMs < lastDistressAtMs) return true;
  return nowMs - lastDistressAtMs < afterMs;
}

export interface DistressWindowInput {
  /** He is in distress in this turn, meaning a negative emotional state; decided by the caller. */
  distressNow: boolean;
  /** Moment in milliseconds of the last turn in which he was in distress, or null. */
  lastDistressAtMs: number | null;
  /** The current moment in milliseconds, 0 to 8,640,000,000,000,000. */
  nowMs: number;
  cfg?: ProbeFlowConfig | null;
}

export interface DistressWindowResult {
  holds: boolean;
  reasonCode: ReasonCode;
  work: ProbeWork;
}

/**
 * Whether the distress window holds, for PlanGates.distressWindow. Only the time is computed here;
 * recognising distress is the caller's job, and a non-negative emotion never counts as distress.
 * The window stops her probes only: what he says is still collected by the caller.
 * On invalid input holds is true (no probes) and reasonCode is set.
 */
export function distressWindowHolds(input: DistressWindowInput): DistressWindowResult {
  const work = newWork();
  try {
    dataObject(input);
    const limits = limitsFor();
    const owned = boundedCopy(input, work, limits, true) as unknown as Record<string, unknown>;

    if (owned.distressNow === undefined) fail('missing_input');
    if (typeof owned.distressNow !== 'boolean') fail('invalid_input');
    if (owned.lastDistressAtMs === undefined) fail('missing_input');
    const lastDistressAtMs = owned.lastDistressAtMs === null
      ? null
      : nonnegative(owned.lastDistressAtMs, PROBE_LIMITS.timeMs);
    const nowMs = nonnegative(owned.nowMs, PROBE_LIMITS.timeMs);
    const cfg = flowConfigOf(owned.cfg, limits);

    const holds = distressWindowHoldsCore(owned.distressNow, lastDistressAtMs, nowMs, cfg.distressAfterMs);
    return { holds, reasonCode: null, work };
  } catch (error) {
    return { holds: true, reasonCode: reasonOf(error), work };
  }
}

export interface ElicitationInput {
  /** The settlement of the current user turn, or null when the turn settled no probe. */
  settlement: { elicitedFacetIds: string[] } | null;
  /** The facet a piece of evidence from that user message is about. */
  facetId: string;
}

export interface ElicitationResult {
  /** 'probe': the evidence was asked for by a probe. null: this function makes no judgement. */
  elicitation: 'probe' | null;
  reasonCode: ReasonCode;
  work: ProbeWork;
}

/**
 * Whether evidence about a facet in the settling user message was elicited by the settled probe.
 * Returns 'probe' when the facet is among the settlement's elicited facets, else null. null means
 * "no judgement here": a later annotation decides between spontaneous and an answer to an ordinary
 * question of hers. This function never calls anything spontaneous.
 * On invalid input elicitation is null and reasonCode is set; the caller must not read that as
 * spontaneous either.
 */
export function elicitationFor(input: ElicitationInput): ElicitationResult {
  const work = newWork();
  try {
    dataObject(input);
    const owned = boundedCopy(input, work, limitsFor(), true) as unknown as Record<string, unknown>;

    let elicited: unknown[] = [];
    const settlement = owned.settlement;
    if (settlement === undefined) fail('missing_input');
    if (settlement !== null) {
      dataObject(settlement);
      if (!Array.isArray(settlement.elicitedFacetIds)) fail('invalid_input');
      elicited = settlement.elicitedFacetIds;
    }
    const facetId = checkedText(owned.facetId, PROBE_LIMITS.key);
    if (facetId.length === 0) fail('invalid_input');

    let found = false;
    for (let index = 0; index < elicited.length; index++) {
      work.steps++;
      if (typeof elicited[index] !== 'string') fail('invalid_input');
      if (elicited[index] === facetId) found = true;
    }
    return { elicitation: found ? 'probe' : null, reasonCode: null, work };
  } catch (error) {
    return { elicitation: null, reasonCode: reasonOf(error), work };
  }
}
