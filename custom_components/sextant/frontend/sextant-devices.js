/**
 * Trackers and Bermuda modes: Bermuda without its options flow.
 *
 * section="trackers": what Bermuda tracks, each with a dialog for its name,
 * class (the icon on the map), height, ref trim and custom icon, and
 * everything Bermuda hears but does not track (one click to track, which
 * opens that same dialog).
 * section="bermuda": Bermuda's own things - global options, FindMy
 * accessories (with a step-by-step add) and the Tiles' binding state.
 */
import { LitElement, html, css, nothing } from "./lit.js";
import { sharedStyles, widgetStyles, fmtAge, fmtNum, toast, callWS, confirmDialog, slugLabel, uiField, uiSelect, uiSwitch, uiButton, trackerName, fmtLen, lenUnit, toDisplayLen, fromDisplayLen, TRACKER_CLASSES, classIcon } from "./sextant-ui.js";

const KIND_FILTERS = [["all", "Everything"], ["tile", "Tiles"], ["ibeacon", "iBeacons"], ["device", "Other devices"]];
const RECENT_SECS = 60;
const FINDMY_KEYS = ["master_key", "skn", "sks", "paired_at"];
const FINDMY_GUIDE = "https://github.com/malmeloo/FindMy.py";

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
    _wizard: { state: true },
    _findmyWizard: { state: true },
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
    this._wizard = null;        // tracker dialog state
    this._findmyWizard = null;  // FindMy add-accessory dialog state
    this._pendingTrack = null;  // config_value just sent to Bermuda: open its dialog once it appears
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
    this._openPendingTrack();
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

  // --- Bermuda actions -------------------------------------------------------

  async _bindTile(uid) {
    const tileId = this._bindPick[uid];
    if (!tileId) return;
    const r = await callWS(this, this.hass, { type: "sextant/bermuda/tile/bind", tile_id: tileId, uid });
    if (r) {
      toast(this, r.address ? `${trackerName(this.data, tileId)} is now ${r.address}` : `${trackerName(this.data, tileId)} remembered as ${uid}; it binds when that Tile is next heard`);
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
      if (add.length === 1) this._pendingTrack = { value: add[0], since: Date.now() };
      setTimeout(() => { this._refresh(); this.dispatchEvent(new CustomEvent("layout-changed")); }, 4000);
      setTimeout(() => { this._refresh(); }, 9000);
    }
  }

  /** A device just sent to Bermuda shows up in the tracked list a few seconds later: open its dialog then. */
  _openPendingTrack() {
    const p = this._pendingTrack;
    if (!p || Date.now() - p.since > 60000) { this._pendingTrack = null; return; }
    const want = String(p.value).toLowerCase();
    const hit = Object.entries(this._tracked || {}).find(([address, d]) => address.toLowerCase() === want || String(d.slug).toLowerCase() === want || String(d.config_value || "").toLowerCase() === want);
    if (!hit) return;
    this._pendingTrack = null;
    this._openWizard(hit[1].slug, hit[0]);
  }

  async _tune(entity, patch) {
    const r = await callWS(this, this.hass, { type: "sextant/tracker/tune", entity, ...patch });
    if (r) this.dispatchEvent(new CustomEvent("layout-changed"));
    return r;
  }

  async _uploadIcon(entity, file) {
    if (!file) return null;
    const form = new FormData();
    form.append("icon", file, file.name);
    try {
      const resp = await this.hass.fetchWithAuth("/api/sextant/upload_tracker_icon", { method: "POST", body: form });
      if (!resp.ok) throw new Error(await resp.text());
      const body = await resp.json().catch(() => ({}));
      return body.value || body.path || `/local/sextant_icons/${file.name}`;
    } catch (e) {
      toast(this, `icon upload failed: ${e.message || e}`, 6000);
      return null;
    }
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

  // --- Tracker dialog --------------------------------------------------------

  _openWizard(slug, address) {
    const layout = this.data?.layout || {};
    this._wizard = {
      slug, address,
      name: layout.tracker_names?.[slug] || "",
      placeholder: trackerName({ ...this.data, names: { ...(this.data?.names || {}), [slug]: undefined } }, slug),
      tracker_class: layout.tracker_classes?.[slug] || "",
      height: toDisplayLen(layout.tracker_heights?.[slug], this.hass),
      ref: layout.tracker_ref_offsets?.[slug] ?? "",
      icon: layout.tracker_icons?.[slug] || "",
      file: null,
    };
  }

  async _saveWizard() {
    const w = this._wizard;
    if (!w) return;
    this._busy = true;
    let icon = w.icon || null;
    if (w.file) { const uploaded = await this._uploadIcon(w.slug, w.file); if (uploaded) icon = uploaded; }
    const r = await this._tune(w.slug, {
      name: w.name.trim() || null,
      tracker_class: w.tracker_class || null,
      height: w.height === "" || w.height == null ? null : fromDisplayLen(w.height, this.hass),
      ref_offset_db: w.ref === "" || w.ref == null ? null : Number(w.ref),
      icon,
    });
    this._busy = false;
    if (r) { toast(this, `${w.name.trim() || w.placeholder} saved`); this._wizard = null; }
  }

  _renderWizard() {
    const w = this._wizard;
    if (!w) return nothing;
    const unit = lenUnit(this.hass);
    return html`<div class="modal" @click=${(e) => { if (e.target === e.currentTarget) this._wizard = null; }}>
      <div class="dialog card" role="dialog" aria-label="Tracker settings">
        <h3>${w.placeholder} <span class="muted small">${w.address}</span></h3>
        <div class="row">
          ${uiField({ label: "Name", value: w.name, placeholder: w.placeholder, onChange: (v) => { w.name = v; this.requestUpdate(); }, style: "flex: 1; min-width: 220px" })}
        </div>
        <p class="small muted">Blank keeps the device name from Bermuda / Home Assistant.</p>
        <h4>What is it?</h4>
        <div class="classes">
          ${TRACKER_CLASSES.map(([key, label, icon]) => html`<button class="cls ${w.tracker_class === key ? "on" : ""}" title=${label} @click=${() => { w.tracker_class = key; this.requestUpdate(); }}>
            ${icon ? html`<ha-icon icon=${icon}></ha-icon>` : html`<span class="initials">Ab</span>`}<span>${label}</span></button>`)}
        </div>
        <div class="row">
          ${uiField({ label: `Height (${unit})`, type: "number", step: 0.05, min: 0, max: unit === "ft" ? 16 : 5, value: w.height, placeholder: String(toDisplayLen(1.0, this.hass)), onChange: (v) => { w.height = v; this.requestUpdate(); }, style: "width: 150px" })}
          ${uiField({ label: "Ref trim (dB)", type: "number", step: 0.5, min: -20, max: 20, value: w.ref, placeholder: "0", onChange: (v) => { w.ref = v; this.requestUpdate(); }, style: "width: 150px" })}
        </div>
        <p class="small muted">Height: how high it is usually carried or placed (a phone in a pocket about 1 m, a dog's collar 0.3 m). Ref trim: a few dB either way if this tracker always reads too near or too far.</p>
        <h4>Custom icon <span class="muted small">optional, overrides the class icon</span></h4>
        <div class="row">
          ${w.icon ? html`<img class="icon" src=${w.icon} alt="">` : nothing}
          ${uiSelect({ value: w.icon || "", options: [{ value: "", label: "none" }, ...(this.data?.icons || []).map((i) => ({ value: i.value, label: i.label }))], onChange: (v) => { w.icon = v; this.requestUpdate(); }, style: "min-width: 180px" })}
          <label class="btn small" title="Upload an image">Upload…<input type="file" accept="image/*" hidden @change=${(e) => { w.file = e.target.files[0] || null; this.requestUpdate(); }}></label>
          ${w.file ? html`<span class="small muted">${w.file.name}</span>` : nothing}
        </div>
        <div class="row end">
          ${uiButton({ label: "Cancel", kind: "text", onClick: () => { this._wizard = null; } })}
          ${uiButton({ label: this._busy ? "Saving…" : "Save", kind: "primary", disabled: this._busy, onClick: () => this._saveWizard() })}
        </div>
      </div>
    </div>`;
  }

  // --- FindMy dialog ---------------------------------------------------------

  _openFindMyWizard() { this._findmyWizard = { step: 1, text: "", parsed: [], errors: [], names: {} }; }

  _parseFindMy(text) {
    const w = this._findmyWizard;
    w.text = text;
    w.parsed = []; w.errors = [];
    const trimmed = text.trim();
    if (!trimmed) { this.requestUpdate(); return; }
    let items;
    try {
      const value = JSON.parse(trimmed);
      items = Array.isArray(value) ? value : [value];
    } catch {
      // Several objects pasted one after another, or one per line.
      items = [];
      for (const chunk of trimmed.split(/\}\s*(?:,|\n)\s*\{/)) {
        const s = chunk.trim().replace(/^\{?/, "{").replace(/\}?$/, "}");
        try { items.push(JSON.parse(s)); } catch { w.errors.push(`Not valid JSON: ${s.slice(0, 40)}…`); }
      }
    }
    items.forEach((it, i) => {
      if (!it || typeof it !== "object") { w.errors.push(`Item ${i + 1} is not an object`); return; }
      const missing = FINDMY_KEYS.filter((k) => !it[k]);
      if (missing.length) { w.errors.push(`Item ${i + 1}${it.name ? ` (${it.name})` : ""} is missing ${missing.join(", ")}`); return; }
      w.parsed.push({ json: JSON.stringify(it), name: it.name || "", model: it.model || "", identifier: it.identifier || "" });
    });
    this.requestUpdate();
  }

  async _addFindMyAll() {
    const w = this._findmyWizard;
    if (!w?.parsed.length) return;
    this._busy = true;
    let added = 0;
    for (const [i, item] of w.parsed.entries()) {
      const name = (w.names[i] ?? item.name ?? "").trim() || null;
      const r = await callWS(this, this.hass, { type: "sextant/bermuda/findmy/add", accessory_json: item.json, name });
      if (r) added++;
    }
    this._busy = false;
    toast(this, `Added ${added} of ${w.parsed.length} accessor${w.parsed.length === 1 ? "y" : "ies"}`);
    if (added) { this._findmyWizard = null; this._refresh(); }
  }

  _renderFindMyWizard() {
    const w = this._findmyWizard;
    if (!w) return nothing;
    return html`<div class="modal" @click=${(e) => { if (e.target === e.currentTarget) this._findmyWizard = null; }}>
      <div class="dialog card wide" role="dialog" aria-label="Add FindMy accessories">
        <h3>Add FindMy accessories</h3>
        <ol class="steps">
          <li><b>Export the keys.</b> An AirTag or FindMy tag changes its address every 15 minutes on a schedule seeded when it was paired, so Bermuda needs the pairing keys, and only the Mac (or iPhone backup) they were paired from has them. Follow the key-extraction guide of <a href=${FINDMY_GUIDE} target="_blank" rel="noopener">FindMy.py</a>: it decrypts the Owned Beacons records from your Mac's keychain and prints one JSON per accessory (<code>FindMyAccessory.to_json()</code>).</li>
          <li><b>Paste them here</b>, one or several, in any order. Each needs ${FINDMY_KEYS.map((k, i) => html`${i ? ", " : ""}<code>${k}</code>`)}; a name and model come along when the export had them.</li>
          <li><b>Name and add.</b> Each accessory becomes a <code>findmy_…</code> device in Bermuda; track it from the Trackers page once it has been seen.</li>
        </ol>
        <textarea placeholder='{"master_key": "...", "skn": "...", "sks": "...", "paired_at": "...", "name": "Keys"}' .value=${w.text} @input=${(e) => this._parseFindMy(e.target.value)}></textarea>
        ${w.errors.length ? html`<ul class="errors">${w.errors.map((e) => html`<li>${e}</li>`)}</ul>` : nothing}
        ${w.parsed.length ? html`<div class="wrap"><table>
          <tr><th>Accessory</th><th>Model</th><th>Name in Bermuda</th></tr>
          ${w.parsed.map((p, i) => html`<tr>
            <td>${p.name || html`<span class="muted">unnamed</span>`}<br><span class="muted small">${p.identifier || "id from the key"}</span></td>
            <td>${p.model || "—"}</td>
            <td>${uiField({ value: w.names[i] ?? p.name ?? "", placeholder: p.name || "name", onChange: (v) => { w.names[i] = v; }, style: "width: 220px" })}</td>
          </tr>`)}
        </table></div>` : nothing}
        <div class="row end">
          ${uiButton({ label: "Cancel", kind: "text", onClick: () => { this._findmyWizard = null; } })}
          ${uiButton({ label: this._busy ? "Adding…" : `Add ${w.parsed.length || ""} accessor${w.parsed.length === 1 ? "y" : "ies"}`, kind: "primary", disabled: this._busy || !w.parsed.length, onClick: () => this._addFindMyAll() })}
        </div>
      </div>
    </div>`;
  }

  // --- render ----------------------------------------------------------------

  render() {
    if (!this._hasApi) {
      return html`<div class="page"><div class="card">This Bermuda build has no device-management API. Update Bermuda to fork-testing.15 or later to manage trackers from here.</div></div>`;
    }
    return html`<div class="page">${this.section === "bermuda" ? this._renderBermuda() : this._renderTrackers()}</div>${this._renderWizard()}${this._renderFindMyWizard()}`;
  }

  /** The proxies' own iBeacon (every ESPHome probe advertises the same one) is not a device to track.
   *  Its name is the ESPHome device name, which ends in the WiFi MAC's last six hex digits; the
   *  scanner's slug carries the same six (great_room_eth_d83d6c for ble-esp32-eth-d83d6c). */
  _isProxyBeacon(c) {
    if (c.kind !== "ibeacon") return false;
    const name = String(c.name || "").toLowerCase();
    const scanners = Object.values(this.data?.scanners || {});
    if (scanners.some((s) => [s.name, s.slug].filter(Boolean).some((n) => n.toLowerCase() === name))) return true;
    const hex = /([0-9a-f]{6})$/.exec(name.replace(/[^0-9a-z]/g, ""))?.[1];
    return !!hex && scanners.some((s) => `${s.slug || ""} ${s.name || ""}`.toLowerCase().includes(hex));
  }

  _renderTrackers() {
    const layout = this.data?.layout || {};
    const heights = layout.tracker_heights || {}, offsets = layout.tracker_ref_offsets || {}, icons = layout.tracker_icons || {}, classes = layout.tracker_classes || {};
    const live = new Map((this.positions?.positions || []).map((p) => [p.ent, p]));
    const tracked = Object.entries(this._tracked || {}).sort((a, b) => trackerName(this.data, a[1].slug).localeCompare(trackerName(this.data, b[1].slug)));
    const filter = this._filter.toLowerCase();
    const all = (this._candidates || []).filter((c) => !this._isProxyBeacon(c));
    const recent = all.filter((c) => (c.last_seen_age ?? 1e9) <= RECENT_SECS);
    const candidates = (this._showAll ? all : recent)
      .filter((c) => (this._kind === "all" || c.kind === this._kind) && (!filter || `${c.name} ${c.address} ${c.manufacturer || ""} ${c.area_name || ""}`.toLowerCase().includes(filter)))
      .sort((a, b) => (a.last_seen_age ?? 1e9) - (b.last_seen_age ?? 1e9));
    return html`
      <section class="card">
        <h3>Tracked <span class="muted">${tracked.length}</span></h3>
        <div class="wrap"><table class="compact">
          <tr><th>Tracker</th><th>Where</th><th class="num">Height</th><th class="num">Ref trim</th><th></th></tr>
          ${tracked.map(([address, d]) => {
            const slug = d.slug, p = live.get(slug), name = trackerName(this.data, slug), mdi = classIcon(classes[slug]);
            return html`<tr>
              <td class="who">
                ${icons[slug] ? html`<img class="icon" src=${icons[slug]} alt="">` : html`<ha-icon class="icon" icon=${mdi || "mdi:tag-outline"}></ha-icon>`}
                <div><a href="#" class="name" title="Edit name, class, height, ref trim and icon" @click=${(e) => { e.preventDefault(); this._openWizard(slug, address); }}>${name}</a><br><span class="muted small">${address}${classes[slug] ? ` · ${(TRACKER_CLASSES.find(([k]) => k === classes[slug]) || [])[1] || classes[slug]}` : ""}</span></div>
              </td>
              <td>${p ? html`${p.zone}${p.sub_zone && p.sub_zone !== "unknown" ? ` · ${p.sub_zone}` : ""}<br><span class="muted small">${p.floor}</span>` : html`<span class="muted">—</span>`}</td>
              <td class="num">${heights[slug] != null ? fmtLen(heights[slug], this.hass) : html`<span class="muted">default</span>`}</td>
              <td class="num">${offsets[slug] != null && offsets[slug] !== 0 ? `${offsets[slug] > 0 ? "+" : ""}${fmtNum(offsets[slug], 1)} dB` : html`<span class="muted">0</span>`}</td>
              <td class="actions">
                <button class="iconbtn" title="Edit ${name}" @click=${() => this._openWizard(slug, address)}><ha-icon icon="mdi:pencil-outline"></ha-icon></button>
                <button class="iconbtn danger" title="Stop tracking ${name}" ?disabled=${this._busy} @click=${() => confirmDialog(`Stop tracking ${name}?`) && this._track([], [address])}><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
              </td>
            </tr>`;
          })}
          ${tracked.length ? nothing : html`<tr><td colspan="5" class="muted">Nothing tracked yet.</td></tr>`}
        </table></div>
        <p class="small muted">Click a name to set its name, class, height, ref trim or icon.</p>
      </section>

      <section class="card">
        <h3>Heard, not tracked <span class="muted">${candidates.length}${this._showAll ? "" : ` in the last ${RECENT_SECS} s`}</span></h3>
        <div class="row">
          <input class="grow" type="search" placeholder="Filter by name, address, maker or area" .value=${this._filter} @input=${(e) => { this._filter = e.target.value; }}>
          ${uiSelect({ label: "Kind", value: this._kind, options: KIND_FILTERS.map(([v, l]) => ({ value: v, label: l })), onChange: (v) => { this._kind = v; }, style: "min-width: 150px" })}
          <span class="chips">${uiSwitch({ label: `Show all (${all.length})`, checked: this._showAll, onChange: (v) => { this._showAll = v; } })}</span>
          ${uiButton({ label: "Refresh", kind: "text", icon: "mdi:refresh", onClick: () => this._refreshLight() })}
        </div>
        <div class="wrap"><table class="compact">
          <tr><th>Device</th><th>Maker</th><th class="num">Proxies</th><th class="num">Best dBm</th><th>Seen</th><th></th></tr>
          ${candidates.slice(0, 200).map((c) => html`<tr>
            <td><b>${c.name}</b><br><span class="muted small">${c.address}</span>${c.area_name ? html`<br><span class="muted small">${c.area_name}</span>` : nothing}</td>
            <td>${c.kind === "tile" ? html`<span class="pill">Tile</span>` : c.kind === "ibeacon" ? html`<span class="pill">iBeacon</span>` : nothing} ${c.manufacturer || (c.kind === "device" ? html`<span class="muted">unknown</span>` : "")}</td>
            <td class="num">${c.scanners}</td>
            <td class="num">${c.best_rssi ?? "—"}</td>
            <td class="small">${fmtAge(c.last_seen_age)} ago<br><span class="muted">first ${fmtAge(c.first_seen_age)}</span></td>
            <td>${uiButton({ label: "Track", kind: "primary", disabled: this._busy, onClick: () => this._track([c.config_value], []), title: "Bermuda starts tracking it; its settings dialog opens once it appears" })}</td>
          </tr>`)}
          ${candidates.length ? nothing : html`<tr><td colspan="6" class="muted">${this._candidates ? (this._showAll ? "No matching devices." : `Nothing heard in the last ${RECENT_SECS} s matches; switch on "Show all" for everything Bermuda remembers.`) : "Loading…"}</td></tr>`}
        </table></div>
        <p class="small muted">Apple FindMy tags are not in this list: they need their pairing keys, added on the Bermuda page.</p>
      </section>`;
  }

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
        <div class="wrap"><table class="compact">
          <tr><th>Accessory</th><th>Model</th><th>Status</th><th></th></tr>
          ${(this._findmy || []).map((a) => html`<tr>
            <td><b>${a.name}</b><br><span class="muted small">${a.address}</span></td>
            <td>${a.model || "—"}</td>
            <td>${a.current_source ? html`<span class="pill ok">seen as ${a.current_source}</span> <span class="muted small">${fmtAge(a.last_seen_age)} ago</span>` : a.alignment_index ? html`<span class="pill warn">aligned, not visible</span>` : html`<span class="pill">searching</span>`}</td>
            <td><button class="iconbtn danger" title="Remove ${a.name}" @click=${() => this._removeFindMy(a.address, a.name)}><ha-icon icon="mdi:trash-can-outline"></ha-icon></button></td>
          </tr>`)}
          ${(this._findmy || []).length ? nothing : html`<tr><td colspan="4" class="muted">None configured.</td></tr>`}
        </table></div>
        <div class="row">${uiButton({ label: "Add accessories…", kind: "primary", icon: "mdi:plus", onClick: () => this._openFindMyWizard() })}<span class="muted small">Walks through exporting the keys and pasting them.</span></div>
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
      <div class="wrap"><table class="compact">
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
      <div class="wrap"><table class="compact">
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
    :host { display: block; overflow: auto; position: relative; }
    .cols { grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); }
    .card.wide { grid-column: 1 / -1; }
    table.compact th, table.compact td { padding: 5px 8px; }
    td.who { display: flex; align-items: center; gap: 10px; }
    .icon { width: 28px; height: 28px; object-fit: contain; flex: none; color: var(--secondary-text-color); --mdc-icon-size: 26px; }
    a.name { font-weight: 600; color: var(--primary-text-color); text-decoration: none; border-bottom: 1px dotted var(--secondary-text-color); }
    a.name:hover { color: var(--primary-color); border-bottom-color: var(--primary-color); }
    td.actions { white-space: nowrap; }
    button.iconbtn.danger { color: var(--error-color, #b00020); border-color: transparent; }
    button.iconbtn.danger:hover { border-color: var(--error-color, #b00020); }
    .modal { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; z-index: 20; padding: 16px; }
    .dialog { width: min(640px, 100%); max-height: 90vh; overflow: auto; }
    .dialog.wide { width: min(820px, 100%); }
    .row.end { justify-content: flex-end; margin-top: 12px; }
    .classes { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 6px; margin: 4px 0 10px; }
    button.cls { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 4px; font-size: 11px; line-height: 1.1; }
    button.cls ha-icon { --mdc-icon-size: 26px; }
    button.cls.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
    .initials { font-weight: 700; font-size: 16px; line-height: 26px; }
    ol.steps { padding-left: 20px; margin: 4px 0 10px; }
    ol.steps li { margin: 6px 0; font-size: 13px; }
    ul.errors { color: var(--error-color, #b00020); font-size: 13px; margin: 6px 0; padding-left: 20px; }
    details { margin-top: 8px; }
    summary { cursor: pointer; }
  `];
}

customElements.define("sextant-devices", SextantDevices);
