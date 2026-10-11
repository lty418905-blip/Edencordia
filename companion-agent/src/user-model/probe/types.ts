import type {DayKey,FacetGroup,ProbeMode,ContentFamily,ProbeIntention,RowForbid} from './facets.ts';

export const ARCHETYPES = [
  'routine_chat',              // 日常閒聊
  'distress_moment',           // 情緒事件當下
  'evening_winddown',          // 晚間放鬆
  'late_night',                // 深夜
  'weekend_morning',           // 週末清晨/上午
  'after_her_advice',          // 她給過建議之後
  'after_shared_activity',     // 共同話題/共同活動之後
  'good_news',                 // 好訊息分享
  'conflict_or_misunderstanding', // 分歧或誤解之後
  'after_absence',             // 一段時間未聊之後
] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/** One proposal; strings describe identifiers and enums, never a composed question. */
export interface ProbeCandidate {
  candidateId:string;facetId:string;group:FacetGroup;mode:ProbeMode;depth:1|2|3;
  family:ContentFamily;intention:ProbeIntention;discriminatesFrom:string|null;
  research:'none'|'after_negative'|'after_positive'|'both';forbids:RowForbid[];
  preferredArchetypes:string[];contextAnchor:string|null;
  wordingConstraints:{bans:string[];maxChars:number};validUntilMs:number;createdAtMs:number;
  prescoreAttempts?:number;nextPrescoreAtMs?:number;
  /** Moment in milliseconds at which the asking flow last proposed this candidate; absent until then. */
  lastOfferedAtMs?: number;
}
export interface ActiveAnchor {
  anchorId: string;
  kind: 'arrangement' | 'topic' | 'event';
  label: string;
  validUntilMs?: number;
}

/** 每輪情境（宿主判定；用於情境視窗與排程） */
export interface TurnContext {
  nowMs: number;
  localHour?: number|null;               // 使用者本地小時 0-23
  isWeekend?: boolean|null;
  archetypes?: Archetype[]|null;         // 當前對話所屬情境原型
  dayKey: string;                  // 使用者時區日 YYYY-MM-DD
  weekKey: string;                 // 使用者時區周 YYYY-Www
}

/** 每輪標誌位（宿主供給；rumination/E1 屬測量品質門，非安全處置） */
export interface TurnFlags {
  ruminationActive?: boolean;
  e1Active?: boolean;
  userInRush?: boolean;
  questionBudgetRemaining?: number;
}

/** 對話行（宿主供給的最近上下文；用於後臺語境預評分） */
export interface TurnLine { role: 'user' | 'assistant'; content: string }

// ============================== 輸出契約 ==============================

export interface ProbeIntent {
  candidateId: string;
  facetId: string;
  approachHint: string;
  contextAnchor: string | null;
  wordingConstraints: { bans: string[]; maxChars: number };
}

export type ProbeOutcome = 'answered' | 'evasive' | 'unanswered';

export interface AnswerAnnotation {
  candidateId: string;
  facetId: string;
  probeElicited: true;
  outcome: ProbeOutcome;
  userMessageExcerpt: string;
  answeredAtMs: number;
}

export interface TurnOutput {
  answerAnnotation: AnswerAnnotation | null;  // 本輪訊息若是對上一個追問的回答
  probeIntent: ProbeIntent | null;            // 本輪建議織入的追問（來自後臺預算好的 ReadySet)
}

// ============================== 持久化狀態 ==============================

export interface ItemState {
  lastDeliveredAtMs: number | null;
  cooldownUntilMs: number | null;
  evasiveStreak: number;
  nextApproachIndex: number;
  /**
   * 低分退避保留在面向層。原本掛在候選上，候選被丟棄後 plan 會為同一面向
   * 立刻重鑄新候選、attempts 歸零，形成永久 0 產出迴圈。
   */
  prescoreAttempts?: number;
  nextPrescoreAtMs?: number;
}

/** 後臺預評分結果：語境適配分，帶 TTL；回覆路徑只讀它，不做任何等待 */
export interface ReadyScore {
  candidateId: string;
  facetId: string;
  score: number;      // 0..1 語境適配
  scoredAtMs: number;
  windowHash: string; // 評分時的對話視窗指紋（便於診斷，不作為硬失效條件）
}

export interface FingerprintEntry { hash: string; facetId: string; atMs: number; }

export interface CountStat { delivered: number; answered: number; evasive: number; unanswered: number; }

export interface ScheduleState {
  dayCounts: Record<string, number>;   // dayKey -> 已投遞數（日上限）
  weekCounts: Record<string, number>;  // weekKey -> 已投遞數（週上限）
}

export interface ProbeState {
  /** 宿主維護的狀態版本號 */
  version: number;
  items: Record<string, ItemState>;
  pending: ProbeCandidate[];
  readyScores: ReadyScore[];
  awaitingAnswer: {
    candidateId: string; facetId: string; deliveredAtMs: number;
    /**
     * The members below are written by the asking flow when a delivery is registered. They are
     * optional in the type so that the empty state stays valid; the asking flow refuses a waiting
     * record that lacks any of them.
     */
    /** Group of the facet's registry row when the probe was proposed. */
    group?: FacetGroup;
    /** Content family the probe asks for. */
    family?: ContentFamily;
    /** Why the facet was chosen. */
    intention?: ProbeIntention;
    /** The neighbouring facet a discriminating probe tells apart, or null. */
    discriminatesFrom?: string | null;
    /** Research mark computed from the facet view when the probe was proposed. */
    research?: ProbeResearchMark;
    /** Identifier of her accepted message that carries the question. */
    deliveryRef?: string;
  } | null;
  fingerprints: FingerprintEntry[];
  coverage: Partial<Record<FacetGroup, number>>;        // 該維度最近一次被覆蓋的時間戳
  groupStats: Partial<Record<FacetGroup, CountStat>>;  // 用於披露梯度解鎖
  schedule: ScheduleState;
  stats: {
    totals: CountStat;
    byItem: Record<string, CountStat>;
    /** 語意明示為「缺口集合改變」，**不是**品質指標 */
    deficitsChanged: number;
    /** @deprecated 舊欄位，只讀相容 */
    deficitsResolved?: number;
    /** 低分退避達上限而丟棄的候選數 */
    droppedLowScore: number;
    /** 曾對外給出的追問意圖數（與 delivered 分開） */
    offers: number;
    /** 因已有未回答追問而被拒絕的交付回報數 */
    rejectedDeliveries: number;
  };
  /** 宿主未提供必要檢視欄位的累計次數（可觀測性） */
  viewWarnings: {
    missingView:number;
    missingGate:number;
    missingCounts: number;
    missingBand: number;
    /** 宿主未提供日鍵的歷史累計值 */
    missingDayKey: number;
  };
  lastGaps: string[];
  lastPlanDayKey: string | null;
  /** Ledger of the asking flow; absent or null means an empty ledger. */
  flow?: ProbeFlowLedger | null;
}

/** Which sides of an open review a facet has when a probe about it is proposed; 'none' is an ordinary probe. */
export type ProbeResearchMark = 'none' | 'after_negative' | 'after_positive' | 'both';

/** Whether the one chance roll of a user turn has been made, and how it fell. */
export type ChanceRoll = 'none' | 'passed' | 'failed';

/**
 * A proposal handed to the step that writes her reply, which decides whether the question fits now.
 * Identifiers, closed-list values and numbers only: never a hint text, an anchor or a question.
 */
export interface ActiveOffer {
  /** User turn in which the proposal was made. */
  turnId: string;
  candidateId: string;
  facetId: string;
  /** Group, mode and depth of the registry row at the moment of the proposal. */
  group: FacetGroup;
  mode: ProbeMode;
  depth: 1 | 2 | 3;
  /** Family, intention and neighbour as planned on the candidate. */
  family: ContentFamily;
  intention: ProbeIntention;
  discriminatesFrom: string | null;
  /** Research mark recomputed from the facet view at the moment of the proposal. */
  research: ProbeResearchMark;
  /** Index into the row's approach hints, or null when the row has none. */
  approachIndex: number | null;
  /** Moment of the proposal in milliseconds. */
  offeredAtMs: number;
}

/**
 * What became of one delivered probe. The elicitation mark is always 'probe': evidence about the
 * listed facets in the settling user message was asked for and is never counted as spontaneous.
 */
export interface SettlementRecord {
  /** User turn that settled the probe. */
  turnId: string;
  candidateId: string;
  facetId: string;
  group: FacetGroup;
  family: ContentFamily;
  intention: ProbeIntention;
  discriminatesFrom: string | null;
  research: ProbeResearchMark;
  deliveryRef: string;
  /** Moments in milliseconds: when her message was accepted, and when the user turn settled it. */
  deliveredAtMs: number;
  settledAtMs: number;
  outcome: ProbeOutcome;
  /** True when the waiting time ran out or the clock went backwards; the outcome is then 'unanswered'. */
  timedOut: boolean;
  elicitation: 'probe';
  /** The probed facet, then the discriminated neighbour when there is one. */
  elicitedFacetIds: string[];
}

/** What the asking flow remembers about the user turn it received last. */
export interface FlowTurn {
  turnId: string;
  /** The user refused her asking in this turn, or named a facet he does not want to talk about. */
  refusal: boolean;
  /** This turn falls inside the pause that follows a settled probe. */
  refractory: boolean;
  /** The probe this turn settled, or null. */
  settlement: SettlementRecord | null;
  /** The chance roll is made at most once per turn, so that regenerating a reply cannot roll again. */
  chanceRoll: ChanceRoll;
}

/** State owned by the asking flow, stored inside the probe state. */
export interface ProbeFlowLedger {
  turn: FlowTurn | null;
  /** The proposal waiting for the report of what the reply step did with it, or null. */
  offer: ActiveOffer | null;
  /** Number of coming user messages without a probe; an integer from 0 to 10,000. */
  refractoryLeft: number;
  research: {
    /** Delivered research probes per local week key. */
    weekCounts: Record<string, number>;
    /** Local day of the last delivered research probe per facet. */
    lastProbeDayByFacet: Record<string, DayKey>;
  };
  /** Number of deliveries withdrawn before they were settled. */
  withdrawn: number;
}

/** 宿主對追問意圖的處置 */
export type OfferOutcome = 'used' | 'rewritten' | 'skipped';

export function emptyProbeState(): ProbeState {
  const zero = (): CountStat => ({ delivered: 0, answered: 0, evasive: 0, unanswered: 0 });
  return {
    version: 0,
    items: {}, pending: [], readyScores: [], awaitingAnswer: null, fingerprints: [],
    coverage: {}, groupStats: {},
    schedule: { dayCounts: {}, weekCounts: {} },
    stats: { totals: zero(), byItem: {}, deficitsChanged: 0, droppedLowScore: 0, offers: 0, rejectedDeliveries: 0 },
    viewWarnings: { missingView:0, missingGate:0, missingCounts: 0, missingBand: 0, missingDayKey: 0 },
    lastGaps: [], lastPlanDayKey: null,
  };
}

// ============================== 被直接詢問時的話術（使用者裁定 2026-10-08) ==============================

// 此處保留給產品負責人提供被直接詢問時的內容。
