/**
 * Health mode: receivers, calibration, self-test, stability KPI and tuning.
 */
import { LitElement, html, css, nothing } from "./lit.js";
import { sharedStyles, widgetStyles, fmtAge, fmtNum, toast, callWS, confirmDialog, uiField, uiSelect, uiSwitch, uiButton } from "./sextant-ui.js";

class SextantHealth extends LitElement {
  static properties = {
    hass: { attribute: false },
    data: { attribute: false },
    positions: { attribute: false },
    floor: { type: String },
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
  };

  constructor() {
    super();
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
      if (action === "apply") { toast(this, `Applied corrections to ${r.applied} receiver(s)`); this.dispatchEvent(new CustomEvent("layout-changed")); }
      else if (action === "reset") { toast(this, `Reset ${r.reset} receiver(s)`); this.dispatchEvent(new CustomEvent("layout-changed")); }
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
    return html`<div class="page"><div class="cols">
      ${this._renderReceivers()}
      ${this._renderCalibration()}
      ${this._renderSelftest()}
      ${this._renderKpi()}
      ${this._renderTuning()}
      ${this._renderHistory()}
    </div></div>`;
  }

  _renderReceivers() {
    const rx = this._receivers;
    const placed = rx?.placed || [];
    const offline = placed.filter((r) => !r.online).length;
    const unmatched = placed.filter((r) => !r.matched).length;
    const diag = this.data?.scanner_diagnostics || {};
    return html`<section class="card receivers">
      <h3>Receivers <span class="muted">${placed.length} placed</span></h3>
      <div class="row">
        <span class="pill ${offline ? "bad" : "ok"}">${offline} offline</span>
        <span class="pill ${unmatched ? "warn" : "ok"}">${unmatched} unmatched</span>
        <span class="pill">${(rx?.unplaced || []).length} heard but unplaced</span>
        <span class="grow"></span>
        ${uiButton({ label: "Refresh", kind: "text", icon: "mdi:refresh", onClick: () => this._refresh() })}
      </div>
      <div class="wrap"><table>
        <tr><th>Receiver</th><th>Floor</th><th>Status</th><th class="num">Last heard</th><th class="num">Corr.</th><th class="num">Height</th></tr>
        ${placed.slice().sort((a, b) => (a.online - b.online) || (a.floor || "").localeCompare(b.floor || "") || a.slug.localeCompare(b.slug)).map((r) => html`<tr>
          <td><b>${r.slug}</b>${r.name && r.name !== r.slug ? html`<br><span class="muted small">${r.name}</span>` : nothing}<br><span class="muted small">${r.address || "no address"}</span></td>
          <td>${r.floor}</td>
          <td>${!r.matched ? html`<span class="pill warn">unmatched</span>` : r.online ? html`<span class="pill ok">online</span>` : html`<span class="pill bad">offline</span>`}</td>
          <td class="num">${r.last_seen_age != null ? fmtAge(r.last_seen_age) : r.age != null ? fmtAge(r.age) : "—"}</td>
          <td class="num">${r.correction != null ? fmtNum(r.correction, 3) : "—"}</td>
          <td class="num">${r.height != null ? `${r.height} m` : "—"}</td>
        </tr>`)}
      </table></div>
      ${(rx?.unplaced || []).length ? html`<details><summary>Heard but not placed (${rx.unplaced.length})</summary>
        <ul class="plain">${rx.unplaced.map((u) => html`<li><b>${u.name || u.slug}</b> <span class="muted small">${u.address}${u.area ? ` · ${u.area}` : ""} · ${fmtAge(u.last_seen_age)} ago</span></li>`)}</ul></details>` : nothing}
      ${(diag.unmatched_receivers || []).length ? html`<details open><summary>Naming mismatches (${diag.unmatched_receivers.length})</summary>
        <ul class="plain">${diag.unmatched_receivers.map((u) => html`<li><b>${u.entity_id}</b> on ${u.floor}${u.suggested ? html` → suggested <code>${u.suggested}</code>` : nothing}</li>`)}</ul></details>` : nothing}
      <details @toggle=${(e) => { if (e.target.open && !this._linking) this._loadLinking(); }}><summary>Scanner linking detail</summary>
        ${this._linking ? html`<div class="wrap"><table>
          <tr><th>Receiver</th><th>Status</th><th>Readings</th></tr>
          ${(this._linking.placed || []).map((p) => html`<tr><td>${p.receiver || p.slug}</td><td>${p.status}</td><td class="small">${(p.readings || []).map((d) => `${d.device || d.entity}: ${d.state ?? d.distance ?? "—"}`).join(", ")}</td></tr>`)}
        </table></div>` : html`<div class="muted small">Loading…</div>`}
      </details>
    </section>`;
  }

  _renderCalibration() {
    const cal = this._cal;
    const floors = this.data?.layout?.floor || [];
    const results = cal?.results || {};
    const sampling = cal?.state === "sampling";
    return html`<section class="card">
      <h3>Receiver calibration</h3>
      ${cal ? html`
        <div class="row">
          <span class="pill ${sampling ? "warn" : cal.mode === "auto" ? "ok" : ""}">${cal.mode === "auto" ? "auto" : cal.state}${sampling && cal.seconds_left != null ? ` · ${fmtAge(cal.seconds_left)} left` : ""}</span>
          <span class="muted small">${Object.keys(cal.pair_counts || {}).length} pairs sampled · ${cal.receiver_count} receivers${cal.last_solved_at ? ` · solved ${fmtAge(Date.now() / 1000 - cal.last_solved_at)} ago` : ""}</span>
          ${cal.error ? html`<span class="pill bad">${cal.error}</span>` : nothing}
        </div>
        <div class="row">
          ${uiSelect({ label: "Floor", value: this._calFloor, options: floors.map((f) => ({ value: f.name, label: f.name })), onChange: (v) => { this._calFloor = v; } })}
          ${uiField({ label: "Duration (s)", type: "number", min: 60, max: 3600, step: 30, value: this._calDuration, onChange: (v) => { this._calDuration = Number(v); }, style: "width: 130px" })}
          ${uiButton({ label: "Start run", kind: "primary", disabled: sampling || !!this._busy, onClick: () => this._calAction("start", { floor: this._calFloor, duration: this._calDuration }) })}
          ${uiButton({ label: "Cancel", kind: "text", disabled: !!this._busy, onClick: () => this._calAction("cancel") })}
          ${uiSwitch({ label: "Auto calibration", checked: cal.mode === "auto", onChange: (v) => this._calAction("auto", { enabled: v }) })}
        </div>
        <div class="row">
          ${uiButton({ label: "Solve now", disabled: !!this._busy, onClick: () => this._calAction("solve", { floor: this._calFloor }) })}
          ${uiButton({ label: "Apply corrections", disabled: !!this._busy || !results[this._calFloor], onClick: () => this._calAction("apply", { floor: this._calFloor }) })}
          ${uiButton({ label: "Reset", kind: "danger", disabled: !!this._busy, onClick: () => confirmDialog(`Reset corrections on ${this._calFloor}?`) && this._calAction("reset", { floor: this._calFloor }) })}
        </div>
        ${Object.entries(results).map(([floor, r]) => html`<details ?open=${floor === this._calFloor}>
          <summary>${floor}: ${r.pairs_used} pairs, error ×${fmtNum(r.error_factor_before, 2)} → ×${fmtNum(r.error_factor_after, 2)}${r.low_confidence?.length ? html` <span class="pill warn">${r.low_confidence.length} low confidence</span>` : nothing}</summary>
          <div class="wrap"><table><tr><th>Receiver</th><th class="num">Factor</th><th class="num">≈ dB</th></tr>
            ${Object.entries(r.receivers || {}).sort((a, b) => Math.abs(b[1] - 1) - Math.abs(a[1] - 1)).map(([slug, f]) => html`<tr><td>${slug}${(r.low_confidence || []).includes(slug) ? html` <span class="pill warn">low</span>` : nothing}</td><td class="num">${fmtNum(f, 3)}</td><td class="num">${fmtNum(r.rx_bias_db_equident?.[slug], 1)}</td></tr>`)}
          </table></div>
          ${(r.missing_no_data || []).length ? html`<p class="small muted">No samples: ${r.missing_no_data.join(", ")}</p>` : nothing}
          ${(r.missing_unmatched || []).length ? html`<p class="small muted">Unmatched: ${r.missing_unmatched.join(", ")}</p>` : nothing}
        </details>`)}
      ` : html`<div class="muted">Loading…</div>`}
    </section>`;
  }

  _renderSelftest() {
    const st = this._selftest;
    return html`<section class="card">
      <h3>Receiver self-test</h3>
      <p class="small muted">Leave-one-out: each receiver is located from the others' ranges to it and compared with where it is placed.</p>
      <div class="row">${uiButton({ label: this._busy === "selftest" ? "Running…" : "Run self-test", kind: "primary", disabled: this._busy === "selftest", onClick: () => this._runSelftest() })}
        ${st ? html`<span class="pill ${Number(st.state) < 2 ? "ok" : Number(st.state) < 4 ? "warn" : "bad"}">CEP95 ${st.state} m</span>` : nothing}</div>
      ${st ? html`<div class="wrap"><table><tr><th>Receiver</th><th class="num">Error m</th><th class="num">Neighbours</th></tr>
        ${Object.entries(st.result?.receivers || st.result || {}).filter(([, v]) => v && typeof v === "object").sort((a, b) => (b[1].error_m ?? -1) - (a[1].error_m ?? -1)).slice(0, 60).map(([slug, v]) => html`<tr><td>${slug}</td><td class="num">${v.error_m != null ? fmtNum(v.error_m, 2) : html`<span class="muted">unsolved</span>`}</td><td class="num">${v.neighbors ?? v.neighbours ?? "—"}</td></tr>`)}
      </table></div>` : nothing}
    </section>`;
  }

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
    return html`<section class="card">
      <h3>Stability</h3>
      <div class="row">
        ${uiSelect({ label: "Window", value: this._kpiHours, options: [1, 3, 6, 12, 24, 48].map((h) => ({ value: h, label: `${h} h` })), onChange: (v) => { this._kpiHours = Number(v); }, style: "min-width: 110px" })}
        ${uiSelect({ label: "Compare with", value: this._baseline, options: baselineOptions, onChange: (v) => { this._baseline = v; }, style: "min-width: 240px" })}
        ${uiButton({ label: this._busy === "kpi" ? "Computing…" : "Compute", kind: "primary", disabled: this._busy === "kpi", onClick: () => this._runKpi() })}
        ${s.sextant_zone ? html`<span class="pill">${s.sextant_zone.changes_per_tracker_hour} zone changes / tracker-h</span>
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
        ${ents.map(([e, m]) => html`<tr><td>${e.replace(/^sensor\./, "").replace(/_sextant_zone$/, "")}</td><td class="num">${fmtNum(m.changes_per_hour, 1)}</td><td class="num">${m.flip_ratio != null ? fmtNum(m.flip_ratio * 100, 0) : "—"}</td><td class="num">${fmtAge(m.median_dwell_s)}</td><td class="num">${m.short_dwell_ratio != null ? fmtNum(m.short_dwell_ratio * 100, 0) : "—"}</td><td class="num">${m.dead}</td>${d ? html`<td class="num">${lessIsBetter(d.entities?.[e]?.changes_per_hour, 1)}</td><td class="num">${lessIsBetter(d.entities?.[e]?.flip_ratio, 0, 100)}</td><td class="num">${moreIsBetter(d.entities?.[e]?.median_dwell_s)}</td>` : nothing}</tr>`)}
      </table></div>` : k ? html`<div class="muted small">No zone sensors in the recorder window.</div>` : nothing}
    </section>`;
  }

  _renderTuning() {
    const spec = this.data?.tuning_spec || {};
    const groups = [
      ["Estimator", ["position_estimator", "fingerprint_weight", "fingerprint_floor_weight", "fingerprint_k", "fingerprint_missing_m", "fingerprint_ref_gain", "fingerprint_auto_gain", "distance_estimator", "median_window_secs", "median_min_samples"]],
      ["Solver", ["solver_max_receivers", "solver_max_range", "solver_near_always"]],
      ["Zones", ["zone_hysteresis", "zone_prob_smoothing", "zone_switch_margin", "zone_switch_secs", "stationary_speed", "stationary_secs", "zone_unlock_margin", "zone_unlock_secs"]],
      ["Sub-zones", ["subzone_switch_secs", "subzone_enter_prob", "subzone_unlock_margin"]],
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
      if (s.type === "bool") return uiSwitch({ label: key, checked: v == null ? !!s.default : !!v, onChange: set });
      if (s.type === "str") return uiSelect({ label: key, value: v ?? s.default, options: s.choices.map((c) => ({ value: c, label: c })), onChange: set, style: "min-width: 200px" });
      return uiField({ label: key, type: "number", step: s.type === "int" ? 1 : "any", min: s.min, max: s.max, placeholder: String(s.default), value: v == null ? "" : v, onChange: (val) => set(val === "" ? null : Number(val)), style: "width: 200px" });
    };
    return html`<section class="card">
      <h3>Tuning <span class="muted small">applies live, no restart</span></h3>
      ${groups.map(([name, keys]) => html`<h4>${name}</h4><div class="row">${keys.map(field)}</div>`)}
      <div class="row">${uiButton({ label: "Apply", kind: "primary", onClick: () => this._saveTuning() })}${uiButton({ label: "Restore defaults", kind: "text", onClick: () => this._resetTuning() })}</div>
    </section>`;
  }

  async _clearHistory(entity) {
    if (!confirmDialog(entity ? `Forget the recorded positions of ${entity}?` : "Forget every tracker's recorded positions?")) return;
    const r = await callWS(this, this.hass, { type: "sextant/history/clear", ...(entity ? { entity } : {}) });
    if (r) toast(this, `History cleared (${r.removed} file${r.removed === 1 ? "" : "s"} rewritten)`);
  }

  _renderHistory() {
    const ents = this.data?.entities || [];
    return html`<section class="card">
      <h3>Position history</h3>
      <p class="small muted">Positions are kept on disk for the scrubber in Live mode (retention is set by the layout's history keys). Forgetting is the one thing nothing else can do.</p>
      <div class="row">
        ${uiSelect({ label: "Tracker", value: this._histEnt || "", options: [{ value: "", label: "every tracker" }, ...ents.map((e) => ({ value: e, label: e }))], onChange: (v) => { this._histEnt = v; }, style: "min-width: 220px" })}
        ${uiButton({ label: "Clear history", kind: "danger", onClick: () => this._clearHistory(this._histEnt || null) })}
      </div>
    </section>`;
  }

  static styles = [sharedStyles, widgetStyles, css`
    .good { color: var(--success-color, #2e7d32); font-weight: 600; }
    .bad { color: var(--error-color, #c62828); font-weight: 600; }
    :host { display: block; overflow: auto; }
    .cols { grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); }
    section.receivers { grid-column: 1 / -1; }
    ul.plain { list-style: none; padding: 0; margin: 6px 0; }
    ul.plain li { padding: 3px 0; }
    details { margin-top: 8px; }
    summary { cursor: pointer; }
    h4 { margin-top: 12px; }
  `];
}

customElements.define("sextant-health", SextantHealth);
