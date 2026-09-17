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
import { SextantMap, polygonCentroid } from "./sextant-map.js";
import { sharedStyles, toast, callWS, confirmDialog, fmtNum } from "./sextant-ui.js";
import { mapUrlFor } from "./sextant-panel.js";

const TOOLS = [
  ["select", "Select / move", "mdi:cursor-default"],
  ["receiver", "Place receiver", "mdi:access-point"],
  ["zone", "Draw zone", "mdi:vector-square"],
  ["subzone", "Draw sub-zone", "mdi:vector-rectangle"],
  ["nogo", "Draw no-go", "mdi:cancel"],
  ["measure", "Measure scale", "mdi:ruler"],
];

function uid(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

class SextantEdit extends LitElement {
  static properties = {
    hass: { attribute: false },
    data: { attribute: false },
    floor: { type: String },
    narrow: { type: Boolean },
    _draft: { state: true },
    _dirty: { state: true },
    _tool: { state: true },
    _selection: { state: true },
    _placing: { state: true },
    _measure: { state: true },
    _proposal: { state: true },
    _busy: { state: true },
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
  }

  firstUpdated() {
    this._map = new SextantMap(this.renderRoot.querySelector("canvas"), {
      onSelect: (hit) => { this._selection = hit; },
      onChange: () => { this._dirty = true; this._tick++; this.requestUpdate(); },
      onDrawPoint: () => this.requestUpdate(),
      onDrawClose: () => this._closeDraft(),
      onContextMenu: (hit) => this._context(hit),
    });
    this._map.setMode("edit");
    this._map.setOptions({ labels: true, subzones: true, receiverLabels: true, trails: false });
    this._syncDraft(true);
  }

  disconnectedCallback() { super.disconnectedCallback(); this._map?.destroy(); }

  updated(changed) {
    if (!this._map) return;
    if (changed.has("data")) this._syncDraft(!this._dirty);
    if (changed.has("floor")) this._pushFloor();
    if (changed.has("_tool")) { this._map.setTool(this._tool === "measure" || this._tool === "receiver" ? "select" : this._tool); }
  }

  _syncDraft(replace) {
    if (replace || !this._draft) {
      this._draft = JSON.parse(JSON.stringify(this.data?.layout || { floor: [] }));
      this._dirty = false;
      this._selection = null;
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
      for (const r of f.receivers || []) r.unmatched = !((r.address && known.has(r.address)) || knownSlugs.has(r.entity_id));
    }
    this._map?.setFloor(f, mapUrlFor(this.floor, this.data?.maps));
    this._map?.setOffline(this.data?.offline_receivers || []);
    this._map?.setSelection(null);
    this._selection = null;
  }

  // --- tools -------------------------------------------------------------------

  _setTool(tool) {
    this._tool = tool;
    this._measure = null;
    if (tool !== "receiver") this._placing = null;
    if (tool === "receiver" || tool === "measure") this._map.setTool("select");
  }

  _onCanvasClick(e) {
    if (this._map?.lastDragMoved) return; // a pan, not a click
    if (this._tool === "receiver" && this._placing) this._placeReceiver(e);
    else if (this._tool === "measure") this._measureClick(e);
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

  _applyMeasure(metres) {
    const m = this._measure, f = this._floorObj();
    if (!m?.b || !f || !(metres > 0)) return;
    const px = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y);
    f.scale = Math.round((px / metres) * 10000) / 10000;
    this._dirty = true;
    this._measure = null;
    this._tool = "select";
    toast(this, `Scale set to ${fmtNum(f.scale, 2)} px/m`);
  }

  _closeDraft() {
    const pts = this._map.finishDraft();
    const f = this._floorObj();
    if (!pts || !f) return;
    const tool = this._tool;
    if (tool === "zone" || tool === "nogo") {
      f.zones = f.zones || [];
      const name = tool === "nogo" ? `No-go ${f.zones.filter((z) => z.no_go).length + 1}` : `Zone ${f.zones.length + 1}`;
      f.zones.push({ zone_id: uid("zone"), entity_id: name, poly: true, cords: pts, type: "zone", ...(tool === "nogo" ? { no_go: true } : {}) });
      this._selection = { kind: "zone", index: f.zones.length - 1 };
    } else if (tool === "subzone") {
      f.subzones = f.subzones || [];
      const c = polygonCentroid(pts);
      const parent = (f.zones || []).find((z) => !z.no_go && this._inside(c, z.cords));
      f.subzones.push({ sub_zone_id: uid("subzone"), entity_id: `Sub-zone ${f.subzones.length + 1}`, parent: parent?.zone_id || null, poly: true,
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
      if (list[hit.index].cords.length > 3) { list[hit.index].cords.splice(hit.vertex, 1); this._dirty = true; this._map.invalidate(); }
    }
  }

  _deleteSelection() {
    const sel = this._selection, f = this._floorObj();
    if (!sel || !f) return;
    const list = sel.kind === "receiver" ? f.receivers : sel.kind === "zone" ? f.zones : f.subzones;
    const item = list[sel.index];
    if (!confirmDialog(`Delete ${sel.kind} "${item.entity_id}"?`)) return;
    list.splice(sel.index, 1);
    if (sel.kind === "zone") for (const s of f.subzones || []) if (s.parent === item.zone_id) s.parent = null;
    this._selection = null;
    this._dirty = true;
    this._map.setSelection(null);
    this._map.invalidate();
  }

  _edit(field, value) {
    const sel = this._selection, f = this._floorObj();
    if (!sel || !f) return;
    const list = sel.kind === "receiver" ? f.receivers : sel.kind === "zone" ? f.zones : f.subzones;
    const item = list[sel.index];
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
    const draft = this._draft;
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
    if (!f || !confirmDialog(`Delete floor "${f.name}" with its ${(f.receivers || []).length} receivers and ${(f.zones || []).length} zones?`)) return;
    const maps = this.data?.maps || [];
    const url = mapUrlFor(f.name, maps);
    const mapFile = url ? decodeURIComponent(url.split("/").pop()) : null;
    this._draft.floor = this._draft.floor.filter((x) => x !== f);
    await this._save(mapFile);
    this.dispatchEvent(new CustomEvent("floor-changed", { detail: this._draft.floor[0]?.name || null }));
  }

  async _save(removeMap = null) {
    const draft = this._draft;
    for (const f of draft.floor) for (const r of f.receivers || []) delete r.unmatched;
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
          ${TOOLS.map(([id, label, icon]) => html`<button class=${this._tool === id ? "active" : ""} title=${label} @click=${() => this._setTool(id)}><ha-icon icon=${icon}></ha-icon></button>`)}
          <span class="sep"></span>
          <button title="Fit" @click=${() => this._map.fit()}><ha-icon icon="mdi:fit-to-screen"></ha-icon></button>
          <span class="sep"></span>
          <button class="primary" ?disabled=${!this._dirty || this._busy} @click=${() => this._save()}>Save</button>
          <button class="ghost" ?disabled=${!this._dirty} @click=${() => this._discard()}>Discard</button>
        </div>
        ${this._tool === "receiver" ? html`<div class="hint">
          <select @change=${(e) => { this._placing = e.target.value || null; }}>
            <option value="">Pick a scanner, then click the map…</option>
            ${scanners.map(([addr, s]) => html`<option value=${addr} ?disabled=${placedAddr.has(addr)}>${s.name || s.slug}${placedAddr.has(addr) ? " (placed)" : ""}${s.area ? ` · ${s.area}` : ""}</option>`)}
          </select></div>` : nothing}
        ${this._tool === "measure" ? html`<div class="hint">
          ${this._measure?.b ? html`Distance between the two points in metres: <input type="number" step="0.01" min="0.1" id="metres"> <button class="primary" @click=${() => this._applyMeasure(Number(this.renderRoot.querySelector("#metres").value))}>Set scale</button>`
            : this._measure ? "Click the second point." : `Click two points a known distance apart. Current scale: ${f?.scale ? fmtNum(f.scale, 2) + " px/m" : "unset"}`}
        </div>` : nothing}
        ${["zone", "subzone", "nogo"].includes(this._tool) ? html`<div class="hint">Click to add vertices; click the first vertex or double-click to close. <button class="ghost" @click=${() => { this._map.cancelDraft(); }}>Cancel</button></div>` : nothing}
      </div>
      <aside class="side">
        ${f ? html`
          <div class="card">
            <h4>${f.name} <span class="muted small">${f.scale ? `${fmtNum(f.scale, 1)} px/m` : "no scale"}</span></h4>
            <div class="row small muted">${(f.receivers || []).length} receivers · ${(f.zones || []).filter((z) => !z.no_go).length} zones · ${(f.zones || []).filter((z) => z.no_go).length} no-go · ${(f.subzones || []).length} sub-zones</div>
            <div class="row">
              <label class="field">Scale px/m<input type="number" step="0.01" .value=${f.scale ?? ""} @change=${(e) => { f.scale = Number(e.target.value) || null; this._dirty = true; this.requestUpdate(); }}></label>
              <button ?disabled=${this._busy} @click=${() => this._adjust("zones")}>Adjust zones</button>
              <button ?disabled=${this._busy} @click=${() => this._adjust("subzones")}>Adjust sub-zones</button>
              <button class="danger" ?disabled=${this._busy} @click=${() => this._removeFloor()}>Delete floor</button>
            </div>
          </div>` : html`<div class="card muted">No floor yet. Add one below.</div>`}
        ${this._proposal ? html`<div class="card">
          <h4>Proposed ${this._proposal.target}</h4>
          <ul class="plain small">${(this._proposal.report || this._proposal.changes || []).slice(0, 12).map((c) => html`<li>${typeof c === "string" ? c : `${c.name || c.zone || ""}: ${c.change || c.note || JSON.stringify(c)}`}</li>`)}</ul>
          <div class="row"><button class="primary" @click=${() => this._acceptProposal()}>Accept</button><button class="ghost" @click=${() => { this._proposal = null; }}>Reject</button></div>
        </div>` : nothing}
        ${sel ? this._renderSelection(sel, f) : html`<div class="card muted small">Select a receiver, zone or sub-zone on the map to edit it. Drag to move; drag a vertex or an edge midpoint; right-click a vertex to remove it.</div>`}
        <div class="card">
          <h4>Add a floor</h4>
          <form @submit=${(e) => { e.preventDefault(); const fd = new FormData(e.target); this._addFloor(fd.get("name"), fd.get("file")); }}>
            <div class="row"><input class="grow" type="text" name="name" placeholder="Floor name" required><input type="file" name="file" accept="image/*" required></div>
            <div class="row"><button type="submit" ?disabled=${this._busy}>Add floor</button><span class="muted small">The image is stored as the floor's map.</span></div>
          </form>
        </div>
        ${(this.data?.scanner_diagnostics?.unplaced_scanners || []).length ? html`<div class="card small"><h4>Reporting, not placed</h4>${this.data.scanner_diagnostics.unplaced_scanners.join(", ")}</div>` : nothing}
      </aside>
    `;
  }

  _renderSelection(sel, f) {
    const list = sel.kind === "receiver" ? f.receivers : sel.kind === "zone" ? f.zones : f.subzones;
    const item = list?.[sel.index];
    if (!item) return nothing;
    const zones = (f.zones || []).filter((z) => !z.no_go);
    return html`<div class="card">
      <h4>${sel.kind === "receiver" ? "Receiver" : sel.kind === "zone" ? (item.no_go ? "No-go area" : "Zone") : "Sub-zone"}</h4>
      <div class="row">
        <label class="field grow">Name<input type="text" .value=${item.entity_id || ""} @change=${(e) => this._edit("entity_id", e.target.value)}></label>
      </div>
      ${sel.kind === "receiver" ? html`
        <div class="row">
          <label class="field grow">Scanner address<select @change=${(e) => this._edit("address", e.target.value || undefined)}>
            <option value="" ?selected=${!item.address}>none</option>
            ${Object.entries(this.data?.scanners || {}).map(([addr, s]) => html`<option value=${addr} ?selected=${item.address === addr}>${s.name || s.slug} · ${addr}</option>`)}
          </select></label>
        </div>
        <div class="row">
          <label class="field">Mount height m<input type="number" step="0.05" min="0" max="10" .value=${item.height ?? ""} @change=${(e) => this._edit("height", e.target.value)}></label>
          <label class="field">Correction ×<input type="number" step="0.001" min="0.5" max="2" .value=${item.correction ?? ""} @change=${(e) => this._edit("correction", e.target.value)}></label>
        </div>
        <div class="muted small">${item.unmatched ? "Bermuda does not report this scanner right now." : "Linked."} x ${fmtNum(item.cords?.x, 0)}, y ${fmtNum(item.cords?.y, 0)}</div>` : nothing}
      ${sel.kind === "zone" ? html`<label class="inline"><input type="checkbox" .checked=${!!item.no_go} @change=${(e) => this._edit("no_go", e.target.checked)}> No-go area (trackers cannot be here)</label>` : nothing}
      ${sel.kind === "subzone" ? html`
        <div class="row">
          <label class="field grow">Parent zone<select @change=${(e) => this._edit("parent", e.target.value || null)}>
            <option value="" ?selected=${!item.parent}>none</option>
            ${zones.map((z) => html`<option value=${z.zone_id} ?selected=${item.parent === z.zone_id}>${z.entity_id}</option>`)}
          </select></label>
          <label class="field">Colour<input type="color" .value=${this._hex(item.color)} @change=${(e) => this._edit("color", e.target.value)}></label>
        </div>` : nothing}
      <div class="row"><span class="muted small">${(item.cords?.length ?? 1)} point(s)</span><span class="grow"></span><button class="danger" @click=${() => this._deleteSelection()}>Delete</button></div>
    </div>`;
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

  static styles = [sharedStyles, css`
    :host { display: grid; grid-template-columns: 1fr 320px; min-height: 0; }
    .stage { position: relative; min-width: 0; }
    canvas { width: 100%; height: 100%; display: block; --sextant-map-bg: var(--card-background-color, #fff); }
    .toolbar { position: absolute; left: 10px; top: 10px; display: flex; gap: 4px; padding: 6px; border-radius: 8px; background: var(--card-background-color); box-shadow: var(--ha-card-box-shadow, 0 1px 4px rgba(0,0,0,0.2)); align-items: center; }
    .toolbar button.active { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
    .sep { width: 1px; height: 24px; background: var(--divider-color); margin: 0 4px; }
    .hint { position: absolute; left: 10px; bottom: 10px; right: 10px; padding: 8px 10px; border-radius: 8px; background: var(--card-background-color); box-shadow: var(--ha-card-box-shadow, 0 1px 4px rgba(0,0,0,0.2)); font-size: 13px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .hint select { max-width: 100%; }
    .side { border-left: 1px solid var(--divider-color); overflow: auto; padding: 12px; }
    ul.plain { list-style: none; padding: 0; margin: 4px 0; }
    @media (max-width: 720px) { :host { grid-template-columns: 1fr; grid-template-rows: 1fr auto; } .side { border-left: 0; border-top: 1px solid var(--divider-color); max-height: 45vh; } }
  `];
}

customElements.define("sextant-edit", SextantEdit);
