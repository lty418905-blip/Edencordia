import type {FacetGroup} from './facets.ts';
import type {ProbeState} from './types.ts';
import {boundedCopy,checkedText,checkState,ownValue,newWork,failure,PROBE_LIMITS,limitsFor,type InputFailure,type ProbeWork} from './util.ts';
/** Depth is unlocked by answers in this group; deliveries alone do not unlock it. */
export function allowedDepthCore(group:FacetGroup,state:ProbeState,work:ProbeWork=newWork()):1|2|3{work.steps++;return (ownValue(state.groupStats,group)?.answered??0)>=2?3:2;}
/** O(N) own-data snapshot; failure closes the depth gate. */
export function allowedDepth(group:FacetGroup,state:ProbeState,rowCount:number=PROBE_LIMITS.registry):number|InputFailure<number>{const work=newWork();try{const limits=limitsFor(rowCount);const x=boundedCopy({group,state},work,limits);checkedText(x.group,PROBE_LIMITS.key);checkState(x.state,work,limits);return allowedDepthCore(x.group,x.state,work);}catch(error){return failure(0,error,work);}}
