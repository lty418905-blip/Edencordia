/** Deterministic scheduling on a bounded caller projection. O(N + R log R + L). */

import { boundedCopy, copyCore, checkContext, checkedText, nonnegative, ownValue, PROBE_LIMITS, newWork, reasonOf, type ReasonCode, type ProbeWork, failure, type InputFailure, fail, checkedArray, dataObject, checkState, checkLocalContext, limitsFor, type ProbeLimits } from './util.ts';
import type {Archetype,ProbeState,TurnContext} from './types.ts';
import type {RegistryRow} from './facets.ts';

export interface ScheduleConfig {
  maxPerDay: number;             // 每日投遞上限（預設 2)
  maxPerWeek: number;            // 每週投遞上限（預設 6)
  forms: number;                 // 輪換份數（預設 3，即 3-form design)
}

export const DEFAULT_SCHEDULE_CONFIG: ScheduleConfig = Object.freeze({
  maxPerDay: 2,
  maxPerWeek: 6,
  forms: 3,
});

/** Deterministic scheduling on a bounded caller projection. O(N + R log R + L). */
function hash32(s: string,work:ProbeWork): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    work.steps++;h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function formOfCore(itemId: string, forms: number,work:ProbeWork=newWork()): number {
  return hash32(itemId,work) % Math.max(1, forms);
}

/** Deterministic scheduling on a bounded caller projection. O(N + R log R + L). */
function hash01(s: string,work:ProbeWork): number {
  return hash32(s,work) / 4294967296; // 2^32
}

/** Deterministic scheduling on a bounded caller projection. O(N + R log R + L). */
export function effectiveMinIntervalDaysCore(itemId: string, baseDays: number, seed?: string,work:ProbeWork=newWork(),jitterFraction=0.15): number {
  return baseDays * (1-jitterFraction + 2*jitterFraction * hash01(`${itemId}|${seed ?? ''}`,work));
}

/** Deterministic scheduling on a bounded caller projection. O(N + R log R + L). */
export function activeFormCore(weekKey: string | undefined, forms: number,work:ProbeWork=newWork()): number {
  if (!weekKey) return 0;
  return hash32(weekKey,work) % Math.max(1, forms);
}

/** Deterministic scheduling on a bounded caller projection. O(N + R log R + L). */
const TIME_WINDOWS: Partial<Record<Archetype, (hour: number, isWeekend: boolean) => boolean>> = {
  late_night: (h) => h >= 22 || h <= 3,
  evening_winddown: (h) => h >= 19 && h <= 23,
  weekend_morning: (h, we) => we && h >= 7 && h <= 12,
};

/** Deterministic scheduling on a bounded caller projection. O(N + R log R + L). */
function itemTimeBound(item: RegistryRow,work:ProbeWork): string[] {
  return item.contextArchetypes.filter((a) => {work.steps++;return ownValue(TIME_WINDOWS,a);});
}

/** Deterministic scheduling on a bounded caller projection. O(N + R log R + L). */
export function timeEligibleCore(item: RegistryRow, ctx: TurnContext,work:ProbeWork=newWork()): boolean {
  const h = ctx.localHour;
  if (h == null) return !item.contextArchetypes.some(a=>{work.steps++;return Object.hasOwn(TIME_WINDOWS,a);}) && !(ctx.archetypes??[]).some(a=>{work.steps++;return Object.hasOwn(TIME_WINDOWS,a);}); // 無法判定時段時關門
  const we = ctx.isWeekend ?? false;

  // (2) 當前情境中的帶時窗原型：每一個都必須滿足
  for (const a of ctx.archetypes ?? []) {
    work.steps++;
    const win = ownValue(TIME_WINDOWS,a);
    if (win && !win(h, we)) return false;
  }

  // (3) 題目側：無時窗原型者不受鐘點限制；有時窗原型者需至少一個成立
  const bound = itemTimeBound(item,work);
  if (bound.length === 0) return true;
  return bound.some((a) => {work.steps++;return ownValue(TIME_WINDOWS,a)!(h, we);});
}

/** Deterministic scheduling on a bounded caller projection. O(N + R log R + L). */
export function archetypeEligibleCore(item: RegistryRow, ctx: TurnContext,work:ProbeWork=newWork()): boolean {
  const current = ctx.archetypes ?? [];
  if (current.length === 0) return false; 
  for(const a of item.contextArchetypes){work.steps++;for(const b of current){work.steps++;if(a===b)return true;}}return false;
}

/** Deterministic scheduling on a bounded caller projection. O(N + R log R + L). */
export function capacityLeftCore(state: ProbeState, ctx: TurnContext, cfg: ScheduleConfig,work:ProbeWork=newWork()): number {
  const { dayKey, weekKey } = ctx;
  const day = ownValue(state.schedule.dayCounts,dayKey) ?? 0;
  const week = ownValue(state.schedule.weekCounts,weekKey) ?? 0;
  nonnegative(day); nonnegative(week); nonnegative(cfg.maxPerDay); nonnegative(cfg.maxPerWeek);
  return Math.max(0, Math.min(cfg.maxPerDay - day, cfg.maxPerWeek - week));
}

/** Deterministic scheduling on a bounded caller projection. O(N + R log R + L). */
export function planningCapacityLeftCore(state: ProbeState, ctx: TurnContext, cfg: ScheduleConfig,work:ProbeWork=newWork()): number {
  return Math.max(0, capacityLeftCore(state, ctx, cfg,work) - state.pending.length);
}

export function noteScheduledCore(state: ProbeState, ctx: TurnContext,work:ProbeWork): void {
  const { dayKey, weekKey } = ctx;
  nonnegative(ownValue(state.schedule.dayCounts,dayKey) ?? 0); nonnegative(ownValue(state.schedule.weekCounts,weekKey) ?? 0);
  Object.defineProperty(state.schedule.dayCounts,dayKey,{value:(ownValue(state.schedule.dayCounts,dayKey) ?? 0)+1,enumerable:true,writable:true,configurable:true});
  Object.defineProperty(state.schedule.weekCounts,weekKey,{value:(ownValue(state.schedule.weekCounts,weekKey) ?? 0)+1,enumerable:true,writable:true,configurable:true});
  // 清理過期計數，避免狀態無限增長
  const dayKeys = Object.keys(state.schedule.dayCounts).sort((a,b)=>{work.comparisons++;return a<b?-1:a>b?1:0;});
  for (const k of dayKeys.slice(0, Math.max(0, dayKeys.length - PROBE_LIMITS.retainedDays))){work.steps++;delete state.schedule.dayCounts[k];}
  const weekKeys = Object.keys(state.schedule.weekCounts).sort((a,b)=>{work.comparisons++;return a<b?-1:a>b?1:0;});
  for (const k of weekKeys.slice(0, Math.max(0, weekKeys.length - PROBE_LIMITS.retainedWeeks))){work.steps++;delete state.schedule.weekCounts[k];}
}

/** Deterministic scheduling on a bounded caller projection. O(N + R log R + L). */
export function scheduledCore(
  item: RegistryRow,
  ctx: TurnContext,
  state: ProbeState,
  cfg: ScheduleConfig,
  isCritical: boolean,
  work:ProbeWork=newWork(),
): boolean {
  if (!archetypeEligibleCore(item, ctx,work)) return false;
  if (!timeEligibleCore(item, ctx,work)) return false;
  // 3-form：非關鍵題必須落在本週生效份內
  if (!isCritical && formOfCore(item.facetId, cfg.forms,work) !== activeFormCore(ctx.weekKey, cfg.forms,work)) return false;
  void state;
  return true;
}

export function checkScheduleConfig(cfg:ScheduleConfig,limits:ProbeLimits=limitsFor()):void {
  dataObject(cfg);nonnegative(cfg.maxPerDay);nonnegative(cfg.maxPerWeek);nonnegative(cfg.forms,limits.forms);
  if(!Number.isInteger(cfg.forms))fail('invalid_input');
}
export function checkItem(item:RegistryRow):void {
  dataObject(item);checkedText(item.facetId,PROBE_LIMITS.key);
  for(const a of checkedArray(item.contextArchetypes))checkedText(a,PROBE_LIMITS.quote);
}
/** Deterministic scheduling on a bounded caller projection. O(N + R log R + L). */
export function formOf(itemId:string,forms:number,rowCount:number=PROBE_LIMITS.registry):number|InputFailure<number>{
  const work=newWork();try{const limits=limitsFor(rowCount);const x=boundedCopy({itemId,forms},work,limits);checkedText(x.itemId,PROBE_LIMITS.key);nonnegative(x.forms,limits.forms);if(!Number.isInteger(x.forms))fail('invalid_input');return formOfCore(x.itemId,x.forms,work);}catch(error){return failure(-1,error,work);}
}
export function effectiveMinIntervalDays(itemId:string,baseDays:number,seed?:string|null):number|InputFailure<number>{
  const work=newWork();try{const x=boundedCopy({itemId,baseDays,seed},work);checkedText(x.itemId,PROBE_LIMITS.key);nonnegative(x.baseDays);if(x.seed!=null)checkedText(x.seed,PROBE_LIMITS.key);return effectiveMinIntervalDaysCore(x.itemId,x.baseDays,x.seed??undefined,work);}catch(error){return failure(Number.MAX_SAFE_INTEGER,error,work);}
}
export function activeForm(weekKey:string|undefined|null,forms:number,rowCount:number=PROBE_LIMITS.registry):number|InputFailure<number>{
  const work=newWork();try{const limits=limitsFor(rowCount);const x=boundedCopy({weekKey,forms},work,limits);nonnegative(x.forms,limits.forms);if(!Number.isInteger(x.forms))fail('invalid_input');if(x.weekKey!=null)checkedText(x.weekKey,PROBE_LIMITS.key);return activeFormCore(x.weekKey??undefined,x.forms,work);}catch(error){return failure(-2,error,work);}
}
export function timeEligible(item:RegistryRow,ctx:TurnContext):boolean|InputFailure<false>{
  const work=newWork();try{const x=boundedCopy({item,ctx},work);checkItem(x.item);checkLocalContext(x.ctx);return timeEligibleCore(x.item,x.ctx,work);}catch(error){return failure(false,error,work);}
}
export function archetypeEligible(item:RegistryRow,ctx:TurnContext):boolean|InputFailure<false>{
  const work=newWork();try{const x=boundedCopy({item,ctx},work);checkItem(x.item);checkLocalContext(x.ctx);return archetypeEligibleCore(x.item,x.ctx,work);}catch(error){return failure(false,error,work);}
}
export function capacityLeft(state:ProbeState,ctx:TurnContext,cfg:ScheduleConfig):number|InputFailure<number>{
  const work=newWork();try{const x=boundedCopy({state,ctx,cfg},work);checkState(x.state,work);checkContext(x.ctx);checkScheduleConfig(x.cfg);return capacityLeftCore(x.state,x.ctx,x.cfg,work);}catch(error){return failure(0,error,work);}
}
export function planningCapacityLeft(state:ProbeState,ctx:TurnContext,cfg:ScheduleConfig):number|InputFailure<number>{
  const work=newWork();try{const x=boundedCopy({state,ctx,cfg},work);checkState(x.state,work);checkContext(x.ctx);checkScheduleConfig(x.cfg);return planningCapacityLeftCore(x.state,x.ctx,x.cfg,work);}catch(error){return failure(0,error,work);}
}
export function noteScheduled(state:ProbeState,ctx:TurnContext):{reasonCode:ReasonCode;work:ProbeWork}{
  const work=newWork();try{const x=boundedCopy({state,ctx},work);checkState(x.state,work);checkContext(x.ctx);noteScheduledCore(x.state,x.ctx,work);
    let d:PropertyDescriptor|undefined;try{d=Object.getOwnPropertyDescriptor(state,'schedule');}catch{fail('input_access');}if(!d || !('value' in d) || !d.writable)fail('input_access');
    try{Object.defineProperty(state,'schedule',{value:copyCore(x.state.schedule,work)});}catch{fail('input_access');}return {reasonCode:null,work};
  }catch(error){return {reasonCode:reasonOf(error),work};}
}
export function scheduled(item:RegistryRow,ctx:TurnContext,state:ProbeState,cfg:ScheduleConfig,isCritical:boolean):boolean|InputFailure<false>{
  const work=newWork();try{const x=boundedCopy({item,ctx,state,cfg,isCritical},work);checkItem(x.item);checkState(x.state,work);checkContext(x.ctx);checkScheduleConfig(x.cfg);if(typeof x.isCritical!=='boolean')fail('invalid_input');return scheduledCore(x.item,x.ctx,x.state,x.cfg,x.isCritical,work);}catch(error){return failure(false,error,work);}
}
