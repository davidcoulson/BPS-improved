/**
 * Shared styles and helpers for the Sextant panel's modes.
 *
 * Plain HTML controls styled with Home Assistant's theme variables rather
 * than HA's own web components: the panel then renders identically across
 * frontend versions and the elements it needs are always defined.
 */
import { css } from "./lit.js";

export const sharedStyles = css`
  * { box-sizing: border-box; }
  h3 { margin: 0 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--secondary-text-color); }
  h4 { margin: 0 0 6px; font-size: 15px; }
  .muted { color: var(--secondary-text-color); }
  .small { font-size: 12px; }
  .card { background: var(--card-background-color); border-radius: var(--ha-card-border-radius, 12px); box-shadow: var(--ha-card-box-shadow, 0 1px 4px rgba(0,0,0,0.15)); padding: 12px 14px; margin: 0 0 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .grow { flex: 1; min-width: 0; }
  button, .btn { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); cursor: pointer; }
  button:hover { border-color: var(--primary-color); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  button.danger { border-color: var(--error-color, #b00020); color: var(--error-color, #b00020); }
  button.ghost { background: transparent; }
  button.icon { padding: 4px 6px; line-height: 0; }
  input[type="text"], input[type="number"], input[type="search"], select, textarea { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); min-width: 0; }
  input[type="number"] { width: 90px; }
  textarea { width: 100%; min-height: 80px; font-family: ui-monospace, monospace; font-size: 12px; }
  label.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--secondary-text-color); }
  label.field > * { color: var(--primary-text-color); font-size: 14px; }
  label.inline { display: inline-flex; align-items: center; gap: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--divider-color); vertical-align: middle; }
  th { font-weight: 600; color: var(--secondary-text-color); font-size: 12px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .wrap { overflow-x: auto; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--secondary-background-color); }
  .pill.ok { background: rgba(44,110,73,0.18); color: var(--success-color, #2c6e49); }
  .pill.warn { background: rgba(224,165,74,0.22); color: var(--warning-color, #9a5b00); }
  .pill.bad { background: rgba(217,83,79,0.18); color: var(--error-color, #b00020); }
  .empty { padding: 24px; color: var(--secondary-text-color); text-align: center; }
  .page { padding: 12px 16px; overflow: auto; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; align-items: start; }
  code { font-family: ui-monospace, monospace; font-size: 12px; }
  .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--primary-text-color); color: var(--primary-background-color); padding: 8px 14px; border-radius: 8px; font-size: 13px; z-index: 10; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
`;

export function fmtAge(seconds) {
  if (seconds == null || !isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function fmtNum(value, digits = 2) {
  if (value == null || !isFinite(value)) return "—";
  return Number(value).toFixed(digits);
}

/** A short message at the bottom of the host element's shadow root. */
export function toast(host, message, ms = 3500) {
  const root = host.renderRoot || host.shadowRoot || host;
  let el = root.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; root.appendChild(el); }
  el.textContent = message;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.remove(), ms);
}

/** hass.callWS with the error surfaced as a toast; resolves to null on failure. */
export async function callWS(host, hass, message) {
  try {
    return await hass.callWS(message);
  } catch (e) {
    toast(host, e?.message || String(e), 6000);
    return null;
  }
}

export function confirmDialog(text) {
  return window.confirm(text);
}

export function slugLabel(slug) {
  return String(slug || "").replace(/^private_ble_device_/, "").replace(/^private_ble_/, "").replace(/_/g, " ");
}

// --- Home Assistant's own widgets --------------------------------------------
//
// The panel renders with HA's form elements (ha-textfield, ha-select,
// ha-switch, ha-button) so it looks like Settings. They are part of HA's
// frontend, not ours; ensureHaComponents() pulls the editor bundle that
// defines them, and each helper falls back to a plain element when one is
// missing, so the panel never renders an inert unknown tag.
import { html, nothing } from "./lit.js";

let _haReady = null;
export function ensureHaComponents() {
  if (_haReady) return _haReady;
  _haReady = (async () => {
    try {
      if (!(customElements.get("ha-input") || customElements.get("ha-textfield")) || !customElements.get("ha-select") || !customElements.get("ha-switch")) {
        const helpers = await window.loadCardHelpers?.();
        // Creating an entities-card editor loads the shared form elements.
        const card = helpers?.createCardElement?.({ type: "entities", entities: [] });
        await card?.constructor?.getConfigElement?.();
      }
      await Promise.race([
        Promise.all(["ha-select", "ha-switch", "ha-formfield", "ha-button"].map((t) => customElements.whenDefined(t))),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    } catch { /* fall back to plain elements */ }
    return { textfield: !!(customElements.get("ha-input") || customElements.get("ha-textfield")), select: !!customElements.get("ha-select"),
             switch: !!customElements.get("ha-switch") && !!customElements.get("ha-formfield"), button: !!customElements.get("ha-button") || !!customElements.get("mwc-button") };
  })();
  return _haReady;
}

const has = (tag) => !!customElements.get(tag);

/** Text or number field. HA 2026.3+ ships ha-input (a Web Awesome input);
 *  older frontends ship ha-textfield; both emit a composed change event. */
export function uiField({ label, value, type = "text", step, min, max, placeholder, onChange, disabled = false, style = "", suffix }) {
  const v = value == null ? "" : String(value);
  if (has("ha-input")) {
    return html`<ha-input .label=${label ?? ""} .value=${v} .type=${type} .step=${step ?? nothing} .min=${min ?? nothing} .max=${max ?? nothing}
        .placeholder=${placeholder ?? ""} ?disabled=${disabled} style=${style} withoutSpinButtons
        @change=${(e) => onChange?.(e.target.value)}></ha-input>`;
  }
  if (has("ha-textfield")) {
    return html`<ha-textfield .label=${label ?? ""} .value=${v} .type=${type} .step=${step ?? nothing} .min=${min ?? nothing} .max=${max ?? nothing}
        .placeholder=${placeholder ?? ""} .suffix=${suffix ?? nothing} ?disabled=${disabled} style=${style}
        @change=${(e) => onChange?.(e.target.value)}></ha-textfield>`;
  }
  return html`<label class="field" style=${style}>${label ?? ""}<input type=${type} step=${step ?? nothing} min=${min ?? nothing} max=${max ?? nothing}
        placeholder=${placeholder ?? ""} .value=${v} ?disabled=${disabled} @change=${(e) => onChange?.(e.target.value)}></label>`;
}

/** Dropdown. options: [{value, label, disabled?}] */
export function uiSelect({ label, value, options, onChange, disabled = false, style = "" }) {
  const v = value == null ? "" : String(value);
  const Sel = customElements.get("ha-select");
  const opts = options.map((o) => ({ value: String(o.value), label: o.label, disabled: !!o.disabled }));
  const fire = (e) => { const nv = e.detail?.value ?? e.target?.value; if (nv != null && String(nv) !== v) onChange?.(String(nv)); };
  if (Sel && Sel.elementProperties?.has?.("options")) {
    // HA 2026.3+: options are a property, selection arrives as value-changed.
    return html`<ha-select .label=${label ?? ""} .value=${v} .options=${opts} ?disabled=${disabled} style=${style}
        @value-changed=${fire} @change=${fire} @closed=${(e) => e.stopPropagation()}></ha-select>`;
  }
  if (Sel && has("mwc-list-item")) {
    return html`<ha-select .label=${label ?? ""} .value=${v} ?disabled=${disabled} style=${style} naturalMenuWidth fixedMenuPosition
        @selected=${(e) => { const nv = e.target.value; if (nv !== v) onChange?.(nv); }} @closed=${(e) => e.stopPropagation()}>
      ${options.map((o) => html`<mwc-list-item .value=${String(o.value)} ?disabled=${!!o.disabled}>${o.label}</mwc-list-item>`)}
    </ha-select>`;
  }
  return html`<label class="field" style=${style}>${label ?? ""}<select ?disabled=${disabled} @change=${(e) => onChange?.(e.target.value)}>
      ${options.map((o) => html`<option value=${String(o.value)} ?selected=${String(o.value) === v} ?disabled=${!!o.disabled}>${o.label}</option>`)}</select></label>`;
}

/** On/off toggle with a label. */
export function uiSwitch({ label, checked, onChange, disabled = false }) {
  if (has("ha-switch") && has("ha-formfield")) {
    return html`<ha-formfield .label=${label ?? ""}><ha-switch .checked=${!!checked} ?disabled=${disabled} @change=${(e) => onChange?.(e.target.checked)}></ha-switch></ha-formfield>`;
  }
  return html`<label class="inline"><input type="checkbox" .checked=${!!checked} ?disabled=${disabled} @change=${(e) => onChange?.(e.target.checked)}> ${label ?? ""}</label>`;
}

/** Button. kind: "primary" | "outline" | "text" | "danger" */
export function uiButton({ label, onClick, kind = "outline", disabled = false, icon, title }) {
  if (has("ha-button") || has("mwc-button")) {
    const tag = has("ha-button") ? "ha-button" : "mwc-button";
    const raised = kind === "primary", outlined = kind === "outline" || kind === "danger";
    const cls = kind === "danger" ? "danger" : "";
    return tag === "ha-button"
      ? html`<ha-button ?raised=${raised} ?outlined=${outlined} ?disabled=${disabled} class=${cls} title=${title ?? nothing} @click=${onClick}>${icon ? html`<ha-icon slot="icon" icon=${icon}></ha-icon>` : nothing}${label}</ha-button>`
      : html`<mwc-button ?raised=${raised} ?outlined=${outlined} ?disabled=${disabled} class=${cls} title=${title ?? nothing} @click=${onClick}>${icon ? html`<ha-icon slot="icon" icon=${icon}></ha-icon>` : nothing}${label}</mwc-button>`;
  }
  return html`<button class=${kind === "primary" ? "primary" : kind === "danger" ? "danger" : kind === "text" ? "ghost" : ""} ?disabled=${disabled} title=${title ?? nothing} @click=${onClick}>${label}</button>`;
}

export const widgetStyles = css`
  ha-textfield { --mdc-text-field-fill-color: var(--card-background-color); min-width: 120px; }
  ha-textfield.narrow { width: 110px; }
  ha-select { min-width: 160px; }
  ha-button.danger, mwc-button.danger { --mdc-theme-primary: var(--error-color, #b00020); }
  ha-formfield { --mdc-typography-body2-font-size: 13px; }
`;
