/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week) evaluated in an IANA time
 * zone, with the robfig/cron semantics Linksyncx uses: `*`, `?`, lists, ranges, steps (`a/n` = `a-max/n`),
 * month and weekday names, 7 = Sunday, and day-of-month OR day-of-week when both are restricted.
 * The @yearly/@monthly/@weekly/@daily/@midnight/@hourly shorthands are accepted too.
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

interface CronField {
  values: number[];
  set: Set<number>;
  /** `*` / `?` (step 1): the field does not restrict the day match. */
  star: boolean;
}

export interface CronSpec {
  source: string;
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

const DESCRIPTORS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseValue(text: string, names: string[] | null, offset: number, what: string): number {
  if (/^\d{1,2}$/.test(text)) return Number.parseInt(text, 10);
  const idx = names ? names.indexOf(text.toLowerCase()) : -1;
  if (idx >= 0) return idx + offset;
  throw new CronError(`Invalid ${what} value "${text}"`);
}

function parseField(text: string, min: number, max: number, what: string, names: string[] | null = null, nameOffset = 0): CronField {
  if (!text) throw new CronError(`Missing ${what} field`);
  const set = new Set<number>();
  let star = false;
  for (const part of text.split(",")) {
    const pieces = part.split("/");
    if (pieces.length > 2 || !pieces[0]) throw new CronError(`Invalid ${what} field "${text}"`);
    const [range, stepText] = pieces as [string, string | undefined];
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,3}$/.test(stepText)) throw new CronError(`Invalid ${what} step "${stepText}"`);
      step = Number.parseInt(stepText, 10);
      if (step < 1 || step > max - min + 1) throw new CronError(`Invalid ${what} step "${stepText}"`);
    }
    let lo: number;
    let hi: number;
    if (range === "*" || range === "?") {
      lo = min;
      hi = max;
      if (step === 1) star = true;
    } else if (range.includes("-")) {
      const bounds = range.split("-");
      if (bounds.length !== 2) throw new CronError(`Invalid ${what} range "${range}"`);
      lo = parseValue(bounds[0]!, names, nameOffset, what);
      hi = parseValue(bounds[1]!, names, nameOffset, what);
    } else {
      lo = parseValue(range, names, nameOffset, what);
      hi = stepText !== undefined ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) throw new CronError(`${what} value out of range (${min}-${max}): "${part}"`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { values: [...set].sort((a, b) => a - b), set, star };
}

/** Throws CronError with a readable reason when `expr` is not a valid expression. */
export function parseCron(expr: string): CronSpec {
  const source = expr.trim().replace(/\s+/g, " ");
  const expanded = DESCRIPTORS[source.toLowerCase()] ?? source;
  if (expanded.startsWith("@")) throw new CronError(`Unknown shorthand "${source}"`);
  const fields = expanded.split(" ");
  if (fields.length !== 5) throw new CronError("Expected 5 fields: minute hour day-of-month month day-of-week");
  const dowRaw = parseField(fields[4]!, 0, 7, "day-of-week", DAYS, 0);
  // 7 is Sunday too.
  const dowSet = new Set([...dowRaw.set].map((d) => (d === 7 ? 0 : d)));
  return {
    source,
    minute: parseField(fields[0]!, 0, 59, "minute"),
    hour: parseField(fields[1]!, 0, 23, "hour"),
    dom: parseField(fields[2]!, 1, 31, "day-of-month"),
    month: parseField(fields[3]!, 1, 12, "month", MONTHS, 1),
    dow: { values: [...dowSet].sort((a, b) => a - b), set: dowSet, star: dowRaw.star },
  };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    if (formatters.size > 64) formatters.clear();
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in `timeZone`. */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number.parseInt(p.value, 10);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour === 24 ? 0 : out.hour!,
    minute: out.minute!,
    second: out.second!,
  };
}

/** YYYY-MM-DD of an instant in `timeZone`. */
export function zonedDate(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The instant a wall-clock minute in `timeZone` names; null when it does not exist (DST gap). */
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number | null {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (ms: number) => {
    const p = zonedParts(ms, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  const p = zonedParts(t, timeZone);
  if (p.year !== year || p.month !== month || p.day !== day || p.hour !== hour || p.minute !== minute) return null;
  return t;
}

function dayMatches(spec: CronSpec, dayOfMonth: number, weekday: number): boolean {
  const domMatch = spec.dom.set.has(dayOfMonth);
  const dowMatch = spec.dow.set.has(weekday);
  if (spec.dom.star || spec.dow.star) return domMatch && dowMatch;
  return domMatch || dowMatch;
}

const DAY_MS = 86_400_000;
/** Far enough for any satisfiable expression (Feb 29 on a given weekday recurs within 28 years). */
const MAX_SCAN_DAYS = 366 * 29;

/** First fire time strictly after `after`, evaluated in `timeZone`; null when the expression never fires. */
export function nextCronRun(spec: CronSpec, after: Date, timeZone: string): Date | null {
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const first = zonedParts(start, timeZone);
  const firstWall = first.hour * 60 + first.minute;
  let cursor = Date.UTC(first.year, first.month - 1, first.day);
  for (let i = 0; i < MAX_SCAN_DAYS; i++, cursor += DAY_MS) {
    const day = new Date(cursor);
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const dom = day.getUTCDate();
    if (!spec.month.set.has(month) || !dayMatches(spec, dom, day.getUTCDay())) continue;
    for (const hour of spec.hour.values) {
      for (const minute of spec.minute.values) {
        if (i === 0 && hour * 60 + minute < firstWall) continue;
        const t = zonedToUtc(year, month, dom, hour, minute, timeZone);
        if (t !== null && t >= start) return new Date(t);
      }
    }
  }
  return null;
}
