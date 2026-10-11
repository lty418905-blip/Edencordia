/** Verbal bands of understanding. A band is a label, never a score. */
export const UNDERSTANDING_BANDS = Object.freeze(['unknown', 'mentioned', 'guess', 'current_view'] as const);
export type UnderstandingBand = (typeof UNDERSTANDING_BANDS)[number];

/** Content families of evidence: a general self-description, a concrete event, a stated preference. */
export const CONTENT_FAMILIES = Object.freeze(['G', 'E', 'P'] as const);
export type ContentFamily = (typeof CONTENT_FAMILIES)[number];

/** Local day key of the user's time zone, YYYY-MM-DD. */
export type DayKey = string;

export interface FacetReview {
  negative: { quietEndsDay: DayKey } | null;
  positive: { quietEndsDay: DayKey } | null;
  lastResearchProbeDay: DayKey | null;
}

export interface FacetView {
  facetId: string;
  band?: UnderstandingBand | null;
  familiesPresent?: ContentFamily[] | null;
  distinctLocalDays?: number | null;
  spontaneousCount?: number | null;
  nextStep?: { localDays: number; families: number; spontaneous: number } | null;
  review?: FacetReview | null;
  coolingEndsDay?: DayKey | null;
  declined?: boolean | null;
}

/** Situations the caller may report for the current turn; in any of them no probe is proposed for any facet:
 * the day of an argument, the user wants to be alone, deep night, right after a short answer. They stop
 * only the proposing of probes; they are never a signal to stop passive collection: what the user says
 * is still recorded by the caller and still enters the profile, marked with the situation. */
export const UNIVERSAL_SITUATIONS = Object.freeze([
  'same_day_conflict', 'user_wants_alone', 'deep_night', 'after_short_answer',
] as const);
export type UniversalSituation = (typeof UNIVERSAL_SITUATIONS)[number];

/** Forbids a registry row may declare, reported by the caller as active situations: the user is
 * ruminating; the user is in a rush. Neither a non-negative emotion of the user nor her own recent
 * behaviour is a forbid (product owner, 2026-10-10): see ADVISORY_SITUATIONS. */
export const ROW_FORBIDS = Object.freeze([
  'rumination',
  'user_in_rush',
] as const);
export type RowForbid = (typeof ROW_FORBIDS)[number];

/** Situations a caller may report that never close a gate and that a registry row cannot declare
 * as forbids: the user has just said that he misses her, she has just written a long message, she has
 * just disclosed something about herself, she has just been silent for a while. People do ask each
 * other what they think at such moments. They are reported so that the step that words a question can
 * make it follow from the conversation instead of reading like a questionnaire. */
export const ADVISORY_SITUATIONS = Object.freeze([
  'user_just_expressed_missing',
  'after_her_long_message',
  'after_her_self_disclosure',
  'after_her_gap',
] as const);
export type AdvisorySituation = (typeof ADVISORY_SITUATIONS)[number];

export type Situation = UniversalSituation | RowForbid | AdvisorySituation;

/** The gates the caller supplies with each planning call; they decide whether a probe
 * may be PROPOSED now. Apart from learningEnabled, none of them stops passive
 * collection. */
export interface PlanGates {
  /** The consent switch of the user, set only on the backend page of the workspace (nothing said in a
   * conversation changes it); false stops everything: nothing proposed, collecting and evaluation stop,
   * waiting dropped. While it is true, passive collection and evaluation never stop. */
  learningEnabled: boolean;
  /** True while the user is in distress, meaning a negative emotional state (for example grief, fear,
   * anger, pain), and for the 24 hours after: no probes; collection continues, marked with the
   * situation. A non-negative emotion, such as affection, joy or missing her, never sets it. */
  distressWindow: boolean;
  /** The situations that hold now; see UNIVERSAL_SITUATIONS, ROW_FORBIDS and ADVISORY_SITUATIONS. */
  situations: Situation[];
  /** Facts about the relationship that prerequisites of a registry row may require. */
  relationship: { daysAcquainted: number | null; relationalLanguageSeen: boolean | null };
  /** The weekly ceiling for probes about facets under review; null when no research probe may be proposed. */
  research: { perFacetMinGapDays: number; perWeekTotal: number; probesThisWeek: number } | null;
}

export const FACET_GROUPS = Object.freeze(['HB','ST','DS','ER','CP','ND','SN','CL','DC','RF','TR','IR','DG','RL','RS'] as const);
export type FacetGroup = (typeof FACET_GROUPS)[number];

/** Probe modes a row may declare; the only accepted values. */
export const PROBE_MODES = Object.freeze(['ask', 'offer', 'only_if_user_raises', 'observe_only'] as const);
export type ProbeMode = (typeof PROBE_MODES)[number];

/** Licence states a row may declare; the only accepted values. */
export const LICENCE_STATUSES = Object.freeze([
  'not_near_scale', 'near_scale_unchecked', 'near_scale_cleared',
] as const);
export type LicenceStatus = (typeof LICENCE_STATUSES)[number];
export type Prerequisite =
  | { kind: 'facet_band_at_least'; facetId: string; band: Exclude<UnderstandingBand, 'unknown'> }
  | { kind: 'days_acquainted'; days: number }
  | { kind: 'user_used_relational_language' };

export interface RegistryRow {
  facetId: string;
  group: FacetGroup;
  neighbours: string[];
  openingFamilies: ContentFamily[];
  observationEntrance: boolean;
  mode: ProbeMode;
  depth: 1 | 2 | 3;
  prerequisites: Prerequisite[];
  forbids: RowForbid[];
  contextArchetypes: string[];
  minGapDays: number;
  licence: LicenceStatus;
  approachHints: string[];
  sources: string[];
}

export type ProbeIntention = 'first_evidence' | 'discriminate' | 'add_family' | 'add_day';

/** Upper bound on the number of rows a registry may carry. */
export const REGISTRY_MAX = 512;
