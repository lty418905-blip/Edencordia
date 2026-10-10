import {failure,newWork,type InputFailure} from './util.ts';
import type { DayKey } from './facets.ts';

/** Length of each month in a common year. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Day count before the first day of each month in a common year. */
const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334] as const;

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Gregorian leap rule, by integer arithmetic only. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** True for strings of exactly the form YYYY-MM-DD with a real calendar day, year 0001 to 9999. */
export function isDayKey(value: unknown): value is DayKey {
  if (typeof value !== 'string') return false;
  const match = DAY_KEY_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day >= 1 && day <= maxDay;
}

/**
 * Number of whole days since 0001-01-01 (which is 0), by pure integer arithmetic.
 * Never throws; returns NaN exactly for invalid keys.
 */
export function dayNumberCore(key: DayKey): number {
  if (!isDayKey(key)) return NaN;
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const day = Number(key.slice(8, 10));
  const priorYears = year - 1;
  const priorLeaps = Math.floor(priorYears / 4) - Math.floor(priorYears / 100) + Math.floor(priorYears / 400);
  let days = priorYears * 365 + priorLeaps + DAYS_BEFORE_MONTH[month - 1] + (day - 1);
  if (month > 2 && isLeapYear(year)) days += 1;
  return days;
}

/** Day count from `from` to `to`; NaN if either key is invalid. */
export function daysBetweenCore(from: DayKey, to: DayKey): number {
  return dayNumberCore(to) - dayNumberCore(from);
}

/** True only when both arguments are valid keys and `day` is on or after `limit` (code-unit string order). */
export function dayOnOrAfter(day: DayKey, limit: DayKey): boolean {
  return isDayKey(day) && isDayKey(limit) && day >= limit;
}

/** Public date arithmetic reports an invalid context instead of leaking NaN. */
export function dayNumber(key:DayKey):number|InputFailure<null>{return isDayKey(key)?dayNumberCore(key):failure(null,'invalid_context',newWork());}
export function daysBetween(from:DayKey,to:DayKey):number|InputFailure<null>{return isDayKey(from)&&isDayKey(to)?daysBetweenCore(from,to):failure(null,'invalid_context',newWork());}
