export interface HassContext {
  id: string;
  parent_id: string | null;
  user_id: string | null;
}

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed: string;
  last_updated: string;
  context: HassContext;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  entities?: Record<
    string,
    {
      entity_id: string;
      device_id?: string | null;
      area_id?: string | null;
      labels?: string[];
      hidden?: boolean;
      entity_category?: string | null;
    }
  >;
  devices?: Record<
    string,
    { id: string; area_id?: string | null; labels?: string[]; name?: string | null; name_by_user?: string | null }
  >;
  areas?: Record<string, { area_id: string; floor_id?: string | null; name: string }>;
  config: { latitude: number; longitude: number; time_zone: string; unit_system?: { temperature?: string } };
  user?: { id: string; is_admin: boolean; name: string };
  language?: string;
  locale?: { language?: string; time_format?: string };
  callWS<T>(msg: Record<string, unknown>): Promise<T>;
  callApi?<T>(method: "GET" | "POST", path: string): Promise<T>;
}

export interface EntityCheckCardConfig {
  type: string;
  title?: string;
  entity?: string;
  /** Entity types (domains) offered in the picker. */
  domains?: string[];
  /** Only offer entities in these areas. */
  areas?: string[];
  /** Only offer entities of these devices. */
  devices?: string[];
  /** Always offer these entities, even if the filters above leave them out. */
  include_entities?: string[];
  /** Never offer these entities. */
  exclude_entities?: string[];
}
