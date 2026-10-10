import { CONTENT_FAMILIES, UNDERSTANDING_BANDS } from './facets.ts';
import { isDayKey } from './day-keys.ts';
import type {ProbeWork} from './util.ts';
/**
 * Guards shared by the probe modules. Pure functions only; they never throw,
 * not even for proxies whose traps throw.
 */

/**
 * True only for a non-null, non-array object with the Object.prototype or null
 * prototype whose own properties, string keys and symbol keys alike, are all
 * data properties (never accessors). A Proxy may throw from any trap: caught.
 */
export function isPlainData(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    const names = Object.getOwnPropertyNames(value);
    for (let index = 0; index < names.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, names[index] as string);
      if (descriptor === undefined) return false;
      if ('get' in descriptor || 'set' in descriptor) return false;
    }
    const symbols = Object.getOwnPropertySymbols(value);
    for (let index = 0; index < symbols.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, symbols[index] as symbol);
      if (descriptor === undefined) return false;
      if ('get' in descriptor || 'set' in descriptor) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** True only for a number that is an integer and not negative. */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Fixed per-value limits; each limit applies to one call's projection. */
export const DATA_LIMITS = Object.freeze({key:128,quote:500,situations:32,neighbours:16,hints:8,sources:16,prerequisites:8,archetypes:16});
/** Own-index array projection, O(length); length is checked before descriptors. */
export function ownArrayData(value:unknown,limit:number,work?:ProbeWork):{ok:true;values:unknown[]}|{ok:false;reason:'invalid_input'|'input_limit'}{
  try{
    if(!Array.isArray(value))return {ok:false,reason:'invalid_input'};
    const d=Object.getOwnPropertyDescriptor(value,'length');
    if(!d||!('value' in d)||!isNonNegativeInteger(d.value))return {ok:false,reason:'invalid_input'};
    if(d.value>limit)return {ok:false,reason:'input_limit'};
    for(const key of Reflect.ownKeys(value)){if(work)work.steps++;const member=Object.getOwnPropertyDescriptor(value,key);if(!member||!('value' in member))return {ok:false,reason:'invalid_input'};}
    const values:unknown[]=[];
    for(let i=0;i<d.value;i++){if(work)work.steps++;const member=Object.getOwnPropertyDescriptor(value,String(i));values.push(member?.value);}
    return {ok:true,values};
  }catch{return {ok:false,reason:'invalid_input'};}
}
export function containsName(list: readonly string[], value: unknown): boolean {
  for(let i=0;i<list.length;i++)if(list[i]===value)return true;
  return false;
}
export function hasExactlyNames(value: object, names: readonly string[]): boolean {
  try { const keys=Object.getOwnPropertyNames(value);return keys.length===names.length && names.every(k=>Object.hasOwn(value,k)); }catch{return false;}
}
/** Shared closed lists. Missing members are admitted by selection validation and closed by the facet gate. */
export function viewMemberValid(key: string, value: unknown, missingAllowed: boolean): boolean {
  try {
    if(value===undefined)return missingAllowed;
    if(value===null)return true;
    if(key==='band')return containsName(UNDERSTANDING_BANDS,value);
    if(key==='declined')return typeof value==='boolean';
    if(key==='coolingEndsDay')return isDayKey(value);
    if(key==='distinctLocalDays'||key==='spontaneousCount')return isNonNegativeInteger(value);
    if(key==='familiesPresent'){
      if(!Array.isArray(value)||value.length>CONTENT_FAMILIES.length)return false;
      const seen=new Set();for(let i=0;i<value.length;i++){const v=value[i];if(!containsName(CONTENT_FAMILIES,v)||seen.has(v))return false;seen.add(v);}return true;
    }
    if(!isPlainData(value))return false;
    if(key==='nextStep')return ['localDays','families','spontaneous'].every(k=>value[k]===undefined?missingAllowed:isNonNegativeInteger(value[k]));
    if(key==='review'){
      for(const k of ['negative','positive']){
        const side=value[k];if(side===undefined){if(!missingAllowed)return false;continue;}if(side===null)continue;
        if(!isPlainData(side)||(side.quietEndsDay===undefined?!missingAllowed:!isDayKey(side.quietEndsDay)))return false;
      }
      return value.lastResearchProbeDay===undefined?missingAllowed:value.lastResearchProbeDay===null||isDayKey(value.lastResearchProbeDay);
    }
    return false;
  }catch{return false;}
}
