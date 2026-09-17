/**
 * Devices mode: Bermuda without its options flow.
 *
 * Tracked devices with their Sextant settings, everything Bermuda hears but
 * does not track (one click to track), the Tiles' binding state, FindMy
 * accessories, and Bermuda's global options.
 */
import { LitElement, html, css, nothing } from "./lit.js";
import { sharedStyles, fmtAge, fmtNum, toast, callWS, confirmDialog, slugLabel } from "./sextant-ui.js";

const KIND_LABEL = { tile: "Tile", ibeacon: "iBeacon", device: "Device" };

class SextantDevices extends LitElement {
  static properties = {
    hass: { attribute: false },
    data: { attribute: false },
    positions: { attribute: false },
    _tracked: { state: true },
    _candidates: { state: true },
    _tiles: { state: true },
    _findmy: { state: true },
    _options: { state: true },
    _filter: { state: true },
    _kinds: { state: true },
    _busy: { state: true },
    _findmyJson: { state: true },
    _findmyName: { state: true },
  };

  constructor() {
    super();
    this._tracked = null;
    this._candidates = null;
    this._tiles = null;
    this._findmy = null;
    this._options = null;
    this._filter = "";
    this._kinds = new Set(["tile", "ibeacon", "device"]);
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
    const [tracked, candidates, tiles, findmy, options] = await Promise.all([
      this.hass.callWS({ type: "sextant/bermuda/tracked" }).catch(() => null),
      this.hass.callWS({ type: "sextant/bermuda/candidates" }).catch(() => null),
      this.hass.callWS({ type: "sextant/bermuda/tiles" }).catch(() => null),
      this.hass.callWS({ type: "sextant/bermuda/findmy" }).catch(() => null),
      this.hass.callWS({ type: "sextant/bermuda/options" }).catch(() => null),
    ]);
    this._tracked = tracked?.tracked ?? null;
    this._candidates = candidates?.candidates ?? null;
    this._tiles = tiles?.tiles ?? null;
    this._findmy = findmy?.accessories ?? null;
    this._options = options?.options ?? null;
  }

  async _refreshLight() {
    if (!this.hass) return;
    const [candidates, tiles] = await Promise.all([
      this.hass.callWS({ type: "sextant/bermuda/candidates" }).catch(() => null),
      this.hass.callWS({ type: "sextant/bermuda/tiles" }).catch(() => null),
    ]);
    if (candidates) this._candidates = candidates.candidates;
    if (tiles) this._tiles = tiles.tiles;
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
    if (r) { toast(this, `${slugLabel(entity)} updated`); this.dispatchEvent(new CustomEvent("layout-changed")); }
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

  async _saveOptions(form) {
    const options = {};
    for (const el of form.querySelectorAll("[data-key]")) {
      const key = el.dataset.key;
      if (el.type === "checkbox") options[key] = el.checked;
      else if (el.type === "number") { if (el.value !== "") options[key] = Number(el.value); }
      else options[key] = el.value;
    }
    const r = await callWS(this, this.hass, { type: "sextant/bermuda/options/set", options });
    if (r) { toast(this, "Bermuda options saved; Bermuda is reloading…"); this._options = r.options; }
  }

  render() {
    if (!this._hasApi) {
      return html`<div class="page"><div class="card">This Bermuda build has no device-management API. Update Bermuda to fork-testing.15 or later to manage trackers from here.</div></div>`;
    }
    const layout = this.data?.layout || {};
    const heights = layout.tracker_heights || {}, offsets = layout.tracker_ref_offsets || {}, icons = layout.tracker_icons || {};
    const live = new Map((this.positions?.positions || []).map((p) => [p.ent, p]));
    const tracked = Object.entries(this._tracked || {}).sort((a, b) => a[1].name.localeCompare(b[1].name));
    const filter = this._filter.toLowerCase();
    const candidates = (this._candidates || []).filter((c) => this._kinds.has(c.kind) && (!filter || `${c.name} ${c.address} ${c.manufacturer || ""}`.toLowerCase().includes(filter)));
    return html`
      <div class="page">
        <div class="cols">
          <section class="card">
            <h3>Tracked <span class="muted">${tracked.length}</span></h3>
            <div class="wrap"><table>
              <tr><th>Device</th><th>Where</th><th class="num">Height m</th><th class="num">Ref trim dB</th><th>Icon</th><th></th></tr>
              ${tracked.map(([address, d]) => {
                const slug = d.slug, p = live.get(slug);
                return html`<tr>
                  <td><b>${d.name}</b><br><span class="muted small">${address}</span></td>
                  <td>${p ? html`${p.zone}<br><span class="muted small">${p.floor}</span>` : html`<span class="muted">—</span>`}</td>
                  <td class="num"><input type="number" step="0.05" min="0" max="5" .value=${heights[slug] ?? ""} placeholder="1.0"
                        @change=${(e) => this._tune(slug, { height: e.target.value === "" ? null : Number(e.target.value) })}></td>
                  <td class="num"><input type="number" step="0.5" min="-20" max="20" .value=${offsets[slug] ?? ""} placeholder="0"
                        @change=${(e) => this._tune(slug, { ref_offset_db: e.target.value === "" ? null : Number(e.target.value) })}></td>
                  <td>
                    <div class="row">
                      ${icons[slug] ? html`<img class="icon" src=${icons[slug]} alt="">` : nothing}
                      <select @change=${(e) => this._tune(slug, { icon: e.target.value || null })}>
                        <option value="" ?selected=${!icons[slug]}>default</option>
                        ${(this.data?.icons || []).map((i) => html`<option value=${i.value} ?selected=${icons[slug] === i.value}>${i.label}</option>`)}
                      </select>
                      <label class="btn small" title="Upload an icon">⤒<input type="file" accept="image/*" hidden @change=${(e) => this._uploadIcon(slug, e.target.files[0])}></label>
                    </div>
                  </td>
                  <td><button class="danger" ?disabled=${this._busy} @click=${() => confirmDialog(`Stop tracking ${d.name}?`) && this._track([], [address])}>Untrack</button></td>
                </tr>`;
              })}
              ${tracked.length ? nothing : html`<tr><td colspan="6" class="muted">Nothing tracked yet.</td></tr>`}
            </table></div>
          </section>

          <section class="card">
            <h3>Heard, not tracked <span class="muted">${(this._candidates || []).length}</span></h3>
            <div class="row">
              <input class="grow" type="search" placeholder="filter by name, address, maker" .value=${this._filter} @input=${(e) => { this._filter = e.target.value; }}>
              ${Object.entries(KIND_LABEL).map(([k, l]) => html`<label class="inline small"><input type="checkbox" .checked=${this._kinds.has(k)} @change=${(e) => { const s = new Set(this._kinds); e.target.checked ? s.add(k) : s.delete(k); this._kinds = s; }}> ${l}</label>`)}
              <button class="ghost" @click=${() => this._refreshLight()}>Refresh</button>
            </div>
            <div class="wrap"><table>
              <tr><th>Device</th><th>Kind</th><th class="num">Proxies</th><th class="num">Best</th><th>Seen</th><th></th></tr>
              ${candidates.slice(0, 200).map((c) => html`<tr>
                <td><b>${c.name}</b><br><span class="muted small">${c.address}${c.manufacturer ? ` · ${c.manufacturer}` : ""}${c.area_name ? ` · ${c.area_name}` : ""}</span></td>
                <td><span class="pill">${KIND_LABEL[c.kind] || c.kind}</span></td>
                <td class="num">${c.scanners}</td>
                <td class="num">${c.best_rssi ?? "—"}</td>
                <td class="small">${fmtAge(c.last_seen_age)} ago<br><span class="muted">first ${fmtAge(c.first_seen_age)}</span></td>
                <td><button class="primary" ?disabled=${this._busy} @click=${() => this._track([c.config_value], [])}>Track</button></td>
              </tr>`)}
              ${candidates.length ? nothing : html`<tr><td colspan="6" class="muted">${this._candidates ? "No matching devices." : "Loading…"}</td></tr>`}
            </table></div>
          </section>

          <section class="card">
            <h3>Tiles</h3>
            ${this._renderTiles()}
          </section>

          <section class="card">
            <h3>FindMy accessories <span class="muted">${(this._findmy || []).length}</span></h3>
            <div class="wrap"><table>
              <tr><th>Accessory</th><th>Model</th><th>Status</th><th></th></tr>
              ${(this._findmy || []).map((a) => html`<tr>
                <td><b>${a.name}</b><br><span class="muted small">${a.address}</span></td>
                <td>${a.model || "—"}</td>
                <td>${a.current_source ? html`<span class="pill ok">seen as ${a.current_source}</span> <span class="muted small">${fmtAge(a.last_seen_age)} ago</span>` : a.alignment_index ? html`<span class="pill warn">aligned, not visible</span>` : html`<span class="pill">searching</span>`}</td>
                <td><button class="danger" @click=${() => this._removeFindMy(a.address, a.name)}>Remove</button></td>
              </tr>`)}
              ${(this._findmy || []).length ? nothing : html`<tr><td colspan="4" class="muted">None configured.</td></tr>`}
            </table></div>
            <details>
              <summary>Add an accessory</summary>
              <p class="muted small">Paste the key JSON exported with FindMy.py's <code>FindMyAccessory.to_json()</code>.</p>
              <textarea placeholder='{"master_key": "...", ...}' .value=${this._findmyJson} @input=${(e) => { this._findmyJson = e.target.value; }}></textarea>
              <div class="row">
                <input class="grow" type="text" placeholder="Name (optional)" .value=${this._findmyName} @input=${(e) => { this._findmyName = e.target.value; }}>
                <button class="primary" @click=${() => this._addFindMy()}>Add</button>
              </div>
            </details>
          </section>

          <section class="card">
            <h3>Bermuda global options</h3>
            ${this._options ? html`
              <form @submit=${(e) => { e.preventDefault(); this._saveOptions(e.target); }}>
                <div class="row">
                  ${[["ref_power", "Ref power dBm at 1 m", "number", 1], ["attenuation", "Attenuation", "number", 0.1], ["max_area_radius", "Max area radius m", "number", 0.1],
                     ["max_velocity", "Max velocity m/s", "number", 0.1], ["devtracker_nothome_timeout", "Not-home timeout s", "number", 1],
                     ["update_interval", "Update interval s", "number", 0.1], ["smoothing_samples", "Smoothing samples", "number", 1]].map(([k, l, t, step]) => html`
                    <label class="field">${l}<input type=${t} step=${step} data-key=${k} .value=${this._options[k] ?? ""}></label>`)}
                  <label class="inline"><input type="checkbox" data-key="create_scanner_entities" .checked=${!!this._options.create_scanner_entities}> Create scanner entities</label>
                </div>
                <div class="row"><button class="primary" type="submit">Save options</button><span class="muted small">Bermuda reloads to apply.</span></div>
              </form>` : html`<div class="muted">Loading…</div>`}
          </section>
        </div>
      </div>
    `;
  }

  _renderTiles() {
    const t = this._tiles;
    if (!t) return html`<div class="muted">Loading…</div>`;
    const bindings = Object.entries(t.bindings || {});
    if (!bindings.length) return html`<div class="muted">No Tiles configured. Track one from the list on the left; Tiles show as <span class="pill">Tile</span>.</div>`;
    return html`
      <div class="wrap"><table>
        <tr><th>Tile</th><th>Bound address</th><th>Tile ID</th><th>History</th></tr>
        ${bindings.map(([id, sources]) => html`<tr>
          <td><b>${slugLabel(id)}</b></td>
          <td><code>${sources[0] || "—"}</code></td>
          <td>${t.uids?.[id] ? html`<code>${t.uids[id]}</code>` : t.uids && id in t.uids ? html`<span class="pill warn">no ID characteristic</span>` : html`<span class="pill">not read yet</span>`}</td>
          <td class="small muted">${sources.slice(1, 4).join(" → ") || "—"}</td>
        </tr>`)}
      </table></div>
      <p class="small muted">Handovers ${t.handovers ?? 0} (${t.ambiguous_handovers ?? 0} ambiguous) · probes ${t.probes ?? 0}, failed ${t.probe_failures ?? 0}${t.probes_pending?.length ? `, pending ${t.probes_pending.length}` : ""}.
        ${t.last_handover ? html`Last: ${slugLabel(t.last_handover.tile)} → <code>${t.last_handover.to}</code> by ${t.last_handover.reason || "rssi pattern"}${t.last_handover.score != null ? ` (${fmtNum(t.last_handover.score, 1)} dB over ${t.last_handover.scanners} scanners)` : ""}.` : nothing}
        ${t.last_probe?.detail ? html`<br>Last probe of <code>${t.last_probe.address}</code>: ${t.last_probe.error || "ok"} ${t.last_probe.detail}` : nothing}
      </p>`;
  }

  static styles = [sharedStyles, css`
    :host { display: block; overflow: auto; }
    img.icon { width: 22px; height: 22px; object-fit: contain; }
    details { margin-top: 8px; }
    summary { cursor: pointer; }
  `];
}

customElements.define("sextant-devices", SextantDevices);
