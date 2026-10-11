/**
 * Validation of facet registry rows. Pure functions only: invalid input is
 * reported, never thrown; valid rows come back as fresh, deeply frozen copies.
 */

import {
  CONTENT_FAMILIES,
  FACET_GROUPS,
  LICENCE_STATUSES,
  PROBE_MODES,
  REGISTRY_MAX,
  ROW_FORBIDS,
  type ContentFamily,
  type FacetGroup,
  type LicenceStatus,
  type ProbeMode,
  type Prerequisite,
  type RegistryRow,
  type RowForbid,
  type UnderstandingBand,
} from './facets.ts';
import {newWork,type ProbeWork} from './util.ts';
import { DATA_LIMITS, ownArrayData, containsName, hasExactlyNames, isNonNegativeInteger, isPlainData } from './guards.ts';

/** Bands a band prerequisite may require; 'unknown' is never askable. */
type RequiredBand = Exclude<UnderstandingBand, 'unknown'>;
const REQUIRED_BANDS: readonly RequiredBand[] = ['mentioned', 'guess', 'current_view'];

const MAX_NEIGHBOURS = DATA_LIMITS.neighbours;
const MAX_OPENING_FAMILIES = CONTENT_FAMILIES.length;
const MAX_CONTEXT_ARCHETYPES = DATA_LIMITS.archetypes;
const MAX_APPROACH_HINTS = DATA_LIMITS.hints;
const MAX_SOURCES = DATA_LIMITS.sources;
const MAX_PREREQUISITES = DATA_LIMITS.prerequisites;
const MAX_FORBIDS = ROW_FORBIDS.length;

type RowFailure = { ok: false; reason: 'invalid_input' | 'input_limit' };

const INVALID: RowFailure = { ok: false, reason: 'invalid_input' };
const TOO_LONG: RowFailure = { ok: false, reason: 'input_limit' };

type MemberState =
  | { kind: 'missing' }
  | { kind: 'data'; value: unknown };

/** Own member of an object: only own data properties count, accessors are rejected. */
function ownMember(object: object, key: string): MemberState {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) return { kind: 'missing' };
  return { kind: 'data', value: descriptor.value };
}


/** Check a string value: wrong type, too long, or empty where emptiness is forbidden. */
function textValue(value: unknown, maxLength: number, allowEmpty: boolean): { ok: true; value: string } | RowFailure {
  if (typeof value !== 'string') return INVALID;
  if (value.length > maxLength) return TOO_LONG;
  if (!allowEmpty && value.length === 0) return INVALID;
  return { ok: true, value };
}

/** Same as textValue, but for a required own member of a row. */
function textOf(member: MemberState, maxLength: number, allowEmpty: boolean): { ok: true; value: string } | RowFailure {
  if (member.kind !== 'data') return INVALID;
  return textValue(member.value, maxLength, allowEmpty);
}

/** Check an array member: only a real array is accepted, with at most maxLength entries. */
function arrayOf(member: MemberState, maxLength: number,work:ProbeWork): { ok: true; value: unknown[] } | RowFailure {
  if (member.kind !== 'data') return INVALID;
  const value = member.value;
  const projected=ownArrayData(value,maxLength,work);
  if(!projected.ok)return {ok:false,reason:projected.reason};
  return { ok: true, value:projected.values };
}

function isFacetGroup(value: unknown): value is FacetGroup {
  return typeof value === 'string' && containsName(FACET_GROUPS, value);
}

function isProbeMode(value: unknown): value is ProbeMode {
  return typeof value === 'string' && containsName(PROBE_MODES, value);
}

function isLicenceStatus(value: unknown): value is LicenceStatus {
  return typeof value === 'string' && containsName(LICENCE_STATUSES, value);
}

function isDepth(value: unknown): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}

function isMinGapDays(value: unknown): value is number {
  return isNonNegativeInteger(value) && value >= 1 && value <= 3650;
}

function isPrerequisiteDays(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= 36500;
}

function isRequiredBand(value: unknown): value is RequiredBand {
  return typeof value === 'string' && containsName(REQUIRED_BANDS, value);
}

function isContentFamily(value: unknown): value is ContentFamily {
  return typeof value === 'string' && containsName(CONTENT_FAMILIES, value);
}

function isRowForbid(value: unknown): value is RowForbid {
  return typeof value === 'string' && containsName(ROW_FORBIDS, value);
}


/** One prerequisite object: exactly one of the three shapes with valid members. */
function validatePrerequisite(value: unknown): { ok: true; value: Prerequisite } | RowFailure {
  if (!isPlainData(value)) return INVALID;
  const kindMember = ownMember(value, 'kind');
  const kind = kindMember.kind === 'data' ? kindMember.value : undefined;
  if (kind === 'facet_band_at_least') {
    if (!hasExactlyNames(value, ['kind', 'facetId', 'band'])) return INVALID;
    const id = textOf(ownMember(value, 'facetId'), DATA_LIMITS.key, false);
    if (!id.ok) return id;
    const bandMember = ownMember(value, 'band');
    const band = bandMember.kind === 'data' ? bandMember.value : undefined;
    if (!isRequiredBand(band)) return INVALID;
    const prerequisite: Prerequisite = { kind: 'facet_band_at_least', facetId: id.value, band };
    Object.freeze(prerequisite);
    return { ok: true, value: prerequisite };
  }
  if (kind === 'days_acquainted') {
    if (!hasExactlyNames(value, ['kind', 'days'])) return INVALID;
    const daysMember = ownMember(value, 'days');
    const days = daysMember.kind === 'data' ? daysMember.value : undefined;
    if (!isPrerequisiteDays(days)) return INVALID;
    const prerequisite: Prerequisite = { kind: 'days_acquainted', days };
    Object.freeze(prerequisite);
    return { ok: true, value: prerequisite };
  }
  if (kind === 'user_used_relational_language') {
    if (!hasExactlyNames(value, ['kind'])) return INVALID;
    const prerequisite: Prerequisite = { kind: 'user_used_relational_language' };
    Object.freeze(prerequisite);
    return { ok: true, value: prerequisite };
  }
  return INVALID;
}

/** Fresh, frozen copy of a list. */
function freezeArray<T>(values: T[]): T[] {
  return Object.freeze(values) as T[];
}

/**
 * Validate one row and build a fresh, deeply frozen copy with only known members.
 * The members are checked in this order, which is NOT the declared order of RegistryRow, and the
 * first failing one supplies the reason: facetId, group, mode, depth, observationEntrance,
 * licence, minGapDays, then the lists neighbours, openingFamilies, forbids, contextArchetypes,
 * approachHints, sources and prerequisites, each by its length first and its members after.
 */
function validateRow(row: unknown,work:ProbeWork): { ok: true; row: RegistryRow } | RowFailure {
  work.nodes++;
  // Any accessor property on the row, even one with an unknown name, is rejected.
  if (!isPlainData(row)) return INVALID;

  const idField = textOf(ownMember(row, 'facetId'), DATA_LIMITS.key, false);
  if (!idField.ok) return idField;
  const facetId = idField.value;

  const groupMember = ownMember(row, 'group');
  const group = groupMember.kind === 'data' ? groupMember.value : undefined;
  if (!isFacetGroup(group)) return INVALID;

  const modeMember = ownMember(row, 'mode');
  const mode = modeMember.kind === 'data' ? modeMember.value : undefined;
  if (!isProbeMode(mode)) return INVALID;

  const depthMember = ownMember(row, 'depth');
  const depth = depthMember.kind === 'data' ? depthMember.value : undefined;
  if (!isDepth(depth)) return INVALID;

  const entranceMember = ownMember(row, 'observationEntrance');
  const observationEntrance = entranceMember.kind === 'data' ? entranceMember.value : undefined;
  if (typeof observationEntrance !== 'boolean') return INVALID;

  const licenceMember = ownMember(row, 'licence');
  const licence = licenceMember.kind === 'data' ? licenceMember.value : undefined;
  if (!isLicenceStatus(licence)) return INVALID;

  const gapMember = ownMember(row, 'minGapDays');
  const minGapDays = gapMember.kind === 'data' ? gapMember.value : undefined;
  if (!isMinGapDays(minGapDays)) return INVALID;

  const neighboursField = arrayOf(ownMember(row, 'neighbours'),MAX_NEIGHBOURS,work);
  if (!neighboursField.ok) return neighboursField;
  const neighbours: string[] = [];
  const neighbourSeen = new Set<string>();
  for (let index = 0; index < neighboursField.value.length; index++) {
    work.steps++;
    const text = textValue(neighboursField.value[index], DATA_LIMITS.key, false);
    if (!text.ok) return text;
    if (text.value === facetId) return INVALID;
    if (neighbourSeen.has(text.value)) return INVALID;
    neighbourSeen.add(text.value);
    neighbours.push(text.value);
  }

  const openingsField = arrayOf(ownMember(row, 'openingFamilies'),MAX_OPENING_FAMILIES,work);
  if (!openingsField.ok) return openingsField;
  const openingFamilies: ContentFamily[] = [];
  const openingSeen = new Set<string>();
  for (let index = 0; index < openingsField.value.length; index++) {
    work.steps++;
    const element = openingsField.value[index];
    if (!isContentFamily(element)) return INVALID;
    if (openingSeen.has(element)) return INVALID;
    openingSeen.add(element);
    openingFamilies.push(element);
  }

  const forbidsField=arrayOf(ownMember(row,'forbids'),MAX_FORBIDS,work);
  if(!forbidsField.ok)return forbidsField;
  const forbidsValue=forbidsField.value;
  const forbids: RowForbid[] = [];
  const forbidSeen = new Set<string>();
  for (let index = 0; index < forbidsValue.length; index++) {
    work.steps++;
    const element = forbidsValue[index];
    if (!isRowForbid(element)) return INVALID;
    if (forbidSeen.has(element)) return INVALID;
    forbidSeen.add(element);
    forbids.push(element);
  }

  const contextField = arrayOf(ownMember(row, 'contextArchetypes'),MAX_CONTEXT_ARCHETYPES,work);
  if (!contextField.ok) return contextField;
  const contextArchetypes: string[] = [];
  for (let index = 0; index < contextField.value.length; index++) {
    work.steps++;
    const text = textValue(contextField.value[index], DATA_LIMITS.key, false);
    if (!text.ok) return text;
    contextArchetypes.push(text.value);
  }

  const hintsField = arrayOf(ownMember(row, 'approachHints'),MAX_APPROACH_HINTS,work);
  if (!hintsField.ok) return hintsField;
  const approachHints: string[] = [];
  for (let index = 0; index < hintsField.value.length; index++) {
    work.steps++;
    const text = textValue(hintsField.value[index], DATA_LIMITS.quote, false);
    if (!text.ok) return text;
    approachHints.push(text.value);
  }

  const sourcesField = arrayOf(ownMember(row, 'sources'),MAX_SOURCES,work);
  if (!sourcesField.ok) return sourcesField;
  const sources: string[] = [];
  for (let index = 0; index < sourcesField.value.length; index++) {
    work.steps++;
    const text = textValue(sourcesField.value[index], DATA_LIMITS.key, true);
    if (!text.ok) return text;
    sources.push(text.value);
  }

  const prerequisitesField = arrayOf(ownMember(row, 'prerequisites'),MAX_PREREQUISITES,work);
  if (!prerequisitesField.ok) return prerequisitesField;
  const prerequisites: Prerequisite[] = [];
  for (let index = 0; index < prerequisitesField.value.length; index++) {
    work.steps++;
    const prerequisite = validatePrerequisite(prerequisitesField.value[index]);
    if (!prerequisite.ok) return prerequisite;
    prerequisites.push(prerequisite.value);
  }

  const output: RegistryRow = {
    facetId,
    group,
    neighbours: freezeArray(neighbours),
    openingFamilies: freezeArray(openingFamilies),
    observationEntrance,
    mode,
    depth,
    prerequisites: freezeArray(prerequisites),
    forbids: freezeArray(forbids),
    contextArchetypes: freezeArray(contextArchetypes),
    minGapDays,
    licence,
    approachHints: freezeArray(approachHints),
    sources: freezeArray(sources),
  };
  Object.freeze(output);
  return { ok: true, row: output };
}

/**
 * Check a registry: a real array of at most REGISTRY_MAX plain-object rows with
 * the required own data members and valid values, one row per facetId. Valid
 * rows come back as fresh, deeply frozen copies; the caller's array is untouched.
 */
export function validateRegistryCore(rows: unknown,work:ProbeWork=newWork()): { ok: true; rows: RegistryRow[] } | { ok: false; reason: 'invalid_input' | 'input_limit'; index: number | null } {
  try {
    const root=ownArrayData(rows,REGISTRY_MAX,work);
    if(!root.ok)return {ok:false,reason:root.reason,index:null};
    const inputRows=root.values;
    const output: RegistryRow[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < inputRows.length; index++) {
    work.steps++;
      try {
        const result = validateRow(inputRows[index],work);
        if (!result.ok) return { ok: false, reason: result.reason, index };
        if (seen.has(result.row.facetId)) return { ok: false, reason: 'invalid_input', index };
        seen.add(result.row.facetId);
        output.push(result.row);
      } catch {
        return { ok: false, reason: 'invalid_input', index };
      }
    }
    return { ok: true, rows: Object.freeze(output) as RegistryRow[] };
  } catch {
    return { ok: false, reason: 'invalid_input', index: null };
  }
}

/** Public registry boundary. Schema validation creates one owned frozen projection. */
export function validateRegistry(rows: unknown): ReturnType<typeof validateRegistryCore> { return validateRegistryCore(rows); }
