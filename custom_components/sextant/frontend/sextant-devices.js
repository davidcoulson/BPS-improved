/**
 * Trackers and Bermuda modes: Bermuda without its options flow.
 *
 * section="trackers": what Bermuda tracks, with each tracker's Sextant
 * settings, and everything it hears but does not track (one click to track).
 * section="bermuda": Bermuda's own things - global options, FindMy
 * accessories and the Tiles' binding state.
 */
import { LitElement, html, css, nothing } from "./lit.js";
import { sharedStyles, widgetStyles, fmtAge, fmtNum, toast, callWS, confirmDialog, slugLabel, uiField, uiSelect, uiSwitch, uiButton, trackerName, fmtLen, lenUnit, toDisplayLen, fromDisplayLen } from "./sextant-ui.js";

const KIND_FILTERS = [["all", "Everything"], ["tile", "Tiles"], ["ibeacon", "iBeacons"], ["device", "Other devices"]];
const RECENT_SECS = 60;

class SextantDevices extends LitElement {
  static properties = {
    hass: { attribute: false },
    data: { attribute: false },
    positions: { attribute: false },
    section: { type: String },
    _tracked: { state: true },
    _candidates: { state: true },
    _tiles: { state: true },
    _identities: { state: true },
    _bindPick: { state: true },
    _findmy: { state: true },
    _options: { state: true },
    _filter: { state: true },
    _kind: { state: true },
    _showAll: { state: true },
    _busy: { state: true },
    _findmyJson: { state: true },
    _findmyName: { state: true },
  };

  constructor() {
    super();
    this.section = "trackers";
    this._tracked = null;
    this._candidates = null;
    this._tiles = null;
    this._identities = null;
    this._bindPick = {};
    this._findmy = null;
    this._options = null;
    this._filter = "";
    this._kind = "all";
    this._showAll = false;
    this._busy = false;
    this._findmyJson = "";
    this._findmyName = "";
  }

  connectedCallback() {
    super.connectedCallback();
    this._refresh();
    this._timer = setInterval(() => this._refreshLight(), 15000);
  }

  disconnectedCallback() { super.disconnectedCallback(); clearInterval(this._timer); }

  get _hasApi() { return (this.data?.features || []).includes("device_management"); }

  async _refresh() {
    if (!this.hass) return;
    const [tracked, candidates, tiles, findmy, options, identities] = await Promise.all([
      this.hass.callWS({ type: "sextant/bermuda/tracked" }).catch(() => null),
      this.hass.callWS({ type: "sextant/bermuda/candidates" }).catch(() => null),
      this.hass.callWS({ type: "sextant/bermuda/tiles" }).catch(() => null),
      this.hass.callWS({ type: "sextant/bermuda/findmy" }).catch(() => null),
      this.hass.callWS({ type: "sextant/bermuda/options" }).catch(() => null),
      this.hass.callWS({ type: "sextant/bermuda/tile_identities" }).catch(() => null),
    ]);
    this._tracked = tracked?.tracked ?? null;
    this._candidates = candidates?.candidates ?? null;
    this._tiles = tiles?.tiles ?? null;
    this._identities = identities?.identities ?? null;
    this._findmy = findmy?.accessories ?? null;
    this._options = options?.options ?? null;
  }

  async _refreshLight() {
    if (!this.hass) return;
    const [candidates, tiles, identities] = await Promise.all([
      this.hass.callWS({ type: "sextant/bermuda/candidates" }).catch(() => null),
      this.hass.callWS({ type: "sextant/bermuda/tiles" }).catch(() => null),
      this.hass.callWS({ type: "sextant/bermuda/tile_identities" }).catch(() => null),
    ]);
    if (candidates) this._candidates = candidates.candidates;
    if (tiles) this._tiles = tiles.tiles;
    if (identities) this._identities = identities.identities;
  }

  async _bindTile(uid) {
    const tileId = this._bindPick[uid];
    if (!tileId) return;
    const r = await callWS(this, this.hass, { type: "sextant/bermuda/tile/bind", tile_id: tileId, uid });
    if (r) {
      toast(this, r.address ? `${slugLabel(tileId)} is now ${r.address}` : `${slugLabel(tileId)} remembered as ${uid}; it binds when that Tile is next heard`);
      this._bindPick = { ...this._bindPick, [uid]: "" };
      await this._refreshLight();
    }
  }

  async _track(add, remove) {
    this._busy = true;
    const r = await callWS(this, this.hass, { type: "sextant/bermuda/track", add, remove });
    this._busy = false;
    if (r) {
      toast(this, add.length ? `Tracking ${add.join(", ")}. Bermuda is reloading…` : `Stopped tracking ${remove.join(", ")}.`);
      setTimeout(() => { this._refresh(); this.dispatchEvent(new CustomEvent("layout-changed")); }, 4000);
    }
  }

  async _tune(entity, patch) {
    const r = await callWS(this, this.hass, { type: "sextant/tracker/tune", entity, ...patch });
    if (r) { toast(this, `${trackerName(this.data, entity)} updated`); this.dispatchEvent(new CustomEvent("layout-changed")); }
  }

  async _uploadIcon(entity, file) {
    if (!file) return;
    const form = new FormData();
    form.append("icon", file, file.name);
    try {
      const resp = await this.hass.fetchWithAuth("/api/sextant/upload_tracker_icon", { method: "POST", body: form });
      if (!resp.ok) throw new Error(await resp.text());
      const body = await resp.json().catch(() => ({}));
      const value = body.value || body.path || `/local/sextant_icons/${file.name}`;
      await this._tune(entity, { icon: value });
    } catch (e) {
      toast(this, `icon upload failed: ${e.message || e}`, 6000);
    }
  }

  async _addFindMy() {
    if (!this._findmyJson.trim()) return;
    const r = await callWS(this, this.hass, { type: "sextant/bermuda/findmy/add", accessory_json: this._findmyJson, name: this._findmyName || null });
    if (r) { toast(this, `Added ${r.name || "accessory"}`); this._findmyJson = ""; this._findmyName = ""; this._refresh(); }
  }

  async _removeFindMy(address, name) {
    if (!confirmDialog(`Remove FindMy accessory ${name}?`)) return;
    const r = await callWS(this, this.hass, { type: "sextant/bermuda/findmy/remove", address });
    if (r) { toast(this, "Removed"); this._refresh(); }
  }

  async _saveOptions() {
    const options = {};
    for (const [key, value] of Object.entries(this._options || {})) if (value !== null && value !== undefined) options[key] = value;
    const r = await callWS(this, this.hass, { type: "sextant/bermuda/options/set", options });
    if (r) { toast(this, "Bermuda options saved; Bermuda is reloading…"); this._options = r.options; }
  }

  render() {
    if (!this._hasApi) {
      return html`<div class="page"><div class="card">This Bermuda build has no device-management API. Update Bermuda to fork-testing.15 or later to manage trackers from here.</div></div>`;
    }
    return html`<div class="page">${this.section === "bermuda" ? this._renderBermuda() : this._renderTrackers()}</div>`;
  }

  // --- Trackers ------------------------------------------------------------------

  /** The proxies' own iBeacon (every ESPHome probe advertises the same one) is not a device to track. */
  _isProxyBeacon(c) {
    if (c.kind !== "ibeacon") return false;
    const names = new Set(Object.values(this.data?.scanners || {}).flatMap((s) => [s.name, s.slug]).filter(Boolean).map((n) => n.toLowerCase()));
    return names.has(String(c.name || "").toLowerCase());
  }

  _renderTrackers() {
    const layout = this.data?.layout || {};
    const heights = layout.tracker_heights || {}, offsets = layout.tracker_ref_offsets || {}, icons = layout.tracker_icons || {};
    const live = new Map((this.positions?.positions || []).map((p) => [p.ent, p]));
    const tracked = Object.entries(this._tracked || {}).sort((a, b) => trackerName(this.data, a[1].slug).localeCompare(trackerName(this.data, b[1].slug)));
    const filter = this._filter.toLowerCase();
    const all = (this._candidates || []).filter((c) => !this._isProxyBeacon(c));
    const recent = all.filter((c) => (c.last_seen_age ?? 1e9) <= RECENT_SECS);
    const candidates = (this._showAll ? all : recent)
      .filter((c) => (this._kind === "all" || c.kind === this._kind) && (!filter || `${c.name} ${c.address} ${c.manufacturer || ""} ${c.area_name || ""}`.toLowerCase().includes(filter)))
      .sort((a, b) => (a.last_seen_age ?? 1e9) - (b.last_seen_age ?? 1e9));
    const unit = lenUnit(this.hass);
    return html`
      <section class="card">
        <h3>Tracked <span class="muted">${tracked.length}</span></h3>
        <div class="wrap"><table>
          <tr><th>Tracker</th><th>Where</th><th class="num">Height / ref trim</th><th>Icon</th><th></th></tr>
          ${tracked.map(([address, d]) => {
            const slug = d.slug, p = live.get(slug), name = trackerName(this.data, slug);
            return html`<tr>
              <td class="who">
                ${icons[slug] ? html`<img class="icon" src=${icons[slug]} alt="">` : html`<ha-icon class="icon" icon="mdi:tag-outline"></ha-icon>`}
                <div><b>${name}</b><br><span class="muted small">${address}${d.name && d.name !== name ? ` · Bermuda: ${d.name}` : ""}</span></div>
              </td>
              <td>${p ? html`${p.zone}<br><span class="muted small">${p.floor}</span>` : html`<span class="muted">—</span>`}</td>
              <td class="num stack">
                ${uiField({ label: `Height (${unit})`, type: "number", step: 0.05, min: 0, max: 20, value: toDisplayLen(heights[slug], this.hass), placeholder: toDisplayLen(1.0, this.hass), style: "width: 110px", onChange: (v) => this._tune(slug, { height: fromDisplayLen(v, this.hass) }) })}
                ${uiField({ label: "Ref trim (dB)", type: "number", step: 0.5, min: -20, max: 20, value: offsets[slug] ?? "", placeholder: "0", style: "width: 110px", onChange: (v) => this._tune(slug, { ref_offset_db: v === "" ? null : Number(v) }) })}
              </td>
              <td>
                <div class="row">
                  ${uiSelect({ value: icons[slug] || "", options: [{ value: "", label: "default" }, ...(this.data?.icons || []).map((i) => ({ value: i.value, label: i.label }))], onChange: (v) => this._tune(slug, { icon: v || null }), style: "min-width: 130px" })}
                  <label class="btn small" title="Upload an icon">⤒<input type="file" accept="image/*" hidden @change=${(e) => this._uploadIcon(slug, e.target.files[0])}></label>
                </div>
              </td>
              <td><button class="iconbtn danger" title="Stop tracking ${name}" ?disabled=${this._busy} @click=${() => confirmDialog(`Stop tracking ${name}?`) && this._track([], [address])}><ha-icon icon="mdi:trash-can-outline"></ha-icon></button></td>
            </tr>`;
          })}
          ${tracked.length ? nothing : html`<tr><td colspan="5" class="muted">Nothing tracked yet.</td></tr>`}
        </table></div>
        <p class="small muted">Names come from the device in Home Assistant: rename it under Settings › Devices and it changes here. Height is how high the tracker is usually carried or placed.</p>
      </section>

      <section class="card">
        <h3>Heard, not tracked <span class="muted">${candidates.length}${this._showAll ? "" : ` in the last ${RECENT_SECS} s`}</span></h3>
        <div class="row">
          <input class="grow" type="search" placeholder="Filter by name, address, maker or area" .value=${this._filter} @input=${(e) => { this._filter = e.target.value; }}>
          ${uiSelect({ label: "Kind", value: this._kind, options: KIND_FILTERS.map(([v, l]) => ({ value: v, label: l })), onChange: (v) => { this._kind = v; }, style: "min-width: 150px" })}
          <span class="chips">${uiSwitch({ label: `Show all (${all.length})`, checked: this._showAll, onChange: (v) => { this._showAll = v; } })}</span>
          ${uiButton({ label: "Refresh", kind: "text", icon: "mdi:refresh", onClick: () => this._refreshLight() })}
        </div>
        <div class="wrap"><table>
          <tr><th>Device</th><th>Maker</th><th class="num">Proxies</th><th class="num">Best dBm</th><th>Seen</th><th></th></tr>
          ${candidates.slice(0, 200).map((c) => html`<tr>
            <td><b>${c.name}</b><br><span class="muted small">${c.address}</span>${c.area_name ? html`<br><span class="muted small">${c.area_name}</span>` : nothing}</td>
            <td>${c.kind === "tile" ? html`<span class="pill">Tile</span>` : c.kind === "ibeacon" ? html`<span class="pill">iBeacon</span>` : nothing} ${c.manufacturer || (c.kind === "device" ? html`<span class="muted">unknown</span>` : "")}</td>
            <td class="num">${c.scanners}</td>
            <td class="num">${c.best_rssi ?? "—"}</td>
            <td class="small">${fmtAge(c.last_seen_age)} ago<br><span class="muted">first ${fmtAge(c.first_seen_age)}</span></td>
            <td>${uiButton({ label: "Track", kind: "primary", disabled: this._busy, onClick: () => this._track([c.config_value], []) })}</td>
          </tr>`)}
          ${candidates.length ? nothing : html`<tr><td colspan="6" class="muted">${this._candidates ? (this._showAll ? "No matching devices." : `Nothing heard in the last ${RECENT_SECS} s matches; switch on "Show all" for everything Bermuda remembers.`) : "Loading…"}</td></tr>`}
        </table></div>
      </section>`;
  }

  // --- Bermuda -------------------------------------------------------------------

  _renderBermuda() {
    return html`<div class="cols">
      <section class="card">
        <h3>Bermuda global options</h3>
        ${this._options ? html`
          <form @submit=${(e) => { e.preventDefault(); this._saveOptions(); }}>
            <div class="row">
              ${[["ref_power", "Ref power (dBm at 1 m)", 1], ["attenuation", "Attenuation", 0.1], ["max_area_radius", "Max area radius (m)", 0.1],
                 ["max_velocity", "Max velocity (m/s)", 0.1], ["devtracker_nothome_timeout", "Not-home timeout (s)", 1],
                 ["update_interval", "Update interval (s)", 0.1], ["smoothing_samples", "Smoothing samples", 1]].map(([k, l, step]) =>
                uiField({ label: l, type: "number", step, value: this._options[k] ?? "", style: "width: 170px", onChange: (v) => { this._options = { ...this._options, [k]: v === "" ? null : Number(v) }; } }))}
              <span class="chips">${uiSwitch({ label: "Create scanner entities", checked: !!this._options.create_scanner_entities, onChange: (v) => { this._options = { ...this._options, create_scanner_entities: v }; } })}</span>
            </div>
            <div class="row">${uiButton({ label: "Save options", kind: "primary", onClick: () => this._saveOptions() })}<span class="muted small">Bermuda reloads to apply. These are Bermuda's units, metres and dBm.</span></div>
          </form>` : html`<div class="muted">Loading…</div>`}
      </section>

      <section class="card">
        <h3>FindMy accessories <span class="muted">${(this._findmy || []).length}</span></h3>
        <div class="wrap"><table>
          <tr><th>Accessory</th><th>Model</th><th>Status</th><th></th></tr>
          ${(this._findmy || []).map((a) => html`<tr>
            <td><b>${a.name}</b><br><span class="muted small">${a.address}</span></td>
            <td>${a.model || "—"}</td>
            <td>${a.current_source ? html`<span class="pill ok">seen as ${a.current_source}</span> <span class="muted small">${fmtAge(a.last_seen_age)} ago</span>` : a.alignment_index ? html`<span class="pill warn">aligned, not visible</span>` : html`<span class="pill">searching</span>`}</td>
            <td><button class="iconbtn danger" title="Remove ${a.name}" @click=${() => this._removeFindMy(a.address, a.name)}><ha-icon icon="mdi:trash-can-outline"></ha-icon></button></td>
          </tr>`)}
          ${(this._findmy || []).length ? nothing : html`<tr><td colspan="4" class="muted">None configured.</td></tr>`}
        </table></div>
        <details>
          <summary>Add an accessory</summary>
          <p class="muted small">Paste the key JSON exported with FindMy.py's <code>FindMyAccessory.to_json()</code>.</p>
          <textarea placeholder='{"master_key": "...", ...}' .value=${this._findmyJson} @input=${(e) => { this._findmyJson = e.target.value; }}></textarea>
          <div class="row">
            ${uiField({ label: "Name (optional)", value: this._findmyName, onChange: (v) => { this._findmyName = v; }, style: "flex: 1" })}
            ${uiButton({ label: "Add accessory", kind: "primary", onClick: () => this._addFindMy() })}
          </div>
        </details>
      </section>

      <section class="card wide">
        <h3>Tiles</h3>
        ${this._renderTiles()}
      </section>
    </div>`;
  }

  _renderTiles() {
    const t = this._tiles;
    if (!t) return html`<div class="muted">Loading…</div>`;
    const bindings = Object.entries(t.bindings || {});
    if (!bindings.length) return html`<div class="muted">No Tiles configured. Track one from the Trackers page; Tiles show as <span class="pill">Tile</span>.</div>`;
    return html`
      <div class="wrap"><table>
        <tr><th>Tile</th><th>Bound address</th><th>Tile ID</th><th>History</th></tr>
        ${bindings.map(([id, sources]) => html`<tr>
          <td><b>${trackerName(this.data, id)}</b></td>
          <td><code>${sources[0] || "—"}</code>${t.bound_age?.[id] != null ? html` <span class="muted small">heard ${fmtAge(t.bound_age[id])} ago</span>` : html` <span class="pill warn">not heard</span>`}</td>
          <td>${t.uids?.[id] ? html`<code>${t.uids[id]}</code>` : t.uids && id in t.uids ? html`<span class="pill warn">no ID characteristic</span>` : html`<span class="pill">not read yet</span>`}</td>
          <td class="small muted">${sources.slice(1, 4).join(" → ") || "—"}</td>
        </tr>`)}
      </table></div>
      ${this._renderIdentities(bindings.map(([id]) => id))}
      <p class="small muted">Handovers ${t.handovers ?? 0} (${t.ambiguous_handovers ?? 0} ambiguous) · probes ${t.probes ?? 0}, failed ${t.probe_failures ?? 0}${t.probes_inherited ? `, ${t.probes_inherited} inherited` : ""}${t.probes_pending?.length ? `, pending ${t.probes_pending.length}` : ""}${t.probe_budget_left != null ? ` · ${t.probe_budget_left} connections left this hour` : ""}.
        ${t.last_handover ? html`Last: ${trackerName(this.data, t.last_handover.tile)} → <code>${t.last_handover.to}</code> by ${t.last_handover.reason || "rssi pattern"}${t.last_handover.score != null ? ` (${fmtNum(t.last_handover.score, 1)} dB over ${t.last_handover.scanners} proxies)` : ""}.` : nothing}
        ${t.last_probe?.detail ? html`<br>Last probe of <code>${t.last_probe.address}</code>: ${t.last_probe.error || "ok"} ${t.last_probe.detail}` : nothing}
      </p>`;
  }

  _renderIdentities(tileIds) {
    const ids = Object.values(this._identities || {}).sort((a, b) => (a.last_seen_age ?? 1e9) - (b.last_seen_age ?? 1e9));
    if (!ids.length) return nothing;
    const options = [{ value: "", label: "choose a Tile…" }, ...tileIds.map((id) => ({ value: id, label: trackerName(this.data, id) }))];
    return html`<h4>Tile IDs heard <span class="muted small">read from the tags; pick which configured Tile each one is</span></h4>
      <div class="wrap"><table>
        <tr><th>Tile ID</th><th>Last heard</th><th>Where</th><th>Loudest proxy</th><th>Is</th><th></th></tr>
        ${ids.map((row) => html`<tr>
          <td><code>${row.uid}</code></td>
          <td>${row.last_seen_age != null ? `${fmtAge(row.last_seen_age)} ago` : "—"}</td>
          <td>${row.area_name || "—"}</td>
          <td class="small">${row.strongest ? `${row.strongest.scanner} (${row.strongest.rssi} dBm)` : "—"}</td>
          <td>${row.tile_id ? html`<b>${trackerName(this.data, row.tile_id)}</b>` : html`<div class="row">
            ${uiSelect({ label: "", value: this._bindPick[row.uid] || "", options, onChange: (v) => { this._bindPick = { ...this._bindPick, [row.uid]: v }; }, style: "min-width: 200px" })}
            ${uiButton({ label: "Bind", kind: "primary", disabled: !this._bindPick[row.uid], onClick: () => this._bindTile(row.uid) })}</div>`}</td>
          <td class="small muted">${row.addresses?.length || 0} address${row.addresses?.length === 1 ? "" : "es"}</td>
        </tr>`)}
      </table></div>`;
  }

  static styles = [sharedStyles, widgetStyles, css`
    :host { display: block; overflow: auto; }
    .cols { grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); }
    .card.wide { grid-column: 1 / -1; }
    td.who { display: flex; align-items: center; gap: 10px; }
    .icon { width: 28px; height: 28px; object-fit: contain; flex: none; color: var(--secondary-text-color); --mdc-icon-size: 26px; }
    td.stack { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
    button.iconbtn.danger { color: var(--error-color, #b00020); border-color: transparent; }
    button.iconbtn.danger:hover { border-color: var(--error-color, #b00020); }
    details { margin-top: 8px; }
    summary { cursor: pointer; }
  `];
}

customElements.define("sextant-devices", SextantDevices);
