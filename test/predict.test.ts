import { describe, expect, it } from "vitest";
import { parseAutomation, type TargetContext } from "../src/automation";
import { evalCondition, occurrences, stateAt, upcoming, type PredictContext } from "../src/predict";
import { sunTimes } from "../src/sun";
import { parseDuration, zonedParts, zonedToDate } from "../src/time";
import type { HomeAssistant } from "../src/types";

const TZ = "America/New_York";

function makeHass(states: Record<string, any> = {}): HomeAssistant {
  const full: HomeAssistant["states"] = {};
  for (const [id, s] of Object.entries(states)) {
    full[id] = {
      entity_id: id,
      state: s.state ?? s,
      attributes: s.attributes ?? {},
      last_changed: "",
      last_updated: "",
      context: { id: "", parent_id: null, user_id: null },
    };
  }
  return {
    states: full,
    config: { latitude: 40.7128, longitude: -74.006, time_zone: TZ },
    callWS: async () => {
      throw new Error("not in tests");
    },
  };
}

const target: TargetContext = { entityId: "light.porch", labels: [], areaId: "front", deviceId: "dev1" };

function ctx(hass: HomeAssistant, live = new Map<unknown, boolean | null>()): PredictContext {
  return { hass, tz: TZ, lat: 40.7128, lon: -74.006, live };
}

describe("time helpers", () => {
  it("round-trips wall clock time in a time zone, across DST", () => {
    const d = zonedToDate(2026, 3, 8, 12, 0, 0, TZ); // DST starts that morning
    expect(zonedParts(d, TZ)).toMatchObject({ year: 2026, month: 3, day: 8, hour: 12, minute: 0 });
    const w = zonedToDate(2026, 1, 15, 7, 30, 0, TZ);
    expect(w.toISOString()).toBe("2026-01-15T12:30:00.000Z");
  });

  it("parses durations", () => {
    expect(parseDuration("-00:30:00")).toBe(-1800);
    expect(parseDuration("01:15")).toBe(4500);
    expect(parseDuration({ minutes: 10 })).toBe(600);
    expect(parseDuration(45)).toBe(45);
  });
});

describe("sun", () => {
  it("gives a plausible New York sunset in June", () => {
    const s = sunTimes(zonedToDate(2026, 6, 21, 12, 0, 0, TZ), 40.7128, -74.006);
    const p = zonedParts(s.sunset!, TZ);
    expect(p.hour).toBe(20);
    expect(p.minute).toBeGreaterThanOrEqual(25);
    expect(p.minute).toBeLessThanOrEqual(35);
  });
});

describe("automation parsing", () => {
  it("finds actions in both old and new syntax, including area targets and choose branches", () => {
    const hass = makeHass();
    const a = parseAutomation(
      hass,
      "automation.a",
      {
        trigger: [{ platform: "sun", event: "sunset" }],
        action: [
          { service: "light.turn_on", target: { area_id: "front" } },
          { service: "switch.turn_off", target: { area_id: "front" } }, // other domain: ignored
          {
            choose: [{ conditions: [{ condition: "state", entity_id: "input_boolean.x", state: "on" }], sequence: [{ action: "light.turn_off", target: { entity_id: "light.porch" } }] }],
          },
        ],
      },
      target,
    );
    expect(a.actions.map((x) => x.effect)).toEqual(["on", "off"]);
    expect(a.actions[1].guards).toHaveLength(1);
    expect(a.triggers[0].kind).toBe("sun");
  });
});

describe("prediction", () => {
  const hass = makeHass({ "input_boolean.vacation": "off" });
  const vacationOff = { condition: "state", entity_id: "input_boolean.vacation", state: "off" };
  const autos = [
    parseAutomation(
      hass,
      "automation.on",
      {
        alias: "Porch on at sunset",
        triggers: [{ trigger: "sun", event: "sunset", offset: "-00:30:00" }],
        conditions: [vacationOff],
        actions: [{ action: "light.turn_on", target: { entity_id: "light.porch" } }],
      },
      target,
    ),
    parseAutomation(
      hass,
      "automation.off",
      {
        alias: "Porch off at 23:00",
        triggers: [{ trigger: "time", at: "23:00:00" }],
        conditions: [{ condition: "time", weekday: ["mon", "tue", "wed", "thu", "fri"] }],
        actions: [{ action: "light.turn_off", target: { entity_id: "light.porch" } }],
      },
      target,
    ),
  ];

  it("lists occurrences in order", () => {
    const from = zonedToDate(2026, 6, 22, 0, 0, 0, TZ);
    const to = zonedToDate(2026, 6, 23, 0, 0, 0, TZ);
    const occ = occurrences(autos, from, to, ctx(hass));
    expect(occ.map((o) => o.automation.entityId)).toEqual(["automation.on", "automation.off"]);
  });

  it("expects ON in the evening when vacation mode is off", () => {
    const live = new Map<unknown, boolean | null>([[vacationOff, true]]);
    const at = zonedToDate(2026, 6, 22, 21, 30, 0, TZ); // Monday
    const s = stateAt(autos, at, ctx(hass, live));
    expect(s.expected).toBe("on");
    expect(s.decidedBy?.automation.entityId).toBe("automation.on");
  });

  it("expects OFF when vacation mode blocks the sunset automation", () => {
    const live = new Map<unknown, boolean | null>([[vacationOff, false]]);
    const at = zonedToDate(2026, 6, 23, 21, 30, 0, TZ); // Tuesday
    const s = stateAt(autos, at, ctx(hass, live));
    expect(s.expected).toBe("off");
    expect(s.skipped[0].blockedBy?.description).toContain("is off");
  });

  it("knows the weekday condition blocks the 23:00 run on Saturday", () => {
    const live = new Map<unknown, boolean | null>([[vacationOff, true]]);
    const sat = zonedToDate(2026, 6, 27, 22, 0, 0, TZ);
    const next = upcoming(autos, sat, ctx(hass, live), 2);
    expect(next[0].automation.entityId).toBe("automation.off");
    expect(next[0].status).toBe("fail");
    expect(next.find((e) => e.status === "pass")?.automation.entityId).toBe("automation.on");
  });

  it("evaluates time conditions that cross midnight", () => {
    const c = { condition: "time", after: "22:00", before: "06:00" };
    const late = evalCondition(c, zonedToDate(2026, 1, 1, 23, 0, 0, TZ), null, ctx(hass));
    const noon = evalCondition(c, zonedToDate(2026, 1, 1, 12, 0, 0, TZ), null, ctx(hass));
    expect(late.result).toBe(true);
    expect(noon.result).toBe(false);
  });
});

describe("grouped upcoming runs", () => {
  it("shows each automation once, with a repeat count", async () => {
    const { upcomingGrouped } = await import("../src/predict");
    const hass = makeHass();
    const a = parseAutomation(
      hass,
      "automation.daily",
      { triggers: [{ trigger: "time", at: "20:30" }], actions: [{ action: "light.turn_off", target: { entity_id: "light.porch" } }] },
      target,
    );
    const groups = upcomingGrouped([a], zonedToDate(2026, 11, 22, 19, 0, 0, TZ), ctx(hass));
    expect(groups).toHaveLength(1);
    expect(groups[0].passes).toBeGreaterThanOrEqual(7);
  });
});

describe("picker", () => {
  it("filters by type, area and typed words, using friendly names", async () => {
    const { entityOptions, filterOptions } = await import("../src/picker");
    const hass = makeHass({
      "light.secrets_office": { state: "on", attributes: { friendly_name: "Secretary's Office" } },
      "light.kitchen": { state: "off", attributes: { friendly_name: "Kitchen Light" } },
      "switch.office_fan": { state: "off", attributes: { friendly_name: "Office Fan" } },
      "sensor.temp": { state: "20", attributes: { friendly_name: "Temp" } },
    });
    hass.entities = {
      "light.secrets_office": { entity_id: "light.secrets_office", device_id: "d1" },
      "switch.office_fan": { entity_id: "switch.office_fan", area_id: "office" },
    };
    hass.devices = { d1: { id: "d1", area_id: "office", name: "Office Dimmer" } };
    hass.areas = { office: { area_id: "office", name: "Office" } };
    const opts = entityOptions(hass, { type: "x" });
    expect(opts.map((o) => o.entityId)).not.toContain("sensor.temp");
    const f = { domain: "", area: "office", device: "", search: "" };
    expect(filterOptions(opts, f).map((o) => o.name)).toEqual(["Office Fan", "Secretary's Office"]);
    expect(filterOptions(opts, { ...f, domain: "light" })[0].deviceName).toBe("Office Dimmer");
    expect(filterOptions(opts, { domain: "", area: "", device: "", search: "secr off" })).toHaveLength(1);
  });
});

describe("new-style sun trigger", () => {
  it("predicts `trigger: sun.sunrise` with options", () => {
    const hass = makeHass();
    const a = parseAutomation(
      hass,
      "automation.morning",
      {
        triggers: [{ trigger: "sun.sunrise", options: { offset: "00:15:00" } }],
        actions: [{ action: "light.turn_on", target: { entity_id: "light.porch" } }],
      },
      target,
    );
    expect(a.triggers[0].kind).toBe("sun");
    expect(a.triggers[0].description).toBe("At sunrise +15 min");
    const occ = occurrences([a], zonedToDate(2026, 6, 22, 0, 0, 0, TZ), zonedToDate(2026, 6, 23, 0, 0, 0, TZ), ctx(hass));
    expect(zonedParts(occ[0].time, TZ).hour).toBe(5);
  });
});

describe("scripts and scenes", () => {
  it("follows automation → script → script down to the light, with the via chain", () => {
    const hass = makeHass();
    const ctxWithScripts: TargetContext = {
      ...target,
      scripts: new Map<string, any>([
        ["script.night", { sequence: [{ action: "script.turn_on", target: { entity_id: "script.porch_off" } }] }],
        ["script.porch_off", { sequence: [{ condition: "state", entity_id: "input_boolean.x", state: "on" }, { action: "light.turn_off", target: { entity_id: "light.porch" } }] }],
        ["script.loop", { sequence: [{ action: "script.loop" }] }],
      ]),
    };
    const a = parseAutomation(
      hass,
      "automation.night",
      { triggers: [{ trigger: "time", at: "23:00" }], actions: [{ action: "script.night" }, { action: "script.loop" }] },
      ctxWithScripts,
    );
    expect(a.actions).toHaveLength(1);
    expect(a.actions[0].effect).toBe("off");
    expect(a.actions[0].via).toEqual(["script.night", "script.porch_off"]);
    expect(a.actions[0].guards).toHaveLength(1); // the script's own condition step still applies
  });

  it("understands scene.turn_on and inline scene.apply", () => {
    const hass = makeHass();
    const ctxWithScenes: TargetContext = { ...target, scenes: new Map([["scene.evening", "on" as const]]) };
    const a = parseAutomation(
      hass,
      "automation.scenes",
      {
        triggers: [{ trigger: "sun", event: "sunset" }],
        actions: [
          { action: "scene.turn_on", target: { entity_id: "scene.evening" } },
          { action: "scene.apply", data: { entities: { "light.porch": { state: "off" } } } },
        ],
      },
      ctxWithScenes,
    );
    expect(a.actions.map((x) => [x.effect, x.via])).toEqual([
      ["on", ["scene.evening"]],
      ["off", []],
    ]);
  });
});

describe("real-world: Weekdays All style automation", () => {
  it("shows the 12:30 AM Good Night run (via script) as the next change, not the 10:30 PM one", async () => {
    const { upcomingGrouped } = await import("../src/predict");
    const hass = makeHass({ "input_boolean.vacation_mode": "off" });
    const vacation = { condition: "state", entity_id: "input_boolean.vacation_mode", state: "off" };
    const tctx: TargetContext = {
      ...target,
      scripts: new Map<string, any>([
        ["script.good_night_script", { sequence: [{ action: "light.turn_off", target: { entity_id: "light.porch" } }] }],
      ]),
    };
    const a = parseAutomation(
      hass,
      "automation.weekdays_all",
      {
        alias: "Weekdays All",
        triggers: [
          { at: "00:30:00", id: "12:30 AM", trigger: "time" },
          { at: "22:30:00", id: "10:30 PM", trigger: "time" },
        ],
        conditions: [vacation],
        actions: [
          {
            choose: [
              {
                conditions: [{ condition: "trigger", id: ["12:30 AM"] }],
                sequence: [{ data: {}, action: "script.good_night_script" }],
              },
              {
                conditions: [{ condition: "trigger", id: ["10:30 PM"] }],
                sequence: [{ action: "light.turn_off", target: { entity_id: "light.outside_front_door" } }],
              },
            ],
          },
        ],
      },
      tctx,
    );
    const live = new Map<unknown, boolean | null>([[vacation, true]]);
    const from = zonedToDate(2026, 11, 22, 20, 0, 0, TZ);
    const [g] = upcomingGrouped([a], from, ctx(hass, live));
    expect(g.first.status).toBe("fail"); // 10:30 PM doesn't touch this light
    expect(g.nextPass?.trigger.id).toBe("12:30 AM");
    expect(g.nextPass?.effect).toBe("off");
    expect(g.nextPass?.action?.via).toEqual(["script.good_night_script"]);
    expect(zonedParts(g.nextPass!.time, TZ)).toMatchObject({ day: 23, hour: 0, minute: 30 });
  });

  it("writes trigger times in 12-hour format when Home Assistant uses it", () => {
    const hass = makeHass();
    hass.locale = { time_format: "12" };
    const a = parseAutomation(hass, "automation.x", { triggers: [{ trigger: "time", at: "22:30:00" }], actions: [] }, target);
    expect(a.triggers[0].description).toBe("At 10:30 PM");
    hass.locale = { time_format: "24" };
    const b = parseAutomation(hass, "automation.x", { triggers: [{ trigger: "time", at: "00:30:00" }], actions: [] }, target);
    expect(b.triggers[0].description).toBe("At 00:30");
  });
});
