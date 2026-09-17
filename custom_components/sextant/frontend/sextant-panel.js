/**
 * Sextant panel: a native Home Assistant custom panel (no iframe).
 *
 * One websocket subscription (sextant/subscribe) feeds every mode; the
 * request/response commands in ws.py do the rest. Modes:
 *   live         the floor plan with trackers, trails and a history scrubber
 *   edit         the floor-plan editor
 *   trackers     what Bermuda tracks, and what it hears but does not
 *   bermuda      Bermuda's own things: global options, FindMy, Tiles
 *   proxies      proxy health, grouped by floor and room, plus the self-test
 *   calibration  proxy calibration runs
 *   tuning       stability KPI, live tuning, history retention
 */
import { LitElement, html, css, nothing } from "./lit.js";
import { SextantMap, trackerHue } from "./sextant-map.js";
import { sharedStyles, widgetStyles, fmtAge, toast, ensureHaComponents, uiSwitch, uiSelect, uiButton, callWS, sortFloors, trackerName, proxyName, fmtLen, fmtSpeed, classIcon } from "./sextant-ui.js";
import "./sextant-devices.js";
import "./sextant-health.js";
import "./sextant-edit.js";

const MODES = [
  ["live", "Live", "mdi:map-marker-radius"],
  ["edit", "Edit", "mdi:vector-polygon"],
  ["trackers", "Trackers", "mdi:tag-multiple"],
  ["bermuda", "Bermuda", "mdi:bluetooth-settings"],
  ["proxies", "Proxies", "mdi:access-point-network"],
  ["calibration", "Calibration", "mdi:tune-vertical"],
  ["tuning", "Tuning", "mdi:chart-timeline-variant"],
];
const FLOOR_MODES = new Set(["live", "edit", "proxies", "calibration"]);
// Modes from before the page split (3.7.0) still stored in the browser.
const MODE_ALIASES = { devices: "trackers", health: "proxies" };
const REPO_URL = "https://github.com/davidcoulson/sextant";

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
    this._mode = (() => { try { const m = localStorage.getItem("sextant.mode") || "live"; return MODE_ALIASES[m] || m; } catch { return "live"; } })();
    if (!MODES.some(([id]) => id === this._mode)) this._mode = "live";
    this._data = null;
    this._positions = { positions: [], offline_receivers: [], stamp: 0 };
    this._floor = null;
    this._unsub = null;
    this._error = null;
  }

  connectedCallback() {
    super.connectedCallback();
    // HA's form elements are loaded by HA itself; make sure they exist before
    // the first render so the modes pick them instead of the plain fallbacks.
    ensureHaComponents().then(() => this.requestUpdate());
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
        <a class="brand" href="#" title="Back to the live map" @click=${(e) => { e.preventDefault(); this._setMode("live"); }}>
          <ha-icon icon="mdi:compass-rose"></ha-icon>
          <span class="brand-text"><span class="brand-name">Sextant</span><span class="brand-sub">Powered by Bermuda</span></span>
        </a>
        <nav class="modes" role="tablist">
          ${MODES.map(([id, label, icon]) => html`
            <button role="tab" class=${this._mode === id ? "active" : ""} aria-selected=${this._mode === id}
                    @click=${() => this._setMode(id)} title=${label}>
              <ha-icon icon=${icon}></ha-icon><span class="mode-label">${label}</span>
            </button>`)}
        </nav>
        <div class="spacer"></div>
        ${floors.length && FLOOR_MODES.has(this._mode) ? html`
          <label class="floor-pick">
            <span class="sr">Floor</span>
            <select @change=${(e) => { this._floor = e.target.value; }}>
              ${sortFloors(floors).map((f) => html`<option value=${f.name} ?selected=${f.name === this._floor}>${f.name}</option>`)}
            </select>
          </label>` : nothing}
        <span class="stamp" title="last position update">${this._positions.stamp ? fmtAge(Date.now() / 1000 - this._positions.stamp) : "—"}</span>
        <a class="repo" href=${REPO_URL} target="_blank" rel="noopener" title="Sextant on GitHub"><ha-icon icon="mdi:github"></ha-icon></a>
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
      case "trackers":
      case "bermuda":
        return html`<sextant-devices .hass=${this.hass} .data=${this._data} .positions=${this._positions} .section=${this._mode}
                                     @layout-changed=${() => this._onLayoutChanged()}></sextant-devices>`;
      case "proxies":
      case "calibration":
      case "tuning":
        return html`<sextant-health .hass=${this.hass} .data=${this._data} .positions=${this._positions} .floor=${this._floor} .section=${this._mode}
                                    @layout-changed=${() => this._onLayoutChanged()}></sextant-health>`;
      default:
        return html`<sextant-live .hass=${this.hass} .data=${this._data} .positions=${this._positions} .floor=${this._floor}
                                  @floor-changed=${(e) => { this._floor = e.detail; }}></sextant-live>`;
    }
  }

  static styles = [sharedStyles, css`
    :host { display: flex; flex-direction: column; height: 100vh; background: var(--primary-background-color); color: var(--primary-text-color); }
    .topbar { display: flex; align-items: center; gap: 10px; padding: 0 12px; height: 56px; background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff); flex: none; }
    .brand { display: flex; align-items: center; gap: 8px; margin-right: 8px; color: inherit; text-decoration: none; }
    .brand ha-icon { --mdc-icon-size: 26px; }
    .brand-text { display: flex; flex-direction: column; line-height: 1.05; }
    .brand-name { font-weight: 600; font-size: 18px; }
    .brand-sub { font-size: 9px; letter-spacing: 0.04em; opacity: 0.75; text-transform: uppercase; }
    .modes { display: flex; gap: 2px; }
    .modes button { display: flex; align-items: center; gap: 6px; background: transparent; color: inherit; border: 0; border-bottom: 3px solid transparent; padding: 0 10px; height: 56px; cursor: pointer; font: inherit; opacity: 0.8; }
    .modes button.active { opacity: 1; border-bottom-color: currentColor; }
    .modes button:hover { opacity: 1; }
    .spacer { flex: 1; }
    .floor-pick select { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.4); background: rgba(255,255,255,0.12); color: inherit; }
    .floor-pick select option { color: #111; }
    .stamp { font-variant-numeric: tabular-nums; opacity: 0.8; font-size: 12px; min-width: 40px; text-align: right; }
    .repo { color: inherit; opacity: 0.85; display: flex; align-items: center; }
    .repo:hover { opacity: 1; }
    .body { flex: 1; min-height: 0; display: flex; }
    .body > * { flex: 1; min-width: 0; }
    .banner.error { background: var(--error-color, #b00020); color: #fff; padding: 8px 12px; }
    .banner button { margin-left: 8px; }
    .sr { position: absolute; left: -9999px; }
    @media (max-width: 960px) { .mode-label { display: none; } .modes button { padding: 0 8px; } }
    @media (max-width: 720px) { .brand-text { display: none; } }
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
    _links: { state: true },
  };

  constructor() {
    super();
    this._selected = null;
    this._links = null;
    this._options = { circles: false, fingerprint: false, trails: true, grid: "off", labels: true, subzones: true, receiverLabels: false, image: true };
    try { Object.assign(this._options, JSON.parse(localStorage.getItem("sextant.live.options") || "{}")); } catch { /* ignore */ }
    this._history = null; // {ent, from, to, points:[{t,x,y,f}] }
    this._scrub = null;   // seconds, absolute
    this._icons = new Map();
  }

  firstUpdated() {
    this._map = new SextantMap(this.renderRoot.querySelector("canvas"), {
      onSelect: (hit) => { this._select(hit?.kind === "tracker" ? hit.ent : null); },
    });
    this._linksTimer = setInterval(() => { if (this._selected) this._loadLinks(); }, 10000);
    this._pushFloor();
    this._pushTrackers();
  }

  disconnectedCallback() { super.disconnectedCallback(); this._map?.destroy(); clearInterval(this._linksTimer); }

  _select(ent) {
    this._selected = ent;
    this._map?.setOptions({ focus: ent });
    if (ent) this._loadLinks(); else this._links = null;
  }

  async _loadLinks() {
    const r = await this.hass.callWS({ type: "sextant/beacon_links" }).catch(() => null);
    if (r) this._links = r.beacons || [];
  }

  updated(changed) {
    if (!this._map) return;
    if (changed.has("data") || changed.has("floor")) this._pushFloor();
    if (changed.has("positions") || changed.has("floor") || changed.has("data") || changed.has("_scrub") || changed.has("_history")) this._pushTrackers();
    if (changed.has("_options")) this._map.setOptions(this._options);
  }

  _floorObj() { return (this.data?.layout?.floor || []).find((f) => f.name === this.floor) || null; }

  _pushFloor() {
    const f = this._floorObj();
    if (f) for (const r of f.receivers || []) r.label = proxyName(this.data, r.address || r.entity_id);
    this._map.setFloor(f, mapUrlFor(this.floor, this.data?.maps));
    this._map.setOffline(this.positions?.offline_receivers || this.data?.offline_receivers || []);
    this._map.setOptions({ ...this._options, focus: this._selected });
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
    const classes = this.data?.layout?.tracker_classes || {};
    let trackers = rows.map((p) => ({ ...p, icon: this._icon(p.ent), mdi: classIcon(classes[p.ent]), label: this._label(p.ent) }));
    // Scrubbing: replace the live dot of the scrubbed tracker with the past one.
    const h = this._history;
    if (h && this._scrub != null && h.ent) {
      const f = this._floorObj();
      const at = this._pointAt(h, this._scrub);
      trackers = trackers.filter((t) => t.ent !== h.ent);
      if (at && at.f === this.floor && f?.scale) {
        trackers.push({ ent: h.ent, cords: [at.x * f.scale, at.y * f.scale], zone: at.z, conf: 1, label: `${this._label(h.ent)} · ${new Date(this._scrub * 1000).toLocaleTimeString()}`, icon: this._icon(h.ent), mdi: classIcon(classes[h.ent]) });
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

  _label(ent) { return trackerName(this.data, ent); }

  /** The same disc the map draws: the tracker's hue, with its custom icon, its class icon, or initials. */
  _avatar(ent) {
    const color = `hsl(${trackerHue(ent)}, 70%, 45%)`;
    const src = this.data?.layout?.tracker_icons?.[ent];
    const mdi = classIcon(this.data?.layout?.tracker_classes?.[ent]);
    return html`<span class="avatar" style="background: ${color}">
      ${src ? html`<img src=${src.startsWith("/") ? src : `/sextant/${src}`} alt="">` : mdi ? html`<ha-icon icon=${mdi}></ha-icon>` : html`<span class="initials">${this._label(ent).slice(0, 2).toUpperCase()}</span>`}
    </span>`;
  }

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
    const rows = (this.positions?.positions || []).slice().sort((a, b) => this._label(a.ent).localeCompare(this._label(b.ent)));
    const sel = rows.find((p) => p.ent === this._selected);
    const h = this._history;
    const switches = [
      ["image", "Map image", "Show or hide the floor-plan drawing behind the rooms"],
      ["labels", "Labels", "Room and tracker names"],
      ["trails", "Trails", "Each tracker's recent path"],
      ["subzones", "Spots", "Draw the spots (a couch, a desk, a bedside table)"],
      ["receiverLabels", "Proxy names", "Name every proxy on the map, not just the one under the pointer"],
      ["circles", "Range circles", "The distance each proxy measured, as a circle: the fix is where they meet"],
      ["fingerprint", "Fingerprint fix", "Where the fingerprint estimator alone would put each tracker (dashed), next to the published fix"],
    ];
    return html`
      <div class="stage"><canvas></canvas>
        <div class="overlay">
          <div class="chips" title="A switch and its label share a border: the word is on the right of its switch.">
            ${switches.map(([k, l, tip]) => html`<span title=${tip} class="chipwrap">${uiSwitch({ label: l, checked: !!this._options[k], onChange: (v) => this._setOption(k, v) })}</span>`)}
          </div>
          ${uiSelect({ label: "Grid", value: this._options.grid, options: [{ value: "off", label: "No grid" }, { value: "m", label: "Metres" }, { value: "ft", label: "Feet" }], onChange: (v) => this._setOption("grid", v), style: "min-width: 120px" })}
          ${uiButton({ label: "Fit map", kind: "text", icon: "mdi:fit-to-screen", onClick: () => this._map.fit() })}
        </div>
        ${h ? html`
          <div class="scrub">
            <span>${new Date(h.from * 1000).toLocaleTimeString()}</span>
            <input type="range" min=${h.from} max=${h.to} step="1" .value=${String(this._scrub ?? h.to)}
                   @input=${(e) => { this._scrub = Number(e.target.value); }}>
            <span>${new Date(h.to * 1000).toLocaleTimeString()}</span>
            ${uiButton({ label: "Back to live", kind: "text", onClick: () => this._loadHistory(null) })}
          </div>` : nothing}
      </div>
      <aside class="side">
        <h3>Trackers <span class="muted">${rows.length}</span></h3>
        <ul class="list">
          ${rows.map((p) => html`
            <li class=${p.ent === this._selected ? "selected" : ""} @click=${() => { this._select(p.ent === this._selected ? null : p.ent); if (p.floor && p.floor !== this.floor) this.dispatchEvent(new CustomEvent("floor-changed", { detail: p.floor })); }}>
              ${this._avatar(p.ent)}
              <span class="name">${this._label(p.ent)}</span>
              <span class="where">${p.zone}${p.sub_zone && p.sub_zone !== "unknown" ? ` · ${p.sub_zone}` : ""}</span>
              <span class="muted small">${p.floor}</span>
            </li>`)}
          ${rows.length ? nothing : html`<li class="muted">No positions yet.</li>`}
        </ul>
        ${sel ? html`
          <div class="card detail">
            <h4>${this._label(sel.ent)} <span class="muted small">click the row again to unfocus</span></h4>
            <dl>
              <dt>Room</dt><dd>${sel.zone} ${sel.zone_locked ? html`<ha-icon icon="mdi:lock" title="stationary lock"></ha-icon>` : nothing}</dd>
              <dt>Spot</dt><dd>${sel.sub_zone || "—"} ${sel.sub_zones ? html`<span class="muted small">${Object.entries(sel.sub_zones).sort((a, b) => b[1] - a[1]).map(([s, p]) => `${s === "unknown" ? "none" : s} ${(p * 100).toFixed(0)}%`).join(" · ")}</span>` : nothing}</dd>
              <dt>Floor</dt><dd>${sel.floor} ${sel.floors ? html`<span class="muted small">${Object.entries(sel.floors).map(([f, p]) => `${f} ${(p * 100).toFixed(0)}%`).join(" · ")}</span>` : nothing}</dd>
              <dt>Confidence</dt><dd>${sel.conf ?? "—"} ${sel.rms_m != null ? html`<span class="muted small">rms ${fmtLen(sel.rms_m, this.hass)}</span>` : nothing}</dd>
              <dt>Estimator</dt><dd>${sel.estimator || "geometric"}${sel.fp ? html` <span class="muted small">fp ${sel.fp.conf}${sel.fp.gain != null ? ` · gain ×${sel.fp.gain}` : ""} · ${(sel.fp.refs || []).map((r) => proxyName(this.data, r[0])).slice(0, 2).join(", ")}</span>` : nothing}</dd>
              <dt>Proxies</dt><dd>${sel.radii?.length ?? 0} in the solve${sel.anchor ? html`<br><span class="pill ok" title="one proxy reads it within arm's reach and no other comes close: placed on that proxy">anchored to ${proxyName(this.data, sel.anchor)}</span>` : nothing}</dd>
              <dt>Speed</dt><dd>${fmtSpeed(sel.speed, this.hass)}</dd>
              <dt>Updated</dt><dd>${fmtAge(Date.now() / 1000 - sel.updated)} ago</dd>
            </dl>
            <div class="row">
              ${uiButton({ label: "Scrub history", icon: "mdi:history", disabled: h?.ent === sel.ent, onClick: () => this._loadHistory(sel.ent) })}
            </div>
            ${this._renderLinks(sel.ent)}
          </div>` : nothing}
      </aside>
    `;
  }

  _renderLinks(ent) {
    const row = (this._links || []).find((b) => b.device === ent);
    if (!row) return html`<div class="muted small">Loading proxies…</div>`;
    // Only proxies placed on a floor plan take part in positioning; the rest (a kiosk, a test board) are noise here.
    const placedSlugs = new Set((this.data?.layout?.floor || []).flatMap((f) => (f.receivers || []).map((r) => r.entity_id)));
    const placedAddr = new Set((this.data?.layout?.floor || []).flatMap((f) => (f.receivers || []).map((r) => String(r.address || "").toLowerCase())));
    const addrOf = (slug) => Object.entries(this.data?.scanners || {}).find(([, s]) => s.slug === slug)?.[0];
    const everything = row.receivers || [];
    const recs = everything.filter((r) => placedSlugs.has(r.scanner) || placedAddr.has(String(addrOf(r.scanner) || "").toLowerCase()));
    const dropped = everything.length - recs.length;
    return html`<details open class="links">
      <summary>Heard by ${recs.length} placed proxy${recs.length === 1 ? "" : "ies"}${dropped ? html` <span class="muted small">(+${dropped} unplaced and ignored)</span>` : nothing}</summary>
      <table class="small"><tr><th>Proxy</th><th class="num">Distance</th></tr>
        ${recs.slice(0, 16).map((r) => html`<tr><td>${proxyName(this.data, r.scanner)}</td><td class="num">${fmtLen(r.distance, this.hass)}</td></tr>`)}
        ${recs.length > 16 ? html`<tr><td class="muted" colspan="2">and ${recs.length - 16} more</td></tr>` : nothing}
      </table>
    </details>`;
  }

  static styles = [sharedStyles, widgetStyles, css`
    :host { display: grid; grid-template-columns: 1fr 300px; min-height: 0; }
    .stage { position: relative; min-width: 0; }
    canvas { width: 100%; height: 100%; display: block; --sextant-map-bg: var(--card-background-color, #fff); }
    .overlay { position: absolute; left: 10px; top: 10px; display: flex; flex-wrap: wrap; gap: 8px 12px; padding: 6px 10px; border-radius: 8px; background: var(--card-background-color); box-shadow: var(--ha-card-box-shadow, 0 1px 4px rgba(0,0,0,0.2)); font-size: 12px; align-items: center; max-width: calc(100% - 20px); }
    .overlay ha-formfield { --mdc-typography-body2-font-size: 12px; }
    .chipwrap { display: inline-flex; }
    .chipwrap > ha-formfield, .chipwrap > label.inline { border: 1px solid var(--divider-color); border-radius: 999px; padding: 0 12px 0 2px; }
    .chipwrap > label.inline { padding: 4px 12px 4px 8px; }
    .links table { margin-top: 6px; }
    .scrub { position: absolute; left: 10px; right: 10px; bottom: 10px; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px; background: var(--card-background-color); box-shadow: var(--ha-card-box-shadow, 0 1px 4px rgba(0,0,0,0.2)); font-size: 12px; font-variant-numeric: tabular-nums; }
    .scrub input { flex: 1; }
    .side { border-left: 1px solid var(--divider-color); overflow: auto; padding: 12px; }
    .list { list-style: none; margin: 0 0 12px; padding: 0; }
    .list li { display: grid; grid-template-columns: 30px 1fr auto; grid-template-rows: auto auto; column-gap: 10px; align-items: center; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
    .avatar { grid-row: 1 / 3; width: 30px; height: 30px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.15); display: flex; align-items: center; justify-content: center; overflow: hidden; color: #fff; }
    .avatar ha-icon { --mdc-icon-size: 18px; }
    .avatar img { width: 100%; height: 100%; object-fit: cover; }
    .avatar .initials { font-size: 11px; font-weight: 700; }
    .list li:hover, .list li.selected { background: var(--secondary-background-color); }
    .list li.selected { outline: 2px solid var(--primary-color); }
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
