/**
 * Sextant map card for Lovelace, on the same renderer as the panel.
 *
 *   type: custom:sextant-map-card
 *   floor: Ground Floor          # default: the first floor
 *   entities: [fry, leela]       # default: every tracker on that floor
 *   height: 420                  # px
 *   circles: false               # solver circles
 *   trails: true                 # recent trail per tracker
 *   labels: true
 *   subzones: true               # draw the spots
 *   follow: false                # switch floor to follow the first entity
 *
 * Resource: /sextant/sextant-map-card.js (module).
 */
import { LitElement, html, css, nothing } from "./lit.js";
import { SextantMap } from "./sextant-map.js";
import { sortFloors, classIcon, trackerName } from "./sextant-ui.js";

function mapUrlFor(floorName, maps) {
  if (!floorName || !maps) return null;
  const norm = (s) => String(s).toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[\s_-]+/g, "");
  const want = norm(floorName);
  const hit = maps.find((m) => norm(m) === want) || maps.find((m) => norm(m).startsWith(want));
  return hit ? `/local/sextant_maps/${encodeURIComponent(hit)}` : null;
}

class SextantMapCard extends LitElement {
  static properties = { hass: { attribute: false }, _config: { state: true }, _data: { state: true }, _positions: { state: true }, _floor: { state: true } };

  static getConfigElement() { return document.createElement("sextant-map-card-editor"); }
  static getStubConfig() { return { height: 360, trails: true }; }

  setConfig(config) {
    this._config = { height: 360, circles: false, trails: true, labels: true, subzones: true, follow: false, ...config };
    this._floor = this._config.floor || this._floor;
  }

  getCardSize() { return Math.ceil((this._config?.height || 360) / 50); }

  connectedCallback() { super.connectedCallback(); this._load(); this._subscribe(); }
  disconnectedCallback() { super.disconnectedCallback(); if (this._unsub) { this._unsub.then((u) => u()).catch(() => {}); this._unsub = null; } this._map?.destroy(); this._map = null; }

  updated(changed) {
    if (changed.has("hass") && this.hass) { if (!this._data && !this._loading) this._load(); if (!this._unsub) this._subscribe(); }
    if (!this._map) {
      const canvas = this.renderRoot.querySelector("canvas");
      if (canvas) this._map = new SextantMap(canvas, {});
    }
    if (this._map) this._push();
  }

  async _load() {
    if (!this.hass) return;
    this._loading = true;
    try {
      this._data = await this.hass.callWS({ type: "sextant/layout/get" });
      if (!this._floor) this._floor = this._config?.floor || this._data.layout?.floor?.[0]?.name || null;
    } catch (e) { this._error = e?.message || String(e); }
    finally { this._loading = false; }
  }

  _subscribe() {
    if (!this.hass?.connection || this._unsub) return;
    this._unsub = this.hass.connection.subscribeMessage((payload) => {
      this._positions = payload;
      if (this._config?.follow && this._config.entities?.length) {
        const first = payload.positions?.find((p) => p.ent === this._config.entities[0]);
        if (first?.floor && first.floor !== this._floor) this._floor = first.floor;
      }
    }, { type: "sextant/subscribe" });
    this._unsub.catch(() => { this._unsub = null; });
  }

  _push() {
    const layout = this._data?.layout;
    const floor = (layout?.floor || []).find((f) => f.name === this._floor) || null;
    const url = this._config?.image || this._config?.map_file ? (this._config.image || `/local/sextant_maps/${this._config.map_file}`) : mapUrlFor(this._floor, this._data?.maps);
    this._map.setFloor(floor, url);
    this._map.setOptions({ circles: !!this._config.circles, trails: !!this._config.trails, labels: this._config.labels !== false, subzones: this._config.subzones !== false, fingerprint: false });
    this._map.setOffline(this._positions?.offline_receivers || []);
    const wanted = this._config.entities?.length ? new Set(this._config.entities) : null;
    const rows = (this._positions?.positions || []).filter((p) => p.floor === this._floor && (!wanted || wanted.has(p.ent)));
    const icons = layout?.tracker_icons || {};
    this._icons = this._icons || new Map();
    const classes = layout?.tracker_classes || {};
    this._map.setTrackers(rows.map((p) => ({ ...p, icon: this._icon(icons[p.ent]), mdi: classIcon(classes[p.ent]), label: trackerName(this._data, p.ent) })));
    if (this._config.trails) for (const p of rows) this._trail(p);
  }

  _icon(src) {
    if (!src) return null;
    let img = this._icons.get(src);
    if (!img) { img = new Image(); img.src = src.startsWith("/") ? src : `/sextant/${src}`; img.onload = () => this._map?.invalidate(); this._icons.set(src, img); }
    return img;
  }

  _trail(p) {
    this._trails = this._trails || new Map();
    const t = this._trails.get(p.ent) || [];
    const last = t[t.length - 1];
    if (!last || Math.hypot(last[0] - p.cords[0], last[1] - p.cords[1]) > 2) t.push([p.cords[0], p.cords[1]]);
    while (t.length > 60) t.shift();
    this._trails.set(p.ent, t);
    this._map.setTrail(p.ent, t);
  }

  render() {
    const floors = this._data?.layout?.floor || [];
    return html`<ha-card>
      ${this._config?.title ? html`<h1 class="card-header">${this._config.title}</h1>` : nothing}
      <div class="stage" style="height:${this._config?.height || 360}px">
        <canvas></canvas>
        ${floors.length > 1 && !this._config?.floor ? html`<select class="floor" @change=${(e) => { this._floor = e.target.value; }}>
          ${sortFloors(floors).map((f) => html`<option value=${f.name} ?selected=${f.name === this._floor}>${f.name}</option>`)}</select>` : nothing}
        ${this._error ? html`<div class="err">${this._error}</div>` : nothing}
      </div>
    </ha-card>`;
  }

  static styles = css`
    .stage { position: relative; }
    canvas { width: 100%; height: 100%; display: block; --sextant-map-bg: var(--card-background-color, #fff); border-radius: 0 0 var(--ha-card-border-radius, 12px) var(--ha-card-border-radius, 12px); }
    .floor { position: absolute; right: 8px; top: 8px; font: inherit; padding: 4px 6px; border-radius: 6px; }
    .err { position: absolute; left: 8px; bottom: 8px; background: var(--error-color); color: #fff; padding: 4px 8px; border-radius: 6px; font-size: 12px; }
  `;
}

class SextantMapCardEditor extends LitElement {
  static properties = { hass: { attribute: false }, _config: { state: true }, _floors: { state: true } };
  setConfig(config) { this._config = { ...config }; }
  async firstUpdated() { try { const d = await this.hass.callWS({ type: "sextant/layout/get" }); this._floors = (d.layout?.floor || []).map((f) => f.name); this._entities = d.entities; } catch { /* keep manual */ } }
  _set(key, value) {
    const config = { ...this._config };
    if (value === "" || value == null || value === false && key !== "trails" && key !== "labels" && key !== "subzones") delete config[key]; else config[key] = value;
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }
  render() {
    const c = this._config || {};
    return html`<div class="form">
      <label>Title <input type="text" .value=${c.title || ""} @change=${(e) => this._set("title", e.target.value)}></label>
      <label>Floor <select @change=${(e) => this._set("floor", e.target.value)}><option value="">first / follow</option>${(this._floors || []).map((f) => html`<option value=${f} ?selected=${c.floor === f}>${f}</option>`)}</select></label>
      <label>Entities (comma separated, blank = all) <input type="text" .value=${(c.entities || []).join(", ")} @change=${(e) => this._set("entities", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}></label>
      <label>Height px <input type="number" .value=${c.height || 360} @change=${(e) => this._set("height", Number(e.target.value))}></label>
      ${[["circles", "Solver circles"], ["trails", "Trails"], ["labels", "Labels"], ["subzones", "Sub-zones"], ["follow", "Follow first entity's floor"]].map(([k, l]) => html`<label class="inline"><input type="checkbox" .checked=${c[k] ?? (k === "trails" || k === "labels" || k === "subzones")} @change=${(e) => this._set(k, e.target.checked)}> ${l}</label>`)}
    </div>`;
  }
  static styles = css`.form { display: grid; gap: 8px; padding: 8px 0; } label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; } label.inline { flex-direction: row; align-items: center; } input, select { font: inherit; padding: 6px; }`;
}

if (!customElements.get("sextant-map-card")) customElements.define("sextant-map-card", SextantMapCard);
if (!customElements.get("sextant-map-card-editor")) customElements.define("sextant-map-card-editor", SextantMapCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({ type: "sextant-map-card", name: "Sextant Map", description: "Trackers on a Sextant floor plan, live.", preview: true, documentationURL: "https://github.com/davidcoulson/sextant" });
