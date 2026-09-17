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
