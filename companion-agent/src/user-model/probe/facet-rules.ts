/**
 * Gates and ranking keys of a single facet. Pure functions only:
 * no state, no clock; the caller passes today's day key in.
 */

import {
  CONTENT_FAMILIES,
  REGISTRY_MAX,
  type ContentFamily,
  type DayKey,
  type FacetView,
  type PlanGates,
  type ProbeIntention,
  type RegistryRow,
  type UnderstandingBand,
} from './facets.ts';
import { dayOnOrAfter, daysBetweenCore, isDayKey } from './day-keys.ts';
import {snapshotCore,newWork,limitsFor,ownValue,type ProbeWork} from './util.ts';
import { ownArrayData, viewMemberValid, isNonNegativeInteger, isPlainData } from './guards.ts';


/** Families of CONTENT_FAMILIES the row can open but the facet has no evidence for, in row.openingFamilies order. */
export function missingFamiliesCore(row: RegistryRow, facet: FacetView,work:ProbeWork=newWork()): ContentFamily[] {
  try {
    if (row==null || facet==null) return [];
    const openings = row.openingFamilies;
    if (!Array.isArray(openings)) return [];
    const familiesPresent = facet.familiesPresent;
    if (familiesPresent !== undefined && familiesPresent !== null && !Array.isArray(familiesPresent)) return [];
    const present = new Set<unknown>();
    if (Array.isArray(familiesPresent)) {
      for (let index = 0; index < familiesPresent.length; index++) {work.steps++;present.add(familiesPresent[index]);}
    }
    const missing: ContentFamily[] = [];
    for (let index = 0; index < openings.length; index++) {
      work.steps++;const family = openings[index];
      if (typeof family !== 'string' || !CONTENT_FAMILIES.includes(family as ContentFamily)) continue;
      if (!present.has(family)) missing.push(family);
    }
    return missing;
  } catch {
    return [];
  }
}

/** Rank of a band on the ladder unknown < mentioned < guess < current_view; null for absent values. */
function bandRank(band: UnderstandingBand | null | undefined): number | null {
  switch (band) {
    case 'unknown': return 0;
    case 'mentioned': return 1;
    case 'guess': return 2;
    case 'current_view': return 3;
    default: return null;
  }
}

function isBand(value: unknown): value is UnderstandingBand {
  return value === 'unknown' || value === 'mentioned' || value === 'guess' || value === 'current_view';
}

/** True when the quiet side is null or a plain object whose quietEndsDay is a valid key that today has reached. */
function quietSideEnded(side: unknown, today: DayKey,trusted=false): boolean {
  if (side === null) return true;
  if (!trusted && !isPlainData(side)) return false;
  const quietEndsDay = (side as Record<string,unknown>).quietEndsDay;
  if (typeof quietEndsDay !== 'string' || !isDayKey(quietEndsDay)) return false;
  return dayOnOrAfter(today, quietEndsDay);
}

/** Why a facet cannot be asked about. The first failing gate supplies the reason. */
export type FacetGateReason =
  | 'missing_view' | 'licence' | 'mode' | 'declined' | 'cooling'
  | 'review' | 'situation' | 'prerequisite' | 'nothing_to_add';

export interface FacetGateInput {
  row: RegistryRow;
  facet: FacetView | undefined;
  gates: PlanGates;
  today: DayKey;
  work?:ProbeWork;
  bandOf: (facetId: string) => UnderstandingBand | null | undefined;
}

/**
 * Check the gates of one facet in fixed order. A malformed input closes with
 * 'missing_view'; an undefined member where a decision is needed counts as a
 * closed gate; null means "none" where the type allows it. The first closed
 * gate names the reason. Never throws.
 */
function gate(input: FacetGateInput, trusted: boolean): { eligible: true } | { eligible: false; reason: FacetGateReason } {
  try {
    const work=input?.work??newWork();
    const closed = (reason: FacetGateReason): { eligible: false; reason: FacetGateReason } => ({ eligible: false, reason });

    // 0. Shape: the input, the row, the gates and the day must be usable at all.
    if (!trusted && !isPlainData(input)) return closed('missing_view');
    const rowValue: unknown = input.row;
    const facetValue: unknown = input.facet;
    const gatesValue: unknown = input.gates;
    const todayValue: unknown = input.today;
    const bandOfValue: unknown = input.bandOf;
    if (facetValue===undefined || (!trusted && (!isPlainData(rowValue) || !isPlainData(facetValue) || !isPlainData(gatesValue)))) return closed('missing_view');
    if (typeof bandOfValue !== 'function') return closed('missing_view');
    if (!isDayKey(todayValue)) return closed('missing_view');
    const row = rowValue as RegistryRow;
    const facet = facetValue as FacetView;
    const gates = gatesValue as PlanGates;
    const today = todayValue as DayKey;
    const relationship = gates.relationship;
    const situations = gates.situations;
    const research = gates.research;
    if (!trusted && !isPlainData(relationship)) return closed('missing_view');
    if (!Array.isArray(situations)) return closed('missing_view');
    if (research !== null) {
      if (!trusted && !isPlainData(research)) return closed('missing_view');
    }
    const openings = row.openingFamilies;
    const forbids = row.forbids;
    const prerequisites = row.prerequisites;
    if (!Array.isArray(openings) || !Array.isArray(forbids) || !Array.isArray(prerequisites)) return closed('missing_view');

    // 1. View and band, plus the closed value lists of the view members.
    const band = facet.band;
    if (band === undefined || band === null) return closed('missing_view');
    if (!isBand(band)) return closed('missing_view');
    if (!trusted && !viewMemberValid('familiesPresent',facet.familiesPresent,true)) return closed('missing_view');
    if (!trusted && (!viewMemberValid('distinctLocalDays',facet.distinctLocalDays,true) || !viewMemberValid('spontaneousCount',facet.spontaneousCount,true))) return closed('missing_view');
    if (facet.nextStep!=null && (facet.nextStep.localDays===undefined || facet.nextStep.families===undefined || facet.nextStep.spontaneous===undefined || (!trusted && !viewMemberValid('nextStep',facet.nextStep,false)))) return closed('missing_view');

    // 2. Licence.
    if (row.licence !== 'near_scale_cleared' && row.licence !== 'not_near_scale') return closed('licence');
    // 3. Mode and opening families.
    if (row.mode === 'observe_only' || openings.length === 0) return closed('mode');
    // 4. Declined must be exactly false.
    if (facet.declined !== false) return closed('declined');
    // 5. Cooling: undefined closes, null is not cooling, a valid day key is compared with today.
    const cooling = facet.coolingEndsDay;
    if (cooling === undefined) return closed('cooling');
    if (cooling !== null) {
      if (!isDayKey(cooling)) return closed('cooling');
      if (!dayOnOrAfter(today, cooling)) return closed('cooling');
    }
    // 6. Review: quiet periods must have ended and the research gap must hold.
    const review = facet.review;
    if (review === undefined) return closed('review');
    if (review !== null) {
      if (!trusted && !viewMemberValid('review',review,false)) return closed('review');
      if (review.negative===undefined || review.positive===undefined || review.lastResearchProbeDay===undefined) return closed('review');
      if (research === null) return closed('review');
      if (!isNonNegativeInteger(research.perFacetMinGapDays)) return closed('review');
      if (!quietSideEnded(review.negative, today,trusted) || !quietSideEnded(review.positive, today,trusted)) return closed('review');
      const lastProbe = review.lastResearchProbeDay;
      if (lastProbe !== null) {
        if (typeof lastProbe !== 'string' || !isDayKey(lastProbe)) return closed('review');
        if (daysBetweenCore(lastProbe, today) < research.perFacetMinGapDays) return closed('review');
      }
    }
    // 7. Situations, by index loops: the caller's iterators are never used.
    for (let index = 0; index < forbids.length; index++) {
      for (let other = 0; other < situations.length; other++) {
        work.steps++;if (forbids[index] === situations[other]) return closed('situation');
      }
    }
    // 8. Prerequisites: unknown shapes close, a throwing bandOf call closes.
    for (let index = 0; index < prerequisites.length; index++) {
      work.steps++;const prerequisite = prerequisites[index];
      if (!trusted && !isPlainData(prerequisite)) return closed('prerequisite');
      const kind = prerequisite.kind;
      if (kind === 'facet_band_at_least') {
        if (prerequisite.band!=='mentioned' && prerequisite.band!=='guess' && prerequisite.band!=='current_view') return closed('prerequisite');
        let actual: UnderstandingBand | null | undefined;
        try {
          actual = (bandOfValue as (facetId: string) => UnderstandingBand | null | undefined)(prerequisite.facetId as string);
        } catch {
          return closed('prerequisite');
        }
        const actualRank = bandRank(actual);
        const requiredRank = bandRank(prerequisite.band as UnderstandingBand);
        if (actualRank === null || requiredRank === null || actualRank < requiredRank) return closed('prerequisite');
      } else if (kind === 'days_acquainted') {
        const requiredDays = prerequisite.days;
        const days = relationship.daysAcquainted;
        if (typeof requiredDays !== 'number' || !Number.isFinite(requiredDays)) return closed('prerequisite');
        if (typeof days !== 'number' || !Number.isFinite(days) || days < requiredDays) return closed('prerequisite');
      } else if (kind === 'user_used_relational_language') {
        if (relationship.relationalLanguageSeen !== true) return closed('prerequisite');
      } else {
        return closed('prerequisite');
      }
    }
    // 9. Asking must be able to add evidence.
    if (band !== 'unknown') {
      const families = facet.familiesPresent as ContentFamily[] | null | undefined;
      const localDays = facet.distinctLocalDays as number | null | undefined;
      const spontaneous = facet.spontaneousCount as number | null | undefined;
      if (families === undefined || families === null) return closed('missing_view');
      if (localDays === undefined || localDays === null) return closed('missing_view');
      if (spontaneous === undefined || spontaneous === null) return closed('missing_view');
      const step = facet.nextStep as { localDays: number; families: number; spontaneous: number } | null | undefined;
      if (step === undefined || step === null) return closed('nothing_to_add');
      const missing = missingFamiliesCore(row as unknown as RegistryRow, facet as unknown as FacetView,work);
      const addsDay = step.localDays > localDays;
      const addsFamily = step.families > families.length && missing.length > 0;
      if (!addsDay && !addsFamily) return closed('nothing_to_add');
    }
    return { eligible: true };
  } catch {
    return { eligible: false, reason: 'missing_view' };
  }
}

/** 0: unknown band; 1: leaning near a discriminate stage; 2: a family is missing; 3: only another day would help; malformed input is 3. */
export function rankClassCore(row: RegistryRow, facet: FacetView, neighbourLeaning: boolean,work:ProbeWork=newWork()): 0 | 1 | 2 | 3 {
  try {
    if (row==null || facet==null) return 3;
    if (!Array.isArray(row.openingFamilies)) return 3;
    const familiesPresent = facet.familiesPresent;
    if (familiesPresent !== undefined && familiesPresent !== null && !Array.isArray(familiesPresent)) return 3;
    const band = facet.band ?? null;
    if (band !== null && !isBand(band)) return 3;
    if (typeof neighbourLeaning !== 'boolean') return 3;
    if (band === null || band === 'unknown') return 0;
    const missing = missingFamiliesCore(row, facet,work);
    if (neighbourLeaning && (band === 'mentioned' || band === 'guess') && missing.length > 0) return 1;
    if (missing.length > 0) return 2;
    return 3;
  } catch {
    return 3;
  }
}

/** Anything that is not 0, 1 or 2 means "only another day would help". */
export function intentionOf(rank: 0 | 1 | 2 | 3): ProbeIntention {
  if (rank === 0) return 'first_evidence';
  if (rank === 1) return 'discriminate';
  if (rank === 2) return 'add_family';
  return 'add_day';
}

export interface RankKey {
  rankClass: 0 | 1 | 2 | 3;
  band: UnderstandingBand;
  groupLastCoveredMs: number | null;
  depth: 1 | 2 | 3;
  facetId: string;
}

/** Own reading of one key field; a throwing getter counts as a wrong type. */
function readField(key: unknown, name: string): unknown {
  try {
    if (key === null || (typeof key !== 'object' && typeof key !== 'function')) return undefined;
    return (key as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

/** 0..3 for a valid rank class, 4 for anything else (malformed sorts after valid). */
function rankClassOrder(value: unknown): number {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  return 4;
}

/** 0..3 for a valid band, 4 for anything else (malformed sorts after valid). */
function bandOrder(value: unknown): number {
  const rank = bandRank(value as UnderstandingBand);
  return rank === null ? 4 : rank;
}

/** 1..3 for a valid depth, 4 for anything else (malformed sorts after valid). */
function depthOrder(value: unknown): number {
  if (value === 1 || value === 2 || value === 3) return value;
  return 4;
}

/** A finite number, or null for anything else. */
function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A string, or null for anything else. */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Lower rank class first; then band; then longest-uncovered group (never
 * covered first); then depth; then facetId. A malformed key sorts after every
 * valid value of that key; two malformed keys compare equal on it. Never NaN.
 */
export function compareRanked(a: RankKey, b: RankKey): number {
  try {
    const classA = rankClassOrder(readField(a, 'rankClass'));
    const classB = rankClassOrder(readField(b, 'rankClass'));
    if (classA !== classB) return classA - classB;
    const bandA = bandOrder(readField(a, 'band'));
    const bandB = bandOrder(readField(b, 'band'));
    if (bandA !== bandB) return bandA - bandB;
    const coveredA = finiteNumberOrNull(readField(a, 'groupLastCoveredMs'));
    const coveredB = finiteNumberOrNull(readField(b, 'groupLastCoveredMs'));
    if (coveredA === null && coveredB !== null) return -1;
    if (coveredA !== null && coveredB === null) return 1;
    if (coveredA !== null && coveredB !== null && coveredA !== coveredB) {
      return coveredA < coveredB ? -1 : 1;
    }
    const depthA = depthOrder(readField(a, 'depth'));
    const depthB = depthOrder(readField(b, 'depth'));
    if (depthA !== depthB) return depthA - depthB;
    const idA = stringOrNull(readField(a, 'facetId'));
    const idB = stringOrNull(readField(b, 'facetId'));
    if (idA === null && idB === null) return 0;
    if (idA === null) return 1;
    if (idB === null) return -1;
    if (idA < idB) return -1;
    if (idA > idB) return 1;
    return 0;
  } catch {
    return 0;
  }
}

/** Core entry points take the already validated owned projection. */
export function facetGateCore(input:FacetGateInput):ReturnType<typeof gate>{return gate(input,true);}
export function facetGate(input:FacetGateInput):ReturnType<typeof gate>{
  try{if(!isPlainData(input))return {eligible:false,reason:'missing_view'};
    const work=newWork();work.snapshots++;
    const callback=Object.getOwnPropertyDescriptor(input,'bandOf')?.value;
    const projection=snapshotCore({row:ownValue(input,'row'),facet:ownValue(input,'facet'),gates:ownValue(input,'gates'),today:ownValue(input,'today')},work,limitsFor(),true,'',true);
    return gate(Object.assign(Object.create(null),projection,{bandOf:callback,work}),false);
  }catch{return {eligible:false,reason:'missing_view'};}
}
/** Ranking helpers guarantee non-throwing fallbacks; they do not apply the selection closed lists. */
function helperProjection(row:RegistryRow,facet:FacetView):{row:RegistryRow;facet:FacetView}|null{
  if(!isPlainData(row)||!isPlainData(facet))return null;
  const openings=ownArrayData(Object.getOwnPropertyDescriptor(row,'openingFamilies')?.value,REGISTRY_MAX);
  if(!openings.ok)return null;
  const present=Object.getOwnPropertyDescriptor(facet,'familiesPresent')?.value;
  const families=present==null?present:ownArrayData(present,REGISTRY_MAX);
  if(families!=null && !families.ok)return null;
  return {row:{openingFamilies:openings.values} as RegistryRow,facet:{band:Object.getOwnPropertyDescriptor(facet,'band')?.value,familiesPresent:families==null?families:families.values} as FacetView};
}
export function missingFamilies(row:RegistryRow,facet:FacetView):ContentFamily[]{try{const p=helperProjection(row,facet);return p?missingFamiliesCore(p.row,p.facet):[];}catch{return [];}}
export function rankClass(row:RegistryRow,facet:FacetView,leaning:boolean):0|1|2|3{try{const p=helperProjection(row,facet);return p?rankClassCore(p.row,p.facet,leaning):3;}catch{return 3;}}
