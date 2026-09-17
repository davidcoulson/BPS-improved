/**
 * Proxies, Calibration and Tuning modes (one element, three sections).
 *
 * section="proxies":     every placed proxy grouped by floor and room, with
 *                        a health count per group, plus the self-test.
 * section="calibration": proxy calibration runs and their corrections.
 * section="tuning":      the stability KPI with baselines, live tuning, and
 *                        history retention.
 */
import { LitElement, html, css, nothing } from "./lit.js";
import { pointInPolygon } from "./sextant-map.js";
import { sharedStyles, widgetStyles, fmtAge, fmtNum, toast, callWS, confirmDialog, uiField, uiSelect, uiSwitch, uiButton, sortFloors, trackerName, proxyName, fmtLen } from "./sextant-ui.js";

const QUIET_SECS = 120;   // online, but nothing heard for this long: "quiet"

class SextantHealth extends LitElement {
  static properties = {
    hass: { attribute: false },
    data: { attribute: false },
    positions: { attribute: false },
    floor: { type: String },
    section: { type: String },
    _receivers: { state: true },
    _cal: { state: true },
    _selftest: { state: true },
    _kpi: { state: true },
    _kpiHours: { state: true },
    _baselines: { state: true },
    _baseline: { state: true },
    _baselineName: { state: true },
    _linking: { state: true },
    _busy: { state: true },
    _tuning: { state: true },
    _calFloor: { state: true },
    _calDuration: { state: true },
    _open: { state: true },
  };

  constructor() {
    super();
    this.section = "proxies";
    this._receivers = null;
    this._cal = null;
    this._selftest = null;
    this._kpi = null;
    this._kpiHours = 12;
    this._baselines = [];
    this._baseline = "";
    this._baselineName = "";
    this._linking = null;
    this._busy = null;
    this._tuning = {};
    this._calFloor = null;
    this._calDuration = 600;
    this._open = new Set();   // expanded floor/room groups
  }

  connectedCallback() {
    super.connectedCallback();
    this._refresh();
    this._timer = setInterval(() => this._poll(), 10000);
  }

  disconnectedCallback() { super.disconnectedCallback(); clearInterval(this._timer); }

  updated(changed) {
    if (changed.has("data") && this.data) this._tuning = { ...(this.data.layout?.tuning || {}) };
  }

  async _refresh() {
    if (!this.hass) return;
    const [rx, cal] = await Promise.all([
      this.hass.callWS({ type: "sextant/receivers" }).catch(() => null),
      this.hass.callWS({ type: "sextant/calibration/status" }).catch(() => null),
    ]);
    this._receivers = rx;
    this._cal = cal;
    this._loadBaselines();
    if (!this._calFloor) this._calFloor = cal?.floor || this.floor || this.data?.layout?.floor?.[0]?.name || null;
  }

  async _poll() {
    if (!this.hass) return;
    const cal = await this.hass.callWS({ type: "sextant/calibration/status" }).catch(() => null);
    if (cal) this._cal = cal;
    if (this._cal?.state === "sampling" || this._cal?.mode === "auto") return;
    const rx = await this.hass.callWS({ type: "sextant/receivers" }).catch(() => null);
    if (rx) this._receivers = rx;
  }

  async _calAction(action, extra = {}) {
    this._busy = action;
    const r = await callWS(this, this.hass, { type: "sextant/calibration/action", action, ...extra });
    this._busy = null;
    if (r) {
      this._cal = r;
      if (action === "apply") { toast(this, `Applied corrections to ${r.applied} proxy(ies)`); this.dispatchEvent(new CustomEvent("layout-changed")); }
      else if (action === "reset") { toast(this, `Reset ${r.reset} proxy(ies)`); this.dispatchEvent(new CustomEvent("layout-changed")); }
    }
  }

  async _runSelftest() {
    this._busy = "selftest";
    const r = await callWS(this, this.hass, { type: "sextant/selftest" });
    this._busy = null;
    if (r) this._selftest = r;
  }

  async _runKpi() {
    this._busy = "kpi";
    const msg = { type: "sextant/kpi", hours: this._kpiHours };
    if (this._baseline) msg.baseline = this._baseline;
    const r = await callWS(this, this.hass, msg);
    this._busy = null;
    if (r) this._kpi = r;
  }

  async _loadBaselines() {
    const r = await this.hass.callWS({ type: "sextant/kpi/baselines" }).catch(() => null);
    if (r) {
      this._baselines = r.baselines || [];
      if (this._baseline && !this._baselines.some((b) => b.name === this._baseline)) this._baseline = "";
    }
  }

  async _saveBaseline() {
    const name = (this._baselineName || "").trim();
    if (!name) return;
    this._busy = "baseline";
    const r = await callWS(this, this.hass, { type: "sextant/kpi/baseline/save", name, hours: this._kpiHours });
    this._busy = null;
    if (r) {
      toast(this, `Saved baseline "${r.name}" (${r.trackers} trackers, ${this._kpiHours} h)`);
      this._baselineName = "";
      await this._loadBaselines();
      this._baseline = r.name;
    }
  }

  async _deleteBaseline(name) {
    if (!name || !confirmDialog(`Delete the KPI baseline "${name}"?`)) return;
    const r = await callWS(this, this.hass, { type: "sextant/kpi/baseline/delete", name });
    if (r) { toast(this, `Deleted baseline "${name}"`); this._baseline = ""; if (this._kpi) this._kpi = { ...this._kpi, baseline: undefined, deltas: undefined }; await this._loadBaselines(); }
  }

  async _loadLinking() {
    const r = await callWS(this, this.hass, { type: "sextant/scanner_linking" });
    if (r) this._linking = r;
  }

  async _saveTuning() {
    const spec = this.data?.tuning_spec || {};
    const settings = {};
    for (const [k, v] of Object.entries(this._tuning)) {
      if (v === "" || v == null) continue;
      const s = spec[k];
      settings[k] = s?.type === "bool" ? !!v : s?.type === "str" ? String(v) : Number(v);
    }
    const r = await callWS(this, this.hass, { type: "sextant/tuning/set", settings, reset: true });
    if (r) { toast(this, "Tuning applied live"); this._tuning = { ...r.tuning }; this.dispatchEvent(new CustomEvent("layout-changed")); }
  }

  async _resetTuning() {
    if (!confirmDialog("Restore every tuning value to its default?")) return;
    const r = await callWS(this, this.hass, { type: "sextant/tuning/set", reset: true });
    if (r) { toast(this, "Defaults restored"); this._tuning = {}; this.dispatchEvent(new CustomEvent("layout-changed")); }
  }

  render() {
    switch (this.section) {
      case "calibration":
        return html`<div class="page"><div class="cols">${this._renderCalibration()}</div></div>`;
      case "tuning":
        return html`<div class="page"><div class="cols">${this._renderKpi()}${this._renderTuning()}${this._renderHistory()}</div></div>`;
      default:
        return html`<div class="page"><div class="cols">${this._renderReceivers()}${this._renderSelftest()}</div></div>`;
    }
  }

  // --- Proxies -------------------------------------------------------------------

  /** A proxy's status: "offline", "unmatched", "quiet" or "ok". */
  _status(r) {
    if (!r.matched) return "unmatched";
    if (!r.online) return "offline";
    const age = r.last_seen_age ?? r.age;
    if (age != null && age > QUIET_SECS) return "quiet";
    return "ok";
  }

  /** The room (non-no-go zone) a proxy's placement falls in, from the layout. */
  _roomOf(r) {
    const floor = (this.data?.layout?.floor || []).find((f) => f.name === r.floor);
    const placed = (floor?.receivers || []).find((x) => x.entity_id === r.slug || (r.address && x.address === r.address));
    if (!floor || !placed?.cords) return null;
    const hit = (floor.zones || []).find((z) => !z.no_go && (z.cords || []).length >= 3 && pointInPolygon({ x: placed.cords.x, y: placed.cords.y }, z.cords));
    return hit?.entity_id || null;
  }

  _toggle(key) {
    const s = new Set(this._open);
    s.has(key) ? s.delete(key) : s.add(key);
    this._open = s;
  }

  _counts(rows) {
    const c = { ok: 0, quiet: 0, offline: 0, unmatched: 0 };
    for (const r of rows) c[this._status(r)]++;
    return c;
  }

  _countPills(c) {
    return html`<span class="counts">
      ${c.ok ? html`<span class="pill ok" title="online and heard recently">${c.ok}</span>` : nothing}
      ${c.quiet ? html`<span class="pill quiet" title="online but nothing heard for ${QUIET_SECS} s">${c.quiet}</span>` : nothing}
      ${c.offline ? html`<span class="pill bad" title="offline">${c.offline}</span>` : nothing}
      ${c.unmatched ? html`<span class="pill warn" title="placed but Bermuda has no scanner by that name">${c.unmatched}</span>` : nothing}
    </span>`;
  }

  _renderReceivers() {
    const rx = this._receivers;
    const placed = rx?.placed || [];
    const diag = this.data?.scanner_diagnostics || {};
    const floors = sortFloors(this.data?.layout?.floor || []).map((f) => f.name);
    for (const name of new Set(placed.map((r) => r.floor).filter(Boolean))) if (!floors.includes(name)) floors.push(name);
    const total = this._counts(placed);
    const attention = placed.filter((r) => this._status(r) !== "ok");
    return html`<section class="card receivers">
      <h3>Proxies <span class="muted">${placed.length} placed</span></h3>
      <div class="row">
        ${this._countPills(total)}
        <span class="muted small">green online · yellow quiet (${fmtAge(QUIET_SECS)} without a reading) · red offline · orange unmatched</span>
        <span class="pill">${(rx?.unplaced || []).length} heard but unplaced</span>
        <span class="grow"></span>
        ${uiButton({ label: "Refresh", kind: "text", icon: "mdi:refresh", onClick: () => this._refresh() })}
      </div>
      ${attention.length ? html`<div class="attention">
        <b>Needs a look:</b> ${attention.map((r) => html`<span class="pill ${this._status(r) === "offline" ? "bad" : this._status(r) === "quiet" ? "quiet" : "warn"}" title=${this._status(r)}>${proxyName(this.data, r.address || r.slug)} · ${r.floor || "?"}</span>`)}
      </div>` : html`<div class="muted small">Every placed proxy is online and reporting.</div>`}
      ${floors.map((floor) => {
        const rows = placed.filter((r) => r.floor === floor);
        if (!rows.length) return nothing;
        const key = `floor:${floor}`;
        const rooms = new Map();
        for (const r of rows) { const room = this._roomOf(r) || "outside any room"; if (!rooms.has(room)) rooms.set(room, []); rooms.get(room).push(r); }
        const roomNames = [...rooms.keys()].sort((a, b) => (a === "outside any room") - (b === "outside any room") || a.localeCompare(b));
        return html`<div class="group">
          <button class="grouphead" @click=${() => this._toggle(key)}>
            <ha-icon icon=${this._open.has(key) ? "mdi:chevron-down" : "mdi:chevron-right"}></ha-icon>
            <b>${floor}</b> <span class="muted small">${rows.length} proxies · ${rooms.size} rooms</span>
            <span class="grow"></span>${this._countPills(this._counts(rows))}
          </button>
          ${this._open.has(key) ? roomNames.map((room) => {
            const rr = rooms.get(room), rkey = `room:${floor}:${room}`;
            return html`<div class="room">
              <button class="grouphead sub" @click=${() => this._toggle(rkey)}>
                <ha-icon icon=${this._open.has(rkey) ? "mdi:chevron-down" : "mdi:chevron-right"}></ha-icon>
                ${room} <span class="muted small">${rr.length}</span>
                <span class="grow"></span>${this._countPills(this._counts(rr))}
              </button>
              ${this._open.has(rkey) ? html`<div class="wrap"><table>
                <tr><th>Proxy</th><th>Status</th><th class="num">Last heard</th><th class="num">Corr.</th><th class="num">Height</th></tr>
                ${rr.slice().sort((a, b) => (this._status(a) === "ok") - (this._status(b) === "ok") || a.slug.localeCompare(b.slug)).map((r) => {
                  const st = this._status(r);
                  return html`<tr>
                    <td><b>${proxyName(this.data, r.address || r.slug)}</b><br><span class="muted small">${r.slug}${r.address ? ` · ${r.address}` : ""}</span></td>
                    <td><span class="pill ${st === "ok" ? "ok" : st === "quiet" ? "quiet" : st === "offline" ? "bad" : "warn"}">${st}</span></td>
                    <td class="num">${r.last_seen_age != null ? fmtAge(r.last_seen_age) : r.age != null ? fmtAge(r.age) : "—"}</td>
                    <td class="num">${r.correction != null ? fmtNum(r.correction, 3) : "—"}</td>
                    <td class="num">${r.height != null ? fmtLen(r.height, this.hass) : "—"}</td>
                  </tr>`;
                })}
              </table></div>` : nothing}
            </div>`;
          }) : nothing}
        </div>`;
      })}
      ${(rx?.unplaced || []).length ? html`<details><summary>Heard but not placed (${rx.unplaced.length})</summary>
        <ul class="plain">${rx.unplaced.map((u) => html`<li><b>${u.name || u.slug}</b> <span class="muted small">${u.address}${u.area ? ` · ${u.area}` : ""} · ${fmtAge(u.last_seen_age)} ago</span></li>`)}</ul></details>` : nothing}
      ${(diag.unmatched_receivers || []).length ? html`<details open><summary>Naming mismatches (${diag.unmatched_receivers.length})</summary>
        <ul class="plain">${diag.unmatched_receivers.map((u) => html`<li><b>${u.entity_id}</b> on ${u.floor}${u.suggested ? html` → suggested <code>${u.suggested}</code>` : nothing}</li>`)}</ul></details>` : nothing}
      <details @toggle=${(e) => { if (e.target.open && !this._linking) this._loadLinking(); }}><summary>Scanner linking detail</summary>
        ${this._linking ? html`<div class="wrap"><table>
          <tr><th>Proxy</th><th>Status</th><th>Readings</th></tr>
          ${(this._linking.placed || []).map((p) => html`<tr><td>${proxyName(this.data, p.address || p.receiver || p.slug)}</td><td>${p.status}</td><td class="small">${(p.readings || []).map((d) => `${d.device || d.entity}: ${d.state ?? d.distance ?? "—"}`).join(", ")}</td></tr>`)}
        </table></div>` : html`<div class="muted small">Loading…</div>`}
      </details>
    </section>`;
  }

  _renderSelftest() {
    const st = this._selftest;
    return html`<section class="card">
      <h3>Proxy self-test</h3>
      <p class="small muted">Leave-one-out: each proxy is located from the others' ranges to it and compared with where it is placed.</p>
      <div class="row">${uiButton({ label: this._busy === "selftest" ? "Running…" : "Run self-test", kind: "primary", disabled: this._busy === "selftest", onClick: () => this._runSelftest() })}
        ${st ? html`<span class="pill ${Number(st.state) < 2 ? "ok" : Number(st.state) < 4 ? "warn" : "bad"}">CEP95 ${fmtLen(Number(st.state), this.hass)}</span>` : nothing}</div>
      ${st ? html`<div class="wrap"><table><tr><th>Proxy</th><th class="num">Error</th><th class="num">Neighbours</th></tr>
        ${Object.entries(st.result?.receivers || st.result || {}).filter(([, v]) => v && typeof v === "object").sort((a, b) => (b[1].error_m ?? -1) - (a[1].error_m ?? -1)).slice(0, 60).map(([slug, v]) => html`<tr><td>${proxyName(this.data, slug)}</td><td class="num">${v.error_m != null ? fmtLen(v.error_m, this.hass, 2) : html`<span class="muted">unsolved</span>`}</td><td class="num">${v.neighbors ?? v.neighbours ?? "—"}</td></tr>`)}
      </table></div>` : nothing}
    </section>`;
  }

  // --- Calibration ---------------------------------------------------------------

  _renderCalibration() {
    const cal = this._cal;
    const floors = sortFloors(this.data?.layout?.floor || []);
    const results = cal?.results || {};
    const sampling = cal?.state === "sampling";
    return html`<section class="card wide">
      <h3>Proxy calibration</h3>
      <p class="small muted">Every proxy hears every other proxy's beacon at a known distance; a run collects those readings and solves one range correction per proxy. Apply only when the error factor after is lower than before, otherwise the corrections are absorbing placement error, not radio bias.</p>
      ${cal ? html`
        <div class="row">
          <span class="pill ${sampling ? "warn" : cal.mode === "auto" ? "ok" : ""}">${cal.mode === "auto" ? "auto" : cal.state}${sampling && cal.seconds_left != null ? ` · ${fmtAge(cal.seconds_left)} left` : ""}</span>
          <span class="muted small">${Object.keys(cal.pair_counts || {}).length} pairs sampled · ${cal.receiver_count} proxies${cal.last_solved_at ? ` · solved ${fmtAge(Date.now() / 1000 - cal.last_solved_at)} ago` : ""}</span>
          ${cal.error ? html`<span class="pill bad">${cal.error}</span>` : nothing}
        </div>
        <div class="row">
          ${uiSelect({ label: "Floor", value: this._calFloor, options: floors.map((f) => ({ value: f.name, label: f.name })), onChange: (v) => { this._calFloor = v; } })}
          ${uiField({ label: "Duration (s)", type: "number", min: 60, max: 3600, step: 30, value: this._calDuration, onChange: (v) => { this._calDuration = Number(v); }, style: "width: 130px" })}
          ${uiButton({ label: "Start run", kind: "primary", disabled: sampling || !!this._busy, onClick: () => this._calAction("start", { floor: this._calFloor, duration: this._calDuration }) })}
          ${uiButton({ label: "Cancel", kind: "text", disabled: !!this._busy, onClick: () => this._calAction("cancel") })}
          <span class="chips">${uiSwitch({ label: "Auto calibration", checked: cal.mode === "auto", onChange: (v) => this._calAction("auto", { enabled: v }) })}</span>
        </div>
        <div class="row">
          ${uiButton({ label: "Solve now", disabled: !!this._busy, onClick: () => this._calAction("solve", { floor: this._calFloor }) })}
          ${uiButton({ label: "Apply corrections", disabled: !!this._busy || !results[this._calFloor], onClick: () => this._calAction("apply", { floor: this._calFloor }) })}
          ${uiButton({ label: "Reset", kind: "danger", disabled: !!this._busy, onClick: () => confirmDialog(`Reset corrections on ${this._calFloor}?`) && this._calAction("reset", { floor: this._calFloor }) })}
        </div>
        ${Object.entries(results).map(([floor, r]) => html`<details ?open=${floor === this._calFloor}>
          <summary>${floor}: ${r.pairs_used} pairs, error ×${fmtNum(r.error_factor_before, 2)} → ×${fmtNum(r.error_factor_after, 2)}${r.error_factor_after > r.error_factor_before ? html` <span class="pill warn">worse: do not apply</span>` : nothing}${r.low_confidence?.length ? html` <span class="pill warn">${r.low_confidence.length} low confidence</span>` : nothing}</summary>
          <div class="wrap"><table><tr><th>Proxy</th><th class="num">Factor</th><th class="num">≈ dB</th></tr>
            ${Object.entries(r.receivers || {}).sort((a, b) => Math.abs(b[1] - 1) - Math.abs(a[1] - 1)).map(([slug, f]) => html`<tr><td>${proxyName(this.data, slug)}${(r.low_confidence || []).includes(slug) ? html` <span class="pill warn">low</span>` : nothing}</td><td class="num">${fmtNum(f, 3)}</td><td class="num">${fmtNum(r.rx_bias_db_equident?.[slug], 1)}</td></tr>`)}
          </table></div>
          ${(r.missing_no_data || []).length ? html`<p class="small muted">No samples: ${r.missing_no_data.join(", ")}</p>` : nothing}
          ${(r.missing_unmatched || []).length ? html`<p class="small muted">Unmatched: ${r.missing_unmatched.join(", ")}</p>` : nothing}
        </details>`)}
      ` : html`<div class="muted">Loading…</div>`}
    </section>`;
  }

  // --- Tuning --------------------------------------------------------------------

  _renderKpi() {
    const k = this._kpi;
    const s = k?.summary || {};
    const d = k?.deltas;
    const ents = Object.entries(k?.entities || {}).filter(([e]) => e.endsWith("_sextant_zone")).sort((a, b) => (b[1].changes_per_hour ?? 0) - (a[1].changes_per_hour ?? 0));
    // Fewer changes / flips is better (green); a longer dwell is better.
    const lessIsBetter = (v, digits = 1, scale = 1) => v == null ? "—" : html`<span class=${v < 0 ? "good" : v > 0 ? "bad" : ""}>${v > 0 ? "+" : ""}${fmtNum(v * scale, digits)}</span>`;
    const moreIsBetter = (v) => v == null ? "—" : html`<span class=${v > 0 ? "good" : v < 0 ? "bad" : ""}>${v > 0 ? "+" : "−"}${fmtAge(Math.abs(v))}</span>`;
    const sz = d?.summary?.sextant_zone;
    const baselineOptions = [{ value: "", label: "no baseline" }, ...this._baselines.map((b) => ({ value: b.name, label: `${b.name} · ${b.hours} h · ${(b.saved_at || "").slice(0, 10)}` }))];
    const name = (e) => trackerName(this.data, e.replace(/^sensor\./, "").replace(/_sextant_zone$/, ""));
    return html`<section class="card wide">
      <h3>Stability</h3>
      <div class="row">
        ${uiSelect({ label: "Window", value: this._kpiHours, options: [1, 3, 6, 12, 24, 48].map((h) => ({ value: h, label: `${h} h` })), onChange: (v) => { this._kpiHours = Number(v); }, style: "min-width: 110px" })}
        ${uiSelect({ label: "Compare with", value: this._baseline, options: baselineOptions, onChange: (v) => { this._baseline = v; }, style: "min-width: 240px" })}
        ${uiButton({ label: this._busy === "kpi" ? "Computing…" : "Compute", kind: "primary", disabled: this._busy === "kpi", onClick: () => this._runKpi() })}
        ${s.sextant_zone ? html`<span class="pill">${s.sextant_zone.changes_per_tracker_hour} room changes / tracker-h</span>
          <span class="pill">flip ratio ${s.sextant_zone.flip_ratio}</span><span class="pill">median dwell ${fmtAge(s.sextant_zone.median_of_median_dwell_s)}</span>` : nothing}
        ${sz ? html`<span class="pill" title="this window minus the baseline">vs ${k.baseline.name}: ${lessIsBetter(sz.changes_per_tracker_hour, 2)} chg/tracker-h · ${lessIsBetter(sz.flip_ratio, 0, 100)} flip pts · ${moreIsBetter(sz.median_of_median_dwell_s)} dwell</span>` : nothing}
      </div>
      <div class="row">
        ${uiField({ label: "Save this window as a baseline", value: this._baselineName, placeholder: "e.g. fused 2026-09-17", onChange: (v) => { this._baselineName = v; }, style: "width: 260px" })}
        ${uiButton({ label: this._busy === "baseline" ? "Saving…" : "Save baseline", disabled: this._busy === "baseline" || !(this._baselineName || "").trim(), onClick: () => this._saveBaseline(), title: "Computes the selected window now and keeps it for later comparison" })}
        ${this._baseline ? uiButton({ label: "Delete baseline", kind: "danger", onClick: () => this._deleteBaseline(this._baseline) }) : nothing}
      </div>
      ${ents.length ? html`<div class="wrap"><table>
        <tr><th>Tracker</th><th class="num">chg/h</th><th class="num">flip %</th><th class="num">dwell</th><th class="num">&lt;60 s %</th><th class="num">dead</th>${d ? html`<th class="num">Δ chg/h</th><th class="num">Δ flip pts</th><th class="num">Δ dwell</th>` : nothing}</tr>
        ${ents.map(([e, m]) => html`<tr><td>${name(e)}</td><td class="num">${fmtNum(m.changes_per_hour, 1)}</td><td class="num">${m.flip_ratio != null ? fmtNum(m.flip_ratio * 100, 0) : "—"}</td><td class="num">${fmtAge(m.median_dwell_s)}</td><td class="num">${m.short_dwell_ratio != null ? fmtNum(m.short_dwell_ratio * 100, 0) : "—"}</td><td class="num">${m.dead}</td>${d ? html`<td class="num">${lessIsBetter(d.entities?.[e]?.changes_per_hour, 1)}</td><td class="num">${lessIsBetter(d.entities?.[e]?.flip_ratio, 0, 100)}</td><td class="num">${moreIsBetter(d.entities?.[e]?.median_dwell_s)}</td>` : nothing}</tr>`)}
      </table></div>` : k ? html`<div class="muted small">No room sensors in the recorder window.</div>` : nothing}
    </section>`;
  }

  _renderTuning() {
    const spec = this.data?.tuning_spec || {};
    const groups = [
      ["Estimator", ["position_estimator", "fingerprint_weight", "fingerprint_floor_weight", "fingerprint_k", "fingerprint_missing_m", "fingerprint_ref_gain", "fingerprint_auto_gain", "distance_estimator", "median_window_secs", "median_min_samples"]],
      ["Solver", ["solver_max_receivers", "solver_max_range", "solver_near_always"]],
      ["Rooms", ["zone_hysteresis", "zone_prob_smoothing", "zone_switch_margin", "zone_switch_secs", "stationary_speed", "stationary_secs", "zone_unlock_margin", "zone_unlock_secs"]],
      ["Sub-zones", ["subzone_switch_secs", "subzone_enter_prob", "subzone_unlock_margin"]],
      ["Near-field anchor", ["anchor_max_m", "anchor_ratio", "anchor_secs", "anchor_release_m"]],
      ["Floors", ["floor_switch_secs", "floor_tenure_bonus", "floor_tenure_full_secs", "floor_proximity_weight", "floor_proximity_k"]],
      ["Calibration", ["calibration_target"]],
    ];
    const known = new Set(groups.flatMap((g) => g[1]));
    const rest = Object.keys(spec).filter((k) => !known.has(k));
    if (rest.length) groups.push(["Other", rest]);
    const field = (key) => {
      const s = spec[key];
      if (!s) return nothing;
      const v = this._tuning[key];
      const set = (value) => { this._tuning = { ...this._tuning, [key]: value }; };
      if (s.type === "bool") return html`<span class="chips">${uiSwitch({ label: key, checked: v == null ? !!s.default : !!v, onChange: set })}</span>`;
      if (s.type === "str") return uiSelect({ label: key, value: v ?? s.default, options: s.choices.map((c) => ({ value: c, label: c })), onChange: set, style: "min-width: 200px" });
      return uiField({ label: key, type: "number", step: s.type === "int" ? 1 : "any", min: s.min, max: s.max, placeholder: String(s.default), value: v == null ? "" : v, onChange: (val) => set(val === "" ? null : Number(val)), style: "width: 200px" });
    };
    return html`<section class="card wide">
      <h3>Tuning <span class="muted small">applies live, no restart · distances here are metres, the solver's own unit</span></h3>
      ${groups.map(([name, keys]) => html`<h4>${name}</h4><div class="row">${keys.map(field)}</div>`)}
      <div class="row">${uiButton({ label: "Apply", kind: "primary", onClick: () => this._saveTuning() })}${uiButton({ label: "Restore defaults", kind: "text", onClick: () => this._resetTuning() })}</div>
    </section>`;
  }

  async _clearHistory(entity) {
    if (!confirmDialog(entity ? `Forget the recorded positions of ${trackerName(this.data, entity)}?` : "Forget every tracker's recorded positions?")) return;
    const r = await callWS(this, this.hass, { type: "sextant/history/clear", ...(entity ? { entity } : {}) });
    if (r) toast(this, `History cleared (${r.removed} file${r.removed === 1 ? "" : "s"} rewritten)`);
  }

  _renderHistory() {
    const ents = this.data?.entities || [];
    return html`<section class="card">
      <h3>Position history</h3>
      <p class="small muted">The scrubber on the Live page replays these; this is only where they can be forgotten.</p>
      <div class="row">
        ${uiSelect({ label: "Tracker", value: this._histEnt || "", options: [{ value: "", label: "every tracker" }, ...ents.map((e) => ({ value: e, label: trackerName(this.data, e) }))], onChange: (v) => { this._histEnt = v; }, style: "min-width: 220px" })}
        ${uiButton({ label: "Clear history", kind: "danger", onClick: () => this._clearHistory(this._histEnt || null) })}
      </div>
    </section>`;
  }

  static styles = [sharedStyles, widgetStyles, css`
    .good { color: var(--success-color, #2e7d32); font-weight: 600; }
    .bad { color: var(--error-color, #c62828); font-weight: 600; }
    :host { display: block; overflow: auto; }
    .cols { grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); }
    .card.wide { grid-column: 1 / -1; }
    section.receivers { grid-column: 1 / -1; }
    .attention { margin: 8px 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .group { border-top: 1px solid var(--divider-color); margin-top: 6px; }
    .grouphead { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: 0; padding: 8px 4px; font: inherit; color: inherit; cursor: pointer; border-radius: 6px; }
    .grouphead:hover { background: var(--secondary-background-color); }
    .grouphead.sub { padding-left: 28px; font-size: 13px; }
    .grouphead ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text-color); }
    .room .wrap { padding-left: 28px; margin-bottom: 8px; }
    .counts { display: inline-flex; gap: 4px; }
    ul.plain { list-style: none; padding: 0; margin: 6px 0; }
    ul.plain li { padding: 3px 0; }
    details { margin-top: 8px; }
    summary { cursor: pointer; }
    h4 { margin-top: 12px; }
  `];
}

customElements.define("sextant-health", SextantHealth);
