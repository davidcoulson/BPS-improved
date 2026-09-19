/**
 * Edit mode: the floor-plan editor on the shared map.
 *
 * Works on a draft copy of the layout; nothing reaches the store until Save.
 * Receivers are placed by picking a scanner Bermuda knows, zones, sub-zones
 * and no-go areas are drawn as polygons, and the map's scale is set from a
 * measured distance. A new floor is a map image upload (through the HTTP
 * view, the one thing the websocket does not carry).
 */
import { LitElement, html, css, nothing } from "./lit.js";
import { SextantMap, polygonCentroid, snapToVertex, squareUp } from "./sextant-map.js";
import { sharedStyles, widgetStyles, toast, callWS, confirmDialog, fmtNum, fmtLen, uiField, uiSelect, uiSwitch, uiButton, proxyName, lenUnit, toDisplayLen, fromDisplayLen, fmtScale, isImperial, THING_CLASSES, CLASS_FAMILIES } from "./sextant-ui.js";
import { mapUrlFor } from "./sextant-panel.js";

// [id, label under the icon, icon, tooltip]
const TOOLS = [
  ["select", "Select", "mdi:cursor-default-outline", "Select and drag proxies, rooms and vertices. A dragged proxy snaps onto a nearby wall on the side you are dragging from; hold Alt to place it freely"],
  ["receiver", "Proxy", "mdi:access-point-plus", "Place a proxy: pick one Bermuda knows, then click the map"],
  ["zone", "Room", "mdi:vector-polygon", "Draw a room: click corners, close on the first one"],
  ["subzone", "Spot", "mdi:vector-rectangle", "Draw a spot (a couch, a desk, a bedside table) inside a room"],
  ["nogo", "No-go", "mdi:cancel", "Draw an area things can never be in (a void, a wall)"],
  ["measure", "Scale", "mdi:ruler", "Set the map scale from a known distance"],
  ["pin", "Pin", "mdi:crosshairs-gps", "Pin a point that lines up through the house - an outside corner, a stair post. The same name on another floor says how the floors stack. It lands on a room corner when one is near; hold Alt to place it freely"],
];
// Layers that can be locked against selection and dragging, so a finished
// room layout is not nudged while proxies are being moved (and vice versa).
const LOCKS = [
  ["zone", "Rooms", "mdi:floor-plan"],
  ["subzone", "Spots", "mdi:vector-rectangle"],
  ["receiver", "Proxies", "mdi:access-point"],
  ["pin", "Pins", "mdi:crosshairs-gps"],
];
const UNDO_DEPTH = 50;

function uid(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

class SextantEdit extends LitElement {
  static properties = {
    hass: { attribute: false },
    data: { attribute: false },
    floor: { type: String },
    narrow: { type: Boolean },
    spots: { attribute: false },   // advised proxy spots to show: [{floor, room, x, y}]
    _draft: { state: true },
    _dirty: { state: true },
    _tool: { state: true },
    _selection: { state: true },
    _placing: { state: true },
    _measure: { state: true },
    _proposal: { state: true },
    _busy: { state: true },
    _locks: { state: true },
    _undo: { state: true },
    _alignment: { state: true },
  };

  constructor() {
    super();
    this._draft = null;
    this._dirty = false;
    this._tool = "select";
    this._selection = null;
    this._placing = null; // scanner address chosen for the next receiver click
    this._measure = null; // {a, b} map points
    this._proposal = null;
    this._busy = false;
    this._tick = 0;
    // Rooms start locked: once a floor plan is drawn it rarely changes, and a
    // slip while moving a proxy must not move a wall.
    this._locks = { zone: true, subzone: false, receiver: false, pin: false };
    this._undo = [];
    this._alignment = null; // how the floors stack, graded by the backend against this draft
  }

  // --- undo ---------------------------------------------------------------------

  _snapshot() {
    if (!this._draft) return;
    this._undo = [...this._undo.slice(-(UNDO_DEPTH - 1)), JSON.stringify(this._draft, (k, v) => (k === "linked" || k === "miss" || k === "missLabel" ? undefined : v))];
  }

  _undoLast() {
    if (!this._undo.length) return;
    const prev = this._undo[this._undo.length - 1];
    this._undo = this._undo.slice(0, -1);
    this._draft = JSON.parse(prev);
    this._dirty = JSON.stringify(this._draft) !== JSON.stringify(this.data?.layout || { floor: [] });
    this._proposal = null;
    this._pushFloor();
  }

  _setLock(kind, locked) {
    this._locks = { ...this._locks, [kind]: locked };
    this._map?.setLocks(this._locks);
    if (this._selection?.kind === kind && locked) this._selection = null;
  }

  firstUpdated() {
    this._map = new SextantMap(this.renderRoot.querySelector("canvas"), {
      fetch: (url) => this.hass.fetchWithAuth(url),
      onSelect: (hit) => { this._selection = hit; },
      onDragStart: () => this._snapshot(),
      onChange: (kind) => { this._dirty = true; this._tick++; if (kind === "pin") this._refreshAlignment(); this.requestUpdate(); },
      onDrawPoint: () => this.requestUpdate(),
      onDrawClose: () => this._closeDraft(),
      onContextMenu: (hit) => this._context(hit),
    });
    this._map.setMode("edit");
    this._map.setOptions({ labels: true, subzones: true, receiverLabels: true, trails: false });
    this._map.setLocks(this._locks);
    this._syncDraft(true);
  }

  disconnectedCallback() { super.disconnectedCallback(); clearTimeout(this._alignTimer); this._map?.destroy(); }

  updated(changed) {
    if (!this._map) return;
    if (changed.has("data")) this._syncDraft(!this._dirty);
    if (changed.has("floor")) this._pushFloor();
    if (changed.has("spots") || changed.has("floor")) this._map.setSuggestions((this.spots || []).filter((s) => s.floor === this.floor).map((s) => ({ x: s.x, y: s.y, label: `add a proxy here · ${s.room}` })));
    if (changed.has("_tool")) { this._map.setTool(["measure", "receiver", "pin"].includes(this._tool) ? "select" : this._tool); }
  }

  _syncDraft(replace) {
    if (replace || !this._draft) {
      this._draft = JSON.parse(JSON.stringify(this.data?.layout || { floor: [] }));
      this._dirty = false;
      this._selection = null;
      this._undo = [];
    }
    this._pushFloor();
  }

  _floorObj() { return (this._draft?.floor || []).find((f) => f.name === this.floor) || null; }

  _pushFloor() {
    const f = this._floorObj();
    if (f) {
      // Mark placements Bermuda does not know, for the orange marker.
      const known = new Set(Object.keys(this.data?.scanners || {}));
      const knownSlugs = new Set(Object.values(this.data?.scanners || {}).map((s) => s.slug));
      for (const r of f.receivers || []) {
        r.unmatched = !((r.address && known.has(r.address)) || knownSlugs.has(r.entity_id));
        r.label = proxyName(this.data, r.address || r.entity_id);   // the map shows the friendly name, not the slug
      }
    }
    this._map?.setFloor(f, mapUrlFor(this.floor, this.data?.maps));
    this._map?.setOffline(this.data?.offline_receivers || []);
    this._map?.setSelection(null);
    this._selection = null;
    // The last report already covers every floor: show THIS floor's rings now
    // rather than leaving the previous floor's drawn until the next reply.
    this._markPins();
    this._refreshAlignment();
  }

  // --- pins: how the floors stack ----------------------------------------------

  /** Transient marks the map draws pins with; stripped again before Save. */
  _markPins() {
    const rep = this._alignment;
    for (const fl of this._draft?.floor || []) {
      const misses = rep?.floors?.[fl.name]?.misses || {};
      for (const pin of fl.pins || []) {
        pin.linked = (rep?.pins?.[pin.name] || []).length > 1;
        pin.miss = misses[pin.name] ?? null;
        pin.missLabel = pin.miss == null ? null : fmtLen(pin.miss, this.hass, 2);
      }
    }
    this._map?.setPinGhosts(rep?.floors?.[this.floor]?.ghosts || []);
  }

  /** Ask the backend to grade the DRAFT, so a pin's effect on the fit shows
   * while it is still being placed. Debounced: a drag fires per pixel. */
  _refreshAlignment() {
    clearTimeout(this._alignTimer);
    // Replies can overtake each other while a pin is dragged; only the answer
    // to the LATEST question may be shown, or the card flickers back to a
    // grading of where the pin was half a second ago.
    const asked = (this._alignAsked = (this._alignAsked || 0) + 1);
    this._alignTimer = setTimeout(async () => {
      const draft = this._draft;
      if (!draft || !(draft.floor || []).some((fl) => (fl.pins || []).length)) { this._alignment = null; this._markPins(); return; }
      const clean = { floor: draft.floor.map((fl) => ({ name: fl.name, scale: fl.scale, level: fl.level, elevation: fl.elevation, pins: (fl.pins || []).map((q) => ({ name: q.name, cords: q.cords })) })) };
      let report = null;
      try {
        report = await this.hass.callWS({ type: "sextant/registration", layout: clean });
      } catch (_e) {
        report = null;   // an older backend: the pins still save, they just are not graded
      }
      if (asked !== this._alignAsked || !this.isConnected) return;   // superseded, or the page has gone
      this._alignment = report;
      this._markPins();
    }, 250);
  }

  /** Names pinned on other floors and not yet on this one: what to offer next. */
  _pinNamesElsewhere(f) {
    const here = new Set((f.pins || []).map((q) => q.name));
    const names = [];
    for (const fl of this._draft?.floor || []) if (fl !== f) for (const q of fl.pins || []) if (q.name && !here.has(q.name) && !names.includes(q.name)) names.push(q.name);
    return names;
  }

  _placePin(e) {
    const f = this._floorObj();
    if (!f || this._map.hover?.kind === "pin") return;   // a click on a pin selects it
    let p = this._mapPoint(e);
    if (!e.altKey) p = snapToVertex(p, f.zones, 12 / this._map.view.k) || p;
    this._snapshot();
    f.pins = f.pins || [];
    // The next name another floor is waiting on, so linking a floor is a row
    // of clicks in the same order; a fresh name only when there is none.
    let n = f.pins.length + 1;
    const all = new Set((this._draft.floor || []).flatMap((fl) => (fl.pins || []).map((q) => q.name)));
    while (all.has(`Pin ${n}`)) n++;
    const name = this._pinNamesElsewhere(f)[0] || `Pin ${n}`;
    f.pins.push({ pin_id: uid("pin"), name, cords: { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 } });
    this._dirty = true;
    this._selection = { kind: "pin", index: f.pins.length - 1 };
    this._map.setSelection(this._selection);
    this._refreshAlignment();
    this.requestUpdate();
  }

  /** The draft as it should be stored: without the marks the map draws with.
   * Both save paths go through here - adding a floor posts the draft too, and
   * used to send `unmatched`, `label` and the pin marks along with it. */
  _cleanDraft() {
    const draft = this._draft;
    for (const f of draft.floor) {
      for (const r of f.receivers || []) { delete r.unmatched; delete r.label; }
      for (const q of f.pins || []) { delete q.linked; delete q.miss; delete q.missLabel; }
    }
    return draft;
  }

  _listFor(kind, f) { return kind === "receiver" ? f.receivers : kind === "zone" ? f.zones : kind === "pin" ? f.pins : f.subzones; }

  // --- tools -------------------------------------------------------------------

  _setTool(tool) {
    this._tool = tool;
    this._measure = null;
    if (tool !== "receiver") this._placing = null;
    if (["receiver", "measure", "pin"].includes(tool)) this._map.setTool("select");
    if (tool === "pin" && this._locks.pin) this._setLock("pin", false);   // you are placing pins: they must be reachable
  }

  _onCanvasClick(e) {
    if (this._map?.lastDragMoved) return; // a pan, not a click
    if (this._tool === "receiver" && this._placing) this._placeReceiver(e);
    else if (this._tool === "measure") this._measureClick(e);
    else if (this._tool === "pin") this._placePin(e);
  }

  _mapPoint(e) {
    const r = this._map.canvas.getBoundingClientRect();
    return this._map.toMap({ x: e.clientX - r.left, y: e.clientY - r.top });
  }

  _placeReceiver(e) {
    const f = this._floorObj();
    if (!f) return;
    const p = this._mapPoint(e);
    const info = this.data?.scanners?.[this._placing];
    const slug = info?.slug || this._placing.replace(/:/g, "_");
    this._snapshot();
    f.receivers = f.receivers || [];
    f.receivers.push({ entity_id: slug, cords: { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }, type: "receiver", address: this._placing });
    this._placing = null;
    this._tool = "select";
    this._dirty = true;
    this._pushFloor();
    this._selection = { kind: "receiver", index: f.receivers.length - 1 };
    this._map.setSelection(this._selection);
  }

  _measureClick(e) {
    const p = this._mapPoint(e);
    if (!this._measure || this._measure.b) this._measure = { a: p, b: null };
    else this._measure = { ...this._measure, b: p };
  }

  _applyMeasure(shown) {
    const metres = fromDisplayLen(shown, this.hass);
    const m = this._measure, f = this._floorObj();
    if (!m?.b || !f || !(metres > 0)) return;
    this._snapshot();
    const px = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y);
    f.scale = Math.round((px / metres) * 10000) / 10000;
    this._dirty = true;
    this._measure = null;
    this._tool = "select";
    toast(this, `Scale set to ${fmtScale(f.scale, this.hass)}`);
  }

  _closeDraft() {
    const pts = this._map.finishDraft();
    const f = this._floorObj();
    if (!pts || !f) return;
    this._snapshot();
    const tool = this._tool;
    if (tool === "zone" || tool === "nogo") {
      f.zones = f.zones || [];
      const name = tool === "nogo" ? `No-go ${f.zones.filter((z) => z.no_go).length + 1}` : `Room ${f.zones.length + 1}`;
      f.zones.push({ zone_id: uid("zone"), entity_id: name, poly: true, cords: pts, type: "zone", ...(tool === "nogo" ? { no_go: true } : {}) });
      if (this._locks.zone) this._setLock("zone", false);   // you just drew one: you are editing rooms
      this._selection = { kind: "zone", index: f.zones.length - 1 };
    } else if (tool === "subzone") {
      f.subzones = f.subzones || [];
      const c = polygonCentroid(pts);
      const parent = (f.zones || []).find((z) => !z.no_go && this._inside(c, z.cords));
      f.subzones.push({ sub_zone_id: uid("subzone"), entity_id: `Spot ${f.subzones.length + 1}`, parent: parent?.zone_id || null, poly: true,
        color: `hsl(${Math.floor(Math.random() * 360)}, 70%, 45%)`, cords: pts, type: "subzone" });
      this._selection = { kind: "subzone", index: f.subzones.length - 1 };
    }
    this._dirty = true;
    this._tool = "select";
    this._map.setTool("select");
    this._map.setSelection(this._selection);
    this._map.invalidate();
  }

  _inside(pt, cords) {
    let inside = false;
    for (let i = 0, j = cords.length - 1; i < cords.length; j = i++) {
      const a = cords[i], b = cords[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  _context(hit) {
    if (!hit) return;
    if (hit.vertex != null) {
      const f = this._floorObj();
      const list = hit.kind === "zone" ? f.zones : f.subzones;
      if (list[hit.index].cords.length > 3) { this._snapshot(); list[hit.index].cords.splice(hit.vertex, 1); this._dirty = true; this._map.invalidate(); }
    }
  }

  /** Straighten the selected room or spot's near-straight edges (see squareUp). */
  _squareUp() {
    const sel = this._selection, f = this._floorObj();
    if (!sel || !f || (sel.kind !== "zone" && sel.kind !== "subzone")) return;
    const item = this._listFor(sel.kind, f)[sel.index];
    const squared = squareUp(item.cords || []);
    const moved = squared.reduce((m, q, i) => Math.max(m, Math.hypot(q.x - item.cords[i].x, q.y - item.cords[i].y)), 0);
    if (moved < 0.01) return toast(this, "Already square");
    this._snapshot();
    item.cords = squared;
    this._dirty = true;
    this._map.invalidate();
    this.requestUpdate();
    const m = f.scale ? moved / f.scale : null;
    toast(this, m != null ? `Squared up; no corner moved more than ${Math.round(m * 100)} cm. Save to keep it` : "Squared up. Save to keep it");
  }

  _deleteSelection() {
    const sel = this._selection, f = this._floorObj();
    if (!sel || !f) return;
    const list = this._listFor(sel.kind, f);
    const item = list[sel.index];
    if (!confirmDialog(`Delete ${sel.kind === "receiver" ? "proxy" : sel.kind === "zone" ? "room" : sel.kind === "pin" ? "pin" : "spot"} "${item.entity_id ?? item.name}"?`)) return;
    this._snapshot();
    list.splice(sel.index, 1);
    if (sel.kind === "pin") this._refreshAlignment();
    if (sel.kind === "zone") for (const s of f.subzones || []) if (s.parent === item.zone_id) s.parent = null;
    this._selection = null;
    this._dirty = true;
    this._map.setSelection(null);
    this._map.invalidate();
  }

  _edit(field, value) {
    const sel = this._selection, f = this._floorObj();
    if (!sel || !f) return;
    const list = this._listFor(sel.kind, f);
    const item = list[sel.index];
    this._snapshot();
    if (sel.kind === "pin") this._refreshAlignment();
    if (field === "height" || field === "correction") item[field] = value === "" || value == null ? undefined : Number(value);
    else if (field === "no_go") item.no_go = !!value;
    else item[field] = value;
    if (item.height === undefined) delete item.height;
    if (item.correction === undefined) delete item.correction;
    this._dirty = true;
    this._map.invalidate();
    this.requestUpdate();
  }

  // --- floors ------------------------------------------------------------------

  async _addFloor(name, file) {
    if (!name || !file) return toast(this, "A floor needs a name and a map image");
    const draft = this._cleanDraft();
    const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : ".png";
    const filename = `${name}${ext}`;
    draft.floor.push({ name, scale: null, receivers: [], zones: [], subzones: [] });
    const form = new FormData();
    form.append("coordinates", JSON.stringify(draft));
    form.append("new_floor", "true");
    form.append("file", file, filename);
    this._busy = true;
    try {
      const resp = await this.hass.fetchWithAuth("/api/sextant/save_text", { method: "POST", body: form });
      if (!resp.ok) throw new Error(await resp.text());
      toast(this, `Floor ${name} added`);
      this._dirty = false;
      this.dispatchEvent(new CustomEvent("layout-changed"));
      this.dispatchEvent(new CustomEvent("floor-changed", { detail: name }));
    } catch (e) {
      draft.floor.pop();
      toast(this, `Add floor failed: ${e.message || e}`, 6000);
    } finally {
      this._busy = false;
    }
  }

  async _removeFloor() {
    const f = this._floorObj();
    if (!f || !confirmDialog(`Delete floor "${f.name}" with its ${(f.receivers || []).length} proxies and ${(f.zones || []).length} rooms?`)) return;
    const maps = this.data?.maps || [];
    const url = mapUrlFor(f.name, maps);
    const mapFile = url ? decodeURIComponent(url.split("/").pop()) : null;
    this._draft.floor = this._draft.floor.filter((x) => x !== f);
    await this._save(mapFile);
    this.dispatchEvent(new CustomEvent("floor-changed", { detail: this._draft.floor[0]?.name || null }));
  }

  async _save(removeMap = null) {
    const draft = this._cleanDraft();
    this._busy = true;
    const r = await callWS(this, this.hass, { type: "sextant/layout/save", layout: draft, ...(removeMap ? { remove_map: removeMap } : {}) });
    this._busy = false;
    if (r) { toast(this, "Floor plan saved"); this._dirty = false; this.dispatchEvent(new CustomEvent("layout-changed")); }
  }

  _discard() {
    if (this._dirty && !confirmDialog("Discard unsaved changes?")) return;
    this._syncDraft(true);
  }

  async _adjust(target) {
    const f = this._floorObj();
    if (!f) return;
    this._busy = true;
    const r = await callWS(this, this.hass, { type: "sextant/adjust_zones", target, zones: f.zones || [], subzones: f.subzones || [], options: {} });
    this._busy = false;
    if (r) this._proposal = { target, ...r };
  }

  _acceptProposal() {
    const f = this._floorObj(), p = this._proposal;
    if (!f || !p) return;
    this._snapshot();
    if (p.zones) f.zones = p.zones;
    if (p.subzones) f.subzones = p.subzones;
    this._proposal = null;
    this._dirty = true;
    this._pushFloor();
  }

  // --- render -----------------------------------------------------------------

  render() {
    const f = this._floorObj();
    const sel = this._selection;
    const scanners = Object.entries(this.data?.scanners || {}).sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));
    const placedAddr = new Set((this._draft?.floor || []).flatMap((fl) => (fl.receivers || []).map((r) => r.address)));
    return html`
      <div class="stage">
        <canvas @click=${(e) => this._onCanvasClick(e)}></canvas>
        <div class="toolbar">
          ${TOOLS.map(([id, label, icon, tip]) => html`<button class="tool ${this._tool === id ? "active" : ""}" title=${tip} @click=${() => this._setTool(id)}><ha-icon icon=${icon}></ha-icon><span>${label}</span></button>`)}
          <span class="sep"></span>
          <button class="tool" title="Fit the whole map into the view" @click=${() => this._map.fit()}><ha-icon icon="mdi:fit-to-screen"></ha-icon><span>Fit</span></button>
          <span class="sep"></span>
          ${LOCKS.map(([kind, label, icon]) => html`<button class="tool lock ${this._locks[kind] ? "locked" : ""}" title=${this._locks[kind] ? `${label} are locked: click to allow selecting and moving them` : `${label} can be moved: click to lock them`} @click=${() => this._setLock(kind, !this._locks[kind])}>
            <span class="lockicons"><ha-icon icon=${icon}></ha-icon><ha-icon class="badge" icon=${this._locks[kind] ? "mdi:lock" : "mdi:lock-open-variant-outline"}></ha-icon></span><span>${label}</span></button>`)}
          <span class="sep"></span>
          <button class="tool" title="Undo the last change (${this._undo.length} step${this._undo.length === 1 ? "" : "s"})" ?disabled=${!this._undo.length} @click=${() => this._undoLast()}><ha-icon icon="mdi:undo"></ha-icon><span>Undo</span></button>
          ${uiButton({ label: "Save", kind: "primary", disabled: !this._dirty || this._busy, onClick: () => this._save(), title: "Write the floor plan to the store" })}
          ${uiButton({ label: "Discard", kind: "text", disabled: !this._dirty, onClick: () => this._discard() })}
        </div>
        ${this._tool === "receiver" ? html`<div class="hint">
          <select @change=${(e) => { this._placing = e.target.value || null; }}>
            <option value="">Pick a proxy, then click the map…</option>
            ${scanners.map(([addr, s]) => html`<option value=${addr} ?disabled=${placedAddr.has(addr)}>${s.name || s.slug}${placedAddr.has(addr) ? " (placed)" : ""}${s.area ? ` · ${s.area}` : ""}</option>`)}
          </select></div>` : nothing}
        ${this._tool === "measure" ? html`<div class="hint">
          ${this._measure?.b ? html`${uiField({ label: `Distance between the two points (${lenUnit(this.hass)})`, type: "number", step: 0.01, min: 0.1, onChange: (v) => { this._metres = v; }, style: "width: 240px" })} ${uiButton({ label: "Set scale", kind: "primary", onClick: () => this._applyMeasure(this._metres) })}`
            : this._measure ? "Click the second point." : `Click two points a known distance apart. Current scale: ${fmtScale(f?.scale, this.hass)}`}
        </div>` : nothing}
        ${this._tool === "pin" ? html`<div class="hint">Click a point you can find on every floor: an outside corner, a stair post, a chimney. It lands on a room corner when one is near (Alt places it freely). Then switch floor and pin the same points - the names carry over in order.</div>` : nothing}
        ${["zone", "subzone", "nogo"].includes(this._tool) ? html`<div class="hint">Click to add corners; click the first corner or double-click to close. An edge close to horizontal or vertical snaps straight (orange); hold Alt to place a corner freely. ${uiButton({ label: "Cancel", kind: "text", onClick: () => { this._map.cancelDraft(); } })}</div>` : nothing}
      </div>
      <aside class="side">
        ${f ? html`
          <div class="card">
            <h4>${f.name} <span class="muted small">${fmtScale(f.scale, this.hass)}</span></h4>
            <div class="row small muted">${(f.receivers || []).length} proxies · ${(f.zones || []).filter((z) => !z.no_go).length} rooms · ${(f.zones || []).filter((z) => z.no_go).length} no-go · ${(f.subzones || []).length} spots</div>
            <div class="row small muted">Level: storey number, 0 = ground, -1 = basement; orders the floor picker top-down. Elevation: this floor's finished floor above the ground floor's, so ceiling height plus the floor structure; blank assumes 3 m a storey. Bias: election prior, 1.2 = a 20 % head start every cycle.</div>
            <div class="row">
              ${/* Measuring two points gives a float with a dozen decimals; a
                    hundredth of a pixel per metre is already far finer than any
                    measurement behind it, so show and store it rounded. */ ""}
              ${uiField({ label: "Scale (px per m)", type: "number", step: 0.01, value: f.scale == null ? "" : Math.round(f.scale * 100) / 100, onChange: (v) => { this._snapshot(); f.scale = Number(v) || null; this._dirty = true; this.requestUpdate(); }, style: "width: 150px" })}
              ${uiField({ label: "Level", type: "number", step: 1, value: f.level ?? "", placeholder: "0", onChange: (v) => { if (v === "" || v == null) delete f.level; else f.level = Math.round(Number(v)); this._dirty = true; this.requestUpdate(); }, style: "width: 90px" })}
              ${uiField({ label: `Elevation (${lenUnit(this.hass)})`, type: "number", step: 0.05, value: toDisplayLen(f.elevation, this.hass), placeholder: String(toDisplayLen((f.level || 0) * 3, this.hass)), onChange: (v) => { this._snapshot(); const m = fromDisplayLen(v, this.hass); if (m == null || isNaN(m)) delete f.elevation; else f.elevation = m; this._dirty = true; this._refreshAlignment(); this.requestUpdate(); }, style: "width: 130px" })}
              ${uiField({ label: "Election bias", type: "number", step: 0.05, min: 0.25, max: 4, value: f.bias ?? "", placeholder: "1", onChange: (v) => { if (v === "" || v == null) delete f.bias; else f.bias = Number(v); this._dirty = true; this.requestUpdate(); }, style: "width: 120px" })}
              ${uiButton({ label: "Adjust rooms", disabled: this._busy, onClick: () => this._adjust("zones"), title: "Square up rooms and snap shared walls" })}
              ${uiButton({ label: "Adjust spots", disabled: this._busy, onClick: () => this._adjust("subzones") })}
              ${uiButton({ label: "Delete floor", kind: "danger", disabled: this._busy, onClick: () => this._removeFloor() })}
            </div>
          </div>` : html`<div class="card muted">No floor yet. Add one below.</div>`}
        ${f ? this._renderAlignment(f) : nothing}
        ${this._proposal ? html`<div class="card">
          <h4>Proposed ${this._proposal.target}</h4>
          <ul class="plain small">${(this._proposal.report || this._proposal.changes || []).slice(0, 12).map((c) => html`<li>${typeof c === "string" ? c : `${c.name || c.zone || ""}: ${c.change || c.note || JSON.stringify(c)}`}</li>`)}</ul>
          <div class="row">${uiButton({ label: "Accept", kind: "primary", onClick: () => this._acceptProposal() })}${uiButton({ label: "Reject", kind: "text", onClick: () => { this._proposal = null; } })}</div>
        </div>` : nothing}
        ${sel ? this._renderSelection(sel, f) : html`<div class="card muted small">Select a proxy, room or spot on the map to edit it. Drag to move; drag a vertex or an edge midpoint; right-click a vertex to remove it. Locked layers (the padlocks in the toolbar) cannot be selected.</div>`}
        <div class="card">
          <h4>Add a floor</h4>
          <form @submit=${(e) => { e.preventDefault(); const fd = new FormData(e.target); this._addFloor(fd.get("name"), fd.get("file")); }}>
            <div class="row"><input class="grow" type="text" name="name" placeholder="Floor name" required><input type="file" name="file" accept="image/*" required></div>
            <div class="row">${uiButton({ label: "Add floor", kind: "primary", disabled: this._busy, onClick: (e) => e.target.closest("form").requestSubmit() })}<span class="muted small">The image is stored as the floor's map.</span></div>
          </form>
        </div>
        ${(this.data?.scanner_diagnostics?.unplaced_scanners || []).length ? html`<div class="card small"><h4>Proxies reporting, not placed</h4>${this.data.scanner_diagnostics.unplaced_scanners.map((s) => proxyName(this.data, s)).join(", ")}</div>` : nothing}
      </aside>
    `;
  }

  /** How this floor stacks against the others, and what the pins say about it. */
  _renderAlignment(f) {
    const rep = this._alignment, pins = f.pins || [];
    const row = rep?.floors?.[f.name];
    const waiting = this._pinNamesElsewhere(f);
    if (!pins.length && !waiting.length) {
      return html`<div class="card small muted"><h4>Alignment</h4>Floors are drawn separately and nothing says how they stack. Pin two or more points that line up through the house (the Pin tool), with the same names on each floor.</div>`;
    }
    const useScale = (px) => { this._snapshot(); f.scale = px; this._dirty = true; this._refreshAlignment(); this.requestUpdate(); toast(this, `Scale set to ${fmtScale(px, this.hass)}. Save, then re-run calibration for this floor: its corrections were learned at the old scale`, 8000); };
    const off = row?.implied_scale && row.scale ? Math.abs(row.implied_scale / row.scale - 1) : 0;
    return html`<div class="card small">
      <h4>Alignment <span class="muted small">${pins.length} pin${pins.length === 1 ? "" : "s"}</span></h4>
      ${!row ? html`<div class="muted">Checking…</div>`
        : row.reference ? html`<div>This is the reference floor: the others are lined up against it.</div>`
        : row.ok ? html`${(row.suspects || []).length ? html`<div class="warn"><b>${row.suspects.join(" and ")}</b> ${row.suspects.length === 1 ? "does" : "do"} not line up with the rest (${row.suspects.map((n) => fmtLen(row.misses?.[n], this.hass, 1)).join(", ")} off) and ${row.suspects.length === 1 ? "was" : "were"} left out of the fit. Most often the corner clicked here is not above the one on the other floor: a room that is longer upstairs, a wall set in from the one below. The grey rings on the plan show where the other floors put each pin.</div>` : nothing}<div>Lined up on ${row.shared - (row.suspects || []).length} agreeing pins, typically within <b>${fmtLen(row.rms_m, this.hass, 2)}</b>${row.worst && row.max_m >= 0.05 ? html`; worst is <b>${row.worst}</b> at ${fmtLen(row.max_m, this.hass, 2)}` : nothing}${Math.abs(row.rotation_deg) >= 0.5 ? html`. This plan is turned ${fmtNum(row.rotation_deg, 1)}° against the reference` : nothing}.</div>`
        : row.rms_m != null && row.implied_scale && row.agree_rms_m != null && row.agree_rms_m <= 0.3 ? html`<div class="warn">The pins agree with each other (within ${fmtLen(row.agree_rms_m, this.hass, 2)}) but not at this floor's scale, so the floor cannot be lined up yet. That points at the scale, not at any pin.</div>`
        : row.rms_m != null ? html`<div class="warn">The pins disagree by ${fmtLen(row.rms_m, this.hass, 2)} - too much to use. Check <b>${row.worst}</b> first (${fmtLen(row.max_m, this.hass, 2)} off), or pins that sit very close together.</div>`
        : html`<div class="muted">Not lined up yet: ${row.why}.</div>`}
      ${off >= 0.01 ? html`<div class="row">The pins fit best at <b>${fmtScale(row.implied_scale, this.hass)}</b>; this floor is set to ${fmtScale(row.scale, this.hass)} (${fmtNum(off * 100, 1)} % apart). ${uiButton({ label: "Use the pins' scale", onClick: () => useScale(row.implied_scale), title: "Set this floor's scale from its pins. Four or more well-spread pins usually beat one tape measurement" })}</div>` : nothing}
      ${waiting.length ? html`<div class="muted">Pinned on other floors, not here yet: ${waiting.join(", ")}.</div>` : nothing}
      ${(rep?.unlinked || []).filter((n) => pins.some((q) => q.name === n)).length ? html`<div class="muted">Only on this floor so far: ${rep.unlinked.filter((n) => pins.some((q) => q.name === n)).join(", ")}.</div>` : nothing}
    </div>`;
  }

  _renderSelection(sel, f) {
    const list = this._listFor(sel.kind, f);
    const item = list?.[sel.index];
    if (!item) return nothing;
    if (sel.kind === "pin") {
      const others = [...new Set((this._draft?.floor || []).filter((fl) => fl !== f).flatMap((fl) => (fl.pins || []).map((q) => q.name)))].filter(Boolean);
      const taken = new Set((f.pins || []).filter((q) => q !== item).map((q) => q.name));
      return html`<div class="card">
        <h4>Pin</h4>
        <div class="row">${uiField({ label: "Name (the same on every floor)", value: item.name || "", onChange: (v) => { const name = String(v || "").trim(); if (!name) return; if (taken.has(name)) return toast(this, `This floor already has a pin called ${name}`); this._edit("name", name); }, style: "flex: 1" })}</div>
        ${others.filter((n) => !taken.has(n) && n !== item.name).length ? html`<div class="row small"><span class="muted">On other floors:</span>${others.filter((n) => !taken.has(n) && n !== item.name).map((n) => html`<button class="chip" @click=${() => this._edit("name", n)}>${n}</button>`)}</div>` : nothing}
        <div class="muted small">${item.linked ? "Linked: this name is pinned on another floor too." : "Not linked yet: pin the same point on another floor and give it this name."}${item.miss != null && item.miss >= 0.05 ? ` Misses the fit by ${fmtLen(item.miss, this.hass, 2)}.` : ""} x ${fmtNum(item.cords?.x, 0)}, y ${fmtNum(item.cords?.y, 0)}</div>
        <div class="row"><span class="grow"></span>${uiButton({ label: "Delete", kind: "danger", onClick: () => this._deleteSelection() })}</div>
      </div>`;
    }
    const zones = (f.zones || []).filter((z) => !z.no_go);
    return html`<div class="card">
      <h4>${sel.kind === "receiver" ? "Proxy" : sel.kind === "zone" ? (item.no_go ? "No-go area" : "Room") : "Spot"}</h4>
      <div class="row">
        ${uiField({ label: "Name", value: item.entity_id || "", onChange: (v) => this._edit("entity_id", v), style: "flex: 1" })}
      </div>
      ${sel.kind === "receiver" ? html`
        <div class="row">
          ${uiSelect({ label: "Bermuda proxy", value: item.address || "", options: [{ value: "", label: "none" }, ...Object.entries(this.data?.scanners || {}).map(([addr, s]) => ({ value: addr, label: `${s.name || s.slug} · ${addr}` }))], onChange: (v) => this._edit("address", v || undefined), style: "flex: 1" })}
        </div>
        <div class="row">
          ${uiField({ label: `Mount height (${lenUnit(this.hass)})`, type: "number", step: 0.05, min: 0, max: isImperial(this.hass) ? 33 : 10, value: toDisplayLen(item.height, this.hass), onChange: (v) => this._edit("height", v === "" ? "" : fromDisplayLen(v, this.hass)), style: "width: 150px" })}
          ${uiField({ label: "Correction ×", type: "number", step: 0.001, min: 0.5, max: 2, value: item.correction ?? "", onChange: (v) => this._edit("correction", v), style: "width: 150px" })}
        </div>
        <div class="muted small">${item.unmatched ? "Bermuda does not report this proxy right now." : "Linked."} x ${fmtNum(item.cords?.x, 0)}, y ${fmtNum(item.cords?.y, 0)}</div>` : nothing}
      ${sel.kind === "zone" ? uiSwitch({ label: "No-go area (things can never be here)", checked: !!item.no_go, onChange: (v) => this._edit("no_go", v) }) : nothing}
      ${sel.kind === "subzone" ? html`
        <div class="row">
          ${uiSelect({ label: "Parent room", value: item.parent || "", options: [{ value: "", label: "none" }, ...zones.map((z) => ({ value: z.zone_id, label: z.entity_id }))], onChange: (v) => this._edit("parent", v || null), style: "flex: 1" })}
          <label class="field">Colour<input type="color" .value=${this._hex(item.color)} @change=${(e) => this._edit("color", e.target.value)}></label>
        </div>
        <div class="classes">
          <div class="muted small">Takes which things? None picked means any of them. A bedside table is for a phone, a watch and keys; a cat bed is for the cat.</div>
          <div class="classpick">${this._classPicker(item)}</div>
          <div class="muted small">A ringed group goes together: pick Person or Pet and its kinds count too, shown without the grey background.</div>
        </div>` : nothing}
      <div class="row"><span class="muted small">${(item.cords?.length ?? 1)} point(s)</span><span class="grow"></span>${sel.kind === "zone" || sel.kind === "subzone" ? uiButton({ label: "Square up", icon: "mdi:vector-square", onClick: () => this._squareUp(), title: "Make every edge that is nearly straight exactly horizontal or vertical. Diagonals stay as drawn" }) : nothing}${uiButton({ label: "Delete", kind: "danger", onClick: () => this._deleteSelection() })}</div>
    </div>`;
  }

  /** The class icons for a spot: each family (Person with man, woman, child;
   * Pet with the dog and the cat) inside its own dotted ring so it is obvious
   * which icons travel together, then the rest on their own. Picking the
   * family lights its members too, so the spot's reach is on the screen. */
  _classPicker(item) {
    const chosen = item.classes || [];
    const members = new Set(Object.values(CLASS_FAMILIES).flat());
    const byKey = Object.fromEntries(THING_CLASSES.filter(([k]) => k).map((c) => [c[0], c]));
    const icon = (key) => {
      const [k, label, mdi] = byKey[key];
      const picked = chosen.includes(k);
      const implied = !picked && chosen.some((c) => (CLASS_FAMILIES[c] || []).includes(k));
      const title = implied ? `${label} — comes with the family` : label;
      return html`<button class="cls ${picked ? "on" : implied ? "implied" : ""}" title=${title}
                          aria-label=${title} aria-pressed=${picked || implied}
                          @click=${() => this._edit("classes", this._toggleClass(chosen, k, !picked))}>
        <ha-icon icon=${mdi}></ha-icon>
      </button>`;
    };
    // The families on their own line and the rest on the next: a ring cannot
    // break across lines, so mixing them left a ragged hole in the row.
    return html`
      <div class="picked-row">
        ${Object.entries(CLASS_FAMILIES).map(([parent, kin]) => html`
          <span class="family">${[parent, ...kin].map(icon)}</span>`)}
      </div>
      <div class="picked-row">
        ${THING_CLASSES.filter(([k]) => k && !CLASS_FAMILIES[k] && !members.has(k)).map(([k]) => icon(k))}
      </div>
    `;
  }

  /** The spot's class list with `cls` added or removed; undefined when empty,
   * so a spot that takes anything carries no key at all. */
  _toggleClass(current, cls, on) {
    const next = (current || []).filter((c) => c !== cls);
    if (on) next.push(cls);
    return next.length ? next : undefined;
  }

  _hex(color) {
    if (!color) return "#2a9d8f";
    if (color.startsWith("#")) return color;
    const m = /hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/.exec(color);
    if (!m) return "#2a9d8f";
    const h = Number(m[1]) / 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100;
    const f = (n) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, "0"); };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  static styles = [sharedStyles, widgetStyles, css`
    .classes { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
    /* One icon per class rather than seventeen labelled switches: picked is
       the page's own ink, the rest sit back in grey. The name is on hover. */
    .classpick { display: flex; flex-direction: column; gap: 6px; }
    .picked-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    .family { display: inline-flex; gap: 1px; padding: 2px; border: 1.5px solid var(--divider-color); border-radius: 11px; }
    /* Sized so both family rings sit on one line of the 320px side panel. */
    .classpick .cls { padding: 3px; border: 1px solid transparent; border-radius: 7px; background: transparent; line-height: 0; cursor: pointer; color: var(--disabled-text-color, #c4c4c4); }
    .classpick .cls ha-icon { --mdc-icon-size: 20px; }
    .classpick .cls.on { color: var(--primary-text-color); background: var(--secondary-background-color); border-color: var(--divider-color); }
    /* Pulled in by a family: the same ink as a picked one, but no fill, so it
       reads as "counts, though you did not pick it yourself". */
    .classpick .cls.implied { color: var(--primary-text-color); background: transparent; }
    .classpick .cls:hover { border-color: var(--primary-color); }
    :host { display: grid; grid-template-columns: 1fr 320px; min-height: 0; }
    .stage { position: relative; min-width: 0; }
    canvas { width: 100%; height: 100%; display: block; --sextant-map-bg: var(--card-background-color, #fff); }
    .toolbar { position: absolute; left: 10px; top: 10px; display: flex; gap: 4px; padding: 6px; border-radius: 8px; background: var(--card-background-color); box-shadow: var(--ha-card-box-shadow, 0 1px 4px rgba(0,0,0,0.2)); align-items: center; }
    .toolbar button.tool { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 62px; padding: 4px 6px; font-size: 11px; line-height: 1.1; }
    .toolbar button.tool ha-icon { --mdc-icon-size: 22px; }
    .toolbar button.active { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
    .toolbar button.lock.locked { background: var(--secondary-background-color); color: var(--secondary-text-color); }
    .lockicons { position: relative; display: inline-block; }
    .lockicons .badge { position: absolute; right: -8px; bottom: -4px; --mdc-icon-size: 13px; background: var(--card-background-color); border-radius: 50%; }
    .toolbar button.lock.locked .lockicons .badge { color: var(--error-color, #b00020); }
    .sep { width: 1px; height: 24px; background: var(--divider-color); margin: 0 4px; }
    .hint { position: absolute; left: 10px; bottom: 10px; right: 10px; padding: 8px 10px; border-radius: 8px; background: var(--card-background-color); box-shadow: var(--ha-card-box-shadow, 0 1px 4px rgba(0,0,0,0.2)); font-size: 13px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .hint select { max-width: 100%; }
    .chip { padding: 2px 9px; border-radius: 999px; border: 1px solid var(--divider-color); background: var(--secondary-background-color); color: var(--primary-text-color); font: inherit; font-size: 12px; cursor: pointer; }
    .chip:hover { border-color: var(--primary-color); }
    .warn { color: var(--warning-color, #9a5b00); }
    .side { border-left: 1px solid var(--divider-color); overflow: auto; padding: 12px; }
    ul.plain { list-style: none; padding: 0; margin: 4px 0; }
    @media (max-width: 720px) { :host { grid-template-columns: 1fr; grid-template-rows: 1fr auto; } .side { border-left: 0; border-top: 1px solid var(--divider-color); max-height: 45vh; } .toolbar { flex-wrap: wrap; max-width: calc(100% - 20px); gap: 3px; padding: 4px; } .toolbar button.tool { min-width: 52px; } }
  `];
}

if (!customElements.get("sextant-edit")) customElements.define("sextant-edit", SextantEdit);
