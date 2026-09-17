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
import { pointInPolygon } from "./sextant-map.js";
import { sharedStyles, widgetStyles, fmtAge, fmtNum, toast, callWS, confirmDialog, uiField, uiSelect, uiSwitch, uiButton, trackerName, fmtLen, lenUnit, toDisplayLen, fromDisplayLen, TRACKER_CLASSES, classIcon } from "./sextant-ui.js";

const KIND_FILTERS = [["all", "Everything"], ["tile", "Tiles"], ["ibeacon", "iBeacons"], ["device", "Other devices"]];
const RECENT_SECS = 60;
// The iBeacon every calibration probe advertises (README, "make each probe advertise"), hex without dashes.
const PROBE_BEACON_UUID = "fde3b1502f6443baaee9867f75ee4a6f";
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
    _adoptPick: { state: true },
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
    this._adoptPick = {};
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

  async _adoptTile(tileId) {
    const address = this._adoptPick[tileId];
    if (!address) return;
    const r = await callWS(this, this.hass, { type: "sextant/bermuda/tile/adopt", tile_id: tileId, address });
    if (r) {
      toast(this, `${trackerName(this.data, tileId)} is now ${r.address}`);
      this._adoptPick = { ...this._adoptPick, [tileId]: "" };
      await this._refreshLight();
      this.dispatchEvent(new CustomEvent("layout-changed"));
    }
  }

  async _track(add, remove) {
    this._busy = true;
    const r = await callWS(this, this.hass, { type: "sextant/bermuda/track", add, remove });
    this._busy = false;
    if (r) {
      toast(this, add.length ? `Tracking ${add.join(", ")}. Bermuda is reloading…` : `Stopped tracking ${remove.join(", ")}.`);
      for (const ms of [4000, 9000, 15000]) setTimeout(() => { this._refresh(); this.dispatchEvent(new CustomEvent("layout-changed")); }, ms);
    }
    return r;
  }

  /** A device just sent to Bermuda shows up in the tracked list a few seconds
   *  later, with its slug: apply the settings chosen in the dialog to it then. */
  async _openPendingTrack() {
    const p = this._pendingTrack;
    if (!p || Date.now() - p.since > 90000) { this._pendingTrack = null; return; }
    const want = String(p.value).toLowerCase();
    const hit = Object.entries(this._tracked || {}).find(([address, d]) => address.toLowerCase() === want || String(d.slug).toLowerCase() === want || String(d.config_value || "").toLowerCase() === want);
    if (!hit) return;
    this._pendingTrack = null;
    const slug = hit[1].slug;
    if (!p.settings) { this._openWizard(slug, hit[0]); return; }
    let icon = p.settings.icon;
    if (p.file) { const uploaded = await this._uploadIcon(slug, p.file); if (uploaded) icon = uploaded; }
    const r = await this._tune(slug, { ...p.settings, icon });
    if (r) toast(this, `${p.settings.name || trackerName(this.data, slug)} is tracked and set up`);
  }

  /** Track: the dialog first, Bermuda only after Save (so nothing changes if you change your mind). */
  _startTrack(c) {
    this._wizard = {
      new: true, config_value: c.config_value, address: c.address, slug: null,
      name: "", placeholder: c.name || c.address, tracker_class: c.kind === "tile" ? "tag" : "", height: "", ref: "", icon: "", file: null,
    };
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
    const settings = {
      name: w.name.trim() || null,
      tracker_class: w.tracker_class || null,
      height: w.height === "" || w.height == null ? null : fromDisplayLen(w.height, this.hass),
      ref_offset_db: w.ref === "" || w.ref == null ? null : Number(w.ref),
      icon: w.icon || null,
    };
    if (w.new) {
      // Nothing has touched Bermuda yet. Now it does; the settings follow once the device has a slug.
      this._pendingTrack = { value: w.config_value, since: Date.now(), settings, file: w.file };
      const r = await this._track([w.config_value], []);
      if (r) this._wizard = null; else this._pendingTrack = null;
      return;
    }
    this._busy = true;
    let icon = settings.icon;
    if (w.file) { const uploaded = await this._uploadIcon(w.slug, w.file); if (uploaded) icon = uploaded; }
    const r = await this._tune(w.slug, { ...settings, icon });
    this._busy = false;
    if (r) { toast(this, `${w.name.trim() || w.placeholder} saved`); this._wizard = null; }
  }

  _renderWizard() {
    const w = this._wizard;
    if (!w) return nothing;
    const unit = lenUnit(this.hass);
    return html`<div class="modal" @click=${(e) => { if (e.target === e.currentTarget) this._wizard = null; }}>
      <div class="dialog card" role="dialog" aria-label="Tracker settings">
        <h3>${w.new ? "Track " : ""}${w.placeholder} <span class="muted small">${w.address}</span></h3>
        ${w.new ? html`<p class="small muted">Nothing is sent to Bermuda until you press Track below; Cancel leaves it untracked.</p>` : nothing}
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
          ${uiButton({ label: this._busy ? (w.new ? "Tracking…" : "Saving…") : (w.new ? "Track" : "Save"), kind: "primary", disabled: this._busy, onClick: () => this._saveWizard() })}
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
    if (String(c.address || c.config_value || "").toLowerCase().replace(/-/g, "").startsWith(PROBE_BEACON_UUID)) return true;
    const name = String(c.name || "").toLowerCase();
    const scanners = Object.values(this.data?.scanners || {});
    if (scanners.some((s) => [s.name, s.slug].filter(Boolean).some((n) => n.toLowerCase() === name))) return true;
    const hex = /([0-9a-f]{6})$/.exec(name.replace(/[^0-9a-z]/g, ""))?.[1];
    return !!hex && scanners.some((s) => `${s.slug || ""} ${s.name || ""}`.toLowerCase().includes(hex));
  }

  /** Addresses of every proxy placed on a floor plan: the only ones whose hearing counts. */
  _placedAddresses() {
    const out = new Set();
    for (const f of this.data?.layout?.floor || []) for (const r of f.receivers || []) if (r.address) out.add(String(r.address).toLowerCase());
    return out;
  }

  /** Heard only by proxies that are not on any floor plan (a kiosk, a test board): not worth listing. */
  _onlyUnplaced(c, placed) {
    if (!Array.isArray(c.scanner_addresses) || !placed.size) return false;
    return c.scanner_addresses.length > 0 && !c.scanner_addresses.some((a) => placed.has(String(a).toLowerCase()));
  }

  /** Where a heard device is: the room (and floor) of the loudest placed proxy that hears it. */
  _heardWhere(c, index) {
    const heard = Array.isArray(c.heard_by) ? c.heard_by : [];
    const hit = heard.find((h) => index.has(String(h.address || "").toLowerCase()));
    if (!hit) return null;
    const p = index.get(String(hit.address).toLowerCase());
    return { room: p.room, floor: p.floor, proxy: p.name, rssi: hit.rssi };
  }

  _renderTrackers() {
    const layout = this.data?.layout || {};
    const placed = this._placedAddresses();
    const index = this._placedIndex();
    const heights = layout.tracker_heights || {}, offsets = layout.tracker_ref_offsets || {}, icons = layout.tracker_icons || {}, classes = layout.tracker_classes || {};
    const live = new Map((this.positions?.positions || []).map((p) => [p.ent, p]));
    const tracked = Object.entries(this._tracked || {}).sort((a, b) => trackerName(this.data, a[1].slug).localeCompare(trackerName(this.data, b[1].slug)));
    const filter = this._filter.toLowerCase();
    const placedHearing = (c) => (Array.isArray(c.heard_by) ? c.heard_by : []).filter((h) => placed.has(String(h.address || "").toLowerCase())).length;
    const all = (this._candidates || []).filter((c) => !this._isProxyBeacon(c) && !this._onlyUnplaced(c, placed));
    const recent = all.filter((c) => (c.last_seen_age ?? 1e9) <= RECENT_SECS);
    // One proxy cannot place a device (the solver wants three), so something only one placed proxy hears is
    // noise here: a neighbour's gadget at the edge of range, a proxy's own radar module. "Show all" lifts this.
    const lonely = new Set(placed.size ? recent.filter((c) => placedHearing(c) < 2) : []);
    const haystack = (c) => { const w = this._heardWhere(c, index); return `${c.name} ${c.address} ${c.manufacturer || ""} ${c.apple_summary || ""} ${c.area_name || ""} ${c.kind} ${w ? `${w.room || ""} ${w.floor || ""} ${w.proxy || ""}` : ""}`.toLowerCase(); };
    const candidates = (this._showAll ? all : recent.filter((c) => !lonely.has(c)))
      .filter((c) => (this._kind === "all" || c.kind === this._kind) && (!filter || haystack(c).includes(filter)))
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
                <button class="iconpick" title="Change the icon or class of ${name}" @click=${() => this._openWizard(slug, address)}>
                  ${icons[slug] ? html`<img class="icon" src=${icons[slug]} alt="">` : html`<ha-icon class="icon" icon=${mdi || "mdi:tag-outline"}></ha-icon>`}
                </button>
                <div><a href="#" class="name" title="Edit name, class, height, ref trim and icon" @click=${(e) => { e.preventDefault(); this._openWizard(slug, address); }}>${name}</a><br><span class="muted small">${address}${classes[slug] ? ` · ${(TRACKER_CLASSES.find(([k]) => k === classes[slug]) || [])[1] || classes[slug]}` : ""}</span></div>
              </td>
              <td>${p ? html`${p.zone}${p.sub_zone && p.sub_zone !== "unknown" ? ` · ${p.sub_zone}` : ""}<br><span class="muted small">${p.floor}</span>`
                : d.last_seen_age != null ? html`<span class="muted">no position</span><br><span class="muted small">seen ${fmtAge(d.last_seen_age)} ago</span>`
                : html`<span class="muted">not heard yet</span>`}</td>
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
        <h3>Heard, not tracked <span class="muted">${candidates.length}${this._showAll ? "" : ` in the last ${RECENT_SECS} s`}</span>${!this._showAll && lonely.size ? html` <span class="muted small" title="One proxy cannot position a device; switch on Show all to see them">· ${lonely.size} heard by a single proxy, hidden</span>` : nothing}</h3>
        <div class="row">
          <input class="grow" type="search" placeholder="Filter by name, address, maker, room, floor, proxy or kind" .value=${this._filter} @input=${(e) => { this._filter = e.target.value; }}>
          ${uiSelect({ label: "Kind", value: this._kind, options: KIND_FILTERS.map(([v, l]) => ({ value: v, label: l })), onChange: (v) => { this._kind = v; }, style: "min-width: 150px" })}
          <span class="chips">${uiSwitch({ label: `Show all (${all.length})`, checked: this._showAll, onChange: (v) => { this._showAll = v; } })}</span>
          ${uiButton({ label: "Refresh", kind: "text", icon: "mdi:refresh", onClick: () => this._refreshLight() })}
        </div>
        <div class="wrap"><table class="compact">
          <tr><th>Device</th><th>Maker</th><th>Where</th><th class="num">Proxies</th><th class="num">Signal</th><th>Seen</th><th></th></tr>
          ${candidates.slice(0, 200).map((c) => { const w = this._heardWhere(c, index); return html`<tr>
            <td><b>${c.name}</b> ${c.kind === "tile" ? html`<span class="pill">Tile</span>` : c.kind === "ibeacon" ? html`<span class="pill">iBeacon</span>` : nothing}<br><span class="muted small">${c.address}</span></td>
            <td>${c.manufacturer || html`<span class="muted">unknown</span>`}${c.apple_summary ? html`<br><span class="small muted">${c.apple_summary}</span>` : c.address_type === "bd_addr_random_resolvable" ? html`<br><span class="small muted">rotating address (IRK)</span>` : nothing}</td>
            <td>${w ? html`${w.room || w.floor}${w.room ? html`<br><span class="muted small">${w.floor}</span>` : nothing}<br><span class="muted small">${w.proxy}</span>` : c.area_name ? html`${c.area_name}` : html`<span class="muted">—</span>`}</td>
            <td class="num" title="placed proxies hearing it">${placed.size ? placedHearing(c) : c.scanners}</td>
            <td class="num" title="strongest reading (RSSI)">${w ? w.rssi : c.best_rssi ?? "—"} dBm</td>
            <td class="small">${fmtAge(c.last_seen_age)} ago<br><span class="muted">first ${fmtAge(c.first_seen_age)}</span></td>
            <td>${uiButton({ label: "Track…", kind: "primary", disabled: this._busy, onClick: () => this._startTrack(c), title: "Choose its name, class and height first; Bermuda tracks it when you confirm" })}</td>
          </tr>`; })}
          ${candidates.length ? nothing : html`<tr><td colspan="7" class="muted">${this._candidates ? (this._showAll ? "No matching devices." : `Nothing heard in the last ${RECENT_SECS} s matches; switch on "Show all" for everything Bermuda remembers.`) : "Loading…"}</td></tr>`}
        </table></div>
        <p class="small muted">Only what two or more placed proxies hear is listed: one proxy cannot position a device, and anything heard solely by an unplaced proxy (a kiosk, a test board) is left out; "Show all" lifts both. Apple FindMy tags are not in this list: they need their pairing keys, added on the Bermuda page.</p>
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
              <span class="chips" title="Read Tile IDs over Bluetooth. Off by default: Private ID Tiles rotate the readable ID with the address, and a connection makes them rotate on the spot.">${uiSwitch({ label: "Tile identity probes", checked: !!this._options.tile_identity_probes, onChange: (v) => { this._options = { ...this._options, tile_identity_probes: v }; } })}</span>
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
    // Live, unbound Tile addresses with where they are, for the adopt pickers.
    const index = this._placedIndex();
    const liveTiles = (this._candidates || []).filter((c) => c.kind === "tile" && (c.last_seen_age ?? 1e9) <= 60)
      .map((c) => { const w = this._heardWhere(c, index); return { address: c.address, where: w ? `${w.room || w.floor} · ${w.proxy} (${w.rssi} dBm)` : c.area_name || "unplaced proxies only" }; })
      .sort((a, b) => a.where.localeCompare(b.where));
    return html`
      <p class="small muted">Click a Tile's name to call it "Kitchen keys"; the map and the Trackers page use that name. Bermuda follows each Tile across its address rotations by RSSI pattern and remembers where it last was, so it finds it again after a restart; that works while the Tile is not sitting among other Tiles. A Tile marked <span class="pill warn">not heard</span> has rotated away unseen: pick the live address that is where the Tile is and Adopt. On Private ID Tiles the ID readable over Bluetooth rotates too, so it cannot name a tag; probing stays off unless "Tile identity probes" is on above.</p>
      <div class="wrap"><table class="compact">
        <tr><th>Tile</th><th>Bound address</th><th>This Tile is…</th><th>History</th></tr>
        ${bindings.map(([id, sources]) => { const lost = t.bound_age?.[id] == null || t.bound_age[id] > 300; return html`<tr>
          <td><a href="#" class="name" title="Name this Tile (and set its class, height and icon)" @click=${(e) => { e.preventDefault(); this._openWizard(id, sources[0]); }}>${trackerName(this.data, id)}</a>${this.data?.layout?.tracker_names?.[id] ? nothing : html`<br><span class="muted small">click to name it</span>`}${t.uids?.[id] ? html`<br><code class="small">${t.uids[id]}</code>` : nothing}</td>
          <td><code>${sources[0] || "—"}</code>${t.bound_age?.[id] != null ? html` <span class="muted small">heard ${fmtAge(t.bound_age[id])} ago</span>` : html` <span class="pill warn">not heard</span>`}</td>
          <td>${liveTiles.length ? html`<div class="row">
            ${uiSelect({ label: lost ? "pick the tag it is now" : "re-point it", value: this._adoptPick[id] || "", options: [{ value: "", label: lost ? "choose a live Tile address…" : "leave as is" }, ...liveTiles.map((c) => ({ value: c.address, label: `${c.address} · ${c.where}` }))], onChange: (v) => { this._adoptPick = { ...this._adoptPick, [id]: v }; }, style: "min-width: 300px" })}
            ${uiButton({ label: "Adopt", kind: lost ? "primary" : "outline", disabled: !this._adoptPick[id], onClick: () => this._adoptTile(id) })}</div>` : html`<span class="muted small">no unbound Tile address heard right now</span>`}</td>
          <td class="small muted">${sources.slice(1, 4).join(" → ") || "—"}</td>
        </tr>`; })}
      </table></div>
      ${this._options?.tile_identity_probes ? this._renderIdentities(bindings.map(([id]) => id)) : nothing}
      <p class="small muted">Handovers ${t.handovers ?? 0} (${t.ambiguous_handovers ?? 0} ambiguous) · probes ${t.probes ?? 0}, failed ${t.probe_failures ?? 0}${t.probes_inherited ? `, ${t.probes_inherited} inherited` : ""}${t.probes_pending?.length ? `, pending ${t.probes_pending.length}` : ""}${t.probe_budget_left != null ? ` · ${t.probe_budget_left} connections left this hour` : ""}.
        ${t.last_handover ? html`Last: ${trackerName(this.data, t.last_handover.tile)} → <code>${t.last_handover.to}</code> by ${t.last_handover.reason || "rssi pattern"}${t.last_handover.score != null ? ` (${fmtNum(t.last_handover.score, 1)} dB over ${t.last_handover.scanners} proxies)` : ""}.` : nothing}
        ${t.last_probe?.detail ? html`<br>Last probe of <code>${t.last_probe.address}</code>: ${t.last_probe.error || "ok"} ${t.last_probe.detail}` : nothing}
      </p>`;
  }

  /** The placed proxy (address -> {name, floor, room}) index, for "where is this Tile". */
  _placedIndex() {
    const out = new Map();
    for (const f of this.data?.layout?.floor || []) {
      for (const r of f.receivers || []) {
        if (!r.address || !r.cords) continue;
        const room = (f.zones || []).find((z) => !z.no_go && (z.cords || []).length >= 3 && pointInPolygon({ x: r.cords.x, y: r.cords.y }, z.cords));
        out.set(String(r.address).toLowerCase(), { name: this.data?.scanners?.[r.address]?.name || r.entity_id, floor: f.name, room: room?.entity_id || null });
      }
    }
    return out;
  }

  _renderIdentities(tileIds) {
    const ids = Object.values(this._identities || {}).sort((a, b) => (a.last_seen_age ?? 1e9) - (b.last_seen_age ?? 1e9));
    if (!ids.length) return nothing;
    const options = [{ value: "", label: "choose a Tile…" }, ...tileIds.map((id) => ({ value: id, label: trackerName(this.data, id) }))];
    const placed = this._placedIndex();
    const where = (row) => {
      const heard = row.heard_by || (row.strongest ? [row.strongest] : []);
      const hit = heard.find((h) => placed.has(String(h.address || "").toLowerCase()));
      if (!hit) return { room: row.area_name || null, proxy: null, unplaced: heard.length };
      const p = placed.get(String(hit.address).toLowerCase());
      return { room: p.room ? `${p.room} · ${p.floor}` : p.floor, proxy: `${p.name} (${hit.rssi} dBm)`, unplaced: heard.length - heard.filter((h) => placed.has(String(h.address || "").toLowerCase())).length };
    };
    return html`<h4>Tile IDs heard <span class="muted small">read from the tags; pick which configured Tile each one is. To tell two apart, ring one from the Tile app, carry it to another room for two minutes and watch which ID moves.</span></h4>
      <div class="wrap"><table class="compact">
        <tr><th>Tile ID</th><th>Last heard</th><th>Where</th><th>Loudest placed proxy</th><th>Is</th><th></th></tr>
        ${ids.map((row) => { const w = where(row); return html`<tr>
          <td><code>${row.uid}</code></td>
          <td>${row.last_seen_age != null ? `${fmtAge(row.last_seen_age)} ago` : "—"}</td>
          <td>${w.room || "—"}</td>
          <td class="small">${w.proxy || html`<span class="muted">only unplaced proxies hear it</span>`}${w.unplaced && w.proxy ? html` <span class="muted">(+${w.unplaced} unplaced and ignored)</span>` : nothing}</td>
          <td>${row.tile_id ? html`<b>${trackerName(this.data, row.tile_id)}</b>` : html`<div class="row">
            ${uiSelect({ label: "", value: this._bindPick[row.uid] || "", options, onChange: (v) => { this._bindPick = { ...this._bindPick, [row.uid]: v }; }, style: "min-width: 200px" })}
            ${uiButton({ label: "Bind", kind: "primary", disabled: !this._bindPick[row.uid], onClick: () => this._bindTile(row.uid) })}</div>`}</td>
          <td class="small muted">${row.addresses?.length || 0} address${row.addresses?.length === 1 ? "" : "es"}</td>
        </tr>`; })}
      </table></div>`;
  }

  static styles = [sharedStyles, widgetStyles, css`
    :host { display: block; overflow: auto; position: relative; }
    .cols { grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); }
    @media (max-width: 720px) { .cols { grid-template-columns: 1fr; } .row > ha-textfield, .row > ha-input, .row > ha-select, .row > .chips, .row > label.field { width: 100% !important; min-width: 0 !important; box-sizing: border-box; } .card { min-width: 0; overflow-x: hidden; } }
    .card.wide { grid-column: 1 / -1; }
    table.compact th, table.compact td { padding: 5px 8px; }
    td.who { display: flex; align-items: center; gap: 10px; }
    .icon { width: 28px; height: 28px; object-fit: contain; flex: none; color: var(--secondary-text-color); --mdc-icon-size: 26px; }
    button.iconpick { padding: 2px; border-radius: 50%; border-color: transparent; line-height: 0; }
    button.iconpick:hover { border-color: var(--primary-color); }
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
