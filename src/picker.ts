/** Which entities the card offers, with their friendly, area and device names. */
import type { EntityCheckCardConfig, HomeAssistant } from "./types";

export const DOMAIN_LABELS: Record<string, string> = {
  light: "Lights",
  switch: "Switches",
  fan: "Fans",
  cover: "Covers & blinds",
  lock: "Locks",
  climate: "Climate / AC",
  media_player: "Media players",
  input_boolean: "Toggle helpers",
  valve: "Valves",
  siren: "Sirens",
  humidifier: "Humidifiers",
  water_heater: "Water heaters",
  vacuum: "Vacuums",
};

export const DEFAULT_DOMAINS = Object.keys(DOMAIN_LABELS);

export const domainLabel = (d: string) => DOMAIN_LABELS[d] ?? d.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export interface EntityOption {
  entityId: string;
  name: string;
  domain: string;
  areaId: string | null;
  areaName: string;
  deviceId: string | null;
  deviceName: string;
}

export function deviceName(hass: HomeAssistant, id: string | null | undefined): string {
  if (!id) return "";
  const d = hass.devices?.[id];
  return d?.name_by_user || d?.name || "";
}

export function areaName(hass: HomeAssistant, id: string | null | undefined): string {
  if (!id) return "";
  return hass.areas?.[id]?.name ?? "";
}

export function entityInfo(hass: HomeAssistant, entityId: string): EntityOption {
  const reg = hass.entities?.[entityId];
  const deviceId = reg?.device_id ?? null;
  const areaId = reg?.area_id ?? (deviceId ? (hass.devices?.[deviceId]?.area_id ?? null) : null);
  return {
    entityId,
    name: hass.states[entityId]?.attributes?.friendly_name ?? entityId,
    domain: entityId.split(".")[0],
    areaId,
    areaName: areaName(hass, areaId),
    deviceId,
    deviceName: deviceName(hass, deviceId),
  };
}

export function entityOptions(hass: HomeAssistant, config: EntityCheckCardConfig): EntityOption[] {
  const domains = config.domains?.length ? config.domains : DEFAULT_DOMAINS;
  const include = new Set(config.include_entities ?? []);
  const exclude = new Set(config.exclude_entities ?? []);
  const out: EntityOption[] = [];
  for (const id of Object.keys(hass.states)) {
    if (exclude.has(id)) continue;
    const forced = include.has(id);
    const reg = hass.entities?.[id];
    if (!forced) {
      if (!domains.includes(id.split(".")[0])) continue;
      if (reg?.hidden || reg?.entity_category) continue;
    }
    const info = entityInfo(hass, id);
    if (!forced) {
      if (config.areas?.length && (!info.areaId || !config.areas.includes(info.areaId))) continue;
      if (config.devices?.length && (!info.deviceId || !config.devices.includes(info.deviceId))) continue;
    }
    out.push(info);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface PickerFilter {
  domain: string;
  area: string; // "" = any, "__none__" = no area
  device: string;
  search: string;
}

export function filterOptions(options: EntityOption[], f: PickerFilter, skip?: keyof PickerFilter): EntityOption[] {
  const words = f.search.toLowerCase().split(/\s+/).filter(Boolean);
  return options.filter((o) => {
    if (skip !== "domain" && f.domain && o.domain !== f.domain) return false;
    if (skip !== "area" && f.area) {
      if (f.area === "__none__" ? o.areaId : o.areaId !== f.area) return false;
    }
    if (skip !== "device" && f.device && o.deviceId !== f.device) return false;
    if (words.length) {
      const hay = `${o.name} ${o.entityId} ${o.areaName} ${o.deviceName}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}
