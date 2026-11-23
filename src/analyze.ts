/** Gathers everything the card shows for one entity: past cause, skipped runs, current expectation and next changes. */
import type { HomeAssistant } from "./types";
import {
  asArray,
  collectLiveLeaves,
  describeCondition,
  normalizeCondition,
  parseAutomation,
  type ParsedAutomation,
  type ParsedTrigger,
  type TargetContext,
} from "./automation";
import {
  stateAt,
  upcoming,
  upcomingGrouped,
  type PlanEvent,
  type PredictContext,
  type StateAt,
  type UpcomingGroup,
} from "./predict";

export class NotAdminError extends Error {}

export interface TraceCondition {
  description: string;
  /** null = not checked (an earlier condition already failed). */
  result: boolean | null;
}

export interface Cause {
  kind: "automation" | "script" | "user" | "service" | "outside";
  title: string;
  detail?: string;
  time: Date;
  automationEntity?: string;
  conditions?: TraceCondition[];
  /** true when matched through the run's context id, false when inferred from the logbook. */
  exact: boolean;
}

export interface SkippedRun {
  automationEntity?: string;
  name: string;
  time: Date;
  trigger?: string;
  reason: string;
  failed?: TraceCondition;
}

export interface Analysis {
  entityId: string;
  state: string;
  isOn: boolean;
  lastChanged: Date;
  cause: Cause;
  skipped: SkippedRun[];
  automations: ParsedAutomation[];
  disabled: ParsedAutomation[];
  eventDriven: { automation: ParsedAutomation; trigger: ParsedTrigger }[];
  now: StateAt;
  next: UpcomingGroup[];
  ctx: PredictContext;
  tracesAvailable: boolean;
}

const OFF_STATES = ["off", "closed", "locked", "unavailable", "unknown", "idle", "standby", "not_home", "paused"];
export const isOnState = (s: string) => !OFF_STATES.includes(s);

/* ------------------------------------------------------------------ */
/* Loading                                                              */
/* ------------------------------------------------------------------ */

let configCache: { at: number; configs: { entityId: string; config: any }[] } | null = null;
const CACHE_MS = 60_000;

export function clearCache() {
  configCache = null;
}

async function loadAutomationConfigs(hass: HomeAssistant) {
  if (configCache && Date.now() - configCache.at < CACHE_MS) return configCache.configs;
  const ids = Object.keys(hass.states).filter((id) => id.startsWith("automation."));
  const configs: { entityId: string; config: any }[] = [];
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    const res = await Promise.all(
      chunk.map((entity_id) =>
        hass
          .callWS<{ config: any }>({ type: "automation/config", entity_id })
          .then((r) => ({ entityId: entity_id, config: r.config }))
          .catch(() => null),
      ),
    );
    for (const r of res) if (r?.config) configs.push(r);
  }
  configCache = { at: Date.now(), configs };
  return configs;
}

async function loadTargetContext(hass: HomeAssistant, entityId: string): Promise<TargetContext> {
  let reg: any = null;
  try {
    reg = await hass.callWS({ type: "config/entity_registry/get", entity_id: entityId });
  } catch {
    /* entity has no registry entry (e.g. YAML-only) */
  }
  const display = hass.entities?.[entityId];
  const deviceId = reg?.device_id ?? display?.device_id ?? null;
  let areaId = reg?.area_id ?? display?.area_id ?? null;
  if (!areaId && deviceId) areaId = hass.devices?.[deviceId]?.area_id ?? null;
  return {
    entityId,
    registryId: reg?.id,
    deviceId,
    areaId,
    floorId: areaId ? (hass.areas?.[areaId]?.floor_id ?? null) : null,
    labels: reg?.labels ?? display?.labels ?? [],
  };
}

async function testConditions(hass: HomeAssistant, leaves: any[]): Promise<Map<unknown, boolean | null>> {
  const live = new Map<unknown, boolean | null>();
  await Promise.all(
    leaves.map(async (raw) => {
      if (live.has(raw)) return;
      live.set(raw, null);
      try {
        const r = await hass.callWS<{ result: boolean }>({ type: "test_condition", condition: normalizeCondition(raw) });
        live.set(raw, Boolean(r.result));
      } catch {
        live.set(raw, null); // e.g. templates that need trigger variables
      }
    }),
  );
  return live;
}

let userCache: Map<string, string> | null = null;
async function userName(hass: HomeAssistant, id: string): Promise<string> {
  if (hass.user?.id === id) return hass.user.name;
  if (!userCache) {
    userCache = new Map();
    try {
      const users = await hass.callWS<{ id: string; name: string }[]>({ type: "config/auth/list" });
      for (const u of users) userCache.set(u.id, u.name);
    } catch {
      /* ignore */
    }
  }
  return userCache.get(id) ?? "a user";
}

/* ------------------------------------------------------------------ */
/* Traces                                                               */
/* ------------------------------------------------------------------ */

interface TraceSummary {
  item_id: string;
  run_id: string;
  state: string;
  script_execution?: string;
  trigger?: string;
  error?: string;
  timestamp: { start: string; finish?: string | null };
  context?: { id: string };
}

const getTrace = (hass: HomeAssistant, s: TraceSummary) =>
  hass.callWS<any>({ type: "trace/get", domain: "automation", item_id: s.item_id, run_id: s.run_id });

function traceConditions(full: any, hass: HomeAssistant): TraceCondition[] {
  const conds = asArray(full?.config?.conditions ?? full?.config?.condition);
  const steps = full?.trace ?? {};
  return conds.map((c: any, i: number) => {
    const r = steps[`condition/${i}`]?.[0]?.result?.result;
    return { description: describeCondition(c, hass), result: typeof r === "boolean" ? r : null };
  });
}

const SKIP_REASONS: Record<string, string> = {
  failed_conditions: "Conditions were not met",
  failed_single: "Skipped: it was already running (mode: single)",
  failed_max_runs: "Skipped: too many runs at the same time",
  error: "Stopped with an error",
  cancelled: "Cancelled",
  aborted: "Aborted",
};

async function findCause(
  hass: HomeAssistant,
  entityId: string,
  summaries: TraceSummary[],
  byConfigId: Map<string, ParsedAutomation>,
  relevantIds: Set<string>,
): Promise<Cause> {
  const st = hass.states[entityId];
  const lc = new Date(st.last_changed);
  const ids = [st.context?.id, st.context?.parent_id].filter(Boolean);

  let match = summaries.find((s) => s.context?.id && ids.includes(s.context.id));
  let full: any = null;
  if (!match) {
    const lcMs = lc.getTime();
    const candidates = summaries
      .filter((s) => {
        const start = Date.parse(s.timestamp.start);
        const finish = s.timestamp.finish ? Date.parse(s.timestamp.finish) : Date.now();
        return start <= lcMs + 2000 && finish >= lcMs - 2000;
      })
      .sort((a, b) => {
        // Prefer automations known to act on this entity, then the closest start time.
        const ra = relevantIds.has(a.item_id) ? 0 : 1;
        const rb = relevantIds.has(b.item_id) ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return Math.abs(Date.parse(a.timestamp.start) - lcMs) - Math.abs(Date.parse(b.timestamp.start) - lcMs);
      })
      .slice(0, 8);
    for (const c of candidates) {
      try {
        const t = await getTrace(hass, c);
        if (t?.context?.id && ids.includes(t.context.id)) {
          match = c;
          full = t;
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (match) {
    try {
      full ??= await getTrace(hass, match);
    } catch {
      /* ignore */
    }
    const auto = byConfigId.get(match.item_id);
    return {
      kind: "automation",
      title: auto?.name ?? full?.config?.alias ?? match.item_id,
      detail: match.trigger ?? full?.trigger,
      time: new Date(match.timestamp.start),
      automationEntity: auto?.entityId,
      conditions: full ? traceConditions(full, hass) : undefined,
      exact: true,
    };
  }

  // Fall back to the logbook, which also covers scripts, users and service calls.
  let entry: any = null;
  try {
    const entries = await hass.callWS<any[]>({
      type: "logbook/get_events",
      start_time: new Date(lc.getTime() - 60_000).toISOString(),
      end_time: new Date(lc.getTime() + 5_000).toISOString(),
      entity_ids: [entityId],
    });
    entry = [...entries].reverse().find((e) => e.state === st.state) ?? entries[entries.length - 1] ?? null;
  } catch {
    /* ignore */
  }

  if (entry?.context_event_type === "automation_triggered") {
    return {
      kind: "automation",
      title: entry.context_name ?? entry.context_entity_id_name ?? entry.context_entity_id ?? "An automation",
      detail: entry.context_source,
      time: lc,
      automationEntity: entry.context_entity_id,
      exact: false,
    };
  }
  if (entry?.context_event_type === "script_started") {
    return {
      kind: "script",
      title: `Script: ${entry.context_name ?? entry.context_entity_id_name ?? entry.context_entity_id}`,
      detail: entry.context_source,
      time: lc,
      exact: false,
    };
  }
  const userId = entry?.context_user_id ?? st.context?.user_id;
  if (userId) {
    return {
      kind: "user",
      title: `Changed by ${await userName(hass, userId)}`,
      detail: entry?.context_service
        ? `Using ${entry.context_domain}.${entry.context_service} from a dashboard or the app`
        : "From a dashboard or the app",
      time: lc,
      exact: false,
    };
  }
  if (entry?.context_domain && entry?.context_service) {
    return {
      kind: "service",
      title: `Action ${entry.context_domain}.${entry.context_service}`,
      detail: entry.context_entity_id_name ? `Called by ${entry.context_entity_id_name}` : undefined,
      time: lc,
      exact: false,
    };
  }
  return {
    kind: "outside",
    title: "Not changed by an automation",
    detail:
      "Probably the device itself, a wall switch or remote, the manufacturer's app, or an integration (for example Presence Simulation). It can also mean the automation's run history has already been cleared.",
    time: lc,
    exact: false,
  };
}

async function findSkipped(
  hass: HomeAssistant,
  summaries: TraceSummary[],
  since: Date,
  byConfigId: Map<string, ParsedAutomation>,
  relevantIds: Set<string>,
): Promise<SkippedRun[]> {
  const runs = summaries
    .filter(
      (s) =>
        relevantIds.has(s.item_id) &&
        s.script_execution &&
        SKIP_REASONS[s.script_execution] &&
        Date.parse(s.timestamp.start) > since.getTime(),
    )
    .sort((a, b) => Date.parse(b.timestamp.start) - Date.parse(a.timestamp.start))
    .slice(0, 5);
  return Promise.all(
    runs.map(async (s) => {
      const auto = byConfigId.get(s.item_id);
      let failed: TraceCondition | undefined;
      if (s.script_execution === "failed_conditions") {
        try {
          failed = traceConditions(await getTrace(hass, s), hass).find((c) => c.result === false);
        } catch {
          /* ignore */
        }
      }
      return {
        automationEntity: auto?.entityId,
        name: auto?.name ?? s.item_id,
        time: new Date(s.timestamp.start),
        trigger: s.trigger,
        reason: SKIP_REASONS[s.script_execution!] + (s.error ? `: ${s.error}` : ""),
        failed,
      };
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

export async function analyze(hass: HomeAssistant, entityId: string): Promise<Analysis> {
  if (!hass.user?.is_admin) throw new NotAdminError();
  const st = hass.states[entityId];
  if (!st) throw new Error(`Entity ${entityId} not found`);

  const [tctx, configs] = await Promise.all([loadTargetContext(hass, entityId), loadAutomationConfigs(hass)]);
  const all = configs.map((c) => parseAutomation(hass, c.entityId, c.config, tctx));
  const relevant = all.filter((a) => a.actions.length);
  const enabled = relevant.filter((a) => a.enabled);
  const disabled = relevant.filter((a) => !a.enabled);

  const leaves = collectLiveLeaves(enabled.flatMap((a) => [...a.conditions, ...a.actions.flatMap((x) => x.guards)]));
  const live = await testConditions(hass, leaves);
  const ctx: PredictContext = {
    hass,
    tz: hass.config.time_zone,
    lat: hass.config.latitude,
    lon: hass.config.longitude,
    live,
  };

  const byConfigId = new Map<string, ParsedAutomation>();
  for (const a of all) if (a.configId) byConfigId.set(a.configId, a);
  const relevantIds = new Set(relevant.map((a) => a.configId).filter(Boolean) as string[]);

  let summaries: TraceSummary[] = [];
  let tracesAvailable = true;
  try {
    summaries = await hass.callWS<TraceSummary[]>({ type: "trace/list", domain: "automation" });
  } catch {
    tracesAvailable = false;
  }

  const lastChanged = new Date(st.last_changed);
  const [cause, skipped] = await Promise.all([
    findCause(hass, entityId, summaries, byConfigId, relevantIds),
    findSkipped(hass, summaries, lastChanged, byConfigId, relevantIds),
  ]);

  const now = new Date();
  return {
    entityId,
    state: st.state,
    isOn: isOnState(st.state),
    lastChanged,
    cause,
    skipped,
    automations: enabled,
    disabled,
    eventDriven: enabled.flatMap((a) =>
      a.triggers.filter((t) => t.kind === "other").map((trigger) => ({ automation: a, trigger })),
    ),
    now: stateAt(enabled, now, ctx),
    next: upcomingGrouped(enabled, now, ctx),
    ctx,
    tracesAvailable,
  };
}

/** The "check a time" feature. */
export function checkAt(a: Analysis, at: Date) {
  return {
    state: stateAt(a.automations, at, a.ctx),
    next: upcoming(a.automations, at, a.ctx, 1).find((e) => e.status !== "fail") as PlanEvent | undefined,
  };
}
