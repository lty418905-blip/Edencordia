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

/** Day numbers of the first and the last valid key: 0001-01-01 and 9999-12-31. */
const FIRST_DAY_NUMBER = 0;
const LAST_DAY_NUMBER = 3652058;

/** Lengths in days of the Gregorian cycles of 400, 100, 4 and 1 years. */
const DAYS_PER_400_YEARS = 146097;
const DAYS_PER_100_YEARS = 36524;
const DAYS_PER_4_YEARS = 1461;
const DAYS_PER_YEAR = 365;

/** Largest number of days addDaysCore accepts: one hundred years of 365 days. */
export const ADD_DAYS_MAX = 36500;

/** Decimal text of a non-negative integer, padded with zeros on the left to the given width. */
function zeroPadded(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Day key of a day number, the inverse of dayNumberCore, by pure integer arithmetic.
 * Returns null unless the number is an integer from 0 (0001-01-01) to 3,652,058 (9999-12-31).
 */
function dayKeyOfNumberCore(dayNumber: number): DayKey | null {
  if (!Number.isInteger(dayNumber)) return null;
  if (dayNumber < FIRST_DAY_NUMBER || dayNumber > LAST_DAY_NUMBER) return null;

  let remaining = dayNumber;
  const cycles400 = Math.floor(remaining / DAYS_PER_400_YEARS);
  remaining -= cycles400 * DAYS_PER_400_YEARS;

  // The last day of a 400-year cycle is the leap day of its fourth century: it belongs to
  // century 3, not to a fifth century. The same holds for the last day of a 4-year cycle.
  const centuries = Math.min(3, Math.floor(remaining / DAYS_PER_100_YEARS));
  remaining -= centuries * DAYS_PER_100_YEARS;

  const cycles4 = Math.floor(remaining / DAYS_PER_4_YEARS);
  remaining -= cycles4 * DAYS_PER_4_YEARS;

  const years = Math.min(3, Math.floor(remaining / DAYS_PER_YEAR));
  remaining -= years * DAYS_PER_YEAR;

  const year = cycles400 * 400 + centuries * 100 + cycles4 * 4 + years + 1;
  const leap = isLeapYear(year);

  let month = 1;
  for (; month < 12; month++) {
    const monthLength = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
    if (remaining < monthLength) break;
    remaining -= monthLength;
  }

  return `${zeroPadded(year, 4)}-${zeroPadded(month, 2)}-${zeroPadded(remaining + 1, 2)}`;
}

/**
 * The day key that lies `days` days after `key`. `days` is an integer from 0 to 36,500.
 * Never throws. Returns null when the key is not a valid day key, when `days` is outside its
 * range, or when the result would lie after 9999-12-31.
 * For every valid pair, daysBetweenCore(key, addDaysCore(key, days)) equals days.
 */
export function addDaysCore(key: DayKey, days: number): DayKey | null {
  if (!isDayKey(key)) return null;
  if (typeof days !== 'number' || !Number.isInteger(days)) return null;
  if (days < 0 || days > ADD_DAYS_MAX) return null;
  return dayKeyOfNumberCore(dayNumberCore(key) + days);
}

/**
 * Public form of addDaysCore: the day key `days` days after `key`, or a failure with the reason
 * 'invalid_context' and the value null in every case in which addDaysCore returns null.
 */
export function addDays(key: DayKey, days: number): DayKey | InputFailure<null> {
  const result = addDaysCore(key, days);
  if (result === null) return failure(null, 'invalid_context', newWork());
  return result;
}
