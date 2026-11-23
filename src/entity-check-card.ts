import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { EntityCheckCardConfig, HomeAssistant } from "./types";
import { NotAdminError, analyze, checkAt, clearCache, isOnState, type Analysis } from "./analyze";
import type { Effect } from "./automation";
import type { CondEval, PlanEvent, StateAt, UpcomingGroup } from "./predict";
import { zonedParts, zonedToDate } from "./time";
import { domainLabel, entityInfo, entityOptions, filterOptions, type EntityOption, type PickerFilter } from "./picker";
import "./editor";

const VERSION = "0.3.0";

@customElement("entity-check-card")
export class EntityCheckCard extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @state() private _config!: EntityCheckCardConfig;
  @state() private _entity = "";
  @state() private _loading = false;
  @state() private _error = "";
  @state() private _result?: Analysis;
  @state() private _checkValue = "";
  @state() private _check?: { at: Date; state: StateAt; next?: PlanEvent };
  @state() private _picking = false;
  @state() private _filter: PickerFilter = { domain: "", area: "", device: "", search: "" };

  private _optionsCache?: { states: unknown; config: unknown; options: EntityOption[] };

  public static getStubConfig(): Partial<EntityCheckCardConfig> {
    return {};
  }

  public static getConfigElement(): HTMLElement {
    return document.createElement("entity-check-card-editor");
  }

  public setConfig(config: EntityCheckCardConfig): void {
    this._config = config;
    if (config.entity && !this._entity) this._entity = config.entity;
  }

  public getCardSize(): number {
    return this._result ? 8 : 2;
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("_picking") && this._picking) {
      this.renderRoot.querySelector<HTMLInputElement>("#search")?.focus();
    }
    if (changed.has("hass") && this.hass && this._entity && !this._result && !this._loading && !this._error) {
      this._run();
    }
  }

  /* ------------------------------ actions ----------------------------- */

  private async _run(force = false) {
    if (!this._entity || !this.hass?.states[this._entity]) return;
    if (force) clearCache();
    this._loading = true;
    this._error = "";
    this._check = undefined;
    try {
      this._result = await analyze(this.hass, this._entity);
      if (!this._checkValue) this._checkValue = this._toInputValue(new Date(Date.now() + 3600_000));
    } catch (e) {
      this._result = undefined;
      this._error =
        e instanceof NotAdminError
          ? "Entity Check needs an administrator account to read automations and their run history."
          : `Something went wrong: ${(e as Error).message ?? e}`;
    } finally {
      this._loading = false;
    }
  }

  private _select(entityId: string) {
    this._picking = false;
    if (entityId === this._entity && this._result) return;
    this._entity = entityId;
    this._result = undefined;
    this._run();
  }

  private _clear() {
    this._entity = "";
    this._result = undefined;
    this._error = "";
    this._check = undefined;
    this._picking = true;
  }

  private _setFilter(patch: Partial<PickerFilter>) {
    const f = { ...this._filter, ...patch };
    // Narrowing the type or area can make the chosen device impossible; reset it then.
    if ((patch.domain !== undefined || patch.area !== undefined) && f.device) {
      const still = filterOptions(this._options(), { ...f, search: "" }).some((o) => o.deviceId === f.device);
      if (!still) f.device = "";
    }
    this._filter = f;
  }

  private _onSearchKey(ev: KeyboardEvent) {
    if (ev.key === "Enter") {
      const first = filterOptions(this._options(), this._filter)[0];
      if (first) this._select(first.entityId);
    } else if (ev.key === "Escape" && this._entity) {
      this._picking = false;
    }
  }

  private _options(): EntityOption[] {
    const c = this._optionsCache;
    if (c && c.states === this.hass.states && c.config === this._config) return c.options;
    const options = entityOptions(this.hass, this._config);
    this._optionsCache = { states: this.hass.states, config: this._config, options };
    return options;
  }

  private _doCheck() {
    if (!this._result || !this._checkValue) return;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(this._checkValue);
    if (!m) return;
    const at = zonedToDate(+m[1], +m[2], +m[3], +m[4], +m[5], 0, this.hass.config.time_zone);
    const r = checkAt(this._result, at);
    this._check = { at, ...r };
  }

  private _toInputValue(d: Date): string {
    const p = zonedParts(d, this.hass.config.time_zone);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
  }

  private _openMoreInfo(entityId?: string) {
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
  }

  /* ----------------------------- formatting ---------------------------- */

  private _fmt(d: Date, withDate = true): string {
    const now = new Date();
    const sameDay =
      zonedParts(d, this.hass.config.time_zone).day === zonedParts(now, this.hass.config.time_zone).day &&
      Math.abs(d.getTime() - now.getTime()) < 86400_000;
    return new Intl.DateTimeFormat(this.hass.language ?? undefined, {
      timeZone: this.hass.config.time_zone,
      ...(withDate && !sameDay ? { weekday: "short", month: "short", day: "numeric" } : {}),
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  }

  private _rel(d: Date): string {
    const diff = Math.round((d.getTime() - Date.now()) / 60000);
    const a = Math.abs(diff);
    let s: string;
    if (a < 1) return "just now";
    if (a < 60) s = `${a} min`;
    else if (a < 1440) s = `${Math.floor(a / 60)}h ${a % 60}m`;
    else s = `${Math.floor(a / 1440)}d ${Math.floor((a % 1440) / 60)}h`;
    return diff < 0 ? `${s} ago` : `in ${s}`;
  }

  private _effectWord(effect: Effect | null | "on" | "off"): string {
    const domain = this._entity.split(".")[0];
    if (effect === "toggle") return "toggle";
    if (domain === "cover" || domain === "valve") return effect === "on" ? "open" : "close";
    if (domain === "lock") return effect === "on" ? "unlock" : "lock";
    return effect === "on" ? "turn on" : "turn off";
  }

  private _stateWord(on: "on" | "off"): string {
    const domain = this._entity.split(".")[0];
    if (domain === "cover" || domain === "valve") return on === "on" ? "open" : "closed";
    if (domain === "lock") return on === "on" ? "unlocked" : "locked";
    return on.toUpperCase();
  }

  /* ------------------------------- render ------------------------------ */

  protected render(): TemplateResult {
    if (!this.hass || !this._config) return html``;
    return html`
      <ha-card>
        <div class="header">
          <ha-icon icon="mdi:magnify-scan"></ha-icon>
          <span>${this._config.title ?? "Entity Check"}</span>
          <span class="version">v${VERSION}</span>
        </div>
        <div class="content">
          ${this._renderPicker()}
          ${this._loading && !this._picking ? html`<div class="loading">Checking automations…</div>` : nothing}
          ${this._error ? html`<div class="error">${this._error}</div>` : nothing}
          ${this._result && !this._loading && !this._picking ? this._renderResult(this._result) : nothing}
        </div>
      </ha-card>
    `;
  }

  private _renderPicker() {
    if (this._entity && !this._picking) {
      const info = entityInfo(this.hass, this._entity);
      const sub = [info.areaName, info.deviceName !== info.name ? info.deviceName : ""].filter(Boolean).join(" · ");
      return html`
        <div class="selected">
          <ha-state-icon .hass=${this.hass} .stateObj=${this.hass.states[this._entity]}></ha-state-icon>
          <div class="sel-text clickable" title="Pick another" @click=${() => (this._picking = true)}>
            <div class="big">${info.name}</div>
            ${sub ? html`<div class="muted small">${sub}</div>` : nothing}
          </div>
          <button class="icon" title="Check again" @click=${() => this._run(true)}><ha-icon icon="mdi:refresh"></ha-icon></button>
          <button class="icon" title="Pick another" @click=${this._clear}><ha-icon icon="mdi:swap-horizontal"></ha-icon></button>
        </div>
      `;
    }

    const all = this._options();
    const f = this._filter;
    const base = { ...f, search: "" };
    const forDomain = filterOptions(all, base, "domain");
    const forArea = filterOptions(all, base, "area");
    const forDevice = filterOptions(all, base, "device");
    const domains = [...new Set(forDomain.map((o) => o.domain))].sort((a, b) =>
      domainLabel(a).localeCompare(domainLabel(b)),
    );
    const areas = [...new Map(forArea.filter((o) => o.areaId).map((o) => [o.areaId!, o.areaName || o.areaId!]))].sort(
      (a, b) => a[1].localeCompare(b[1]),
    );
    const hasNoArea = forArea.some((o) => !o.areaId);
    const devices = [
      ...new Map(forDevice.filter((o) => o.deviceId).map((o) => [o.deviceId!, o.deviceName || o.deviceId!])),
    ].sort((a, b) => a[1].localeCompare(b[1]));
    const matches = filterOptions(all, f);
    const shown = matches.slice(0, 60);

    return html`
      <div class="picker">
        <div class="search">
          <ha-icon icon="mdi:magnify"></ha-icon>
          <input
            id="search"
            placeholder="Start typing a name, area or device…"
            .value=${f.search}
            @input=${(e: Event) => this._setFilter({ search: (e.target as HTMLInputElement).value })}
            @keydown=${this._onSearchKey}
            autocomplete="off"
          />
          ${this._entity
            ? html`<button class="icon" title="Cancel" @click=${() => (this._picking = false)}>
                <ha-icon icon="mdi:close"></ha-icon>
              </button>`
            : nothing}
        </div>
        <div class="filters">
          <select @change=${(e: Event) => this._setFilter({ domain: (e.target as HTMLSelectElement).value })}>
            <option value="" ?selected=${!f.domain}>All types</option>
            ${domains.map((d) => html`<option value=${d} ?selected=${d === f.domain}>${domainLabel(d)}</option>`)}
          </select>
          <select @change=${(e: Event) => this._setFilter({ area: (e.target as HTMLSelectElement).value })}>
            <option value="" ?selected=${!f.area}>All areas</option>
            ${areas.map(([id, name]) => html`<option value=${id} ?selected=${id === f.area}>${name}</option>`)}
            ${hasNoArea ? html`<option value="__none__" ?selected=${f.area === "__none__"}>No area</option>` : nothing}
          </select>
          <select @change=${(e: Event) => this._setFilter({ device: (e.target as HTMLSelectElement).value })}>
            <option value="" ?selected=${!f.device}>All devices</option>
            ${devices.map(([id, name]) => html`<option value=${id} ?selected=${id === f.device}>${name}</option>`)}
          </select>
        </div>
        <div class="muted small">${matches.length} match${matches.length === 1 ? "" : "es"}${f.search ? " · press Enter to pick the first" : ""}</div>
        <div class="list">
          ${shown.map(
            (o) => html`
              <div class="item ${o.entityId === this._entity ? "current" : ""}" @click=${() => this._select(o.entityId)}>
                <ha-state-icon .hass=${this.hass} .stateObj=${this.hass.states[o.entityId]}></ha-state-icon>
                <div class="item-text">
                  <div>${o.name}</div>
                  <div class="muted small">
                    ${[o.areaName, o.deviceName && o.deviceName !== o.name ? o.deviceName : "", domainLabel(o.domain)]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <span class="muted small">${this.hass.states[o.entityId]?.state}</span>
              </div>
            `,
          )}
          ${!matches.length ? html`<div class="muted empty">Nothing matches. Try clearing a filter.</div>` : nothing}
          ${matches.length > shown.length
            ? html`<div class="muted small empty">${matches.length - shown.length} more. Keep typing or use the filters.</div>`
            : nothing}
        </div>
      </div>
    `;
  }

  private _renderResult(r: Analysis) {
    const live = this.hass.states[r.entityId];
    const onNow = live ? isOnState(live.state) : r.isOn;
    return html`
      <div class="hero ${onNow ? "on" : "off"}" @click=${() => this._openMoreInfo(r.entityId)}>
        <div class="hero-icon">
          <ha-state-icon .hass=${this.hass} .stateObj=${live}></ha-state-icon>
        </div>
        <div class="hero-text">
          <span class="pill big ${onNow ? "on" : "off"}">${(live?.state ?? r.state).toUpperCase()}</span>
          <div class="muted small">since ${this._fmt(r.lastChanged)} · ${this._rel(r.lastChanged)}</div>
        </div>
      </div>

      ${this._renderExpected(r.now, onNow)} ${this._renderCause(r)}
      ${r.skipped.length ? this._renderSkipped(r) : nothing} ${this._renderNext(r.next)}
      ${r.eventDriven.length || r.disabled.length ? this._renderEventDriven(r) : nothing} ${this._renderCheck()}
      ${!r.automations.length && !r.disabled.length
        ? html`<div class="box grey"><div class="muted">No automation turns this on or off.</div></div>`
        : nothing}
    `;
  }

  private _box(color: string, icon: string, title: string, body: unknown, extra?: unknown) {
    return html`
      <div class="box ${color}">
        <div class="box-title"><ha-icon icon=${icon}></ha-icon><span>${title}</span>${extra ?? nothing}</div>
        ${body}
      </div>
    `;
  }

  private _chip(text: unknown, cls: string, icon?: string, title?: string) {
    return html`<span class="chip ${cls}" title=${title ?? ""}>${icon ? html`<ha-icon icon=${icon}></ha-icon>` : nothing}${text}</span>`;
  }

  private _condChip(description: string, result: boolean | null, note?: string) {
    const cls = result === true ? "pass" : result === false ? "fail" : "unknown";
    const icon = result === true ? "mdi:check" : result === false ? "mdi:close" : "mdi:help";
    return this._chip(description, cls, icon, note);
  }

  private _renderCause(r: Analysis) {
    const c = r.cause;
    const icons: Record<string, string> = {
      automation: "mdi:robot",
      script: "mdi:script-text",
      user: "mdi:account",
      service: "mdi:cog",
      outside: "mdi:gesture-tap",
    };
    const title = c.kind === "outside" ? "Manual, device or integration" : c.title;
    const body = html`
      <div class="line">
        <ha-icon class="lead" icon=${icons[c.kind] ?? "mdi:help"}></ha-icon>
        <div class="grow">
          <div class="strong clickable" @click=${() => this._openMoreInfo(c.automationEntity)}>${title}</div>
          ${c.kind === "outside"
            ? html`<div class="muted small">No automation did this: wall switch, app or an integration.</div>`
            : nothing}
          ${c.detail && c.kind !== "outside" && c.kind !== "user"
            ? html`<div class="chips">${this._chip(c.detail, "neutral", "mdi:flash")}</div>`
            : nothing}
          ${c.kind === "user" && c.detail ? html`<div class="muted small">${c.detail}</div>` : nothing}
          ${c.conditions?.length
            ? html`<div class="chips">${c.conditions.map((x) => this._condChip(x.description, x.result))}</div>`
            : nothing}
        </div>
      </div>
    `;
    return this._box("blue", "mdi:history", "Last change", body);
  }

  private _renderSkipped(r: Analysis) {
    const body = r.skipped.map(
      (s) => html`
        <div class="line">
          <div class="grow">
            <div>
              <span class="strong clickable" @click=${() => this._openMoreInfo(s.automationEntity)}>${s.name}</span>
              <span class="muted small"> · ${this._fmt(s.time)}</span>
            </div>
            <div class="chips">
              ${s.failed ? this._condChip(s.failed.description, false) : this._chip(s.reason, "fail", "mdi:close")}
            </div>
          </div>
        </div>
      `,
    );
    return this._box("red", "mdi:debug-step-over", "Skipped since then", body);
  }

  private _renderExpected(s: StateAt, onNow: boolean) {
    if (!s.expected || !s.decidedBy) {
      return this._box(
        "grey",
        "mdi:scale-balance",
        "Schedule",
        html`<div class="muted small">No time or sun automation decides this.</div>`,
      );
    }
    const match = (s.expected === "on") === onNow;
    const e = s.decidedBy;
    const body = html`
      <div class="line">
        <ha-icon class="lead" icon=${match ? "mdi:check-decagram" : "mdi:alert-decagram"}></ha-icon>
        <div class="grow">
          <div class="strong">${match ? "As expected" : "Not as scheduled"}</div>
          <div class="chips">
            ${this._chip(html`Should be <b>${this._stateWord(s.expected)}</b>`, s.expected === "on" ? "on" : "off")}
            ${match ? nothing : this._chip(html`Is <b>${this._stateWord(onNow ? "on" : "off")}</b>`, onNow ? "on" : "off")}
            ${s.uncertain ? this._chip("depends on conditions", "unknown", "mdi:help") : nothing}
          </div>
          <div class="muted small">
            Last: ${this._effectWord(e.effect)} · ${e.automation.name} · ${this._fmt(e.time)}
          </div>
        </div>
      </div>
    `;
    return this._box(match ? "green" : "orange", "mdi:scale-balance", "Schedule", body);
  }

  private _renderNext(groups: UpcomingGroup[]) {
    if (!groups.length) {
      return this._box(
        "purple",
        "mdi:calendar-clock",
        "Coming up",
        html`<div class="muted small">Nothing scheduled in the next 8 days.</div>`,
      );
    }
    const body = groups.map(({ first: e, nextPass, more }) => {
      const blocked = e.status === "fail";
      const kind = blocked ? "fail" : e.effect === "off" ? "off" : "on";
      const problems = blocked ? [] : e.conditions.filter((c) => c.result !== true);
      const okCount = blocked ? 0 : e.conditions.length - problems.length;
      return html`
        <div class="event">
          <div class="time ${kind}">
            <div class="t">${this._fmt(e.time)}</div>
            <div class="rel">${this._rel(e.time)}</div>
          </div>
          <div class="grow">
            <div>
              <span class="pill ${kind}">${blocked ? "blocked" : this._effectWord(e.effect)}</span>
              <span class="strong clickable" @click=${() => this._openMoreInfo(e.automation.entityId)}>${e.automation.name}</span>
            </div>
            <div class="muted small">${e.trigger.description}${more ? ` · repeats ${more}×` : ""}</div>
            <div class="chips">
              ${blocked && e.blockedBy ? this._condChip(e.blockedBy.description, false, this._basisNote(e.blockedBy)) : nothing}
              ${problems.map((c) => this._condChip(c.description, c.result, this._basisNote(c)))}
              ${okCount ? this._chip(`${okCount} condition${okCount > 1 ? "s" : ""} OK`, "pass", "mdi:check") : nothing}
              ${blocked && nextPass ? this._chip(`next: ${this._fmt(nextPass.time)}`, "neutral", "mdi:calendar-arrow-right") : nothing}
            </div>
          </div>
        </div>
      `;
    });
    return this._box("purple", "mdi:calendar-clock", "Coming up", body);
  }

  private _basisNote(c: CondEval): string | undefined {
    return c.basis === "now" ? "Checked as it is right now" : undefined;
  }

  private _renderEventDriven(r: Analysis) {
    const body = html`
      <div class="chips">
        ${r.eventDriven.map(
          ({ automation, trigger }) => html`
            <span class="chip neutral clickable" title=${trigger.description} @click=${() => this._openMoreInfo(automation.entityId)}>
              <ha-icon icon="mdi:flash"></ha-icon>${automation.name}
              <span class="muted">· ${trigger.description}</span>
            </span>
          `,
        )}
        ${r.disabled.map(
          (a) => html`
            <span class="chip disabled clickable" title="Disabled" @click=${() => this._openMoreInfo(a.entityId)}>
              <ha-icon icon="mdi:power-plug-off"></ha-icon>${a.name}
            </span>
          `,
        )}
      </div>
    `;
    return this._box("grey", "mdi:flash-outline", "Other automations", body);
  }

  private _renderCheck() {
    const c = this._check;
    const body = html`
      <div class="check">
        <input
          type="datetime-local"
          .value=${this._checkValue}
          @input=${(e: Event) => (this._checkValue = (e.target as HTMLInputElement).value)}
        />
        <button class="primary" @click=${this._doCheck}>Check</button>
      </div>
      ${c
        ? html`
            <div class="check-result">
              ${c.state.expected
                ? html`<span class="pill big ${c.state.expected}">${this._stateWord(c.state.expected)}</span>`
                : html`<span class="pill big neutral">?</span>`}
              <div class="grow">
                <div class="strong">${this._fmt(c.at)}</div>
                ${c.state.decidedBy
                  ? html`<div class="muted small">
                      <ha-icon class="tiny" icon="mdi:arrow-left"></ha-icon>
                      ${this._effectWord(c.state.decidedBy.effect)} · ${this._fmt(c.state.decidedBy.time)} · ${c.state.decidedBy.automation.name}
                    </div>`
                  : html`<div class="muted small">No schedule decides this time.</div>`}
                ${c.next
                  ? html`<div class="muted small">
                      <ha-icon class="tiny" icon="mdi:arrow-right"></ha-icon>
                      ${this._effectWord(c.next.effect)} · ${this._fmt(c.next.time)} · ${c.next.automation.name}
                    </div>`
                  : nothing}
              </div>
            </div>
          `
        : nothing}
    `;
    return this._box("teal", "mdi:crystal-ball", "Check a time", body);
  }

  static styles = css`
    :host {
      --ec-on: var(--amber-color, #ffb300);
      --ec-green: var(--green-color, #43a047);
      --ec-red: var(--red-color, #e53935);
      --ec-orange: var(--orange-color, #fb8c00);
      --ec-blue: var(--blue-color, #1e88e5);
      --ec-purple: var(--purple-color, #8e24aa);
      --ec-teal: var(--teal-color, #00897b);
      --ec-grey: var(--grey-color, #9e9e9e);
      --ec-bg: var(--card-background-color, #fff);
    }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 16px 16px 0;
      font-size: 1.2em;
      font-weight: 500;
    }
    .version {
      margin-left: auto;
      font-size: 0.6em;
      font-weight: 400;
      color: var(--secondary-text-color);
    }
    .content {
      padding: 12px 16px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    /* picker */
    .check,
    .search,
    .selected {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .picker {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .search ha-icon {
      color: var(--secondary-text-color);
    }
    .filters {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    select,
    input {
      font: inherit;
      min-width: 0;
      border-radius: 8px;
      border: 1px solid var(--divider-color, #ccc);
      background: var(--ec-bg);
      color: var(--primary-text-color);
    }
    select {
      font-size: 0.9em;
      padding: 6px 4px;
    }
    input {
      flex: 1;
      padding: 8px 10px;
    }
    .list {
      max-height: 320px;
      overflow-y: auto;
      border: 1px solid var(--divider-color, #eee);
      border-radius: 8px;
    }
    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 10px;
      cursor: pointer;
    }
    .item:hover,
    .item.current {
      background: var(--secondary-background-color);
    }
    .item-text,
    .sel-text,
    .grow {
      flex: 1;
      min-width: 0;
    }
    .item ha-state-icon,
    .selected ha-state-icon {
      color: var(--state-icon-color, var(--paper-item-icon-color));
      flex: none;
    }
    .empty {
      padding: 10px;
    }
    button {
      font: inherit;
      cursor: pointer;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: var(--primary-text-color);
    }
    button.icon {
      padding: 6px;
      display: flex;
    }
    button.icon:hover {
      background: var(--secondary-background-color);
    }
    button.primary {
      padding: 8px 16px;
      background: var(--ec-teal);
      color: #fff;
      font-weight: 500;
    }
    .loading {
      color: var(--secondary-text-color);
    }
    .error {
      color: var(--ec-red);
    }

    /* text */
    .muted {
      color: var(--secondary-text-color);
    }
    .small {
      font-size: 0.85em;
    }
    .strong,
    .big {
      font-weight: 600;
    }
    .big {
      font-size: 1.1em;
    }
    .clickable {
      cursor: pointer;
    }
    .clickable:hover {
      text-decoration: underline;
    }

    /* hero */
    .hero {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px;
      border-radius: 14px;
      cursor: pointer;
      background: color-mix(in srgb, var(--ec-grey) 14%, var(--ec-bg));
    }
    .hero.on {
      background: color-mix(in srgb, var(--ec-on) 22%, var(--ec-bg));
    }
    .hero-icon {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--ec-grey) 25%, var(--ec-bg));
      color: var(--secondary-text-color);
      flex: none;
    }
    .hero.on .hero-icon {
      background: var(--ec-on);
      color: #fff;
    }
    .hero-text {
      display: flex;
      flex-direction: column;
      gap: 4px;
      align-items: flex-start;
    }

    /* colored boxes */
    .box {
      --c: var(--ec-grey);
      border-radius: 14px;
      padding: 12px 14px;
      background: color-mix(in srgb, var(--c) 13%, var(--ec-bg));
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .box.blue {
      --c: var(--ec-blue);
    }
    .box.green {
      --c: var(--ec-green);
    }
    .box.orange {
      --c: var(--ec-orange);
    }
    .box.red {
      --c: var(--ec-red);
    }
    .box.purple {
      --c: var(--ec-purple);
    }
    .box.teal {
      --c: var(--ec-teal);
    }
    .box-title {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--secondary-text-color);
      font-size: 0.8em;
    }
    .box-title ha-icon {
      --mdc-icon-size: 20px;
      color: var(--c);
    }
    .line {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .line + .line {
      padding-top: 8px;
      border-top: 1px solid color-mix(in srgb, var(--c) 20%, transparent);
    }
    ha-icon.lead {
      color: var(--c);
      flex: none;
      --mdc-icon-size: 28px;
    }
    ha-icon.tiny {
      --mdc-icon-size: 14px;
      vertical-align: -2px;
    }

    /* chips and pills */
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
    }
    .chip {
      --k: var(--ec-grey);
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.8em;
      background: color-mix(in srgb, var(--k) 16%, var(--ec-bg));
      color: var(--primary-text-color);
      max-width: 100%;
    }
    .chip ha-icon {
      --mdc-icon-size: 14px;
      color: var(--k);
      flex: none;
    }
    .chip.pass {
      --k: var(--ec-green);
    }
    .chip.fail {
      --k: var(--ec-red);
    }
    .chip.unknown {
      --k: var(--ec-orange);
    }
    .chip.on {
      --k: var(--ec-on);
    }
    .chip.disabled {
      opacity: 0.6;
      text-decoration: line-through;
    }
    .pill {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 6px;
      font-size: 0.72em;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-right: 4px;
      background: color-mix(in srgb, var(--ec-grey) 25%, var(--ec-bg));
    }
    .pill.on {
      background: var(--ec-on);
      color: #000;
    }
    .pill.off {
      background: color-mix(in srgb, var(--ec-grey) 45%, var(--ec-bg));
    }
    .pill.fail {
      background: var(--ec-red);
      color: #fff;
    }
    .pill.big {
      font-size: 1em;
      padding: 3px 12px;
      border-radius: 8px;
    }

    /* coming up */
    .event {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .event + .event {
      padding-top: 8px;
      border-top: 1px solid color-mix(in srgb, var(--c) 20%, transparent);
    }
    .time {
      flex: none;
      width: 80px;
    }
    .time .t {
      font-weight: 700;
    }
    .time .rel {
      font-size: 0.85em;
      color: var(--c);
      font-weight: 500;
    }
    .time.fail .rel {
      color: var(--ec-red);
    }

    /* check a time */
    .check-result {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 10px;
      border-radius: 10px;
      background: var(--ec-bg);
    }
  `;
}

declare global {
  interface Window {
    customCards?: { type: string; name: string; description: string; preview?: boolean }[];
  }
}

window.customCards = window.customCards ?? [];
window.customCards.push({
  type: "entity-check-card",
  name: "Entity Check",
  description: "Shows why an entity is on or off, which automation will change it next, and what it should be at any time.",
  preview: false,
});

console.info(`%c ENTITY-CHECK-CARD %c v${VERSION} `, "color:white;background:#03a9f4;font-weight:700", "color:#03a9f4");
