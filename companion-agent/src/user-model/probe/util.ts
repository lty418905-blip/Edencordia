import { foldForMatch } from '../../../../shared/src/common/script-fold.ts';
import {REGISTRY_MAX} from './facets.ts';
import {DATA_LIMITS} from './guards.ts';
import {isDayKey} from './day-keys.ts';
const FINGERPRINTS_PER_ITEM=10;

/** Single-call projections, not chat capacity. Bank-dependent budgets grow with the bank.
 * Strings use UTF-16 units; depth starts at zero. Forms have the same budget as a list.
 */
export const PROBE_LIMITS = Object.freeze({text:20_000,quote:DATA_LIMITS.quote,key:DATA_LIMITS.key,depth:12,retainedDays:60,retainedWeeks:26,perItem:FINGERPRINTS_PER_ITEM,registry:REGISTRY_MAX,candidateIds:64,retired:64,baseNodes:8192,perRowNodes:256,baseText:200000,perRowText:14000,delayMs:2147483647,timeMs:8640000000000000});
export function limitsFor(rowCount:number=REGISTRY_MAX){
  nonnegative(rowCount,PROBE_LIMITS.registry);if(!Number.isInteger(rowCount))fail('invalid_input');
  return Object.freeze({...PROBE_LIMITS,list:Math.max(64,rowCount),fingerprints:rowCount*PROBE_LIMITS.perItem,fields:Math.max(60,rowCount+PROBE_LIMITS.retired),nodes:PROBE_LIMITS.baseNodes+PROBE_LIMITS.perRowNodes*rowCount,totalText:PROBE_LIMITS.baseText+PROBE_LIMITS.perRowText*rowCount,forms:Math.max(1,Math.min(64,rowCount))});
}
export type ProbeLimits=ReturnType<typeof limitsFor>;
export type ReasonCode = 'missing_input' | 'invalid_context' | 'invalid_input' | 'input_limit' | 'input_access' | 'invalid_ids' | 'internal_error' | null;
export interface ProbeWork { snapshots:number; inputNodes:number; nodes:number; units:number; hashBits:number; comparisons:number; steps:number }
export interface InputFailure<T> { value:T; reasonCode:Exclude<ReasonCode,null>; work:ProbeWork }
export function newWork(): ProbeWork { return {snapshots:0,inputNodes:0,nodes:0,units:0,hashBits:0,comparisons:0,steps:0}; }
export function fail(code: Exclude<ReasonCode,null>): never { throw code; }
export function reasonOf(error: unknown): Exclude<ReasonCode,null> {
  return error === 'missing_input' || error === 'invalid_context' || error === 'invalid_input' || error === 'input_limit' || error === 'input_access' || error === 'invalid_ids' ? error : 'internal_error';
}
export function failure<T>(value:T,error:unknown,work:ProbeWork): InputFailure<T> { return {value,reasonCode:reasonOf(error),work}; }
export function checkedText(value: unknown, limit:number): string {
  if (value === undefined) fail('missing_input');
  if (typeof value !== 'string') fail('invalid_input');
  if (value.length > limit) fail('input_limit');
  return value;
}
export function checkedArray<T>(value:T[], limit:number = limitsFor().list): T[] {
  if (value === undefined) fail('missing_input');
  if (!Array.isArray(value)) fail('invalid_input');
  if (value.length > limit) fail('input_limit');
  return value;
}
export function nonnegative(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) fail('missing_input');
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('invalid_input');
  if (value > max) fail('input_limit');
  return value;
}
export function dataObject(value:unknown): asserts value is Record<string,unknown> {
  if(value === undefined) fail('missing_input');
  if(value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_input');
}
/** Own-data snapshot, exactly once per input boundary. O(nodes + UTF-16 units).
 * Input budgets apply here only; internal results are copied without revalidation.
 */
export function snapshotCore<T>(input:T, work = newWork(), limits:ProbeLimits=limitsFor(), loose=false,rootField='',invalidPrerequisites=false): T {
  const visit = (value:unknown, depth:number, field:string,strict=false): unknown => {
    strict=strict||field==='state';
    work.nodes++;work.inputNodes++;
    if (work.inputNodes > limits.nodes || depth > PROBE_LIMITS.depth) fail('input_limit');
    if(invalidPrerequisites && field==='prerequisites' && !Array.isArray(value)){
      try{if(value===null || typeof value!=='object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(k=>!('value' in Object.getOwnPropertyDescriptor(value,k)!)))return {kind:null};}catch{return {kind:null};}
    }
    if(invalidPrerequisites && ['review','negative','positive','coolingEndsDay'].includes(field) && value!==null && typeof value==='object'){
      try{if(!Array.isArray(value) && ![Object.prototype,null].includes(Object.getPrototypeOf(value)))return 0;for(const k of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,k);if(!d||!('value' in d))return 0;}}catch{return 0;}
    }
    if (value == null) return value;
    if (typeof value === 'string') {
      const limit = field==='text' || field==='wording' ? PROBE_LIMITS.text : /(?:Id|Key|metric|targetMetric|targetEventKind|hash|windowHash|role|kind|category)$/.test(field) ? PROBE_LIMITS.key : PROBE_LIMITS.quote;
      if(!loose||strict)checkedText(value,limit);work.units+=value.length;
      if (work.units > limits.totalText) fail('input_limit');
      return value;
    }
    if (typeof value === 'number') return loose&&!strict?value:nonnegative(value);
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'object') fail('invalid_input');
    let array:boolean,keys:string[],length=0;
    try {
      array=Array.isArray(value);
      if(array){const d=Object.getOwnPropertyDescriptor(value,'length');if(!d || !('value' in d))fail('input_access');length=d.value;}
      if (array && length > (field === 'fingerprints' ? limits.fingerprints : field==='registry'?PROBE_LIMITS.registry:field==='candidateIds'?PROBE_LIMITS.candidateIds:field==='blocked'?limits.fields:limits.list)) fail('input_limit');
      keys=Object.keys(value);if(!array){const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)fail('invalid_input');}
      for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value' in d))fail('input_access');}
    }catch(e){if(typeof e==='string')throw e;fail('input_access');}
    if (!array && keys.length > limits.fields) fail('input_limit');
    const known:Record<string,string[]>={facets:['facetId','band','familiesPresent','distinctLocalDays','spontaneousCount','nextStep','review','coolingEndsDay','declined'],registry:['facetId','group','neighbours','openingFamilies','observationEntrance','mode','depth','prerequisites','forbids','contextArchetypes','minGapDays','licence','approachHints','sources'],nextStep:['localDays','families','spontaneous'],review:['negative','positive','lastResearchProbeDay'],negative:['quietEndsDay'],positive:['quietEndsDay']};
    known.facet=known.facets;known.row=known.registry;
    if(loose && !array && Object.hasOwn(known,field))keys=keys.filter(k=>known[field].includes(k));
    const out:Record<string,unknown>|unknown[]=array?[]:Object.create(null);
    for (const key of keys) {
      checkedText(key,PROBE_LIMITS.key);
      let descriptor:PropertyDescriptor|undefined;
      try{descriptor=Object.getOwnPropertyDescriptor(value,key);}catch{fail('input_access');}
      if (!descriptor || !('value' in descriptor)) fail('input_access');
      if (descriptor.value === undefined && !array) continue;
      const copy=visit(descriptor.value,depth+1,array ? field : key,strict);
      Object.defineProperty(out,key,{value:copy,enumerable:true,writable:true,configurable:true});
    }
    if(array){for(let i=0;i<length;i++)if(!Object.hasOwn(out,String(i)))fail('invalid_input');(out as unknown[]).length=length;}
    return out;
  };
  return visit(input,0,rootField) as T;
}
/** Internal owned result copy. No input budgets, no public boundary calls. O(nodes).
 * nodes counts snapshot, schema record visits, and result-copy visits; inputNodes
 * counts the snapshot only. units counts input/folded-anchor UTF-16 units;
 * hashBits counts bit updates, comparisons counts sorting/hash/anchor comparisons,
 * and steps counts the remaining instrumented algorithm loops.
 */
export function copyCore<T>(input:T,work:ProbeWork): T {
  work.nodes++;
  if(input===null || typeof input!=='object')return input;
  const out:Record<string,unknown>|unknown[]=Array.isArray(input)?[]:{};
  for(const key of Object.keys(input))Object.defineProperty(out,key,{value:copyCore((input as Record<string,unknown>)[key],work),enumerable:true,writable:true,configurable:true});
  return out as T;
}
export function ownValue<T>(record:Record<string,T>, key:string): T | undefined {
  return Object.hasOwn(record,key) ? record[key] : undefined;
}
/** Keys are supplied by the caller; shape/calendar validity only, not agreement with nowMs. */
export function checkContext(ctx:{nowMs:number;dayKey:string;weekKey:string;localHour?:number|null;isWeekend?:boolean|null;archetypes?:string[]|null}): void {
  dataObject(ctx);nonnegative(ctx.nowMs,PROBE_LIMITS.timeMs);
  checkedText(ctx.dayKey,PROBE_LIMITS.key);checkedText(ctx.weekKey,PROBE_LIMITS.key);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ctx.dayKey) || !/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(ctx.weekKey)) fail('invalid_context');
  if(!isDayKey(ctx.dayKey))fail('invalid_context');
  checkLocalContext(ctx);
}
export function checkLocalContext(ctx:{localHour?:number|null;isWeekend?:boolean|null;archetypes?:string[]|null}): void {
  dataObject(ctx);
  if(ctx.localHour!=null){nonnegative(ctx.localHour,23);if(!Number.isInteger(ctx.localHour))fail('invalid_input');}
  if(ctx.isWeekend!=null && typeof ctx.isWeekend!=='boolean')fail('invalid_input');
  if(ctx.archetypes!=null)for(const a of checkedArray(ctx.archetypes))checkedText(a,PROBE_LIMITS.quote);
}
export function checkState(state:unknown,work:ProbeWork,limits:ProbeLimits=limitsFor()): void {
  dataObject(state);work.nodes++;
  for(const key of ['items','coverage','groupStats','schedule','stats','viewWarnings']){dataObject(state[key]);work.nodes++;}
  for(const key of ['pending','readyScores','lastGaps','fingerprints'])checkedArray(state[key] as unknown[],key==='fingerprints'?limits.fingerprints:limits.list);
  const schedule=state.schedule as Record<string,unknown>,stats=state.stats as Record<string,unknown>;
  for(const key of ['dayCounts','weekCounts']){dataObject(schedule[key]);for(const v of Object.values(schedule[key])){work.nodes++;nonnegative(v);}}
  dataObject(stats.totals);dataObject(stats.byItem);
  for(const key of ['delivered','answered','evasive','unanswered'])nonnegative((stats.totals as Record<string,unknown>)[key]);
  for(const record of [state.items,stats.byItem])if(Object.keys(record as object).length>limits.fields)fail('input_limit');
  for(const record of [state.items,state.groupStats,stats.byItem])for(const v of Object.values(record as Record<string,unknown>)){dataObject(v);work.nodes++;for(const n of Object.values(v))if(n!=null){work.nodes++;nonnegative(n);}}
  for(const v of Object.values(state.coverage as Record<string,unknown>)){work.nodes++;nonnegative(v);}
  for(const v of Object.values(stats.totals)){work.nodes++;nonnegative(v);}
  for(const key of ['missingView','missingGate','missingCounts','missingBand','missingDayKey'])nonnegative((state.viewWarnings as Record<string,unknown>)[key]);
  for(const v of Object.values(state.viewWarnings as Record<string,unknown>)){work.nodes++;nonnegative(v);}
  if(!Object.hasOwn(state,'lastPlanDayKey'))fail('missing_input');
  if(state.lastPlanDayKey!=null)checkedText(state.lastPlanDayKey,PROBE_LIMITS.key);
  for(const c of state.pending as Record<string,unknown>[]){dataObject(c);work.nodes++;checkedText(c.facetId,PROBE_LIMITS.key);checkedText(c.candidateId,PROBE_LIMITS.key);nonnegative(c.validUntilMs);}
  for(const r of state.readyScores as Record<string,unknown>[]){dataObject(r);work.nodes++;nonnegative(r.scoredAtMs);}
  for(const m of state.lastGaps as string[])checkedText(m,PROBE_LIMITS.key);
}
function fnv1a64(str:string,work:ProbeWork): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i=0;i<str.length;i++) { work.steps++;h ^= BigInt(str.charCodeAt(i)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h;
}
/** O(n) UTF-16 work, at most 64 × max(1,n-1) bit updates; folded text is disposable. */
export function simhash64Core(text:string,work:ProbeWork): string {
    const normalized = foldForMatch(text).replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();
    const v = new Array<number>(64).fill(0);
    const count = Math.max(1,normalized.length-1);
    for (let g=0;g<count;g++) {
      work.steps++;
      const h = fnv1a64(normalized.length > 1 ? normalized.slice(g,g+2) : normalized || '∅',work);
      for (let i=0;i<64;i++) { work.hashBits++; v[i] += (h >> BigInt(i)) & 1n ? 1 : -1; }
    }
    let out=0n;
    for (let i=0;i<64;i++) if (v[i]>0) out |= 1n << BigInt(i);
    return out.toString(16).padStart(16,'0');
}
export function simhash64(text:string): {hash:string|null;reasonCode:ReasonCode;work:ProbeWork} {
  const work=newWork();
  try{const x=boundedCopy({text},work);checkedText(x.text,PROBE_LIMITS.text);return {hash:simhash64Core(x.text,work),reasonCode:null,work};}
  catch(error){return {hash:null,reasonCode:reasonOf(error),work};}
}
/** Fixed 64-bit comparison. Invalid hashes are never considered a safe wording. */
export function simhashSimilarityCore(aHex:string,bHex:string,work:ProbeWork): number {
  work.comparisons++;
  let x = BigInt('0x'+aHex) ^ BigInt('0x'+bHex), d=0;
  while (x>0n) { work.steps++; d += Number(x & 1n); x >>= 1n; }
  return 1-d/64;
}
export function simhashSimilarity(aHex:string,bHex:string): number|InputFailure<null> {
  const work=newWork();
  try{const x=boundedCopy({aHex,bHex},work);checkedText(x.aHex,PROBE_LIMITS.key);checkedText(x.bHex,PROBE_LIMITS.key);if(!/^[0-9a-f]{16}$/i.test(x.aHex)||!/^[0-9a-f]{16}$/i.test(x.bHex))fail('invalid_input');return simhashSimilarityCore(x.aHex,x.bHex,work);}
  catch(error){return failure(null,error,work);}
}

/** Exactly one boundary snapshot; snapshotCore is used only inside an existing boundary. */
export function boundedCopy<T>(input:T,work=newWork(),limits:ProbeLimits=limitsFor(),loose=false):T{work.snapshots++;return snapshotCore(input,work,limits,loose);}
