/** Visual editor shown when adding or editing the card in the dashboard UI. */
import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { EntityCheckCardConfig, HomeAssistant } from "./types";
import { DOMAIN_LABELS } from "./picker";

const SCHEMA = [
  { name: "title", selector: { text: {} } },
  {
    name: "domains",
    selector: {
      select: {
        multiple: true,
        custom_value: true,
        options: Object.entries(DOMAIN_LABELS).map(([value, label]) => ({ value, label })),
      },
    },
  },
  { name: "areas", selector: { area: { multiple: true } } },
  { name: "devices", selector: { device: { multiple: true } } },
  { name: "include_entities", selector: { entity: { multiple: true } } },
  { name: "exclude_entities", selector: { entity: { multiple: true } } },
  { name: "entity", selector: { entity: {} } },
];

const LABELS: Record<string, string> = {
  title: "Title",
  domains: "Entity types to offer",
  areas: "Only these areas",
  devices: "Only these devices",
  include_entities: "Always include these entities",
  exclude_entities: "Never show these entities",
  entity: "Entity to check when the card opens",
};

const HELPERS: Record<string, string> = {
  domains: "Leave empty for lights, switches, fans, covers, locks, climate and more.",
  areas: "Leave empty for all areas.",
  devices: "Leave empty for all devices.",
  include_entities: "Added even if the filters above leave them out.",
};

@customElement("entity-check-card-editor")
export class EntityCheckCardEditor extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @state() private _config!: EntityCheckCardConfig;

  public setConfig(config: EntityCheckCardConfig): void {
    this._config = config;
  }

  protected render(): TemplateResult {
    if (!this.hass || !this._config) return html``;
    return html`
      <ha-form
        .hass=${this.hass}
        .data=${this._config}
        .schema=${SCHEMA}
        .computeLabel=${(s: { name: string }) => LABELS[s.name] ?? s.name}
        .computeHelper=${(s: { name: string }) => HELPERS[s.name]}
        @value-changed=${this._changed}
      ></ha-form>
    `;
  }

  private _changed(ev: CustomEvent) {
    const config: Record<string, unknown> = { ...ev.detail.value };
    for (const [k, v] of Object.entries(config)) {
      if (v === "" || v == null || (Array.isArray(v) && !v.length)) delete config[k];
    }
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }
}
