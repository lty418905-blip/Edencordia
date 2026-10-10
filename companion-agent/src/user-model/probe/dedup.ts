/**
 * 句式指紋去重：同一面向，30 天內避免高度相似的措辭/切入角度。
 * O(E + H×L); matching E per facet is bounded by ten；E、H、L 由集中投影預算約束，保留原文。
 */
import type { FingerprintEntry } from './types.ts';
import { boundedCopy, copyCore, checkedText, nonnegative, PROBE_LIMITS, newWork, reasonOf, fail, simhash64Core, simhashSimilarityCore, checkedArray, dataObject, limitsFor, type ProbeLimits, type ReasonCode, type ProbeWork } from './util.ts';
const WINDOW_MS = 30 * 86400000;
const MAX_SIMILARITY = 0.5;
const KEEP_PER_ITEM = PROBE_LIMITS.perItem;

function checkedEntries(entries:FingerprintEntry[],work:ProbeWork,limits:ProbeLimits): FingerprintEntry[] {
  const copy=checkedArray(entries,limits.fingerprints);
  for(const e of copy) {work.nodes++;dataObject(e);if(e.hash===undefined||e.facetId===undefined||e.atMs===undefined)fail('missing_input');if (typeof e.hash!=='string' || !/^[0-9a-f]{16}$/i.test(e.hash) || typeof e.facetId!=='string' || typeof e.atMs!=='number') fail('invalid_input');}
  return copy;
}
export function recordWording(entries:FingerprintEntry[],facetId:string,wording:string,atMs:number,rowCount:number=PROBE_LIMITS.registry): {reasonCode:ReasonCode;work:ProbeWork} {
  const work=newWork();
  try {
    const limits=limitsFor(rowCount);const x=boundedCopy({fingerprints:entries,facetId,wording,atMs},work,limits);
    checkedText(x.facetId,PROBE_LIMITS.key);nonnegative(x.atMs);checkedText(x.wording,PROBE_LIMITS.text);
    const copy=checkedEntries(x.fingerprints,work,limits);
    const hash={hash:simhash64Core(x.wording,work)};
    copy.push({hash:hash.hash!,facetId,atMs});
    const ofItem=copy.filter(e=>{work.steps++;return e.facetId===facetId;});
    if (ofItem.length>KEEP_PER_ITEM) {
      const stale=new Set(ofItem.slice(0,ofItem.length-KEEP_PER_ITEM).map(e=>e.hash));
      for(let i=copy.length-1;i>=0;i--) if(stale.has(copy[i].hash)) copy.splice(i,1);
    }
    if (copy.length>limits.fingerprints) fail('input_limit');
    try {for (const key of Object.keys(entries).concat('length')) {
      const d=Object.getOwnPropertyDescriptor(entries,key);
      if (!d || !('value' in d) || !d.writable || (key!=='length' && !d.configurable)) fail('input_access');
    }
    if (!Object.isExtensible(entries)) fail('input_access');
    Array.prototype.splice.call(entries,0,entries.length,...copyCore(copy,work));
    }catch{fail('input_access');}
    return {reasonCode:null,work};
  } catch(error) {return {reasonCode:reasonOf(error),work};}
}
export function pickApproach(entries:FingerprintEntry[],facetId:string,hints:string[],startIndex:number,nowMs:number,rowCount:number=PROBE_LIMITS.registry): {hint:string;nextIndex:number;reasonCode:ReasonCode;work:ProbeWork} {
  const work=newWork();
  try {
    const limits=limitsFor(rowCount);const x=boundedCopy({fingerprints:entries,facetId,hints,startIndex,nowMs},work,limits);
    checkedText(x.facetId,PROBE_LIMITS.key);nonnegative(x.startIndex);nonnegative(x.nowMs);
    if (!Number.isInteger(startIndex)) fail('invalid_input');
    const copy=checkedEntries(x.fingerprints,work,limits), list=checkedArray(x.hints);
    let sameFacet=0;for(const e of copy){work.steps++;if(e.facetId===x.facetId && ++sameFacet>PROBE_LIMITS.perItem)fail('input_limit');}
    for(const h of list)checkedText(h,PROBE_LIMITS.quote);
    if(list.length===0)return {hint:'',nextIndex:0,reasonCode:null,work};
    const recent=copy.filter(e=>{work.steps++;return e.facetId===facetId && nowMs-e.atMs<=WINDOW_MS;});
    for(let i=0;i<list.length;i++){
      const idx=(startIndex % list.length+i) % list.length;
      const hash={hash:simhash64Core(list[idx],work)};
      const clash=recent.some(r=>{return simhashSimilarityCore(hash.hash!,r.hash,work)>MAX_SIMILARITY;});
      if(!clash)return {hint:list[idx],nextIndex:(idx+1)%list.length,reasonCode:null,work};
    }
    const idx=startIndex % list.length;
    return {hint:list[idx],nextIndex:(idx+1)%list.length,reasonCode:null,work};
  } catch(error) {return {hint:'',nextIndex:0,reasonCode:reasonOf(error),work};}
}
