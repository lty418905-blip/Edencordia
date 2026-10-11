import {WORDING_BANS} from './itembank.ts';
import {DEFAULT_SCHEDULE_CONFIG,checkScheduleConfig,scheduledCore,planningCapacityLeftCore,effectiveMinIntervalDaysCore,type ScheduleConfig} from './schedule.ts';
import {allowedDepthCore} from './selector.ts';
import {validateSelectCore,selectFacetsCore,type SelectInput} from './select-facets.ts';
import {FACET_GROUPS,UNIVERSAL_SITUATIONS,type FacetView,type PlanGates,type RegistryRow} from './facets.ts';
import {containsName} from './guards.ts';
import type {ActiveAnchor,ProbeState,ProbeCandidate,TurnContext} from './types.ts';
import {boundedCopy,checkState,checkContext,checkedArray,checkedText,nonnegative,dataObject,ownValue,copyCore,newWork,limitsFor,PROBE_LIMITS,fail,reasonOf,type ProbeWork,type ProbeLimits,type ReasonCode} from './util.ts';
import {foldForMatch} from '../../../../shared/src/common/script-fold.ts';

export interface PlannerConfig {maxCandidatesPerDay:number;candidateTtlMs:number;readyTtlMs:number;schedule:ScheduleConfig;jitterFraction:number}
export const DEFAULT_PLANNER_CONFIG:PlannerConfig=Object.freeze({maxCandidatesPerDay:2,candidateTtlMs:72*3600000,readyTtlMs:2*3600000,jitterFraction:0.15,schedule:Object.freeze({...DEFAULT_SCHEDULE_CONFIG})});
export interface PlanOptions {state:ProbeState;registry:RegistryRow[];facets:FacetView[];gates:PlanGates;seed:string;anchors:ActiveAnchor[];ctx:TurnContext;candidateIds:string[];cfg?:PlannerConfig|null}
export interface PlanResult {candidates:ProbeCandidate[];gaps:string[];resolved:string[];reasonCode:ReasonCode;work:ProbeWork}

/** The research marks a pending candidate may carry; 'none' is an ordinary probe. */
const PENDING_RESEARCH_MARKS = Object.freeze(['none', 'after_negative', 'after_positive', 'both'] as const);

/** Input-dependent budgets apply to this call, never to the complete chat. */
function rowCount(input:PlanOptions):number {
  try {const row=Object.getOwnPropertyDescriptor(input,'registry');if(!row)fail('missing_input');if(!('value'in row))fail('input_access');const registry=row.value;if(!Array.isArray(registry))fail('invalid_input');const d=Object.getOwnPropertyDescriptor(registry,'length');if(!d||!('value'in d))fail('input_access');return nonnegative(d.value,PROBE_LIMITS.registry);}catch(e){if(typeof e==='string')throw e;fail('input_access');}
}
export function checkPlannerConfig(cfg:PlannerConfig,nowMs:number,limits:ProbeLimits=limitsFor()):void {
  dataObject(cfg);nonnegative(cfg.maxCandidatesPerDay,PROBE_LIMITS.candidateIds);if(!Number.isInteger(cfg.maxCandidatesPerDay))fail('invalid_input');
  nonnegative(cfg.candidateTtlMs,PROBE_LIMITS.delayMs);nonnegative(cfg.readyTtlMs,PROBE_LIMITS.delayMs);
  if(nowMs+cfg.candidateTtlMs>PROBE_LIMITS.timeMs)fail('input_limit');
  nonnegative(cfg.jitterFraction,1);checkScheduleConfig(cfg.schedule,limits);
}

/** O(A*H*L), H<=8, A<=max(64,R), L<=500. Live labels are folded once per call. */
function anchorIndex(anchors:ActiveAnchor[],now:number,work:ProbeWork):{raw:string;folded:string}[] {
  const out=[];for(const a of anchors){work.steps++;if(a.validUntilMs&&a.validUntilMs<=now)continue;work.units+=a.label.length;out.push({raw:a.label,folded:foldForMatch(a.label)});}return out;
}
function attachAnchor(hints:string[],anchors:{raw:string;folded:string}[],work:ProbeWork):string|null {
  const tokens:string[]=[];for(const hint of hints){work.steps++;work.units+=hint.length;tokens.push(...(foldForMatch(hint).match(/[\u4e00-\u9fa5]{2,}|[a-zA-Z]+/g)??[]));}
  for(const a of anchors)for(const token of tokens){work.steps++;work.comparisons++;work.units+=a.folded.length;if(a.folded.includes(token))return a.raw;}return null;
}
function commit(target:ProbeState,owned:ProbeState,work:ProbeWork):void {
  const fields=['pending','readyScores','lastGaps','lastPlanDayKey','viewWarnings'] as const;
  try {for(const field of fields){const d=Object.getOwnPropertyDescriptor(target,field);if(!d||!('value'in d)||!d.writable)fail('input_access');}const output=Object.fromEntries(fields.map(field=>{work.steps++;return [field,copyCore(owned[field],work)];}));for(const field of fields)Object.defineProperty(target,field,{value:output[field]});}catch{fail('input_access');}
}

/** O(N + R log R + A*H*L); one snapshot, trusted cores, then five-field commit.
 * No callback is invoked. All external descriptors, including Proxy traps, are guarded.
 */
export function plan(input:PlanOptions):PlanResult {
  const work=newWork();
  try {
    dataObject(input);const limits=limitsFor(rowCount(input));const x=boundedCopy(input,work,limits,true);dataObject(x);
    for(const key of ['state','registry','facets','gates','seed','anchors','ctx','candidateIds'] as const)if(x[key]===undefined)fail('missing_input');
    checkContext(x.ctx);checkState(x.state,work,limits);checkedText(x.seed,PROBE_LIMITS.key);
    // A pending candidate without a research mark counts as an ordinary probe. A mark that is
    // present must be one of the four known values: anything else would be counted against the
    // weekly research ceiling without meaning anything, so the whole call is refused.
    for (const candidate of x.state.pending) {
      work.steps++;
      if (candidate.research !== undefined && !containsName(PENDING_RESEARCH_MARKS, candidate.research)) {
        fail('invalid_input');
      }
    }
    const cfg=x.cfg??{...DEFAULT_PLANNER_CONFIG,schedule:{...DEFAULT_SCHEDULE_CONFIG,forms:Math.min(DEFAULT_SCHEDULE_CONFIG.forms,limits.forms)}};checkPlannerConfig(cfg,x.ctx.nowMs,limits);
    for(const a of checkedArray(x.anchors,limits.list)){work.steps++;dataObject(a);checkedText(a.anchorId,PROBE_LIMITS.key);checkedText(a.kind,PROBE_LIMITS.key);checkedText(a.label,PROBE_LIMITS.quote);if(a.validUntilMs!=null)nonnegative(a.validUntilMs);}
    const ids=new Set<string>(),pendingIds=new Set(x.state.pending.map(c=>{work.steps++;return c.candidateId;}));
    for(const id of checkedArray(x.candidateIds,PROBE_LIMITS.candidateIds)){work.steps++;checkedText(id,PROBE_LIMITS.key);if(!id||ids.has(id)||pendingIds.has(id))fail('invalid_ids');ids.add(id);}
    const depths:SelectInput['allowedDepth']={};for(const group of FACET_GROUPS){work.steps++;depths[group]=allowedDepthCore(group,x.state,work);}
    const selection:SelectInput={registry:x.registry,facets:x.facets,gates:x.gates,today:x.ctx.dayKey,capacity:1,pendingResearch:0,groupLastCoveredMs:x.state.coverage,allowedDepth:depths,blocked:[]};
    const validated=validateSelectCore(selection,work);if(!validated.ok)fail(validated.reason);const sel=validated.value;
    const state=x.state,now=x.ctx.nowMs;
    if(!x.gates.learningEnabled){state.pending=[];commit(input.state,state,work);return {candidates:[],gaps:[],resolved:[],reasonCode:null,work};}
    if(x.gates.distressWindow || x.gates.situations.some(s=>{work.steps++;return containsName(UNIVERSAL_SITUATIONS,s);}) || (x.ctx.archetypes??[]).includes('distress_moment'))return {candidates:[],gaps:[],resolved:[],reasonCode:null,work};
    state.pending=state.pending.filter(c=>{work.steps++;return c.validUntilMs>now;});state.readyScores=state.readyScores.filter(r=>{work.steps++;return now-r.scoredAtMs<=cfg.readyTtlMs;});
    const capacity=Math.min(cfg.maxCandidatesPerDay-state.pending.length,planningCapacityLeftCore(state,x.ctx,cfg.schedule,work));
    const pending=new Set(state.pending.map(c=>{work.steps++;return c.facetId;})),views=new Map(sel.facets.map(v=>{work.steps++;return [v.facetId,v] as const;}));
    for(const row of sel.registry){work.steps++;const st=ownValue(state.items,row.facetId),view=views.get(row.facetId);
      if(pending.has(row.facetId) || (st?.nextPrescoreAtMs??0)>now || (st?.cooldownUntilMs??0)>now || !scheduledCore(row,x.ctx,state,cfg.schedule,view?.band==='unknown',work) || (st?.lastDeliveredAtMs && now-st.lastDeliveredAtMs<effectiveMinIntervalDaysCore(row.facetId,row.minGapDays,x.seed,work,cfg.jitterFraction)*86400000))sel.blocked.push(row.facetId);
    }
    sel.capacity=Math.ceil(Math.max(1,capacity));sel.pendingResearch=state.pending.filter(c=>{work.steps++;return c.research!==undefined && c.research!=='none';}).length;
    const result=selectFacetsCore(sel,work);const lateReasons=new Set(['capacity','group_taken','research_ceiling']);const closed=new Set(result.rejected.filter(r=>{work.steps++;return !lateReasons.has(r.reason);}).map(r=>{work.steps++;return r.facetId;}));
    const gaps=sel.registry.filter(r=>{work.steps++;return !closed.has(r.facetId);}).map(r=>{work.steps++;return r.facetId;}).sort((a,b)=>{work.comparisons++;return a<b?-1:a>b?1:0;});const gapSet=new Set(gaps),resolved=state.lastGaps.filter(k=>{work.steps++;return !gapSet.has(k);});
    for(const reject of result.rejected){work.steps++;if(reject.reason==='missing_view'){if(!views.has(reject.facetId))state.viewWarnings.missingView++;else{const view=views.get(reject.facetId)!;if(view.band==null)state.viewWarnings.missingBand++;else state.viewWarnings.missingCounts++;}}else if(['declined','cooling','review'].includes(reject.reason)){const v=views.get(reject.facetId)!;if(v.declined===undefined||v.coolingEndsDay===undefined||v.review===undefined)state.viewWarnings.missingGate++;}}
    state.lastGaps=gaps;
    const chosen=capacity>0?result.candidates:[];if(x.candidateIds.length<chosen.length)fail('invalid_ids');
    const rows=new Map(sel.registry.map(r=>{work.steps++;return [r.facetId,r] as const;})),anchors=anchorIndex(x.anchors,now,work);
    const candidates:ProbeCandidate[]=chosen.map((c,i)=>{work.steps++;const row=rows.get(c.facetId)!;return {...c,candidateId:x.candidateIds[i],forbids:[...row.forbids],preferredArchetypes:[...row.contextArchetypes],contextAnchor:attachAnchor(row.approachHints,anchors,work),wordingConstraints:{bans:[...WORDING_BANS],maxChars:40},validUntilMs:now+cfg.candidateTtlMs,createdAtMs:now};});
    state.pending.push(...copyCore(candidates,work));if(capacity>0)state.lastPlanDayKey=x.ctx.dayKey;commit(input.state,state,work);
    return {candidates,gaps:[...gaps],resolved,reasonCode:null,work};
  }catch(error){return {candidates:[],gaps:[],resolved:[],reasonCode:reasonOf(error),work};}
}
