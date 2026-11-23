/** Time-zone helpers. All schedule math runs in Home Assistant's time zone, not the browser's. */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Monday ... 6 = Sunday */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
export const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function zonedParts(d: Date, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(d)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday] ?? 0,
  };
}

function tzOffsetMs(d: Date, tz: string): number {
  const p = zonedParts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** Wall-clock time in `tz` -> absolute Date. */
export function zonedToDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = tzOffsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

export interface DayKey {
  year: number;
  month: number;
  day: number;
}

export function addDays(k: DayKey, n: number): DayKey & { weekday: number } {
  const d = new Date(Date.UTC(k.year, k.month - 1, k.day + n));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: (d.getUTCDay() + 6) % 7,
  };
}

/** Convert a list of seconds-of-day on a given local day into Dates (DST-safe). */
export function dayTimes(k: DayKey, secs: number[], tz: string): Date[] {
  const start = zonedToDate(k.year, k.month, k.day, 0, 0, 0, tz);
  const startOff = tzOffsetMs(start, tz);
  const end = new Date(start.getTime() + 86400_000);
  const sameOffset = tzOffsetMs(end, tz) === startOff;
  return secs.map((s) => {
    if (sameOffset) return new Date(start.getTime() + s * 1000);
    // Date.UTC handles overflow, so seconds outside 0..86399 (from offsets) roll into neighbouring days.
    return zonedToDate(k.year, k.month, k.day, 0, 0, s, tz);
  });
}

/** "07:30", "07:30:15" -> seconds of day. */
export function parseTimeOfDay(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3] ?? 0);
  if (h > 23 || mi > 59 || s > 59) return null;
  return h * 3600 + mi * 60 + s;
}

/** HA duration/offset: "-01:30:00", "00:30", 90, {minutes: 30} -> seconds. */
export function parseDuration(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^[+-]?\d+(\.\d+)?$/.test(s)) return Number(s);
    const neg = s.startsWith("-");
    const body = s.replace(/^[+-]/, "");
    const parts = body.split(":").map(Number);
    if (parts.some((n) => Number.isNaN(n))) return 0;
    let secs = 0;
    if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) secs = parts[0] * 3600 + parts[1] * 60;
    else secs = parts[0];
    return neg ? -secs : secs;
  }
  if (typeof v === "object") {
    const o = v as Record<string, number>;
    return (
      (o.days ?? 0) * 86400 +
      (o.hours ?? 0) * 3600 +
      (o.minutes ?? 0) * 60 +
      (o.seconds ?? 0) +
      (o.milliseconds ?? 0) / 1000
    );
  }
  return 0;
}

export function formatDuration(secs: number): string {
  const sign = secs < 0 ? "-" : "+";
  const a = Math.abs(Math.round(secs));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  if (h && m) return `${sign}${h}h ${m}m`;
  if (h) return `${sign}${h}h`;
  if (m) return `${sign}${m} min`;
  return `${sign}${a}s`;
}

export function formatClock(secs: number, hour12 = false): string {
  const norm = ((Math.round(secs) % 86400) + 86400) % 86400;
  const h = Math.floor(norm / 3600);
  const m = Math.floor((norm % 3600) / 60);
  const mm = String(m).padStart(2, "0");
  if (hour12) return `${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
  const sec = norm % 60;
  return `${String(h).padStart(2, "0")}:${mm}${sec ? ":" + String(sec).padStart(2, "0") : ""}`;
}
