"""Websocket commands behind the rebuilt panel (sextant/ws.py)."""
import asyncio
import sys
import types

import sextant
from sextant import ws
from sextant import storage as st

from conftest import make_hass


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class _Conn:
    def __init__(self):
        self.results = []
        self.errors = []

    def send_result(self, msg_id, result=None):
        self.results.append((msg_id, result))

    def send_error(self, msg_id, code, message):
        self.errors.append((msg_id, code, message))


def _hass_with_layout(tmp_path, layout=None):
    hass = make_hass(tmp_path)
    hass.states = types.SimpleNamespace(async_all=lambda domain=None: [])
    hass.data["sextant"] = {}
    if layout is not None:
        run(st.save_layout(hass, layout))
    else:
        run(st.load_layout(hass))
    return hass


def _layout():
    return {"floor": [{"name": "F", "scale": 100.0, "receivers": [{"entity_id": "r0", "cords": {"x": 0, "y": 0}}],
                       "zones": [], "subzones": []}], "tuning": {"zone_switch_secs": 30}}


def test_layout_get_reports_layout_maps_and_tuning_spec(tmp_path):
    hass = _hass_with_layout(tmp_path, _layout())
    maps = tmp_path / "www" / "sextant_maps"
    maps.mkdir(parents=True)
    (maps / "F.png").write_bytes(b"png")
    (maps / "notes.txt").write_text("x")
    conn = _Conn()
    run(ws.ws_layout_get(hass, conn, {"id": 1, "type": "sextant/layout/get"}))
    _id, result = conn.results[0]
    assert result["layout"]["floor"][0]["name"] == "F"
    assert result["maps"] == ["F.png"]
    assert result["tuning_spec"]["zone_switch_secs"]["type"] == "float"
    assert result["tuning_spec"]["position_estimator"]["choices"] == ["geometric", "fingerprint", "fused"]
    assert result["entities"] == [] and result["features"] == []


def test_layout_save_validates_then_persists(tmp_path):
    hass = _hass_with_layout(tmp_path)
    conn = _Conn()
    run(ws.ws_layout_save(hass, conn, {"id": 2, "type": "sextant/layout/save", "layout": {"floor": "nope"}}))
    assert conn.errors and "floor" in conn.errors[0][2]
    run(ws.ws_layout_save(hass, conn, {"id": 3, "type": "sextant/layout/save", "layout": _layout()}))
    assert conn.results[-1][1]["version"] >= 1
    assert st.get_layout(hass)["floor"][0]["name"] == "F"


def test_tuning_set_and_tracker_tune_write_the_layout(tmp_path):
    hass = _hass_with_layout(tmp_path, _layout())
    conn = _Conn()
    run(ws.ws_tuning_set(hass, conn, {"id": 4, "type": "sextant/tuning/set", "settings": {"position_estimator": "fused"}}))
    assert conn.results[-1][1]["tuning"] == {"zone_switch_secs": 30, "position_estimator": "fused"}
    run(ws.ws_tuning_set(hass, conn, {"id": 5, "type": "sextant/tuning/set", "settings": {"nope": 1}}))
    assert "unknown tuning key" in conn.errors[-1][2]
    run(ws.ws_tracker_tune(hass, conn, {"id": 6, "type": "sextant/tracker/tune", "entity": "fry",
                                        "ref_offset_db": 3.0, "height": 0.3, "icon": "/local/sextant_icons/cat.png"}))
    layout = st.get_layout(hass)
    assert layout["tracker_ref_offsets"] == {"fry": 3.0} and layout["tracker_heights"] == {"fry": 0.3}
    assert layout["tracker_icons"] == {"fry": "/local/sextant_icons/cat.png"}
    run(ws.ws_tracker_tune(hass, conn, {"id": 7, "type": "sextant/tracker/tune", "entity": "fry", "ref_offset_db": None, "height": None}))
    layout = st.get_layout(hass)
    assert layout["tracker_ref_offsets"] == {} and layout["tracker_heights"] == {}
    run(ws.ws_tracker_tune(hass, conn, {"id": 8, "type": "sextant/tracker/tune", "entity": "fry", "height": 9.0}))
    assert "height" in conn.errors[-1][2]


def test_bermuda_commands_pass_through_the_management_api(tmp_path, monkeypatch):
    hass = _hass_with_layout(tmp_path)
    calls = []
    api = types.ModuleType("custom_components.bermuda.api")
    api.SNAPSHOT_VERSION = 1
    api.SNAPSHOT_FEATURES = frozenset({"device_management", "tracked_devices"})
    api.async_get_advert_snapshot = lambda *a, **k: None
    api.async_get_coordinator = lambda _h: types.SimpleNamespace(tile_manager=types.SimpleNamespace(diagnostics=lambda: {"handovers": 2}))
    api.async_get_device_candidates = lambda _h, **kw: [{"address": "aa", "config_value": "AA"}]
    api.async_get_tracked_devices = lambda _h: {"aa": {"name": "A"}}

    async def set_tracked(_h, add=(), remove=()):
        calls.append(("track", list(add), list(remove)))
        return ["AA"]

    api.async_set_tracked_devices = set_tracked
    api.async_get_findmy_accessories = lambda _h: []
    api.async_get_options = lambda _h: {"ref_power": -55}

    async def set_options(_h, changes):
        if "bad" in changes:
            raise ValueError("not a managed option: bad")
        return {"ref_power": changes.get("ref_power", -55)}

    api.async_set_options = set_options
    pkg = types.ModuleType("custom_components.bermuda"); pkg.api = api
    parent = sys.modules.get("custom_components") or types.ModuleType("custom_components"); parent.bermuda = pkg
    monkeypatch.setitem(sys.modules, "custom_components", parent)
    monkeypatch.setitem(sys.modules, "custom_components.bermuda", pkg)
    monkeypatch.setitem(sys.modules, "custom_components.bermuda.api", api)

    conn = _Conn()
    run(ws.ws_bermuda_candidates(hass, conn, {"id": 1, "type": "sextant/bermuda/candidates"}))
    assert conn.results[-1][1]["candidates"][0]["config_value"] == "AA"
    run(ws.ws_bermuda_track(hass, conn, {"id": 2, "type": "sextant/bermuda/track", "add": ["aa"], "remove": []}))
    assert calls == [("track", ["aa"], [])] and conn.results[-1][1]["configured_devices"] == ["AA"]
    run(ws.ws_bermuda_options_set(hass, conn, {"id": 3, "type": "sextant/bermuda/options/set", "options": {"bad": 1}}))
    assert "managed option" in conn.errors[-1][2]
    run(ws.ws_bermuda_tiles(hass, conn, {"id": 4, "type": "sextant/bermuda/tiles"}))
    assert conn.results[-1][1]["tiles"] == {"handovers": 2}


def test_bermuda_commands_explain_a_missing_api(tmp_path, monkeypatch):
    hass = _hass_with_layout(tmp_path)
    monkeypatch.setitem(sys.modules, "custom_components.bermuda.api", None)
    conn = _Conn()
    run(ws.ws_bermuda_candidates(hass, conn, {"id": 1, "type": "sextant/bermuda/candidates"}))
    assert "update Bermuda" in conn.errors[-1][2]


def test_kpi_metrics_match_the_command_line_tool():
    from sextant import kpi
    sys.path.insert(0, "tools")
    import flap_kpi
    rows = [{"state": s, "last_changed": f"2026-09-17T05:{m:02d}:00+00:00"}
            for m, s in enumerate(["Kitchen", "Kitchen", "Office", "Kitchen", "unknown", "Office"])]
    assert kpi.compute_metrics(rows, 1.0) == flap_kpi.compute_metrics(rows, 1.0)
    per = {"sensor.a_sextant_zone": kpi.compute_metrics(rows, 1.0)}
    assert kpi.summarise(per) == flap_kpi.summarise(per)
    # Recorder rows come as objects or minimal dicts; both feed the metrics.
    from datetime import datetime, timezone
    objs = [types.SimpleNamespace(state="A", last_changed=datetime(2026, 9, 17, tzinfo=timezone.utc)), {"state": "B", "last_changed": "2026-09-17T00:10:00+00:00"}]
    assert kpi.compute_metrics(kpi.rows_from_recorder(objs), 1.0)["changes"] == 1
