/** Reading automation configs: which actions touch the entity, which triggers fire them, and plain-English descriptions. */
import type { HomeAssistant } from "./types";
import { formatClock, formatDuration, parseDuration, parseTimeOfDay } from "./time";

/** on/off/toggle change the on-off state; "adjust" acts on the entity without switching it (e.g. set temperature). */
export type Effect = "on" | "off" | "toggle" | "adjust";
export type TriggerKind = "time" | "sun" | "time_pattern" | "other";

export interface EntityAction {
  effect: Effect;
  service: string;
  /** Conditions that must hold for this action to run (from choose / if / inline condition steps). */
  guards: any[];
  branch?: string;
  /** Short description of what it does, e.g. "set cool 71°" or "turn on 30%". */
  label?: string;
  /** Script entity ids this action is reached through, outermost first. */
  via: string[];
}

export interface ParsedTrigger {
  index: number;
  /** Trigger id as HA sees it (explicit `id`, or the index as a string). */
  id: string;
  raw: any;
  kind: TriggerKind;
  description: string;
}

export interface ParsedAutomation {
  entityId: string;
  configId?: string;
  name: string;
  enabled: boolean;
  config: any;
  triggers: ParsedTrigger[];
  conditions: any[];
  actions: EntityAction[];
}

export interface TargetContext {
  entityId: string;
  registryId?: string;
  deviceId?: string | null;
  areaId?: string | null;
  floorId?: string | null;
  labels: string[];
  /** Script configs by entity id, so actions inside called scripts can be followed. */
  scripts?: Map<string, any>;
  /** What each scene that includes this entity does to it, by scene entity id. */
  scenes?: Map<string, Effect>;
}

export const asArray = <T = any>(x: T | T[] | null | undefined): T[] =>
  x == null ? [] : Array.isArray(x) ? x : [x];

const splitIds = (v: unknown): string[] =>
  asArray(v)
    .flatMap((x) => (typeof x === "string" ? x.split(",").map((s) => s.trim()) : []))
    .filter(Boolean);

const ON_SERVICES = ["turn_on", "open_cover", "open_valve", "unlock", "open"];
const OFF_SERVICES = ["turn_off", "close_cover", "close_valve", "lock", "close"];
const TOGGLE_SERVICES = ["toggle", "toggle_cover"];

const OFF_LIKE = ["off", "closed", "locked", "idle", "standby", "paused"];

/** A scene's stored state for an entity ("on", {state: "off", brightness: 50}, ...) as an effect. */
export function sceneStateEffect(v: unknown): Effect | null {
  const st = typeof v === "string" ? v : v && typeof v === "object" ? (v as any).state : undefined;
  if (typeof st !== "string" || !st) return null;
  return OFF_LIKE.includes(st) ? "off" : "on";
}

const isTemplate = (v: unknown) => typeof v === "string" && v.includes("{{");

/**
 * What a service call does to an entity of its own domain.
 * Returns null for services that don't act on the entity's state at all.
 */
export function serviceAction(service: string, a: any, entityDomain: string): { effect: Effect; label?: string } | null {
  const [domain, svc] = service.split(".");
  const data = { ...(a?.data ?? {}), ...(a?.data_template ?? {}) };
  const base = serviceEffect(service);
  if (base) {
    if (base === "on" && domain === "light" && data.brightness_pct != null && !isTemplate(data.brightness_pct)) {
      return { effect: "on", label: `turn on ${data.brightness_pct}%` };
    }
    return { effect: base };
  }
  if (domain !== entityDomain && domain !== "homeassistant") return null;

  const modeEffect = (mode: unknown, label: string) => {
    if (typeof mode !== "string" || isTemplate(mode)) return { effect: "adjust" as Effect, label };
    return { effect: (mode === "off" ? "off" : "on") as Effect, label: `${label} ${mode}`.trim() };
  };
  const temp = () => {
    if (data.temperature != null) return `${data.temperature}°`;
    if (data.target_temp_low != null || data.target_temp_high != null)
      return `${data.target_temp_low ?? "?"}–${data.target_temp_high ?? "?"}°`;
    return "";
  };

  switch (`${domain}.${svc}`) {
    case "climate.set_hvac_mode":
      return modeEffect(data.hvac_mode, "set");
    case "climate.set_temperature": {
      if (data.hvac_mode != null) {
        const r = modeEffect(data.hvac_mode, "set");
        return { ...r, label: `${r.label} ${temp()}`.trim() };
      }
      return { effect: "adjust", label: `set ${temp() || "temperature"}` };
    }
    case "climate.set_preset_mode":
      return { effect: "adjust", label: `preset ${data.preset_mode ?? ""}`.trim() };
    case "climate.set_fan_mode":
      return { effect: "adjust", label: `fan ${data.fan_mode ?? ""}`.trim() };
    case "water_heater.set_operation_mode":
      return modeEffect(data.operation_mode, "set");
    case "cover.set_cover_position":
    case "valve.set_valve_position": {
      const p = data.position;
      if (p == null || isTemplate(p)) return { effect: "adjust", label: "set position" };
      return { effect: Number(p) > 0 ? "on" : "off", label: `position ${p}%` };
    }
    case "fan.set_percentage": {
      const p = data.percentage;
      if (p == null || isTemplate(p)) return { effect: "adjust", label: "set speed" };
      return { effect: Number(p) > 0 ? "on" : "off", label: `speed ${p}%` };
    }
    case "vacuum.start":
      return { effect: "on", label: "start" };
    case "vacuum.return_to_base":
    case "vacuum.stop":
      return { effect: "off", label: svc.replace(/_/g, " ") };
    case "media_player.media_play":
      return { effect: "on", label: "play" };
    case "media_player.media_stop":
      return { effect: "off", label: "stop" };
    default:
      // Any other action of the entity's own type still acts on it (set mode, set color, ...).
      return { effect: "adjust", label: svc.replace(/_/g, " ") };
  }
}

export function serviceEffect(service: string): Effect | null {
  const svc = service.split(".")[1] ?? "";
  if (ON_SERVICES.includes(svc)) return "on";
  if (OFF_SERVICES.includes(svc)) return "off";
  if (TOGGLE_SERVICES.includes(svc)) return "toggle";
  return null;
}

function targetsEntity(a: any, ctx: TargetContext, serviceDomain: string): boolean {
  const t = { ...(a.data ?? {}), ...(a.data_template ?? {}), ...(a.target ?? {}) };
  const ids = [...splitIds(t.entity_id), ...splitIds(a.entity_id)];
  const entityDomain = ctx.entityId.split(".")[0];
  const domainOk = serviceDomain === "homeassistant" || serviceDomain === entityDomain;
  if (ids.includes(ctx.entityId)) return true;
  if (!domainOk) return false;
  if (ids.includes("all")) return true;
  if (ctx.areaId && splitIds(t.area_id).includes(ctx.areaId)) return true;
  if (ctx.deviceId && splitIds(t.device_id).includes(ctx.deviceId)) return true;
  if (ctx.floorId && splitIds(t.floor_id).includes(ctx.floorId)) return true;
  if (ctx.labels.length && splitIds(t.label_id).some((l) => ctx.labels.includes(l))) return true;
  return false;
}

const and = (conds: any[]) => ({ condition: "and", conditions: conds });
const not = (conds: any[]) => ({ condition: "not", conditions: conds });

const DEVICE_TYPES: Record<string, Effect> = {
  turn_on: "on",
  turn_off: "off",
  toggle: "toggle",
  open: "on",
  close: "off",
  lock: "off",
  unlock: "on",
};

const MAX_SCRIPT_DEPTH = 6;

function walkActions(
  list: unknown,
  guards: any[],
  out: EntityAction[],
  ctx: TargetContext,
  branch?: string,
  via: string[] = [],
) {
  const local = [...guards];
  const walk = (l: unknown, g: any[], br?: string, v: string[] = via) => walkActions(l, g, out, ctx, br, v);
  for (const a of asArray<any>(list as any)) {
    if (!a || typeof a !== "object" || a.enabled === false) continue;

    const service =
      typeof a.action === "string" ? a.action : typeof a.service === "string" ? a.service : undefined;

    if (service) {
      const [domain, svc] = service.split(".");
      if (domain === "scene") {
        if (svc === "turn_on") {
          // Activating stored scenes that include this entity.
          const t = { ...(a.data ?? {}), ...(a.target ?? {}) };
          for (const sid of [...splitIds(t.entity_id), ...splitIds(a.entity_id)]) {
            const effect = ctx.scenes?.get(sid);
            if (effect) out.push({ effect, service, guards: [...local], branch, via: [...via, sid] });
          }
        } else if (svc === "apply") {
          // Scenes written inline in the action.
          const effect = sceneStateEffect((a.data ?? {}).entities?.[ctx.entityId]);
          if (effect) out.push({ effect, service, guards: [...local], branch, via });
        }
        continue;
      }
      if (domain === "script") {
        // Follow into the called script(s): `script.my_script` or `script.turn_on` with script targets.
        let called: string[] = [];
        if (svc === "turn_on" || svc === "toggle") {
          const t = { ...(a.data ?? {}), ...(a.target ?? {}) };
          called = [...splitIds(t.entity_id), ...splitIds(a.entity_id)];
        } else if (svc !== "turn_off" && svc !== "reload") {
          called = [service];
        }
        for (const sid of called) {
          if (via.includes(sid) || via.length >= MAX_SCRIPT_DEPTH) continue;
          const cfg = ctx.scripts?.get(sid);
          if (cfg) walk(cfg.sequence, local, branch, [...via, sid]);
        }
        continue;
      }
      const act = serviceAction(service, a, ctx.entityId.split(".")[0]);
      if (act && targetsEntity(a, ctx, domain)) {
        out.push({ effect: act.effect, label: act.label, service, guards: [...local], branch, via });
      }
      continue;
    }

    if (a.device_id && a.type && a.domain) {
      const effect = DEVICE_TYPES[a.type];
      if (
        effect &&
        a.device_id === ctx.deviceId &&
        (a.entity_id === ctx.entityId || (ctx.registryId && a.entity_id === ctx.registryId))
      ) {
        out.push({ effect, service: `${a.domain} device: ${a.type}`, guards: [...local], branch, via });
      }
      continue;
    }

    if (a.choose !== undefined) {
      const options = asArray<any>(a.choose);
      const prev: any[] = [];
      options.forEach((opt, i) => {
        const conds = asArray(opt.conditions ?? opt.condition);
        const g = [...local, and(conds)];
        if (prev.length) g.push(not(prev.map((p) => and(p))));
        walk(opt.sequence, g, `choose option ${i + 1}`);
        prev.push(conds);
      });
      if (a.default) {
        const g = prev.length ? [...local, not(prev.map((p) => and(p)))] : [...local];
        walk(a.default, g, "choose default");
      }
      continue;
    }

    if (a.if !== undefined) {
      const conds = asArray(a.if);
      walk(a.then, [...local, and(conds)], "if → then");
      if (a.else) walk(a.else, [...local, not([and(conds)])], "if → else");
      continue;
    }

    if (a.parallel !== undefined) {
      for (const p of asArray<any>(a.parallel)) walk(p?.sequence ?? [p], local, branch);
      continue;
    }

    if (a.repeat?.sequence) {
      walk(a.repeat.sequence, local, branch ?? "repeat");
      continue;
    }

    if (a.sequence !== undefined) {
      walk(a.sequence, local, branch);
      continue;
    }

    // An inline condition step stops everything after it when false.
    if (typeof a.condition === "string" || a.and || a.or || a.not) {
      local.push(a);
      continue;
    }
  }
}

function triggerKind(t: any): string {
  return t?.trigger ?? t?.platform ?? "";
}

/** Newer Home Assistant versions also write sun triggers as `trigger: sun.sunset` with `options`. */
function normalizeTrigger(t: any): any {
  const k = triggerKind(t);
  if (typeof k === "string" && (k === "sun.sunrise" || k === "sun.sunset")) {
    const opts = t.options ?? {};
    return { ...t, ...opts, trigger: "sun", event: k.slice(4), offset: opts.offset ?? t.offset };
  }
  if (k === "time.at" || k === "time.time") {
    return { ...t, ...(t.options ?? {}), trigger: "time" };
  }
  return t;
}

export function parseAutomation(
  hass: HomeAssistant,
  entityId: string,
  config: any,
  ctx: TargetContext,
): ParsedAutomation {
  const st = hass.states[entityId];
  const actions: EntityAction[] = [];
  walkActions(config.actions ?? config.action, [], actions, ctx);
  const triggers = asArray<any>(config.triggers ?? config.trigger)
    .map((raw, index) => ({ raw, index }))
    .filter(({ raw }) => raw && raw.enabled !== false)
    .map(({ raw: original, index }) => {
      const raw = normalizeTrigger(original);
      const k = triggerKind(raw);
      const kind: TriggerKind = k === "time" || k === "sun" || k === "time_pattern" ? k : "other";
      return {
        index,
        id: raw.id != null ? String(raw.id) : String(index),
        raw,
        kind,
        description: describeTrigger(raw, hass),
      };
    });
  return {
    entityId,
    configId: st?.attributes?.id,
    name: st?.attributes?.friendly_name ?? config.alias ?? entityId,
    enabled: st ? st.state !== "off" : true,
    config,
    triggers,
    conditions: asArray(config.conditions ?? config.condition).filter((c: any) => c?.enabled !== false),
    actions,
  };
}

/* ------------------------------------------------------------------ */
/* Descriptions                                                         */
/* ------------------------------------------------------------------ */

/** Follows the user's Home Assistant time format setting (12/24 hour, or the language default). */
export function uses12h(hass: HomeAssistant): boolean {
  const tf = hass.locale?.time_format;
  if (tf === "12") return true;
  if (tf === "24") return false;
  const lang = tf === "system" ? undefined : (hass.locale?.language ?? hass.language);
  try {
    return Boolean(new Intl.DateTimeFormat(lang, { hour: "numeric" }).resolvedOptions().hour12);
  } catch {
    return false;
  }
}

/** "07:00:00" -> "7:00 AM", "2026-11-27T21:17:00+00:00" -> "Fri 4:17 PM". */
export function readableTime(hass: HomeAssistant, state: string): string {
  const h12 = uses12h(hass);
  const secs = parseTimeOfDay(state);
  if (secs != null) return formatClock(secs, h12);
  const isoLike = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(state);
  const t = isoLike ? Date.parse(state.includes("T") || /[+-]\d{2}:?\d{2}$|Z$/.test(state) ? state : state.replace(" ", "T")) : NaN;
  if (Number.isNaN(t)) return state;
  try {
    return new Intl.DateTimeFormat(hass.locale?.language ?? hass.language, {
      timeZone: hass.config.time_zone,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: h12,
    }).format(new Date(t));
  } catch {
    return state;
  }
}

export const friendlyName = (hass: HomeAssistant, id: string) =>
  hass.states[id]?.attributes?.friendly_name ?? id;

const names = (hass: HomeAssistant, v: unknown) =>
  splitIds(v)
    .map((id) => friendlyName(hass, id))
    .join(", ") || "?";

const list = (v: unknown) =>
  asArray(v)
    .map((x) => String(x))
    .join(" or ");

function timeValue(hass: HomeAssistant, v: unknown): string {
  if (typeof v === "string") {
    const secs = parseTimeOfDay(v);
    if (secs != null) return formatClock(secs, uses12h(hass));
    if (v.includes(".")) {
      const s = hass.states[v];
      return s ? `${friendlyName(hass, v)} (${readableTime(hass, s.state)})` : v;
    }
    return v;
  }
  if (v && typeof v === "object" && (v as any).entity_id) {
    const o = v as any;
    const off = parseDuration(o.offset);
    return `${timeValue(hass, o.entity_id)}${off ? " " + formatDuration(off) : ""}`;
  }
  return String(v);
}

function sunEvent(event: string, offset: unknown): string {
  const off = parseDuration(offset);
  return `${event}${off ? " " + formatDuration(off) : ""}`;
}

export function describeTrigger(t0: any, hass: HomeAssistant): string {
  const t = normalizeTrigger(t0);
  const k = triggerKind(t);
  switch (k) {
    case "time": {
      const at = asArray(t.at)
        .map((v) => timeValue(hass, v))
        .join(", ");
      const wd = t.weekday ? ` on ${asArray(t.weekday).join(", ")}` : "";
      return `At ${at}${wd}`;
    }
    case "sun":
      return `At ${sunEvent(t.event, t.offset)}`;
    case "time_pattern": {
      const p = [
        t.hours != null ? `hours ${t.hours}` : "",
        t.minutes != null ? `minutes ${t.minutes}` : "",
        t.seconds != null ? `seconds ${t.seconds}` : "",
      ].filter(Boolean);
      return `Time pattern (${p.join(", ") || "every second"})`;
    }
    case "state": {
      let s = `When ${names(hass, t.entity_id)}`;
      if (t.attribute) s += ` ${t.attribute}`;
      if (t.to != null) s += ` changes to ${list(t.to)}`;
      else s += " changes";
      if (t.from != null) s += ` from ${list(t.from)}`;
      if (t.for) s += ` for ${formatDuration(parseDuration(t.for)).replace(/^\+/, "")}`;
      return s;
    }
    case "numeric_state": {
      const parts = [];
      if (t.above != null) parts.push(`goes above ${t.above}`);
      if (t.below != null) parts.push(`goes below ${t.below}`);
      return `When ${names(hass, t.entity_id)}${t.attribute ? " " + t.attribute : ""} ${parts.join(" and ")}`;
    }
    case "homeassistant":
      return `When Home Assistant ${t.event === "shutdown" ? "shuts down" : "starts"}`;
    case "event":
      return `On event "${t.event_type}"`;
    case "zone":
      return `When ${names(hass, t.entity_id)} ${t.event === "leave" ? "leaves" : "enters"} ${names(hass, t.zone)}`;
    case "template":
      return "When a template becomes true";
    case "device":
      return `Device trigger (${t.type ?? "?"})`;
    case "calendar":
      return `Calendar ${t.event ?? "event"} of ${names(hass, t.entity_id)}`;
    case "webhook":
      return "When a webhook is called";
    case "mqtt":
      return `MQTT message on ${t.topic}`;
    case "tag":
      return "When a tag is scanned";
    case "conversation":
      return "Voice command";
    default:
      return k ? `${k} trigger` : "Unknown trigger";
  }
}

/** Normalize the shorthand forms (template strings, `and:`/`or:`/`not:` keys) into full conditions. */
export function normalizeCondition(c: any): any {
  if (typeof c === "string") return { condition: "template", value_template: c };
  if (c && typeof c === "object" && typeof c.condition !== "string") {
    for (const k of ["and", "or", "not"]) if (c[k]) return { condition: k, conditions: asArray(c[k]) };
  }
  return c;
}

export function describeCondition(raw: any, hass: HomeAssistant): string {
  const c = normalizeCondition(raw);
  if (!c || typeof c !== "object") return "Condition";
  if (c.alias) return c.alias;
  const subs = () =>
    asArray(c.conditions)
      .map((x) => describeCondition(x, hass))
      .join("; ");
  switch (c.condition) {
    case "state": {
      const attr = c.attribute ? ` ${c.attribute}` : "";
      const forS = c.for ? ` for ${formatDuration(parseDuration(c.for)).replace(/^\+/, "")}` : "";
      return `${names(hass, c.entity_id)}${attr} is ${list(c.state)}${forS}`;
    }
    case "numeric_state": {
      const parts = [];
      if (c.above != null) parts.push(`above ${c.above}`);
      if (c.below != null) parts.push(`below ${c.below}`);
      return `${names(hass, c.entity_id)}${c.attribute ? " " + c.attribute : ""} is ${parts.join(" and ")}`;
    }
    case "time": {
      const parts = [];
      if (c.after) parts.push(`after ${timeValue(hass, c.after)}`);
      if (c.before) parts.push(`before ${timeValue(hass, c.before)}`);
      if (c.weekday) parts.push(`on ${asArray(c.weekday).join(", ")}`);
      return `Time is ${parts.join(" and ")}`;
    }
    case "sun": {
      const parts = [];
      if (c.after) parts.push(`after ${sunEvent(c.after, c.after_offset)}`);
      if (c.before) parts.push(`before ${sunEvent(c.before, c.before_offset)}`);
      return `Sun: ${parts.join(" and ")}`;
    }
    case "template":
      return `Template: ${String(c.value_template ?? "").slice(0, 80)}`;
    case "zone":
      return `${names(hass, c.entity_id)} is in ${names(hass, c.zone)}`;
    case "trigger":
      return `Only for trigger "${list(c.id)}"`;
    case "and":
      return `All of: ${subs()}`;
    case "or":
      return `Any of: ${subs()}`;
    case "not":
      return `None of: ${subs()}`;
    case "device":
      return `Device condition (${c.type ?? "?"})`;
    default:
      return `${c.condition} condition`;
  }
}

/** Every leaf condition that can't be evaluated locally (needs Home Assistant to test it right now). */
export function collectLiveLeaves(conds: any[], out: any[] = []): any[] {
  for (const raw of conds) {
    const c = normalizeCondition(raw);
    if (!c || typeof c !== "object" || c.enabled === false) continue;
    if (c.condition === "and" || c.condition === "or" || c.condition === "not") {
      collectLiveLeaves(asArray(c.conditions), out);
    } else if (c.condition !== "time" && c.condition !== "sun" && c.condition !== "trigger") {
      out.push(raw);
    }
  }
  return out;
}
