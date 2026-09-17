/**
 * Health mode: receivers, calibration, self-test, stability KPI and tuning.
 */
import { LitElement, html, css, nothing } from "./lit.js";
import { sharedStyles, fmtAge, fmtNum, toast, callWS, confirmDialog } from "./sextant-ui.js";

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
    const r = await callWS(this, this.hass, { type: "sextant/kpi", hours: this._kpiHours });
    this._busy = null;
    if (r) this._kpi = r;
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
        <button class="ghost" @click=${() => this._refresh()}>Refresh</button>
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
          <label class="field">Floor<select @change=${(e) => { this._calFloor = e.target.value; }}>
            ${floors.map((f) => html`<option value=${f.name} ?selected=${f.name === this._calFloor}>${f.name}</option>`)}</select></label>
          <label class="field">Duration s<input type="number" min="60" max="3600" step="30" .value=${String(this._calDuration)} @change=${(e) => { this._calDuration = Number(e.target.value); }}></label>
          <button class="primary" ?disabled=${sampling || !!this._busy} @click=${() => this._calAction("start", { floor: this._calFloor, duration: this._calDuration })}>Start run</button>
          <button ?disabled=${!!this._busy} @click=${() => this._calAction("cancel")}>Cancel</button>
          <label class="inline"><input type="checkbox" .checked=${cal.mode === "auto"} @change=${(e) => this._calAction("auto", { enabled: e.target.checked })}> Auto calibration</label>
        </div>
        <div class="row">
          <button ?disabled=${!!this._busy} @click=${() => this._calAction("solve", { floor: this._calFloor })}>Solve now</button>
          <button ?disabled=${!!this._busy || !results[this._calFloor]} @click=${() => this._calAction("apply", { floor: this._calFloor })}>Apply corrections</button>
          <button class="danger" ?disabled=${!!this._busy} @click=${() => confirmDialog(`Reset corrections on ${this._calFloor}?`) && this._calAction("reset", { floor: this._calFloor })}>Reset</button>
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
      <div class="row"><button ?disabled=${this._busy === "selftest"} @click=${() => this._runSelftest()}>${this._busy === "selftest" ? "Running…" : "Run self-test"}</button>
        ${st ? html`<span class="pill ${Number(st.state) < 2 ? "ok" : Number(st.state) < 4 ? "warn" : "bad"}">CEP95 ${st.state} m</span>` : nothing}</div>
      ${st ? html`<div class="wrap"><table><tr><th>Receiver</th><th class="num">Error m</th><th class="num">Neighbours</th></tr>
        ${Object.entries(st.result?.receivers || st.result || {}).filter(([, v]) => v && typeof v === "object").sort((a, b) => (b[1].error_m ?? -1) - (a[1].error_m ?? -1)).slice(0, 60).map(([slug, v]) => html`<tr><td>${slug}</td><td class="num">${v.error_m != null ? fmtNum(v.error_m, 2) : html`<span class="muted">unsolved</span>`}</td><td class="num">${v.neighbors ?? v.neighbours ?? "—"}</td></tr>`)}
      </table></div>` : nothing}
    </section>`;
  }

  _renderKpi() {
    const k = this._kpi;
    const s = k?.summary || {};
    const ents = Object.entries(k?.entities || {}).filter(([e]) => e.endsWith("_sextant_zone")).sort((a, b) => (b[1].changes_per_hour ?? 0) - (a[1].changes_per_hour ?? 0));
    return html`<section class="card">
      <h3>Stability</h3>
      <div class="row">
        <label class="field">Window<select @change=${(e) => { this._kpiHours = Number(e.target.value); }}>
          ${[1, 3, 6, 12, 24, 48].map((h) => html`<option value=${h} ?selected=${h === this._kpiHours}>${h} h</option>`)}</select></label>
        <button ?disabled=${this._busy === "kpi"} @click=${() => this._runKpi()}>${this._busy === "kpi" ? "Computing…" : "Compute"}</button>
        ${s.sextant_zone ? html`<span class="pill">${s.sextant_zone.changes_per_tracker_hour} zone changes / tracker-h</span>
          <span class="pill">flip ratio ${s.sextant_zone.flip_ratio}</span><span class="pill">median dwell ${fmtAge(s.sextant_zone.median_of_median_dwell_s)}</span>` : nothing}
      </div>
      ${ents.length ? html`<div class="wrap"><table>
        <tr><th>Tracker</th><th class="num">chg/h</th><th class="num">flip %</th><th class="num">dwell</th><th class="num">&lt;60 s %</th><th class="num">dead</th></tr>
        ${ents.map(([e, m]) => html`<tr><td>${e.replace(/^sensor\./, "").replace(/_sextant_zone$/, "")}</td><td class="num">${fmtNum(m.changes_per_hour, 1)}</td><td class="num">${m.flip_ratio != null ? fmtNum(m.flip_ratio * 100, 0) : "—"}</td><td class="num">${fmtAge(m.median_dwell_s)}</td><td class="num">${m.short_dwell_ratio != null ? fmtNum(m.short_dwell_ratio * 100, 0) : "—"}</td><td class="num">${m.dead}</td></tr>`)}
      </table></div>` : k ? html`<div class="muted small">No zone sensors in the recorder window.</div>` : nothing}
    </section>`;
  }

  _renderTuning() {
    const spec = this.data?.tuning_spec || {};
    const groups = [
      ["Estimator", ["position_estimator", "fingerprint_weight", "fingerprint_floor_weight", "fingerprint_k", "fingerprint_missing_m", "fingerprint_ref_gain", "distance_estimator", "median_window_secs", "median_min_samples"]],
      ["Solver", ["solver_max_receivers", "solver_max_range", "solver_near_always"]],
      ["Zones", ["zone_hysteresis", "zone_prob_smoothing", "zone_switch_margin", "zone_switch_secs", "stationary_speed", "stationary_secs", "zone_unlock_margin", "zone_unlock_secs"]],
      ["Sub-zones", ["subzone_switch_secs", "subzone_enter_prob", "subzone_unlock_margin"]],
      ["Floors", ["floor_switch_secs", "floor_tenure_bonus", "floor_tenure_full_secs", "floor_proximity_weight"]],
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
      if (s.type === "bool") return html`<label class="inline"><input type="checkbox" .checked=${v == null ? !!s.default : !!v} @change=${(e) => set(e.target.checked)}> ${key}</label>`;
      if (s.type === "str") return html`<label class="field">${key}<select @change=${(e) => set(e.target.value)}>${s.choices.map((c) => html`<option value=${c} ?selected=${(v ?? s.default) === c}>${c}</option>`)}</select></label>`;
      return html`<label class="field" title="${s.min} to ${s.max}, default ${s.default}">${key}<input type="number" step=${s.type === "int" ? 1 : "any"} min=${s.min} max=${s.max} placeholder=${s.default} .value=${v == null ? "" : String(v)} @change=${(e) => set(e.target.value === "" ? null : Number(e.target.value))}></label>`;
    };
    return html`<section class="card">
      <h3>Tuning <span class="muted small">applies live, no restart</span></h3>
      ${groups.map(([name, keys]) => html`<h4>${name}</h4><div class="row">${keys.map(field)}</div>`)}
      <div class="row"><button class="primary" @click=${() => this._saveTuning()}>Apply</button><button class="ghost" @click=${() => this._resetTuning()}>Restore defaults</button></div>
    </section>`;
  }

  static styles = [sharedStyles, css`
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
