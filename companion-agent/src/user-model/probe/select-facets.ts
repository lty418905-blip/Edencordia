import {snapshotCore,limitsFor,newWork,reasonOf, type ProbeWork} from './util.ts';
/**
 * Selection of facet probes for one planning call: gate every row, rank the
 * eligible ones, apply group, capacity and research limits, and describe each
 * chosen candidate. Pure functions only: the caller passes the registry, the
 * facet views, the gates and today's day key in; nothing here uses state.
 */

import {
  CONTENT_FAMILIES,
  FACET_GROUPS,
  ROW_FORBIDS,
  UNDERSTANDING_BANDS,
  UNIVERSAL_SITUATIONS,
  type ContentFamily,
  type DayKey,
  type FacetGroup,
  type FacetView,
  type PlanGates,
  type ProbeIntention,
  type ProbeMode,
  type RegistryRow,
  type UnderstandingBand,
} from './facets.ts';
import {
  compareRanked,
  facetGateCore,
  intentionOf,
  missingFamiliesCore,
  rankClassCore,
  type FacetGateReason,
  type RankKey,
} from './facet-rules.ts';
import { dayOnOrAfter, isDayKey } from './day-keys.ts';
import { DATA_LIMITS, containsName, viewMemberValid, isNonNegativeInteger, isPlainData } from './guards.ts';
import { validateRegistryCore } from './registry.ts';

export interface SelectInput {
  registry: RegistryRow[];
  facets: FacetView[];
  gates: PlanGates;
  today: DayKey;
  capacity: number;
  pendingResearch: number;
  groupLastCoveredMs: Partial<Record<FacetGroup, number | null>>;
  allowedDepth: Partial<Record<FacetGroup, 1 | 2 | 3>>;
  blocked: string[];
}

export type SelectReason =
  | 'invalid_input' | 'input_limit' | 'learning_disabled' | 'distress_window' | 'universal_situation' | 'no_capacity';

export type ResearchMark = 'none' | 'after_negative' | 'after_positive' | 'both';

export interface SelectedFacet {
  facetId: string;
  group: FacetGroup;
  mode: ProbeMode;
  depth: 1 | 2 | 3;
  family: ContentFamily;
  intention: ProbeIntention;
  discriminatesFrom: string | null;
  research: ResearchMark;
}

export type RejectReason =
  | FacetGateReason
  | 'no_row' | 'depth' | 'blocked' | 'group_taken' | 'research_ceiling' | 'capacity';

export interface SelectResult {
  candidates: SelectedFacet[];
  reason: SelectReason | null;
  clearPending: boolean;
  rejected: { facetId: string; reason: RejectReason }[];
}

/** Input after validation, with lookups normalized to own string keys. */
interface Validated {
  registry: RegistryRow[];
  facets: FacetView[];
  gates: PlanGates;
  today: DayKey;
  capacity: number;
  pendingResearch: number;
  groupLastCoveredMs: Record<string, number | null>;
  allowedDepth: Record<string, 1 | 2 | 3>;
  blocked: string[];
}




function isSituation(value: unknown): boolean {
  return typeof value === 'string'
    && (containsName(UNIVERSAL_SITUATIONS, value) || containsName(ROW_FORBIDS, value));
}

function isUniversalSituation(value: string): boolean {
  return containsName(UNIVERSAL_SITUATIONS, value);
}

/** A view contradicts itself when the band and the evidence counters disagree. */
function viewIsConsistent(view: FacetView): boolean {
  const band = view.band;
  if (band === 'unknown') {
    const families = view.familiesPresent;
    if (Array.isArray(families) && families.length > 0) return false;
    const days = view.distinctLocalDays;
    if (typeof days === 'number' && days > 0) return false;
    return true;
  }
  if (typeof band === 'string' && view.distinctLocalDays === 0) return false;
  return true;
}

function isDepthMember(value: unknown): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}

type ValidationResult = { ok: true; value: Validated } | { ok: false; reason: 'invalid_input' | 'input_limit' };

const INVALID: { ok: false; reason: 'invalid_input' } = { ok: false, reason: 'invalid_input' };
const LIMIT: { ok: false; reason: 'input_limit' } = { ok: false, reason: 'input_limit' };

/** Step 1: check the whole input against the closed lists; any other value is invalid_input or input_limit. */
export function validateSelectCore(input: unknown,work:ProbeWork=newWork(),capture=false): ValidationResult {
  if (!isPlainData(input)) return INVALID;
  const record = input;
  const field=(key:string)=>{const d=Object.getOwnPropertyDescriptor(record,key);const value=d&&'value'in d?d.value:undefined;return capture?snapshotCore(value,work,limitsFor(),true,key):value;};

  const registryInput = field('registry');
  if (!Array.isArray(registryInput)) return INVALID;
  const registry = validateRegistryCore(registryInput,work);
  if (!registry.ok) return registry.reason==='input_limit'?LIMIT:INVALID;

  const facetsInput = field('facets');
  if (!Array.isArray(facetsInput)) return INVALID;
  if (facetsInput.length > registry.rows.length) return LIMIT;
  const facets: FacetView[] = [];
  const viewIds = new Set<string>();
  for (let index = 0; index < facetsInput.length; index++) {
    work.steps++;
    const element = facetsInput[index];
    if (!isPlainData(element)) return INVALID;
    const facetId = element.facetId;
    if (typeof facetId !== 'string' || facetId.length === 0) return INVALID;
    if (facetId.length > DATA_LIMITS.key) return LIMIT;
    if (viewIds.has(facetId)) return INVALID;
    viewIds.add(facetId);
    if (!viewMemberValid('band',element.band,true)) return INVALID;
    if (!viewMemberValid('declined',element.declined,true)) return INVALID;
    if (!viewMemberValid('coolingEndsDay',element.coolingEndsDay,true)) return INVALID;
    if(Array.isArray(element.familiesPresent)&&element.familiesPresent.length>CONTENT_FAMILIES.length)return LIMIT;
    if (!viewMemberValid('familiesPresent',element.familiesPresent,true)) return INVALID;
    if (!viewMemberValid('distinctLocalDays',element.distinctLocalDays,true)) return INVALID;
    if (!viewMemberValid('spontaneousCount',element.spontaneousCount,true)) return INVALID;
    if (!viewMemberValid('nextStep',element.nextStep,true)) return INVALID;
    if (!viewMemberValid('review',element.review,true)) return INVALID;
    const view = element as unknown as FacetView;
    if (!viewIsConsistent(view)) return INVALID;
    facets.push(view);
  }

  const gatesInput = field('gates');
  if (!isPlainData(gatesInput)) return INVALID;
  if (typeof gatesInput.learningEnabled !== 'boolean') return INVALID;
  if (typeof gatesInput.distressWindow !== 'boolean') return INVALID;
  const situationsInput = gatesInput.situations;
  if (!Array.isArray(situationsInput)) return INVALID;
  if (situationsInput.length > DATA_LIMITS.situations) return LIMIT;
  for (let index = 0; index < situationsInput.length; index++) {
    work.steps++;
    if (!isSituation(situationsInput[index])) return INVALID;
  }
  const relationship = gatesInput.relationship;
  if (!isPlainData(relationship)) return INVALID;
  const daysAcquainted = relationship.daysAcquainted;
  if (daysAcquainted !== null) {
    if (typeof daysAcquainted !== 'number' || !Number.isFinite(daysAcquainted) || daysAcquainted < 0) return INVALID;
  }
  const relationalLanguageSeen = relationship.relationalLanguageSeen;
  if (relationalLanguageSeen !== null && typeof relationalLanguageSeen !== 'boolean') return INVALID;
  const researchInput = gatesInput.research;
  if (researchInput !== null) {
    if (!isPlainData(researchInput)) return INVALID;
    if (!isNonNegativeInteger(researchInput.perFacetMinGapDays)) return INVALID;
    if (!isNonNegativeInteger(researchInput.perWeekTotal)) return INVALID;
    if (!isNonNegativeInteger(researchInput.probesThisWeek)) return INVALID;
  }

  const todayValue = field('today');
  if (!isDayKey(todayValue)) return INVALID;
  const capacityValue = field('capacity');
  if (!isNonNegativeInteger(capacityValue)) return INVALID;
  const pendingValue = field('pendingResearch');
  if (!isNonNegativeInteger(pendingValue)) return INVALID;

  const coveredInput = field('groupLastCoveredMs');
  if (!isPlainData(coveredInput)) return INVALID;
  const groupLastCoveredMs: Record<string, number | null> = {};
  for (let index = 0; index < FACET_GROUPS.length; index++) {
    work.steps++;
    const group = FACET_GROUPS[index] as string;
    if (!Object.prototype.hasOwnProperty.call(coveredInput, group)) continue;
    const value = coveredInput[group];
    if (value === undefined || value === null) {
      groupLastCoveredMs[group] = null;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      groupLastCoveredMs[group] = value;
    } else {
      return INVALID;
    }
  }

  const depthInput = field('allowedDepth');
  if (!isPlainData(depthInput)) return INVALID;
  const allowedDepth: Record<string, 1 | 2 | 3> = {};
  for (let index = 0; index < FACET_GROUPS.length; index++) {
    work.steps++;
    const group = FACET_GROUPS[index] as string;
    if (!Object.prototype.hasOwnProperty.call(depthInput, group)) continue;
    const value = depthInput[group];
    if (!isDepthMember(value)) return INVALID;
    allowedDepth[group] = value;
  }

  const blockedInput = field('blocked');
  if (!Array.isArray(blockedInput)) return INVALID;
  if (blockedInput.length > registry.rows.length+limitsFor(0).retired) return LIMIT;
  const blocked: string[] = [];
  for (let index = 0; index < blockedInput.length; index++) {
    work.steps++;
    const id = blockedInput[index];
    if (typeof id !== 'string' || id.length === 0) return INVALID;
    if (id.length > DATA_LIMITS.key) return LIMIT;
    blocked.push(id);
  }

  return {
    ok: true,
    value: {
      registry: registry.rows,
      facets,
      gates: gatesInput as unknown as PlanGates,
      today: todayValue,
      capacity: capacityValue,
      pendingResearch: pendingValue,
      groupLastCoveredMs,
      allowedDepth,
      blocked,
    },
  };
}

interface RankedEntry {
  row: RegistryRow;
  facet: FacetView;
  rank: 0 | 1 | 2 | 3;
}

interface ReviewSides {
  underReview: boolean;
  negative: boolean;
  positive: boolean;
}

/** Under review when review is an object and a side is not null; undefined counts as a side. */
function reviewSides(facet: FacetView): ReviewSides {
  const review = facet.review;
  if (review === undefined || review === null) {
    return { underReview: false, negative: false, positive: false };
  }
  const negative = review.negative !== null;
  const positive = review.positive !== null;
  return { underReview: negative || positive, negative, positive };
}

/** Cooling today unless coolingEndsDay is null or today is on or after it; undefined counts as cooling. */
function isCoolingToday(view: FacetView, today: DayKey): boolean {
  const end = view.coolingEndsDay;
  if (end === null) return false;
  if (end === undefined) return true;
  return !dayOnOrAfter(today, end);
}

/** Rule 8 leaning of one neighbour id: mid band, not declined, not cooling today. */
function leansAtGap(facetId: string, viewById: Map<string, FacetView>, today: DayKey): boolean {
  const view = viewById.get(facetId);
  if (view === undefined) return false;
  if (view.band !== 'mentioned' && view.band !== 'guess') return false;
  if (view.declined !== false) return false;
  return !isCoolingToday(view, today);
}

function leansFromNeighbours(row: RegistryRow, viewById: Map<string, FacetView>, today: DayKey,work:ProbeWork=newWork()): boolean {
  for (let index = 0; index < row.neighbours.length; index++) {
    work.steps++;
    if (leansAtGap(row.neighbours[index], viewById, today)) return true;
  }
  return false;
}

/** Smallest leaning neighbour id in UTF-16 code-unit order, or null. */
function smallestLeaningNeighbour(row: RegistryRow, viewById: Map<string, FacetView>, today: DayKey,work:ProbeWork=newWork()): string | null {
  let smallest: string | null = null;
  for (let index = 0; index < row.neighbours.length; index++) {
    work.steps++;
    const facetId = row.neighbours[index];
    if (!leansAtGap(facetId, viewById, today)) continue;
    if (smallest === null || facetId < smallest) smallest = facetId;
  }
  return smallest;
}

function allowedDepthOf(lookup: Record<string, 1 | 2 | 3>, group: FacetGroup): 1 | 2 | 3 {
  const value = Object.hasOwn(lookup,group)?lookup[group]:undefined;
  if (value === 1 || value === 2 || value === 3) return value;
  return 1;
}

function byFacetId(a: { facetId: string }, b: { facetId: string }): number {
  if (a.facetId < b.facetId) return -1;
  if (a.facetId > b.facetId) return 1;
  return 0;
}

/** Step 11: describe one chosen facet. */
function buildCandidate(entry: RankedEntry, sides: ReviewSides, viewById: Map<string, FacetView>, today: DayKey,work:ProbeWork): SelectedFacet {
  const { row, facet, rank } = entry;
  let family: ContentFamily;
  if (rank === 0 || rank === 3) {
    family = row.openingFamilies[0];
  } else {
    const missing = missingFamiliesCore(row, facet,work);
    family = missing[0];
  }
  let research: ResearchMark = 'none';
  if (sides.underReview) {
    if (sides.negative && sides.positive) research = 'both';
    else if (sides.negative) research = 'after_negative';
    else research = 'after_positive';
  }
  return {
    facetId: row.facetId,
    group: row.group,
    mode: row.mode,
    depth: row.depth,
    family,
    intention: intentionOf(rank),
    discriminatesFrom: rank === 1 ? smallestLeaningNeighbour(row, viewById, today,work) : null,
    research,
  };
}

function invalidResult(): SelectResult {
  return { candidates: [], reason: 'invalid_input', clearPending: false, rejected: [] };
}

function limitResult(): SelectResult {
  return { candidates: [], reason: 'input_limit', clearPending: false, rejected: [] };
}

/** Steps 1 to 12 of the documented procedure. */
export function selectFacetsCore(value: SelectInput,work:ProbeWork=newWork()): SelectResult {
  const {
    registry, facets, gates, today, capacity, pendingResearch,
    groupLastCoveredMs, allowedDepth, blocked,
  } = value;

  // 2. Learning switch.
  if (!gates.learningEnabled) return { candidates: [], reason: 'learning_disabled', clearPending: true, rejected: [] };
  // 3. Current situations: distress first, then universal situations.
  if (gates.distressWindow) return { candidates: [], reason: 'distress_window', clearPending: false, rejected: [] };
  for (let index = 0; index < gates.situations.length; index++) {
    work.steps++;
    if (isUniversalSituation(gates.situations[index])) {
      return { candidates: [], reason: 'universal_situation', clearPending: false, rejected: [] };
    }
  }
  // 4. This call must be able to choose.
  if (capacity === 0) return { candidates: [], reason: 'no_capacity', clearPending: false, rejected: [] };

  // 5. Research budget left this week.
  const research = gates.research;
  let researchLeft = research === null
    ? 0
    : Math.max(0, research.perWeekTotal - research.probesThisWeek - pendingResearch);

  const viewById = new Map<string, FacetView>();
  for (let index = 0; index < facets.length; index++){work.steps++;viewById.set(facets[index].facetId, facets[index]);}
  const registryIds = new Set<string>();
  for (let index = 0; index < registry.length; index++){work.steps++;registryIds.add(registry[index].facetId);}
  const blockedSet = new Set<string>();
  for (let index = 0; index < blocked.length; index++){work.steps++;blockedSet.add(blocked[index]);}

  const rejected: { facetId: string; reason: RejectReason }[] = [];
  const eligible: RankedEntry[] = [];

  // 7. Gate, allowed depth and caller blocks per registry row, in this order.
  for (let index = 0; index < registry.length; index++) {
    work.steps++;
    const row = registry[index];
    const view = viewById.get(row.facetId);
    const gate = facetGateCore({
      row,
      facet: view,
      gates,
      today,
      work,
      bandOf: (facetId) => viewById.get(facetId)?.band,
    });
    if (!gate.eligible) {
      rejected.push({ facetId: row.facetId, reason: gate.reason });
      continue;
    }
    // The gate only passes a present view with a non-null band.
    const facet = view as FacetView;
    if (row.depth > allowedDepthOf(allowedDepth, row.group)) {
      rejected.push({ facetId: row.facetId, reason: 'depth' });
      continue;
    }
    if (blockedSet.has(row.facetId)) {
      rejected.push({ facetId: row.facetId, reason: 'blocked' });
      continue;
    }
    eligible.push({ row, facet, rank: rankClassCore(row, facet, leansFromNeighbours(row, viewById, today,work),work) });
  }
  // Views that no registry row describes.
  for (let index = 0; index < facets.length; index++) {
    work.steps++;
    if (!registryIds.has(facets[index].facetId)) rejected.push({ facetId: facets[index].facetId, reason: 'no_row' });
  }

  // 9. Rank the eligible facets.
  const ranked: { entry: RankedEntry; key: RankKey }[] = [];
  for (let index = 0; index < eligible.length; index++) {
    work.steps++;
    const entry = eligible[index];
    const covered = Object.hasOwn(groupLastCoveredMs,entry.row.group)?groupLastCoveredMs[entry.row.group]:null;
    ranked.push({
      entry,
      key: {
        rankClass: entry.rank,
        band: entry.facet.band as UnderstandingBand,
        groupLastCoveredMs: typeof covered === 'number' ? covered : null,
        depth: entry.row.depth,
        facetId: entry.row.facetId,
      },
    });
  }
  ranked.sort((a, b) => {work.comparisons++;return compareRanked(a.key, b.key);});

  // 10. Walk the ranking under capacity, one-per-group and research limits.
  const candidates: SelectedFacet[] = [];
  const chosenGroups = new Set<FacetGroup>();
  for (let index = 0; index < ranked.length; index++) {
    work.steps++;
    const entry = ranked[index].entry;
    if (candidates.length === capacity) {
      rejected.push({ facetId: entry.row.facetId, reason: 'capacity' });
      continue;
    }
    if (chosenGroups.has(entry.row.group)) {
      rejected.push({ facetId: entry.row.facetId, reason: 'group_taken' });
      continue;
    }
    const sides = reviewSides(entry.facet);
    if (sides.underReview && researchLeft === 0) {
      rejected.push({ facetId: entry.row.facetId, reason: 'research_ceiling' });
      continue;
    }
    if (sides.underReview) researchLeft -= 1;
    chosenGroups.add(entry.row.group);
    // 11. Describe the chosen facet.
    candidates.push(buildCandidate(entry, sides, viewById, today,work));
  }

  // 12. Rejects in facetId code-unit order; candidates stay in chosen order.
  rejected.sort((a,b)=>{work.comparisons++;return byFacetId(a,b);});
  return { candidates, reason: null, clearPending: false, rejected };
}

export function selectFacets(input: SelectInput): SelectResult {
  try {
    const work=newWork();work.snapshots++;const validation=validateSelectCore(input,work,true);
    if(!validation.ok)return validation.reason==='input_limit'?limitResult():invalidResult();
    return selectFacetsCore(validation.value,work);
  } catch(error) {
    return reasonOf(error)==='input_limit'?limitResult():invalidResult();
  }
}
