/** Schedule prediction: when will automations act on the entity, and what state should it be in at a given moment. */
import type { HomeAssistant } from "./types";
import {
  asArray,
  describeCondition,
  normalizeCondition,
  type Effect,
  type EntityAction,
  type ParsedAutomation,
  type ParsedTrigger,
} from "./automation";
import { sunTimes } from "./sun";
import {
  WEEKDAY_KEYS,
  addDays,
  dayTimes,
  parseDuration,
  parseTimeOfDay,
  zonedParts,
  zonedToDate,
  type DayKey,
} from "./time";

export interface PredictContext {
  hass: HomeAssistant;
  tz: string;
  lat: number;
  lon: number;
  /** Results of conditions tested by Home Assistant right now, keyed by the raw condition object/string. */
  live: Map<unknown, boolean | null>;
}

export interface CondEval {
  description: string;
  result: boolean | null;
  /** How we know: evaluated for that time, current live state, from the trigger, or a group of conditions. */
  basis: "time" | "now" | "trigger" | "group";
  children?: CondEval[];
}

export interface Occurrence {
  time: Date;
  automation: ParsedAutomation;
  trigger: ParsedTrigger;
}

export interface PlanEvent extends Occurrence {
  status: "pass" | "fail" | "unknown";
  effect: Effect | null;
  action?: EntityAction;
  conditions: CondEval[];
  blockedBy?: CondEval;
}

/* ------------------------------------------------------------------ */
/* Condition evaluation                                                 */
/* ------------------------------------------------------------------ */

type TimeSpec = { secs: number } | { date: Date } | null;

function resolveTimeSpec(v: unknown, ctx: PredictContext): TimeSpec {
  if (v && typeof v === "object" && (v as any).entity_id) {
    const base = resolveTimeSpec((v as any).entity_id, ctx);
    const off = parseDuration((v as any).offset);
    if (!base) return null;
    return "secs" in base ? { secs: base.secs + off } : { date: new Date(base.date.getTime() + off * 1000) };
  }
  if (typeof v !== "string") return null;
  const secs = parseTimeOfDay(v);
  if (secs != null) return { secs };
  const st = ctx.hass.states[v];
  if (!st || st.state === "unknown" || st.state === "unavailable") return null;
  if (v.startsWith("input_datetime.")) {
    const { has_date, has_time } = st.attributes;
    if (has_time && !has_date) {
      const s = parseTimeOfDay(st.state);
      return s == null ? null : { secs: s };
    }
    if (has_date && has_time) {
      const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(st.state);
      if (!m) return null;
      return { date: zonedToDate(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], ctx.tz) };
    }
    return null;
  }
  const t = Date.parse(st.state);
  return Number.isNaN(t) ? null : { date: new Date(t) };
}

function evalTime(c: any, at: Date, ctx: PredictContext): boolean | null {
  const p = zonedParts(at, ctx.tz);
  if (c.weekday && !asArray(c.weekday).includes(WEEKDAY_KEYS[p.weekday])) return false;
  const now = p.hour * 3600 + p.minute * 60 + p.second;
  const after = c.after != null ? resolveTimeSpec(c.after, ctx) : null;
  const before = c.before != null ? resolveTimeSpec(c.before, ctx) : null;
  if ((c.after != null && !after) || (c.before != null && !before)) return null;
  // Full datetimes are compared directly.
  if ((after && "date" in after) || (before && "date" in before)) {
    const okA = !after || ("date" in after ? at >= after.date : now >= after.secs);
    const okB = !before || ("date" in before ? at < before.date : now < before.secs);
    return okA && okB;
  }
  const a = after ? (after as { secs: number }).secs : 0;
  const b = before ? (before as { secs: number }).secs : 86400;
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

function sunOnDay(at: Date, ctx: PredictContext) {
  const p = zonedParts(at, ctx.tz);
  return sunTimes(zonedToDate(p.year, p.month, p.day, 12, 0, 0, ctx.tz), ctx.lat, ctx.lon);
}

function evalSun(c: any, at: Date, ctx: PredictContext): boolean | null {
  const s = sunOnDay(at, ctx);
  const pick = (ev: string) => (ev === "sunrise" ? s.sunrise : s.sunset);
  if (c.after) {
    const t = pick(c.after);
    if (!t) return null;
    if (at.getTime() < t.getTime() + parseDuration(c.after_offset) * 1000) return false;
  }
  if (c.before) {
    const t = pick(c.before);
    if (!t) return null;
    if (at.getTime() >= t.getTime() + parseDuration(c.before_offset) * 1000) return false;
  }
  return true;
}

export function evalCondition(
  raw: any,
  at: Date,
  trig: ParsedTrigger | null,
  ctx: PredictContext,
): CondEval {
  const c = normalizeCondition(raw);
  const description = describeCondition(raw, ctx.hass);
  if (!c || typeof c !== "object") return { description, result: null, basis: "now" };
  if (c.enabled === false) return { description, result: true, basis: "now" };

  switch (c.condition) {
    case "and":
    case "or":
    case "not": {
      const children = asArray(c.conditions).map((x) => evalCondition(x, at, trig, ctx));
      const rs = children.map((x) => x.result);
      let result: boolean | null;
      if (c.condition === "and") result = rs.includes(false) ? false : rs.includes(null) ? null : true;
      else if (c.condition === "or") result = rs.includes(true) ? true : rs.includes(null) ? null : false;
      else result = rs.includes(true) ? false : rs.includes(null) ? null : true;
      return { description, result, basis: "group", children };
    }
    case "time":
      return { description, result: evalTime(c, at, ctx), basis: "time" };
    case "sun":
      return { description, result: evalSun(c, at, ctx), basis: "time" };
    case "trigger":
      return {
        description,
        result: trig ? asArray(c.id).map(String).includes(trig.id) : null,
        basis: "trigger",
      };
    default:
      return { description, result: ctx.live.has(raw) ? ctx.live.get(raw)! : null, basis: "now" };
  }
}

/* ------------------------------------------------------------------ */
/* Trigger occurrences                                                  */
/* ------------------------------------------------------------------ */

function patternMatcher(spec: unknown): (v: number) => boolean {
  if (spec == null) return () => true;
  const s = String(spec).trim();
  if (s === "*") return () => true;
  if (s.startsWith("/")) {
    const n = Number(s.slice(1));
    return n > 0 ? (v) => v % n === 0 : () => false;
  }
  const n = Number(s);
  return (v) => v === n;
}

function timePatternSeconds(t: any): number[] {
  const hours = t.hours;
  const minutes = t.minutes ?? (hours != null ? 0 : undefined);
  const seconds = t.seconds ?? (minutes != null ? 0 : undefined);
  const mh = patternMatcher(hours);
  const mm = patternMatcher(minutes);
  const ms = patternMatcher(seconds);
  const out: number[] = [];
  for (let h = 0; h < 24; h++) {
    if (!mh(h)) continue;
    for (let m = 0; m < 60; m++) {
      if (!mm(m)) continue;
      for (let s = 0; s < 60; s++) if (ms(s)) out.push(h * 3600 + m * 60 + s);
    }
  }
  return out;
}

function sameDay(d: Date, k: DayKey, tz: string): boolean {
  const p = zonedParts(d, tz);
  return p.year === k.year && p.month === k.month && p.day === k.day;
}

export function triggerTimesOnDay(
  trig: ParsedTrigger,
  k: DayKey & { weekday: number },
  ctx: PredictContext,
): Date[] {
  const t = trig.raw;
  switch (trig.kind) {
    case "time": {
      if (t.weekday && !asArray(t.weekday).includes(WEEKDAY_KEYS[k.weekday])) return [];
      const out: Date[] = [];
      for (const v of asArray(t.at)) {
        const r = resolveTimeSpec(v, ctx);
        if (!r) continue;
        if ("secs" in r) out.push(...dayTimes(k, [r.secs], ctx.tz));
        else if (sameDay(r.date, k, ctx.tz)) out.push(r.date);
      }
      return out;
    }
    case "sun": {
      const s = sunTimes(zonedToDate(k.year, k.month, k.day, 12, 0, 0, ctx.tz), ctx.lat, ctx.lon);
      const ev = t.event === "sunrise" ? s.sunrise : s.sunset;
      return ev ? [new Date(ev.getTime() + parseDuration(t.offset) * 1000)] : [];
    }
    case "time_pattern":
      return dayTimes(k, timePatternSeconds(t), ctx.tz);
    default:
      return [];
  }
}

/**
 * All scheduled trigger times between `from` and `to`.
 * Time patterns can fire very often, so they are only expanded for one day next to `anchor`
 * (the end of the range when looking back, the start when looking ahead).
 */
export function occurrences(
  autos: ParsedAutomation[],
  from: Date,
  to: Date,
  ctx: PredictContext,
  anchor: "from" | "to" = "from",
): Occurrence[] {
  const out: Occurrence[] = [];
  for (const a of autos) {
    if (!a.enabled || !a.actions.length) continue;
    for (const trig of a.triggers) {
      if (trig.kind === "other") continue;
      let f = from;
      let t = to;
      if (trig.kind === "time_pattern") {
        if (anchor === "to") f = new Date(Math.max(from.getTime(), to.getTime() - 86400_000));
        else t = new Date(Math.min(to.getTime(), from.getTime() + 86400_000));
      }
      const start = zonedParts(f, ctx.tz);
      const days = Math.ceil((t.getTime() - f.getTime()) / 86400_000) + 2;
      for (let i = -1; i < days; i++) {
        for (const time of triggerTimesOnDay(trig, addDays(start, i), ctx)) {
          if (time >= f && time <= t) out.push({ time, automation: a, trigger: trig });
        }
      }
    }
  }
  return out.sort((x, y) => x.time.getTime() - y.time.getTime());
}

/* ------------------------------------------------------------------ */
/* Event evaluation and state reconstruction                            */
/* ------------------------------------------------------------------ */

export function evaluateOccurrence(o: Occurrence, ctx: PredictContext): PlanEvent {
  const conditions = o.automation.conditions.map((c) => evalCondition(c, o.time, o.trigger, ctx));
  const failed = conditions.find((c) => c.result === false);
  if (failed) return { ...o, status: "fail", effect: null, conditions, blockedBy: failed };
  let status: PlanEvent["status"] = conditions.some((c) => c.result === null) ? "unknown" : "pass";

  // The last action that would run decides the entity's final state for this run.
  let chosen: EntityAction | undefined;
  let chosenSure = false;
  let firstBlock: CondEval | undefined;
  for (const act of o.automation.actions) {
    const g = act.guards.map((x) => evalCondition(x, o.time, o.trigger, ctx));
    const bad = g.find((x) => x.result === false);
    if (bad) {
      firstBlock ??= bad.children?.find((x) => x.result === false) ?? bad;
      continue;
    }
    chosen = act;
    chosenSure = !g.some((x) => x.result === null);
  }
  if (!chosen) return { ...o, status: "fail", effect: null, conditions, blockedBy: firstBlock };
  if (!chosenSure) status = "unknown";
  return { ...o, status, effect: chosen.effect, action: chosen, conditions };
}

export interface StateAt {
  expected: "on" | "off" | null;
  decidedBy?: PlanEvent;
  uncertain: boolean;
  /** Scheduled runs between the deciding event and the moment that would not change the entity. */
  skipped: PlanEvent[];
}

export function stateAt(autos: ParsedAutomation[], at: Date, ctx: PredictContext, lookbackDays = 8): StateAt {
  const past = occurrences(autos, new Date(at.getTime() - lookbackDays * 86400_000), at, ctx, "to").reverse();
  const skipped: PlanEvent[] = [];
  let toggles = 0;
  let uncertain = false;
  let decidedBy: PlanEvent | undefined;
  for (const o of past) {
    const ev = evaluateOccurrence(o, ctx);
    if (ev.status === "fail") {
      if (!decidedBy && skipped.length < 5) skipped.push(ev);
      continue;
    }
    if (ev.status === "unknown") uncertain = true;
    decidedBy ??= ev;
    if (ev.effect === "toggle") {
      toggles++;
      continue;
    }
    const base = ev.effect as "on" | "off";
    const expected = toggles % 2 ? (base === "on" ? "off" : "on") : base;
    return { expected, decidedBy, uncertain, skipped };
  }
  return { expected: null, decidedBy, uncertain, skipped };
}

export interface UpcomingGroup {
  /** The automation's next scheduled run (may be blocked). */
  first: PlanEvent;
  /** The first run that will actually act on the entity. */
  nextPass?: PlanEvent;
  /** Number of runs in the look-ahead window that will act on the entity. */
  passes: number;
}

/** Next runs, one entry per automation. */
export function upcomingGrouped(
  autos: ParsedAutomation[],
  from: Date,
  ctx: PredictContext,
  lookaheadDays = 8,
): UpcomingGroup[] {
  const fut = occurrences(autos, new Date(from.getTime() + 1000), new Date(from.getTime() + lookaheadDays * 86400_000), ctx);
  const groups = new Map<string, UpcomingGroup>();
  for (const o of fut) {
    const ev = evaluateOccurrence(o, ctx);
    const pass = ev.status !== "fail";
    const g = groups.get(o.automation.entityId);
    if (!g) {
      groups.set(o.automation.entityId, { first: ev, nextPass: pass ? ev : undefined, passes: pass ? 1 : 0 });
      continue;
    }
    if (pass) {
      g.passes++;
      g.nextPass ??= ev;
    }
  }
  return [...groups.values()];
}

export function upcoming(
  autos: ParsedAutomation[],
  from: Date,
  ctx: PredictContext,
  count = 4,
  lookaheadDays = 8,
): PlanEvent[] {
  const fut = occurrences(autos, new Date(from.getTime() + 1000), new Date(from.getTime() + lookaheadDays * 86400_000), ctx);
  const out: PlanEvent[] = [];
  let passes = 0;
  for (const o of fut) {
    const ev = evaluateOccurrence(o, ctx);
    out.push(ev);
    if (ev.status !== "fail") passes++;
    if (out.length >= count && passes > 0) break;
    if (out.length >= count * 3) break;
  }
  return out;
}
