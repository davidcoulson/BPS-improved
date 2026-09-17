"""Websocket commands: everything the Sextant panel reads and writes.

The old panel ran inside an iframe and fetched ``/api/sextant/*`` with a
couriered token. The rebuilt panel is a native Home Assistant panel, so it
talks over the authenticated websocket like the rest of the frontend: one
subscription for positions (``sextant/subscribe``, in __init__) and the
request/response commands below for everything else. The HTTP views stay
for file uploads (a map image, a tracker icon), the legacy editor and the
eval tools.

Every command answers with a plain JSON-able dict, or an error whose
message is meant to be shown to the user as is.
"""

from __future__ import annotations

import json
import logging
import math
import time
from datetime import datetime, timedelta, timezone
from importlib import import_module

import voluptuous as vol
from homeassistant.components import websocket_api

from . import bermuda_source, kpi
from . import history as history_mod
from .storage import (
    LAYOUT_LOCK, get_layout, get_layout_for_edit, get_layout_version, load_kpi_baselines, save_kpi_baselines,
    save_layout,
)

_LOGGER = logging.getLogger(__name__)


def _core():
    """The integration module (sextant/__init__), imported lazily: it imports us."""
    return import_module(__package__)


def _error(connection, msg, message, code="sextant_error"):
    connection.send_error(msg["id"], code, str(message))


def _safe(func, fallback):
    """Call a diagnostics helper; a failure (no Bermuda, no registry) is the fallback, never an error."""
    try:
        return func()
    except Exception as e:  # noqa: BLE001
        _LOGGER.debug("panel diagnostics unavailable: %s", e)
        return fallback


def _tuning_spec_json(spec):
    out = {}
    for key, entry in spec.items():
        kind = entry[1]
        if kind is bool:
            out[key] = {"default": entry[0], "type": "bool"}
        elif kind is str:
            out[key] = {"default": entry[0], "type": "str", "choices": list(entry[2])}
        else:
            out[key] = {"default": entry[0], "type": "int" if kind is int else "float", "min": entry[2], "max": entry[3]}
    return out


def _tracker_names(hass, entities, layout=None) -> dict:
    """{slug: display name} for the tracked entities.

    Bermuda's device name first ("Fry", "David's Phone"), then whatever the
    user renamed the device to in Home Assistant, then the name typed in
    Sextant's own tracker dialog (layout "tracker_names"), which wins.
    """
    names = {}
    for info in (bermuda_source.async_get_tracked_devices(hass) or {}).values():
        slug, name = info.get("slug"), info.get("name")
        if slug and name:
            names[slug] = _tidy_device_name(name)
    try:
        from homeassistant.helpers import device_registry as dr, entity_registry as er  # noqa: PLC0415

        ent_reg, dev_reg = er.async_get(hass), dr.async_get(hass)
        for ent in entities:
            # Only a name the user typed counts here: the registry's own name
            # is Sextant's "<slug> (Sextant)" device or Bermuda's, which the
            # tracked list already gave us in a nicer form.
            for entity_id in (f"sensor.{ent}_sextant_room", f"sensor.{ent}_area", f"device_tracker.{ent}"):
                entry = ent_reg.async_get(entity_id)
                device = dev_reg.async_get(entry.device_id) if entry and entry.device_id else None
                if device is not None and device.name_by_user:
                    # A rename in HA wins, minus the integration prefix HA's
                    # own rename dialog pre-fills ("Private BLE Device ...").
                    names[ent] = _tidy_device_name(device.name_by_user)
                    break
    except Exception:  # noqa: BLE001 - no registries (tests), Bermuda's names stand
        pass
    overrides = layout.get("tracker_names") if isinstance(layout, dict) else None
    if isinstance(overrides, dict):
        for slug, name in overrides.items():
            if isinstance(name, str) and name.strip():
                names[slug] = name.strip()
    return names


def _tidy_device_name(name: str) -> str:
    """"Private BLE Device David's Phone" -> "David's Phone": the integration
    prefix Bermuda copies into the device name is not part of the name."""
    for prefix in ("Private BLE Device ", "Private BLE "):
        if name.startswith(prefix) and len(name) > len(prefix):
            return name[len(prefix):]
    return name


# --- layout ----------------------------------------------------------------------


@websocket_api.websocket_command({vol.Required("type"): "sextant/layout/get"})
@websocket_api.async_response
async def ws_layout_get(hass, connection, msg):
    core = _core()
    layout = get_layout(hass)
    layout_json = json.dumps(layout) if layout else ""
    maps_path = hass.config.path("www/sextant_maps")
    icons_path = hass.config.path("www/sextant_icons")
    try:
        maps = await hass.async_add_executor_job(core.list_map_files, maps_path)
    except Exception:  # noqa: BLE001 - a missing folder is an empty list
        maps = []
    try:
        icons = await hass.async_add_executor_job(core.list_tracker_icons, icons_path)
    except Exception:  # noqa: BLE001
        icons = []
    tracked = bermuda_source.async_get_tracked_device_prefixes(hass)
    if tracked is None:
        try:
            allowed = core._bermuda_distance_sensor_ids(hass)
            tracked = {eid[len("sensor."):].split("_distance_to_")[0] for eid in allowed}
        except Exception:  # noqa: BLE001 - no Bermuda, no registry: nothing tracked
            tracked = set()
    directory = bermuda_source.async_get_scanner_directory(hass) or {}
    dom = hass.data.get(core.DOMAIN, {})
    connection.send_result(msg["id"], {
        "layout": layout if isinstance(layout, dict) else None,
        "version": get_layout_version(hass),
        "maps": sorted(maps),
        "icons": icons,
        "entities": sorted(tracked),
        # Display names: what Bermuda calls the device, overridden by the name
        # the user gave the device in Home Assistant (device registry).
        "names": _safe(lambda: _tracker_names(hass, tracked, layout), {}),
        "scanners": {
            addr: {"slug": info.get("slug"), "name": info.get("name"), "area": info.get("area_name"),
                   "is_remote": info.get("is_remote")}
            for addr, info in directory.items()
        },
        "offline_receivers": list(dom.get("rl_offline") or []),
        "scanner_diagnostics": _safe(lambda: core._scanner_diagnostics(hass, layout_json), {"unmatched_receivers": [], "unplaced_scanners": []}),
        "tuning_spec": _tuning_spec_json(core.TUNING_SPEC),
        "features": sorted(bermuda_source.async_features(hass)),
    })


@websocket_api.websocket_command({
    vol.Required("type"): "sextant/layout/save",
    vol.Required("layout"): dict,
    vol.Optional("remove_map"): str,
})
@websocket_api.async_response
async def ws_layout_save(hass, connection, msg):
    core = _core()
    layout = msg["layout"]
    floors = layout.get("floor")
    if not isinstance(floors, list):
        return _error(connection, msg, "layout.floor must be a list")
    for floor in floors:
        if not isinstance(floor, dict) or not floor.get("name"):
            return _error(connection, msg, "every floor needs a name")
    remove_target = None
    remove = msg.get("remove_map")
    if remove:
        maps_path = hass.config.path("www/sextant_maps")
        remove_target = core._safe_maps_child(maps_path, remove, None)
        if remove_target is None or remove_target.name in core._PROTECTED_MAPS_FILES:
            return _error(connection, msg, "invalid map to remove")
    async with LAYOUT_LOCK:
        await save_layout(hass, layout)
    if remove_target is not None and remove_target.exists():
        try:
            await hass.async_add_executor_job(remove_target.unlink)
        except Exception as e:  # noqa: BLE001
            _LOGGER.warning("Could not remove map %s: %s", remove_target.name, e)
    try:
        core.refresh_receivers_from_coords(hass, json.dumps(layout))
    except Exception as e:  # noqa: BLE001 - calibration bookkeeping must not fail a save
        _LOGGER.debug("refresh_receivers_from_coords: %s", e)
    connection.send_result(msg["id"], {"version": get_layout_version(hass)})


@websocket_api.websocket_command({
    vol.Required("type"): "sextant/tuning/set",
    vol.Optional("settings", default=dict): dict,
    vol.Optional("reset", default=False): bool,
})
@websocket_api.async_response
async def ws_tuning_set(hass, connection, msg):
    core = _core()
    try:
        tuning = await core.async_apply_tuning(hass, msg.get("settings") or {}, bool(msg.get("reset")))
    except Exception as e:  # noqa: BLE001 - HomeAssistantError or ValueError: message for the user
        return _error(connection, msg, e)
    connection.send_result(msg["id"], {"tuning": tuning})


@websocket_api.websocket_command({
    vol.Required("type"): "sextant/tracker/tune",
    vol.Required("entity"): str,
    vol.Optional("ref_offset_db"): vol.Any(None, vol.Coerce(float)),
    vol.Optional("height"): vol.Any(None, vol.Coerce(float)),
    vol.Optional("icon"): vol.Any(None, str),
    vol.Optional("name"): vol.Any(None, str),
    vol.Optional("tracker_class"): vol.Any(None, str),
})
@websocket_api.async_response
async def ws_tracker_tune(hass, connection, msg):
    """Per-tracker settings, each applied on its own: ref-power trim (dB),
    carry height (m), map icon, display name and class (person, dog, phone...
    the panel draws an icon per class). A null clears the field."""
    core = _core()
    entity = msg["entity"]
    changes = {}
    async with LAYOUT_LOCK:
        data = get_layout_for_edit(hass)
        if not isinstance(data, dict):
            return _error(connection, msg, "No layout saved yet")
        if "ref_offset_db" in msg:
            raw = msg["ref_offset_db"]
            offsets = data.get("tracker_ref_offsets")
            if not isinstance(offsets, dict):
                offsets = {}
            if raw is None or raw == 0.0:
                offsets.pop(entity, None)
                changes["ref_offset_db"] = 0.0
            else:
                if not math.isfinite(raw) or abs(raw) > core.TRACKER_REF_OFFSET_MAX_DB:
                    return _error(connection, msg, f"ref_offset_db must be within +/-{core.TRACKER_REF_OFFSET_MAX_DB} dB")
                offsets[entity] = float(raw)
                changes["ref_offset_db"] = float(raw)
            data["tracker_ref_offsets"] = offsets
        if "height" in msg:
            raw = msg["height"]
            heights = data.get("tracker_heights")
            if not isinstance(heights, dict):
                heights = {}
            if raw is None:
                heights.pop(entity, None)
                changes["height"] = None
            else:
                if not math.isfinite(raw) or not 0 <= raw <= 5:
                    return _error(connection, msg, "height must be between 0 and 5 m")
                heights[entity] = float(raw)
                changes["height"] = float(raw)
            data["tracker_heights"] = heights
        if "icon" in msg:
            icons = data.get("tracker_icons")
            if not isinstance(icons, dict):
                icons = {}
            if msg["icon"]:
                icons[entity] = msg["icon"]
            else:
                icons.pop(entity, None)
            data["tracker_icons"] = icons
            changes["icon"] = msg["icon"] or None
        for key, store in (("name", "tracker_names"), ("tracker_class", "tracker_classes")):
            if key in msg:
                values = data.get(store)
                if not isinstance(values, dict):
                    values = {}
                value = (msg[key] or "").strip()
                if value:
                    values[entity] = value[:60]
                else:
                    values.pop(entity, None)
                data[store] = values
                changes[key] = value or None
        await save_layout(hass, data)
    connection.send_result(msg["id"], {"entity": entity, **changes})


# --- history -----------------------------------------------------------------


def _history(hass):
    core = _core()
    hist = core.get_position_history(hass)
    hist.configure(history_mod.history_config(get_layout(hass)))
    hist.evict_all()
    return hist


@websocket_api.websocket_command({vol.Required("type"): "sextant/history/index"})
@websocket_api.async_response
async def ws_history_index(hass, connection, msg):
    core = _core()
    hist = _history(hass)
    files, size = await hass.async_add_executor_job(history_mod.disk_usage, core.history_dir(hass))
    connection.send_result(msg["id"], {
        "now": time.time(),
        "config": dict(hist.cfg),
        "trackers": [dict(hist.retained(e) or {}, ent=e) for e in hist.entities()],
        "disk": {"files": files, "bytes": size},
    })


@websocket_api.websocket_command({
    vol.Required("type"): "sextant/history/get",
    vol.Required("entity"): str,
    vol.Optional("from"): vol.Coerce(float),
    vol.Optional("to"): vol.Coerce(float),
    vol.Optional("max_points"): vol.Coerce(int),
})
@websocket_api.async_response
async def ws_history_get(hass, connection, msg):
    core = _core()
    hist = _history(hass)
    now = time.time()
    to = msg.get("to") or now
    frm = msg.get("from") or (to - hist.cfg["max_age"])
    if frm > to:
        frm, to = to, frm
    max_points = int(min(max(2, msg.get("max_points") or core.HISTORY_DEFAULT_POINTS), core.HISTORY_MAX_QUERY_POINTS))
    data = hist.query(msg["entity"], frm, to, max_points)
    data.update({"now": now, "from": frm, "to": to, "retained": hist.retained(msg["entity"]), "config": dict(hist.cfg)})
    connection.send_result(msg["id"], data)


@websocket_api.websocket_command({vol.Required("type"): "sextant/history/clear", vol.Optional("entity"): str})
@websocket_api.async_response
async def ws_history_clear(hass, connection, msg):
    core = _core()
    hist = core.get_position_history(hass)
    entity = msg.get("entity")
    dirpath = core.history_dir(hass)
    async with core._history_lock(hass):
        hist.forget(entity or None)
        if entity:
            removed = await hass.async_add_executor_job(history_mod.drop_entity, dirpath, entity)
        else:
            removed = await hass.async_add_executor_job(history_mod.clear_segments, dirpath)
    connection.send_result(msg["id"], {"cleared": entity or "*", "removed": removed})


# --- calibration, self-test, receivers ------------------------------------------


@websocket_api.websocket_command({vol.Required("type"): "sextant/calibration/status"})
@websocket_api.async_response
async def ws_calibration_status(hass, connection, msg):
    from .calibration import _status_payload, get_calibration_state  # noqa: PLC0415

    connection.send_result(msg["id"], _status_payload(get_calibration_state(hass)))


@websocket_api.websocket_command({
    vol.Required("type"): "sextant/calibration/action",
    vol.Required("action"): str,
    vol.Optional("floor"): vol.Any(None, str),
    vol.Optional("duration"): vol.Any(None, vol.Coerce(int)),
    vol.Optional("enabled"): bool,
})
@websocket_api.async_response
async def ws_calibration_action(hass, connection, msg):
    from .calibration import async_calibration_action  # noqa: PLC0415

    try:
        payload = await async_calibration_action(hass, msg)
    except ValueError as e:
        return _error(connection, msg, e)
    connection.send_result(msg["id"], payload)


@websocket_api.websocket_command({vol.Required("type"): "sextant/selftest"})
@websocket_api.async_response
async def ws_selftest(hass, connection, msg):
    from .calibration import get_calibration_state  # noqa: PLC0415

    core = _core()
    samples = {k: list(v) for k, v in get_calibration_state(hass).get("samples", {}).items()}
    result = await hass.async_add_executor_job(core.run_selftest, hass, samples)
    state, attrs = core._selftest_summary(result)
    connection.send_result(msg["id"], {"result": result, "state": state, "summary": attrs})


@websocket_api.websocket_command({vol.Required("type"): "sextant/scanner_linking"})
@websocket_api.async_response
async def ws_scanner_linking(hass, connection, msg):
    core = _core()
    layout = get_layout(hass)
    connection.send_result(msg["id"], core._scanner_linking(hass, json.dumps(layout) if layout else ""))


@websocket_api.websocket_command({vol.Required("type"): "sextant/beacon_links"})
@websocket_api.async_response
async def ws_beacon_links(hass, connection, msg):
    """For every tracked device, the receivers currently hearing it, nearest first."""
    core = _core()
    connection.send_result(msg["id"], {"beacons": _safe(lambda: core._beacon_links(hass), [])})


@websocket_api.websocket_command({vol.Required("type"): "sextant/receivers"})
@websocket_api.async_response
async def ws_receivers(hass, connection, msg):
    """Every placed receiver with its liveness, plus scanners Bermuda knows
    that are not placed on any floor."""
    core = _core()
    dom = hass.data.get(core.DOMAIN, {})
    offline = set(dom.get("rl_offline") or [])
    ages = dom.get("rl_ages") or {}
    directory = bermuda_source.async_get_scanner_directory(hass) or {}
    by_slug = {info.get("slug"): (addr, info) for addr, info in directory.items() if info.get("slug")}
    layout = get_layout(hass) or {}
    placed = []
    placed_addresses = set()
    for floor in layout.get("floor", []) if isinstance(layout, dict) else []:
        for rx in floor.get("receivers", []) or []:
            slug = rx.get("entity_id")
            address = (rx.get("address") or "").lower() or None
            info = directory.get(address) if address else None
            if info is None and slug in by_slug:
                address, info = by_slug[slug]
            if address:
                placed_addresses.add(address)
            placed.append({
                "slug": slug,
                "address": address,
                "floor": floor.get("name"),
                "x": (rx.get("cords") or {}).get("x"),
                "y": (rx.get("cords") or {}).get("y"),
                "height": rx.get("height"),
                "correction": rx.get("correction"),
                "online": slug not in offline,
                "age": ages.get(slug),
                "name": info.get("name") if info else None,
                "area": info.get("area_name") if info else None,
                "last_seen_age": info.get("last_seen_age") if info else None,
                "matched": info is not None,
            })
    unplaced = [
        {"address": addr, "slug": info.get("slug"), "name": info.get("name"), "area": info.get("area_name"),
         "last_seen_age": info.get("last_seen_age")}
        for addr, info in directory.items() if addr not in placed_addresses
    ]
    connection.send_result(msg["id"], {"placed": placed, "unplaced": unplaced})


@websocket_api.websocket_command({
    vol.Required("type"): "sextant/adjust_zones",
    vol.Optional("target", default="zones"): str,
    vol.Optional("zones", default=list): list,
    vol.Optional("subzones", default=list): list,
    vol.Optional("options", default=dict): dict,
})
@websocket_api.async_response
async def ws_adjust_zones(hass, connection, msg):
    from .zone_adjust import adjust_subzones, adjust_zones  # noqa: PLC0415

    target = "subzones" if msg.get("target") == "subzones" else "zones"
    zones, subzones, options = msg.get("zones") or [], msg.get("subzones") or [], msg.get("options") or {}
    if target == "subzones" and not subzones:
        return _error(connection, msg, "No sub-zones to adjust")
    if target == "zones" and not zones:
        return _error(connection, msg, "No zones to adjust")
    func = adjust_subzones if target == "subzones" else adjust_zones
    try:
        result = await hass.async_add_executor_job(func, zones, subzones, options)
    except Exception as e:  # noqa: BLE001
        _LOGGER.error("adjust_zones (%s) failed: %s", target, e)
        return _error(connection, msg, "Zone adjustment failed")
    connection.send_result(msg["id"], result)


# --- KPI --------------------------------------------------------------------------


class _KpiUnavailable(Exception):
    """The recorder cannot answer (not loaded, or the query failed)."""


def _kpi_hours(msg):
    return max(0.25, min(float(msg.get("hours") or 12.0), 24 * 14))


async def _compute_kpi(hass, hours):
    """Zone/floor stability over the last ``hours`` from the recorder."""
    entity_ids = sorted(
        s.entity_id for s in hass.states.async_all("sensor") if s.entity_id.endswith(kpi.SUFFIXES)
    )
    if not entity_ids:
        return {"hours": hours, "generated_at": datetime.now(timezone.utc).isoformat(), "entities": {}, "summary": {}}
    try:
        from homeassistant.components.recorder import get_instance  # noqa: PLC0415
        from homeassistant.components.recorder import history as rec_history  # noqa: PLC0415
    except Exception as e:  # noqa: BLE001
        raise _KpiUnavailable("the recorder is not available") from e
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    try:
        states = await get_instance(hass).async_add_executor_job(
            rec_history.get_significant_states, hass, start, end, entity_ids, None, True, True, True, True,
        )
    except Exception as e:  # noqa: BLE001
        raise _KpiUnavailable(f"recorder query failed: {e}") from e
    per_entity = {}
    for eid in entity_ids:
        rows = kpi.rows_from_recorder(states.get(eid))
        per_entity[eid] = kpi.compute_metrics(rows, hours)
    return {
        "hours": hours,
        "generated_at": end.isoformat(),
        "entities": per_entity,
        "summary": kpi.summarise(per_entity),
    }


@websocket_api.websocket_command({
    vol.Required("type"): "sextant/kpi",
    vol.Optional("hours", default=12.0): vol.Coerce(float),
    vol.Optional("baseline"): str,
})
@websocket_api.async_response
async def ws_kpi(hass, connection, msg):
    """Stability KPI for the window; with ``baseline`` also the deltas against
    a saved baseline (sextant/kpi/baseline/save)."""
    hours = _kpi_hours(msg)
    try:
        result = await _compute_kpi(hass, hours)
    except _KpiUnavailable as e:
        return _error(connection, msg, str(e))
    name = (msg.get("baseline") or "").strip()
    if name:
        baselines = await load_kpi_baselines(hass)
        base = baselines.get(name)
        if not isinstance(base, dict):
            return _error(connection, msg, f"no KPI baseline named {name!r}")
        result["baseline"] = {
            "name": name, "saved_at": base.get("saved_at"), "hours": base.get("hours"), "summary": base.get("summary"),
        }
        result["deltas"] = kpi.deltas(result, base)
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({vol.Required("type"): "sextant/kpi/baselines"})
@websocket_api.async_response
async def ws_kpi_baselines(hass, connection, msg):
    baselines = await load_kpi_baselines(hass)
    rows = [
        {
            "name": name, "saved_at": b.get("saved_at"), "hours": b.get("hours"), "summary": b.get("summary"),
            "trackers": len(b.get("entities") or {}),
        }
        for name, b in baselines.items() if isinstance(b, dict)
    ]
    rows.sort(key=lambda r: r.get("saved_at") or "")
    connection.send_result(msg["id"], {"baselines": rows})


@websocket_api.websocket_command({
    vol.Required("type"): "sextant/kpi/baseline/save",
    vol.Required("name"): str,
    vol.Optional("hours", default=12.0): vol.Coerce(float),
})
@websocket_api.async_response
async def ws_kpi_baseline_save(hass, connection, msg):
    """Compute the window now and keep it under ``name`` for later comparison."""
    name = msg["name"].strip()
    if not name or len(name) > 60:
        return _error(connection, msg, "baseline name must be 1-60 characters")
    hours = _kpi_hours(msg)
    try:
        result = await _compute_kpi(hass, hours)
    except _KpiUnavailable as e:
        return _error(connection, msg, str(e))
    if not result["entities"]:
        return _error(connection, msg, "no zone sensors in the recorder window; nothing to save")
    baselines = await load_kpi_baselines(hass)
    baselines[name] = {
        "saved_at": result["generated_at"], "hours": hours,
        "entities": result["entities"], "summary": result["summary"],
    }
    await save_kpi_baselines(hass, baselines)
    connection.send_result(msg["id"], {"name": name, "saved_at": result["generated_at"], "trackers": len(result["entities"])})


@websocket_api.websocket_command({vol.Required("type"): "sextant/kpi/baseline/delete", vol.Required("name"): str})
@websocket_api.async_response
async def ws_kpi_baseline_delete(hass, connection, msg):
    baselines = await load_kpi_baselines(hass)
    if msg["name"] not in baselines:
        return _error(connection, msg, f"no KPI baseline named {msg['name']!r}")
    del baselines[msg["name"]]
    await save_kpi_baselines(hass, baselines)
    connection.send_result(msg["id"], {"deleted": msg["name"]})


# --- Bermuda management ------------------------------------------------------------


def _bermuda_result(connection, msg, value, feature="device_management"):
    if value is None:
        return _error(connection, msg, f"This Bermuda build has no {feature} API; update Bermuda")
    connection.send_result(msg["id"], value)


@websocket_api.websocket_command({vol.Required("type"): "sextant/bermuda/candidates", vol.Optional("max_age"): vol.Coerce(float)})
@websocket_api.async_response
async def ws_bermuda_candidates(hass, connection, msg):
    rows = bermuda_source.async_get_device_candidates(hass, max_age=msg.get("max_age"))
    _bermuda_result(connection, msg, None if rows is None else {"candidates": rows})


@websocket_api.websocket_command({vol.Required("type"): "sextant/bermuda/tracked"})
@websocket_api.async_response
async def ws_bermuda_tracked(hass, connection, msg):
    tracked = bermuda_source.async_get_tracked_devices(hass)
    _bermuda_result(connection, msg, None if tracked is None else {"tracked": tracked}, feature="tracked_devices")


@websocket_api.websocket_command({
    vol.Required("type"): "sextant/bermuda/track",
    vol.Optional("add", default=list): [str],
    vol.Optional("remove", default=list): [str],
})
@websocket_api.async_response
async def ws_bermuda_track(hass, connection, msg):
    devices = await bermuda_source.async_set_tracked_devices(hass, add=msg.get("add") or [], remove=msg.get("remove") or [])
    _bermuda_result(connection, msg, None if devices is None else {"configured_devices": devices})


@websocket_api.websocket_command({vol.Required("type"): "sextant/bermuda/findmy"})
@websocket_api.async_response
async def ws_bermuda_findmy(hass, connection, msg):
    rows = bermuda_source.async_get_findmy_accessories(hass)
    _bermuda_result(connection, msg, None if rows is None else {"accessories": rows})


@websocket_api.websocket_command({
    vol.Required("type"): "sextant/bermuda/findmy/add",
    vol.Required("accessory_json"): str,
    vol.Optional("name"): vol.Any(None, str),
})
@websocket_api.async_response
async def ws_bermuda_findmy_add(hass, connection, msg):
    try:
        added = await bermuda_source.async_add_findmy_accessory(hass, msg["accessory_json"], msg.get("name"))
    except Exception as e:  # noqa: BLE001 - FindMyKeyError carries the reason
        return _error(connection, msg, f"Invalid accessory keys: {e}")
    _bermuda_result(connection, msg, added)


@websocket_api.websocket_command({vol.Required("type"): "sextant/bermuda/findmy/remove", vol.Required("address"): str})
@websocket_api.async_response
async def ws_bermuda_findmy_remove(hass, connection, msg):
    removed = await bermuda_source.async_remove_findmy_accessory(hass, msg["address"])
    _bermuda_result(connection, msg, None if removed is None else {"removed": bool(removed)})


@websocket_api.websocket_command({vol.Required("type"): "sextant/bermuda/options"})
@websocket_api.async_response
async def ws_bermuda_options(hass, connection, msg):
    options = bermuda_source.async_get_options(hass)
    _bermuda_result(connection, msg, None if options is None else {"options": options})


@websocket_api.websocket_command({vol.Required("type"): "sextant/bermuda/options/set", vol.Required("options"): dict})
@websocket_api.async_response
async def ws_bermuda_options_set(hass, connection, msg):
    try:
        options = await bermuda_source.async_set_options(hass, dict(msg["options"]))
    except ValueError as e:
        return _error(connection, msg, e)
    _bermuda_result(connection, msg, None if options is None else {"options": options})


@websocket_api.websocket_command({vol.Required("type"): "sextant/bermuda/scanners"})
@websocket_api.async_response
async def ws_bermuda_scanners(hass, connection, msg):
    directory = bermuda_source.async_get_scanner_directory(hass)
    _bermuda_result(connection, msg, None if directory is None else {"scanners": directory}, feature="scanners")


@websocket_api.websocket_command({vol.Required("type"): "sextant/bermuda/tile_identities"})
@websocket_api.async_response
async def ws_bermuda_tile_identities(hass, connection, msg):
    """Every Tile ID Bermuda has read, with the area / loudest receiver it was last heard at."""
    ids = bermuda_source.async_get_tile_identities(hass)
    _bermuda_result(connection, msg, None if ids is None else {"identities": ids}, feature="tile_identity")


@websocket_api.websocket_command({
    vol.Required("type"): "sextant/bermuda/tile/bind",
    vol.Required("tile_id"): str,
    vol.Required("uid"): str,
})
@websocket_api.async_response
async def ws_bermuda_tile_bind(hass, connection, msg):
    """Declare which Tile ID belongs to a configured Tile (the user knows which tag is on which keys)."""
    try:
        result = await bermuda_source.async_bind_tile(hass, msg["tile_id"], msg["uid"])
    except ValueError as e:
        return _error(connection, msg, str(e))
    _bermuda_result(connection, msg, result, feature="tile_identity")


@websocket_api.websocket_command({vol.Required("type"): "sextant/bermuda/scanner_ranging", vol.Optional("max_age"): vol.Coerce(float)})
@websocket_api.async_response
async def ws_bermuda_scanner_ranging(hass, connection, msg):
    """Receiver-to-receiver ranges from Bermuda: {"scanners": {tx: {rx: {distance, age, ...}}}}.
    What the fingerprint references are built from; also how an unplaced
    receiver's position is estimated."""
    ranging = bermuda_source.async_get_scanner_ranging(hass, max_age=msg.get("max_age"))
    _bermuda_result(connection, msg, ranging, feature="scanner_ranging")


@websocket_api.websocket_command({vol.Required("type"): "sextant/bermuda/tiles"})
@websocket_api.async_response
async def ws_bermuda_tiles(hass, connection, msg):
    diag = bermuda_source.async_get_tile_diagnostics(hass)
    _bermuda_result(connection, msg, None if diag is None else {"tiles": diag}, feature="tile")


COMMANDS = (
    ws_layout_get, ws_layout_save, ws_tuning_set, ws_tracker_tune,
    ws_history_index, ws_history_get, ws_history_clear,
    ws_calibration_status, ws_calibration_action, ws_selftest, ws_scanner_linking, ws_receivers, ws_beacon_links,
    ws_adjust_zones, ws_kpi, ws_kpi_baselines, ws_kpi_baseline_save, ws_kpi_baseline_delete,
    ws_bermuda_candidates, ws_bermuda_tracked, ws_bermuda_track, ws_bermuda_findmy, ws_bermuda_findmy_add,
    ws_bermuda_findmy_remove, ws_bermuda_options, ws_bermuda_options_set, ws_bermuda_scanners, ws_bermuda_tiles,
    ws_bermuda_scanner_ranging, ws_bermuda_tile_identities, ws_bermuda_tile_bind,
)


def async_register(hass) -> None:
    for command in COMMANDS:
        websocket_api.async_register_command(hass, command)
