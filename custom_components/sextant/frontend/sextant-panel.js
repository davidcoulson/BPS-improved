/**
 * Sextant panel: a native Home Assistant custom panel (no iframe).
 *
 * One websocket subscription (sextant/subscribe) feeds every mode; the
 * request/response commands in ws.py do the rest. Modes:
 *   live     the floor plan with trackers, trails and a history scrubber
 *   edit     the floor-plan editor
 *   devices  Bermuda trackers, candidates, Tiles and FindMy accessories
 *   health   receivers, calibration, self-test, KPI, tuning
 *   legacy   the previous editor, until the new one reaches parity
 */
import { LitElement, html, css, nothing } from "./lit.js";
import { SextantMap, trackerHue } from "./sextant-map.js";
import { sharedStyles, fmtAge, toast } from "./sextant-ui.js";
import "./sextant-devices.js";
import "./sextant-health.js";
import "./sextant-edit.js";
import "./sextant-legacy.js";

const MODES = [
  ["live", "Live", "mdi:map-marker-radius"],
  ["edit", "Edit", "mdi:vector-polygon"],
  ["devices", "Devices", "mdi:devices"],
  ["health", "Health", "mdi:heart-pulse"],
];

export function mapUrlFor(floorName, maps) {
  if (!floorName || !maps) return null;
  const norm = (s) => String(s).toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[\s_-]+/g, "");
  const want = norm(floorName);
  const hit = maps.find((m) => norm(m) === want) || maps.find((m) => norm(m).startsWith(want));
  return hit ? `/local/sextant_maps/${encodeURIComponent(hit)}` : null;
}

class SextantPanel extends LitElement {
  static properties = {
    hass: { attribute: false },
    narrow: { type: Boolean },
    panel: { attribute: false },
    route: { attribute: false },
    _mode: { state: true },
    _data: { state: true },
    _positions: { state: true },
    _floor: { state: true },
    _error: { state: true },
  };

  constructor() {
    super();
    this._mode = (() => { try { return localStorage.getItem("sextant.mode") || "live"; } catch { return "live"; } })();
    this._data = null;
    this._positions = { positions: [], offline_receivers: [], stamp: 0 };
    this._floor = null;
    this._unsub = null;
    this._error = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this._load();
    this._subscribe();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._unsub) { this._unsub.then((u) => u()).catch(() => {}); this._unsub = null; }
  }

  updated(changed) {
    if (changed.has("hass") && this.hass && !this._data && !this._loading) this._load();
    if (changed.has("hass") && this.hass && !this._unsub) this._subscribe();
  }

  async _load() {
    if (!this.hass) return;
    this._loading = true;
    try {
      const data = await this.hass.callWS({ type: "sextant/layout/get" });
      this._data = data;
      const floors = data.layout?.floor || [];
      if (!this._floor || !floors.some((f) => f.name === this._floor)) this._floor = floors[0]?.name || null;
      this._error = null;
    } catch (e) {
      this._error = e?.message || String(e);
    } finally {
      this._loading = false;
    }
  }

  _subscribe() {
    if (!this.hass?.connection || this._unsub) return;
    this._unsub = this.hass.connection.subscribeMessage(
      (payload) => { this._positions = payload; },
      { type: "sextant/subscribe" },
    );
    this._unsub.catch((e) => { this._unsub = null; this._error = `live updates: ${e?.message || e}`; });
  }

  _setMode(mode) {
    this._mode = mode;
    try { localStorage.setItem("sextant.mode", mode); } catch { /* private mode */ }
  }

  _onLayoutChanged() { this._load(); }

  render() {
    const floors = this._data?.layout?.floor || [];
    return html`
      <div class="topbar">
        <div class="brand">
          <ha-icon icon="mdi:compass-rose"></ha-icon>
          <span>Sextant</span>
        </div>
        <nav class="modes" role="tablist">
          ${MODES.map(([id, label, icon]) => html`
            <button role="tab" class=${this._mode === id ? "active" : ""} aria-selected=${this._mode === id}
                    @click=${() => this._setMode(id)} title=${label}>
              <ha-icon icon=${icon}></ha-icon><span class="mode-label">${label}</span>
            </button>`)}
          <button role="tab" class=${this._mode === "legacy" ? "active" : ""} @click=${() => this._setMode("legacy")} title="Legacy editor">
            <ha-icon icon="mdi:history"></ha-icon><span class="mode-label">Legacy</span>
          </button>
        </nav>
        <div class="spacer"></div>
        ${floors.length && this._mode !== "legacy" && this._mode !== "devices" ? html`
          <label class="floor-pick">
            <span class="sr">Floor</span>
            <select @change=${(e) => { this._floor = e.target.value; }}>
              ${floors.map((f) => html`<option value=${f.name} ?selected=${f.name === this._floor}>${f.name}</option>`)}
            </select>
          </label>` : nothing}
        <span class="stamp" title="last position update">${this._positions.stamp ? fmtAge(Date.now() / 1000 - this._positions.stamp) : "—"}</span>
      </div>
      ${this._error ? html`<div class="banner error">${this._error} <button @click=${() => this._load()}>Retry</button></div>` : nothing}
      <div class="body">${this._renderMode()}</div>
    `;
  }

  _renderMode() {
    if (!this._data && !this._error) return html`<div class="empty">Loading…</div>`;
    switch (this._mode) {
      case "edit":
        return html`<sextant-edit .hass=${this.hass} .data=${this._data} .floor=${this._floor} .narrow=${this.narrow}
                                  @layout-changed=${() => this._onLayoutChanged()} @floor-changed=${(e) => { this._floor = e.detail; }}></sextant-edit>`;
      case "devices":
        return html`<sextant-devices .hass=${this.hass} .data=${this._data} .positions=${this._positions}
                                     @layout-changed=${() => this._onLayoutChanged()}></sextant-devices>`;
      case "health":
        return html`<sextant-health .hass=${this.hass} .data=${this._data} .positions=${this._positions} .floor=${this._floor}
                                    @layout-changed=${() => this._onLayoutChanged()}></sextant-health>`;
      case "legacy":
        return html`<sextant-legacy-panel .hass=${this.hass} .narrow=${this.narrow}></sextant-legacy-panel>`;
      default:
        return html`<sextant-live .hass=${this.hass} .data=${this._data} .positions=${this._positions} .floor=${this._floor}
                                  @floor-changed=${(e) => { this._floor = e.detail; }}></sextant-live>`;
    }
  }

  static styles = [sharedStyles, css`
    :host { display: flex; flex-direction: column; height: 100vh; background: var(--primary-background-color); color: var(--primary-text-color); }
    .topbar { display: flex; align-items: center; gap: 10px; padding: 0 12px; height: 56px; background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff); flex: none; }
    .brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 18px; margin-right: 8px; }
    .modes { display: flex; gap: 2px; }
    .modes button { display: flex; align-items: center; gap: 6px; background: transparent; color: inherit; border: 0; border-bottom: 3px solid transparent; padding: 0 10px; height: 56px; cursor: pointer; font: inherit; opacity: 0.8; }
    .modes button.active { opacity: 1; border-bottom-color: currentColor; }
    .modes button:hover { opacity: 1; }
    .spacer { flex: 1; }
    .floor-pick select { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.4); background: rgba(255,255,255,0.12); color: inherit; }
    .floor-pick select option { color: #111; }
    .stamp { font-variant-numeric: tabular-nums; opacity: 0.8; font-size: 12px; min-width: 40px; text-align: right; }
    .body { flex: 1; min-height: 0; display: flex; }
    .body > * { flex: 1; min-width: 0; }
    .banner.error { background: var(--error-color, #b00020); color: #fff; padding: 8px 12px; }
    .banner button { margin-left: 8px; }
    .sr { position: absolute; left: -9999px; }
    @media (max-width: 720px) { .mode-label { display: none; } .brand span { display: none; } }
  `];
}

// --- Live mode ------------------------------------------------------------------

class SextantLive extends LitElement {
  static properties = {
    hass: { attribute: false },
    data: { attribute: false },
    positions: { attribute: false },
    floor: { type: String },
    _selected: { state: true },
    _options: { state: true },
    _history: { state: true },
    _scrub: { state: true },
  };

  constructor() {
    super();
    this._selected = null;
    this._options = { circles: false, fingerprint: false, trails: true, grid: "off", labels: true, subzones: true, receiverLabels: false };
    try { Object.assign(this._options, JSON.parse(localStorage.getItem("sextant.live.options") || "{}")); } catch { /* ignore */ }
    this._history = null; // {ent, from, to, points:[{t,x,y,f}] }
    this._scrub = null;   // seconds, absolute
    this._icons = new Map();
  }

  firstUpdated() {
    this._map = new SextantMap(this.renderRoot.querySelector("canvas"), {
      onSelect: (hit) => { this._selected = hit?.kind === "tracker" ? hit.ent : null; },
    });
    this._pushFloor();
    this._pushTrackers();
  }

  disconnectedCallback() { super.disconnectedCallback(); this._map?.destroy(); }

  updated(changed) {
    if (!this._map) return;
    if (changed.has("data") || changed.has("floor")) this._pushFloor();
    if (changed.has("positions") || changed.has("floor") || changed.has("data") || changed.has("_scrub") || changed.has("_history")) this._pushTrackers();
    if (changed.has("_options")) this._map.setOptions(this._options);
  }

  _floorObj() { return (this.data?.layout?.floor || []).find((f) => f.name === this.floor) || null; }

  _pushFloor() {
    const f = this._floorObj();
    this._map.setFloor(f, mapUrlFor(this.floor, this.data?.maps));
    this._map.setOffline(this.positions?.offline_receivers || this.data?.offline_receivers || []);
    this._map.setOptions(this._options);
  }

  _icon(ent) {
    const src = this.data?.layout?.tracker_icons?.[ent];
    if (!src) return null;
    let img = this._icons.get(src);
    if (!img) { img = new Image(); img.src = src.startsWith("/") ? src : `/sextant/${src}`; img.onload = () => this._map?.invalidate(); this._icons.set(src, img); }
    return img;
  }

  _pushTrackers() {
    const rows = (this.positions?.positions || []).filter((p) => p.floor === this.floor);
    let trackers = rows.map((p) => ({ ...p, icon: this._icon(p.ent), label: this._label(p.ent) }));
    // Scrubbing: replace the live dot of the scrubbed tracker with the past one.
    const h = this._history;
    if (h && this._scrub != null && h.ent) {
      const f = this._floorObj();
      const at = this._pointAt(h, this._scrub);
      trackers = trackers.filter((t) => t.ent !== h.ent);
      if (at && at.f === this.floor && f?.scale) {
        trackers.push({ ent: h.ent, cords: [at.x * f.scale, at.y * f.scale], zone: at.z, conf: 1, label: `${this._label(h.ent)} · ${new Date(this._scrub * 1000).toLocaleTimeString()}`, icon: this._icon(h.ent) });
      }
      this._map.clearTrails();
      if (f?.scale) {
        const pts = h.points.filter((q) => q.f === this.floor && q.t <= this._scrub).map((q) => [q.x * f.scale, q.y * f.scale]);
        this._map.setTrail(h.ent, pts);
      }
    }
    this._map.setTrackers(trackers);
    this._map.setOffline(this.positions?.offline_receivers || []);
  }

  _label(ent) { return ent.replace(/^private_ble_device_/, "").replace(/^private_ble_/, "").replace(/_/g, " "); }

  _pointAt(h, t) {
    const pts = h.points;
    if (!pts.length) return null;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pts[mid].t <= t) lo = mid; else hi = mid - 1; }
    return pts[lo].t <= t ? pts[lo] : null;
  }

  _setOption(key, value) {
    this._options = { ...this._options, [key]: value };
    try { localStorage.setItem("sextant.live.options", JSON.stringify(this._options)); } catch { /* ignore */ }
  }

  async _loadHistory(ent) {
    if (!ent) { this._history = null; this._scrub = null; this._map?.clearTrails(); return; }
    try {
      const r = await this.hass.callWS({ type: "sextant/history/get", entity: ent, max_points: 3000 });
      // f and z index into r.floors / r.zones (the record is a table of small ints).
      const points = (r.t || []).map((t, i) => ({
        t, x: r.x_m[i], y: r.y_m[i],
        f: typeof r.f?.[i] === "number" ? r.floors?.[r.f[i]] : r.f?.[i],
        z: typeof r.z?.[i] === "number" ? r.zones?.[r.z[i]] : r.z?.[i],
      }));
      this._history = { ent, from: r.from, to: r.to, points };
      this._scrub = r.to;
    } catch (e) {
      toast(this, `history: ${e?.message || e}`);
    }
  }

  render() {
    const rows = (this.positions?.positions || []).slice().sort((a, b) => a.ent.localeCompare(b.ent));
    const sel = rows.find((p) => p.ent === this._selected);
    const h = this._history;
    return html`
      <div class="stage"><canvas></canvas>
        <div class="overlay">
          ${[["circles", "Circles"], ["fingerprint", "Fingerprint"], ["trails", "Trails"], ["labels", "Labels"], ["subzones", "Sub-zones"], ["receiverLabels", "Receiver names"]].map(([k, l]) => html`
            <label><input type="checkbox" .checked=${!!this._options[k]} @change=${(e) => this._setOption(k, e.target.checked)}> ${l}</label>`)}
          <label>Grid <select @change=${(e) => this._setOption("grid", e.target.value)}>
            ${["off", "m", "ft"].map((u) => html`<option value=${u} ?selected=${this._options.grid === u}>${u}</option>`)}</select></label>
          <button class="ghost" @click=${() => this._map.fit()} title="Fit map">Fit</button>
        </div>
        ${h ? html`
          <div class="scrub">
            <span>${new Date(h.from * 1000).toLocaleTimeString()}</span>
            <input type="range" min=${h.from} max=${h.to} step="1" .value=${String(this._scrub ?? h.to)}
                   @input=${(e) => { this._scrub = Number(e.target.value); }}>
            <span>${new Date(h.to * 1000).toLocaleTimeString()}</span>
            <button class="ghost" @click=${() => this._loadHistory(null)}>Live</button>
          </div>` : nothing}
      </div>
      <aside class="side">
        <h3>Trackers <span class="muted">${rows.length}</span></h3>
        <ul class="list">
          ${rows.map((p) => html`
            <li class=${p.ent === this._selected ? "selected" : ""} @click=${() => { this._selected = p.ent; if (p.floor && p.floor !== this.floor) this.dispatchEvent(new CustomEvent("floor-changed", { detail: p.floor })); }}>
              <span class="dot" style="background: hsl(${trackerHue(p.ent)}, 70%, 45%)"></span>
              <span class="name">${this._label(p.ent)}</span>
              <span class="where">${p.zone}${p.sub_zone && p.sub_zone !== "unknown" ? ` · ${p.sub_zone}` : ""}</span>
              <span class="muted small">${p.floor}</span>
            </li>`)}
          ${rows.length ? nothing : html`<li class="muted">No positions yet.</li>`}
        </ul>
        ${sel ? html`
          <div class="card detail">
            <h4>${this._label(sel.ent)}</h4>
            <dl>
              <dt>Zone</dt><dd>${sel.zone} ${sel.zone_locked ? html`<ha-icon icon="mdi:lock" title="stationary lock"></ha-icon>` : nothing}</dd>
              <dt>Sub-zone</dt><dd>${sel.sub_zone || "—"}</dd>
              <dt>Floor</dt><dd>${sel.floor} ${sel.floors ? html`<span class="muted small">${Object.entries(sel.floors).map(([f, p]) => `${f} ${(p * 100).toFixed(0)}%`).join(" · ")}</span>` : nothing}</dd>
              <dt>Confidence</dt><dd>${sel.conf ?? "—"} ${sel.rms_m != null ? html`<span class="muted small">rms ${sel.rms_m} m</span>` : nothing}</dd>
              <dt>Estimator</dt><dd>${sel.estimator || "geometric"}${sel.fp ? html` <span class="muted small">fp ${sel.fp.conf} · ${(sel.fp.refs || []).map((r) => r[0]).slice(0, 2).join(", ")}</span>` : nothing}</dd>
              <dt>Receivers</dt><dd>${sel.radii?.length ?? 0} in the solve</dd>
              <dt>Speed</dt><dd>${sel.speed != null ? `${sel.speed} m/s` : "—"}</dd>
              <dt>Updated</dt><dd>${fmtAge(Date.now() / 1000 - sel.updated)} ago</dd>
            </dl>
            <div class="row">
              <button @click=${() => this._loadHistory(sel.ent)} ?disabled=${h?.ent === sel.ent}>Scrub history</button>
            </div>
          </div>` : nothing}
      </aside>
    `;
  }

  static styles = [sharedStyles, css`
    :host { display: grid; grid-template-columns: 1fr 300px; min-height: 0; }
    .stage { position: relative; min-width: 0; }
    canvas { width: 100%; height: 100%; display: block; --sextant-map-bg: var(--card-background-color, #fff); }
    .overlay { position: absolute; left: 10px; top: 10px; display: flex; flex-wrap: wrap; gap: 8px 12px; padding: 6px 10px; border-radius: 8px; background: var(--card-background-color); box-shadow: var(--ha-card-box-shadow, 0 1px 4px rgba(0,0,0,0.2)); font-size: 12px; align-items: center; max-width: calc(100% - 20px); }
    .overlay label { display: inline-flex; align-items: center; gap: 4px; }
    .scrub { position: absolute; left: 10px; right: 10px; bottom: 10px; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px; background: var(--card-background-color); box-shadow: var(--ha-card-box-shadow, 0 1px 4px rgba(0,0,0,0.2)); font-size: 12px; font-variant-numeric: tabular-nums; }
    .scrub input { flex: 1; }
    .side { border-left: 1px solid var(--divider-color); overflow: auto; padding: 12px; }
    .list { list-style: none; margin: 0 0 12px; padding: 0; }
    .list li { display: grid; grid-template-columns: 12px 1fr auto; grid-template-rows: auto auto; column-gap: 8px; align-items: center; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
    .list li:hover, .list li.selected { background: var(--secondary-background-color); }
    .list .name { font-weight: 600; grid-column: 2; }
    .list .where { grid-column: 3; text-align: right; font-size: 12px; }
    .list .small { grid-column: 2 / 4; }
    .dot { width: 10px; height: 10px; border-radius: 50%; grid-row: 1 / 3; }
    dl { display: grid; grid-template-columns: 90px 1fr; gap: 4px 8px; margin: 8px 0; font-size: 13px; }
    dt { color: var(--secondary-text-color); }
    dd { margin: 0; }
    @media (max-width: 720px) { :host { grid-template-columns: 1fr; grid-template-rows: 1fr auto; } .side { border-left: 0; border-top: 1px solid var(--divider-color); max-height: 40vh; } }
  `];
}

customElements.define("sextant-live", SextantLive);
customElements.define("sextant-panel", SextantPanel);
