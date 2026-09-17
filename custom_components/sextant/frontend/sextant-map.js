/**
 * Sextant map: one canvas renderer shared by the panel and the Lovelace card.
 *
 * Draws a floor (image, zones, sub-zones, no-go areas, receivers) and the
 * trackers on it, with pan/zoom, and - in edit mode - lets the host move
 * receivers, drag polygon vertices, add vertices on edges and draw new
 * polygons. It owns no data model: the host hands it a floor object in the
 * layout's own shape (pixel coordinates of the floor image), tracker rows
 * from the positions payload, and receives edits back through callbacks.
 *
 * Coordinate frames: "map" = floor image pixels (what the layout stores);
 * "screen" = CSS pixels on the canvas. view = {k, tx, ty}: screen = map*k + t.
 */

export const MAP_FRAME_WIDTH = 2000;
const RECEIVER_SIZE = 10;
const RECEIVER_SIZE_EDIT = 13;   // proxies are the things people drag: give them a target
const VERTEX_SIZE = 6;
const HIT_SLOP = 8;
const TRACKER_RADIUS = 12;
const HUES = [205, 25, 140, 95, 320, 45, 260, 180, 0, 60];

// --- Material Design Icons on the canvas ------------------------------------
// The panel classes trackers (person, dog, phone...) and draws that class's
// MDI icon in the dot. Canvas cannot render <ha-icon>, but Home Assistant
// resolves an icon name to SVG path data for us: render one off-screen,
// read the path out of its shadow DOM, and keep it. Callers get null until
// it arrives (the map is redrawn then) and fall back to initials.
const _iconPaths = new Map();
export function mdiPath(name, onReady) {
  if (!name) return null;
  if (_iconPaths.has(name)) return _iconPaths.get(name);
  _iconPaths.set(name, null);
  (async () => {
    try {
      const el = document.createElement("ha-icon");
      el.setAttribute("icon", name);
      el.style.cssText = "position:absolute;left:-9999px;top:-9999px;";
      document.body.appendChild(el);
      await el.updateComplete;
      for (let i = 0; i < 20; i++) {
        const svg = el.shadowRoot?.querySelector("ha-svg-icon");
        await svg?.updateComplete;
        const d = svg?.shadowRoot?.querySelector("path")?.getAttribute("d");
        if (d) { _iconPaths.set(name, new Path2D(d)); break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      el.remove();
    } catch { /* stays null: initials are drawn instead */ }
    onReady?.();
  })();
  return null;
}

export function trackerHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

export function polygonCentroid(points) {
  if (!points.length) return { x: 0, y: 0 };
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const f = a.x * b.y - b.x * a.y;
    area += f; cx += (a.x + b.x) * f; cy += (a.y + b.y) * f;
  }
  if (Math.abs(area) < 1e-9) {
    const n = points.length;
    return { x: points.reduce((s, p) => s + p.x, 0) / n, y: points.reduce((s, p) => s + p.y, 0) / n };
  }
  area *= 0.5;
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

export function pointInPolygon(pt, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export class SextantMap {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} host callbacks: onSelect(sel), onChange(kind, item), onDrawPoint(pt),
   *                 onHover(sel), onContextMenu(sel, event); colors: getColor(name)
   */
  constructor(canvas, host = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.host = host;
    this.floor = null;
    this.image = null;
    this.imageUrl = null;
    this.trackers = [];
    this.trails = new Map();
    this.offline = new Set();
    this.options = { circles: false, trails: true, fingerprint: false, grid: "off", labels: true, subzones: true, image: true, focus: null };
    this.locks = { zone: false, subzone: false, receiver: false }; // edit mode: locked kinds cannot be selected or dragged
    this.mode = "view";
    this.tool = "select";
    this.selection = null; // {kind:'receiver'|'zone'|'subzone'|'tracker', index, vertex?}
    this.hover = null;
    this.draft = null; // points of a polygon being drawn
    this.view = { k: 1, tx: 0, ty: 0 };
    this._fitted = false;
    this._drag = null;
    this._raf = 0;
    this._bind();
    this._resize = new ResizeObserver(() => this._onResize());
    this._resize.observe(canvas);
    this._onResize();
  }

  destroy() {
    this._resize.disconnect();
    cancelAnimationFrame(this._raf);
  }

  // --- data ------------------------------------------------------------------

  setFloor(floor, imageUrl) {
    const changed = !this.floor || this.floor !== floor || imageUrl !== this.imageUrl;
    this.floor = floor;
    if (imageUrl !== this.imageUrl) {
      this.imageUrl = imageUrl;
      this.image = null;
      this._fitted = false;
      if (imageUrl) {
        const img = new Image();
        img.onload = () => { if (this.imageUrl === imageUrl) { this.image = img; this._fitted = false; this.invalidate(); } };
        img.onerror = () => this.invalidate();
        img.src = imageUrl;
      }
    }
    if (changed) { this.selection = null; this.draft = null; }
    this.invalidate();
  }

  setTrackers(rows) { this.trackers = rows || []; this.invalidate(); }
  setTrail(ent, points) { if (points) this.trails.set(ent, points); else this.trails.delete(ent); this.invalidate(); }
  clearTrails() { this.trails.clear(); this.invalidate(); }
  setOffline(slugs) { this.offline = new Set(slugs || []); this.invalidate(); }
  setOptions(opts) { Object.assign(this.options, opts); this.invalidate(); }
  setMode(mode) { this.mode = mode; if (mode !== "edit") { this.draft = null; this.tool = "select"; } this.invalidate(); }
  setTool(tool) { this.tool = tool; this.draft = tool === "select" ? null : this.draft; this.invalidate(); }
  setSelection(sel) { this.selection = sel; this.invalidate(); }
  setLocks(locks) { Object.assign(this.locks, locks || {}); if (this.selection && this.locks[this.selection.kind]) this.selection = null; this.invalidate(); }
  finishDraft() {
    const pts = this.draft;
    this.draft = null;
    this.invalidate();
    return pts && pts.length >= 3 ? pts : null;
  }
  cancelDraft() { this.draft = null; this.invalidate(); }

  // --- view --------------------------------------------------------------------

  _onResize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr; this.canvas.height = h * dpr;
      this._fitted = false;
    }
    this.invalidate();
  }

  fit() {
    const rect = this.canvas.getBoundingClientRect();
    const size = this._mapSize();
    if (!size.w || !size.h || !rect.width) return;
    const k = Math.min(rect.width / size.w, rect.height / size.h) * 0.96;
    this.view = { k, tx: (rect.width - size.w * k) / 2, ty: (rect.height - size.h * k) / 2 };
    this._fitted = true;
    this.invalidate();
  }

  // The layout's coordinate frame is NOT the image's natural pixels: the
  // original editor drew every floor image onto a canvas normalised to
  // MAP_FRAME_WIDTH pixels wide (height by aspect ratio) and stored
  // coordinates in that frame, and every saved layout depends on it.
  _mapSize() {
    if (this.image) return { w: MAP_FRAME_WIDTH, h: MAP_FRAME_WIDTH * (this.image.naturalHeight / this.image.naturalWidth) };
    // No image yet: size to the content so an image-less floor still renders.
    let maxX = 0, maxY = 0;
    const f = this.floor || {};
    for (const r of f.receivers || []) { maxX = Math.max(maxX, r.cords?.x || 0); maxY = Math.max(maxY, r.cords?.y || 0); }
    for (const list of [f.zones || [], f.subzones || []]) for (const z of list) for (const p of z.cords || []) { maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    return { w: maxX ? maxX * 1.05 : 1000, h: maxY ? maxY * 1.05 : 700 };
  }

  toScreen(p) { return { x: p.x * this.view.k + this.view.tx, y: p.y * this.view.k + this.view.ty }; }
  toMap(p) { return { x: (p.x - this.view.tx) / this.view.k, y: (p.y - this.view.ty) / this.view.k }; }

  // --- input --------------------------------------------------------------------

  _bind() {
    const c = this.canvas;
    c.style.touchAction = "none";
    c.addEventListener("pointerdown", (e) => this._down(e));
    c.addEventListener("pointermove", (e) => this._move(e));
    c.addEventListener("pointerup", (e) => this._up(e));
    c.addEventListener("pointercancel", (e) => this._up(e));
    c.addEventListener("wheel", (e) => this._wheel(e), { passive: false });
    c.addEventListener("dblclick", (e) => this._dblclick(e));
    c.addEventListener("contextmenu", (e) => { e.preventDefault(); const hit = this.hitTest(this._local(e)); if (this.host.onContextMenu) this.host.onContextMenu(hit, e); });
  }

  _local(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  _down(e) {
    const p = this._local(e);
    this.canvas.setPointerCapture(e.pointerId);
    const hit = this.hitTest(p);
    if (this.mode === "edit" && this.tool !== "select" && e.button === 0) {
      // Drawing: each click adds a vertex; clicking the first vertex closes.
      const m = this.toMap(p);
      if (this.draft && this.draft.length >= 3) {
        const first = this.toScreen(this.draft[0]);
        if (Math.hypot(first.x - p.x, first.y - p.y) < HIT_SLOP * 1.5) { if (this.host.onDrawClose) this.host.onDrawClose(); return; }
      }
      this.draft = this.draft || [];
      this.draft.push({ x: Math.round(m.x * 1000) / 1000, y: Math.round(m.y * 1000) / 1000 });
      if (this.host.onDrawPoint) this.host.onDrawPoint(this.draft);
      this.invalidate();
      return;
    }
    if (this.mode === "edit" && hit && e.button === 0 && hit.kind !== "tracker") {
      this.selection = hit;
      if (this.host.onSelect) this.host.onSelect(hit);
      const m = this.toMap(p);
      this._drag = { kind: "item", hit, start: m, moved: false, origin: this._itemPoints(hit) };
      if (this.host.onDragStart) this.host.onDragStart(hit);
      this.invalidate();
      return;
    }
    if (hit && hit.kind === "tracker" && e.button === 0 && this.mode !== "edit") {
      this.selection = hit;
      if (this.host.onSelect) this.host.onSelect(hit);
    } else if (this.mode !== "edit" && this.host.onSelect && !hit) {
      this.selection = null;
      this.host.onSelect(null);
    } else if (this.mode === "edit" && !hit) {
      this.selection = null;
      if (this.host.onSelect) this.host.onSelect(null);
    }
    this._drag = { kind: "pan", start: p, view: { ...this.view }, moved: false };
  }

  _itemPoints(hit) {
    const f = this.floor;
    if (hit.kind === "receiver") { const r = f.receivers[hit.index]; return [{ x: r.cords.x, y: r.cords.y }]; }
    const list = hit.kind === "zone" ? f.zones : f.subzones;
    return (list[hit.index].cords || []).map((q) => ({ x: q.x, y: q.y }));
  }

  _move(e) {
    const p = this._local(e);
    if (!this._drag) {
      const hit = this.hitTest(p);
      const key = hit ? `${hit.kind}:${hit.index}:${hit.vertex ?? ""}` : "";
      if (key !== this._hoverKey) {
        this._hoverKey = key; this.hover = hit;
        this.canvas.style.cursor = hit ? (this.mode === "edit" ? "move" : "pointer") : (this.mode === "edit" && this.tool !== "select" ? "crosshair" : "grab");
        if (this.host.onHover) this.host.onHover(hit);
        this.invalidate();
      }
      return;
    }
    const d = this._drag;
    if (d.kind === "pan") {
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      this.view = { k: d.view.k, tx: d.view.tx + dx, ty: d.view.ty + dy };
      this.invalidate();
      return;
    }
    const m = this.toMap(p);
    const dx = m.x - d.start.x, dy = m.y - d.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 0.5) d.moved = true;
    const f = this.floor, hit = d.hit;
    if (hit.kind === "receiver") {
      f.receivers[hit.index].cords = { x: d.origin[0].x + dx, y: d.origin[0].y + dy };
    } else {
      const list = hit.kind === "zone" ? f.zones : f.subzones;
      const item = list[hit.index];
      if (hit.vertex != null) {
        item.cords[hit.vertex] = { x: d.origin[hit.vertex].x + dx, y: d.origin[hit.vertex].y + dy };
      } else if (hit.edge != null) {
        // Dragging an edge midpoint inserts a vertex there, then drags it.
        const at = hit.edge + 1;
        item.cords.splice(at, 0, { x: m.x, y: m.y });
        d.hit = { ...hit, edge: undefined, vertex: at };
        d.origin = item.cords.map((q) => ({ x: q.x, y: q.y }));
        d.origin[at] = { x: m.x - dx, y: m.y - dy };
        this.selection = d.hit;
      } else {
        item.cords = d.origin.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      }
    }
    this.invalidate();
  }

  _up(e) {
    const d = this._drag;
    this._drag = null;
    this.lastDragMoved = !!(d && d.moved);
    if (!d) return;
    if (d.kind === "item" && d.moved) {
      const f = this.floor, hit = d.hit;
      const round = (q) => ({ x: Math.round(q.x * 1000) / 1000, y: Math.round(q.y * 1000) / 1000 });
      if (hit.kind === "receiver") f.receivers[hit.index].cords = round(f.receivers[hit.index].cords);
      else { const list = hit.kind === "zone" ? f.zones : f.subzones; list[hit.index].cords = list[hit.index].cords.map(round); }
      if (this.host.onChange) this.host.onChange(hit.kind, hit.index);
    }
    this.invalidate();
  }

  _wheel(e) {
    e.preventDefault();
    const p = this._local(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    const k = Math.max(0.05, Math.min(20, this.view.k * factor));
    const m = this.toMap(p);
    this.view = { k, tx: p.x - m.x * k, ty: p.y - m.y * k };
    this._fitted = true;
    this.invalidate();
  }

  _dblclick(e) {
    if (this.mode === "edit" && this.draft && this.draft.length >= 3) { if (this.host.onDrawClose) this.host.onDrawClose(); return; }
    this.fit();
  }

  // --- hit testing -----------------------------------------------------------

  hitTest(p) {
    const f = this.floor;
    if (!f) return null;
    const m = this.toMap(p);
    const slop = HIT_SLOP / this.view.k;
    if (this.mode !== "edit") {
      for (let i = this.trackers.length - 1; i >= 0; i--) {
        const t = this.trackers[i];
        if (!t.cords) continue;
        if (Math.hypot(t.cords[0] - m.x, t.cords[1] - m.y) <= (TRACKER_RADIUS + 4) / this.view.k) return { kind: "tracker", index: i, ent: t.ent };
      }
    }
    const edit = this.mode === "edit";
    const rs = ((edit ? RECEIVER_SIZE_EDIT : RECEIVER_SIZE) + (edit ? 6 : 0)) / this.view.k;
    if (!(edit && this.locks.receiver)) {
      for (let i = (f.receivers || []).length - 1; i >= 0; i--) {
        const r = f.receivers[i];
        if (r.cords && Math.abs(r.cords.x - m.x) <= slop + rs && Math.abs(r.cords.y - m.y) <= slop + rs) return { kind: "receiver", index: i, id: r.entity_id };
      }
    }
    if (this.mode === "edit") {
      // Vertices and edge midpoints of the selected polygon first.
      const sel = this.selection;
      if (sel && (sel.kind === "zone" || sel.kind === "subzone")) {
        const list = sel.kind === "zone" ? f.zones : f.subzones;
        const item = list[sel.index];
        if (item) {
          const pts = item.cords || [];
          for (let v = 0; v < pts.length; v++) if (Math.hypot(pts[v].x - m.x, pts[v].y - m.y) <= slop + VERTEX_SIZE / this.view.k) return { kind: sel.kind, index: sel.index, id: item.entity_id, vertex: v };
          for (let v = 0; v < pts.length; v++) {
            const a = pts[v], b = pts[(v + 1) % pts.length];
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            if (Math.hypot(mid.x - m.x, mid.y - m.y) <= slop + VERTEX_SIZE / this.view.k) return { kind: sel.kind, index: sel.index, id: item.entity_id, edge: v };
          }
        }
      }
    }
    const subs = this.options.subzones && !(edit && this.locks.subzone) ? f.subzones || [] : [];
    for (let i = subs.length - 1; i >= 0; i--) if ((subs[i].cords || []).length >= 3 && pointInPolygon(m, subs[i].cords)) return { kind: "subzone", index: i, id: subs[i].entity_id };
    if (edit && this.locks.zone) return null;
    for (let i = (f.zones || []).length - 1; i >= 0; i--) if ((f.zones[i].cords || []).length >= 3 && pointInPolygon(m, f.zones[i].cords)) return { kind: "zone", index: i, id: f.zones[i].entity_id };
    return null;
  }

  // --- drawing ----------------------------------------------------------------

  invalidate() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }

  draw() {
    const ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    if (!this._fitted) this.fit();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const f = this.floor;
    if (!f) return;
    const v = this.view;
    ctx.save();
    ctx.translate(v.tx, v.ty);
    ctx.scale(v.k, v.k);
    const size = this._mapSize();
    ctx.fillStyle = this._css("--sextant-map-bg", "#ffffff");
    ctx.fillRect(0, 0, size.w, size.h);
    if (this.image && this.options.image !== false) ctx.drawImage(this.image, 0, 0, size.w, size.h);
    this._drawGrid(ctx, size);
    this._drawPolygons(ctx, f.zones || [], "zone");
    if (this.options.subzones) this._drawPolygons(ctx, f.subzones || [], "subzone");
    this._drawDraft(ctx);
    this._drawReceivers(ctx, f.receivers || []);
    if (this.mode !== "edit") this._drawTrackers(ctx);
    ctx.restore();
  }

  _css(name, fallback) {
    const value = getComputedStyle(this.canvas).getPropertyValue(name).trim();
    return value || fallback;
  }

  _drawGrid(ctx, size) {
    const unit = this.options.grid;
    const scale = this.floor.scale;
    if (!unit || unit === "off" || !scale) return;
    const step = unit === "ft" ? scale * 0.3048 : scale;
    ctx.save();
    ctx.strokeStyle = "rgba(120,120,120,0.25)";
    ctx.lineWidth = 1 / this.view.k;
    ctx.beginPath();
    for (let x = 0; x <= size.w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, size.h); }
    for (let y = 0; y <= size.h; y += step) { ctx.moveTo(0, y); ctx.lineTo(size.w, y); }
    ctx.stroke();
    ctx.restore();
  }

  _drawPolygons(ctx, list, kind) {
    const k = this.view.k;
    list.forEach((item, index) => {
      const pts = item.cords || [];
      if (pts.length < 2) return;
      const selected = this.selection && this.selection.kind === kind && this.selection.index === index;
      const hovered = this.hover && this.hover.kind === kind && this.hover.index === index;
      const noGo = !!item.no_go;
      const hue = kind === "subzone" ? null : trackerHue(item.entity_id || "");
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (pts.length >= 3) ctx.closePath();
      if (kind === "subzone") {
        ctx.fillStyle = (item.color || "hsl(175,70%,45%)").replace(/\)$/, ", 0.22)").replace("hsl(", "hsla(");
        ctx.strokeStyle = item.color || "hsl(175,70%,45%)";
      } else if (noGo) {
        ctx.fillStyle = "rgba(110,110,110,0.30)";
        ctx.strokeStyle = "rgba(70,70,70,0.9)";
      } else {
        ctx.fillStyle = `hsla(${hue}, 60%, 55%, ${selected || hovered ? 0.28 : 0.16})`;
        ctx.strokeStyle = `hsla(${hue}, 60%, 40%, 0.9)`;
      }
      ctx.lineWidth = (selected ? 3 : hovered ? 2 : 1.25) / k;
      if (noGo) ctx.setLineDash([6 / k, 4 / k]);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      if (noGo) this._hatch(ctx, pts);
      if (this.options.labels && item.entity_id) {
        const c = polygonCentroid(pts);
        this._label(ctx, item.entity_id, c.x, c.y, kind === "subzone" ? 11 : 13, kind === "subzone" ? 0.75 : 0.9);
      }
      if (this.mode === "edit" && selected) {
        for (let v = 0; v < pts.length; v++) this._handle(ctx, pts[v], VERTEX_SIZE / k, "#ffffff", ctx.strokeStyle);
        for (let v = 0; v < pts.length; v++) {
          const a = pts[v], b = pts[(v + 1) % pts.length];
          this._handle(ctx, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, VERTEX_SIZE * 0.6 / k, "rgba(255,255,255,0.6)", ctx.strokeStyle);
        }
      }
    });
  }

  _hatch(ctx, pts) {
    ctx.save();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.clip();
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    ctx.strokeStyle = "rgba(60,60,60,0.45)";
    ctx.lineWidth = 1.5 / this.view.k;
    ctx.beginPath();
    const step = 14 / this.view.k;
    for (let x = minX - (maxY - minY); x < maxX; x += step) { ctx.moveTo(x, maxY); ctx.lineTo(x + (maxY - minY), minY); }
    ctx.stroke();
    ctx.restore();
  }

  _handle(ctx, p, r, fill, stroke) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill();
    ctx.lineWidth = 1.5 / this.view.k; ctx.strokeStyle = stroke; ctx.stroke();
  }

  _label(ctx, text, x, y, px, alpha = 0.9) {
    const k = this.view.k;
    const size = px / k;
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width;
    ctx.fillStyle = `rgba(255,255,255,${alpha * 0.85})`;
    const pad = 4 / k;
    ctx.fillRect(x - w / 2 - pad, y - size / 2 - pad / 2, w + pad * 2, size + pad);
    ctx.fillStyle = `rgba(20,24,32,${alpha})`;
    ctx.fillText(text, x, y);
  }

  _drawReceivers(ctx, receivers) {
    const k = this.view.k, edit = this.mode === "edit";
    const base = edit ? RECEIVER_SIZE_EDIT : RECEIVER_SIZE;
    receivers.forEach((r, index) => {
      if (!r.cords) return;
      const selected = this.selection && this.selection.kind === "receiver" && this.selection.index === index;
      const hovered = this.hover && this.hover.kind === "receiver" && this.hover.index === index;
      const offline = this.offline.has(r.entity_id);
      const unmatched = r.unmatched;
      const locked = edit && this.locks.receiver;
      const s = (hovered || selected ? base * 1.4 : base) / k;
      ctx.save();
      ctx.translate(r.cords.x, r.cords.y);
      ctx.rotate(Math.PI / 4);
      ctx.globalAlpha = locked ? 0.55 : 1;
      ctx.fillStyle = offline ? "#d9534f" : unmatched ? "#e0a54a" : "#1f7a8c";
      ctx.strokeStyle = selected ? "#ffd166" : "#ffffff";
      ctx.lineWidth = (selected ? 3 : 1.5) / k;
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.strokeRect(-s / 2, -s / 2, s, s);
      ctx.restore();
      if (this.options.labels && (edit || hovered || selected || this.options.receiverLabels)) {
        this._label(ctx, r.label || r.entity_id, r.cords.x, r.cords.y + (base + 9) / k, 10, 0.8);
      }
    });
  }

  _drawDraft(ctx) {
    const pts = this.draft;
    if (!pts || !pts.length) return;
    const k = this.view.k;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 2 / k; ctx.setLineDash([6 / k, 4 / k]);
    ctx.stroke(); ctx.setLineDash([]);
    pts.forEach((p, i) => this._handle(ctx, p, (i === 0 ? VERTEX_SIZE * 1.3 : VERTEX_SIZE) / k, "#ffd166", "#5a4400"));
  }

  _drawTrackers(ctx) {
    const k = this.view.k;
    const focus = this.options.focus || null;
    for (const t of this.trackers) {
      if (!t.cords) continue;
      const hue = t.hue ?? trackerHue(t.ent);
      const color = `hsl(${hue}, 70%, 45%)`;
      const focused = focus && t.ent === focus;
      ctx.save();
      if (focus && !focused) ctx.globalAlpha = 0.28;   // everything but the one you clicked fades back
      const trail = this.options.trails ? this.trails.get(t.ent) : null;
      if (trail && trail.length > 1) {
        ctx.beginPath();
        trail.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.strokeStyle = `hsla(${hue}, 70%, 45%, 0.5)`; ctx.lineWidth = 2 / k; ctx.stroke();
      }
      if (this.options.circles && Array.isArray(t.radii)) {
        for (const [x, y, r] of t.radii) {
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.strokeStyle = `hsla(${hue}, 70%, 45%, 0.35)`; ctx.lineWidth = 1 / k; ctx.stroke();
        }
      }
      if (this.options.fingerprint && t.fp && t.fp.fix) {
        ctx.beginPath(); ctx.arc(t.fp.fix[0], t.fp.fix[1], 7 / k, 0, Math.PI * 2);
        ctx.strokeStyle = color; ctx.lineWidth = 2 / k; ctx.setLineDash([3 / k, 3 / k]); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(t.fp.fix[0], t.fp.fix[1]); ctx.lineTo(t.cords[0], t.cords[1]);
        ctx.strokeStyle = `hsla(${hue}, 70%, 45%, 0.5)`; ctx.lineWidth = 1 / k; ctx.stroke();
      }
      if (t.raw && this.options.circles) {
        ctx.beginPath(); ctx.arc(t.raw[0], t.raw[1], 4 / k, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue}, 70%, 45%, 0.6)`; ctx.fill();
      }
      const selected = focused || (this.selection && this.selection.kind === "tracker" && this.selection.ent === t.ent);
      const r = (focused ? TRACKER_RADIUS * 1.6 : TRACKER_RADIUS) / k;
      if (focused) {
        // A halo that does not scale with zoom, so the focused tracker is findable at any zoom level.
        ctx.beginPath(); ctx.arc(t.cords[0], t.cords[1], r * 2.6, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${hue}, 80%, 40%, 0.9)`; ctx.lineWidth = 3 / k; ctx.setLineDash([8 / k, 5 / k]); ctx.stroke(); ctx.setLineDash([]);
      }
      // Confidence ring: the published conf in (0,1] as the ring's alpha.
      ctx.beginPath(); ctx.arc(t.cords[0], t.cords[1], r * 1.9, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue}, 70%, 45%, ${0.08 + 0.22 * (t.conf ?? 0.5)})`; ctx.fill();
      ctx.beginPath(); ctx.arc(t.cords[0], t.cords[1], r, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.lineWidth = (selected ? 3 : 2) / k; ctx.strokeStyle = selected ? "#ffd166" : "#ffffff"; ctx.stroke();
      const glyph = t.mdi ? mdiPath(t.mdi, () => this.invalidate()) : null;
      if (t.icon && t.icon.complete && t.icon.naturalWidth) {
        ctx.save(); ctx.beginPath(); ctx.arc(t.cords[0], t.cords[1], r * 0.85, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(t.icon, t.cords[0] - r * 0.85, t.cords[1] - r * 0.85, r * 1.7, r * 1.7); ctx.restore();
      } else if (glyph) {
        // MDI paths live in a 24x24 box; fit it inside the dot.
        const s = (r * 1.4) / 24;
        ctx.save(); ctx.translate(t.cords[0] - r * 0.7, t.cords[1] - r * 0.7); ctx.scale(s, s);
        ctx.fillStyle = "#ffffff"; ctx.fill(glyph); ctx.restore();
      } else {
        ctx.fillStyle = "#ffffff"; ctx.font = `700 ${11 / k}px system-ui, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText((t.label || t.ent).slice(0, 2).toUpperCase(), t.cords[0], t.cords[1]);
      }
      if (this.options.labels || focused) this._label(ctx, t.label || t.ent, t.cords[0], t.cords[1] + r + 9 / k, focused ? 13 : 11, 0.9);
      ctx.restore();
    }
  }
}
