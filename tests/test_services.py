"""The sextant.* services (registered by _register_calibration_services) edit
the layout through the store and turn the calibration layer's refusals into
service errors."""
import asyncio
import re
import types
from pathlib import Path

import pytest

import sextant
from sextant import storage as st

from conftest import make_hass


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class _Call:
    def __init__(self, **data):
        self.data = data


def _hass(tmp_path):
    hass = make_hass(tmp_path)
    hass.data["sextant"] = {}
    hass.states = types.SimpleNamespace(async_all=lambda domain=None: [])
    recs = [{"entity_id": s, "cords": {"x": i * 300, "y": 0}} for i, s in enumerate(("r0", "r1", "r2"))]
    run(st.save_layout(hass, {"floor": [{"name": "F", "scale": 100.0, "receivers": recs, "zones": [], "subzones": []}], "tuning": {}}))
    handlers = {}
    hass.services = types.SimpleNamespace(async_register=lambda domain, name, handler, schema=None: handlers.__setitem__(name, handler))
    sextant._register_calibration_services(hass)
    return hass, handlers


def _receivers(hass):
    return {r["entity_id"]: r for r in st.get_layout(hass)["floor"][0]["receivers"]}


def test_every_documented_service_is_registered(tmp_path):
    _hass_, handlers = _hass(tmp_path)
    documented = set(re.findall(r"^([a-z_]+):", (Path(sextant.__file__).parent / "services.yaml").read_text(), re.M))
    assert set(handlers) == documented


def test_receiver_heights_are_written_with_a_default_and_range_checked(tmp_path):
    hass, h = _hass(tmp_path)
    run(h["set_receiver_heights"](_Call(heights={"r0": 1.2, "typo": 0.5}, default=0.9)))
    recs = _receivers(hass)
    assert recs["r0"]["height"] == 1.2 and recs["r1"]["height"] == 0.9 and recs["r2"]["height"] == 0.9
    with pytest.raises(Exception, match="between 0 and 10"):
        run(h["set_receiver_heights"](_Call(heights={"r0": 42})))
    assert _receivers(hass)["r0"]["height"] == 1.2


def test_tracker_heights_accumulate(tmp_path):
    hass, h = _hass(tmp_path)
    run(h["set_tracker_heights"](_Call(heights={"phone": 1.1})))
    run(h["set_tracker_heights"](_Call(heights={"watch": 0.9})))
    assert st.get_layout(hass)["tracker_heights"] == {"phone": 1.1, "watch": 0.9}


def test_tuning_is_validated_and_reset(tmp_path):
    hass, h = _hass(tmp_path)
    run(h["set_tuning"](_Call(settings={"zone_switch_secs": 45})))
    assert st.get_layout(hass)["tuning"]["zone_switch_secs"] == 45
    with pytest.raises(Exception, match="nope"):
        run(h["set_tuning"](_Call(settings={"nope": 1})))
    with pytest.raises(Exception):
        run(h["set_tuning"](_Call(settings={"zone_switch_secs": -5})))
    assert st.get_layout(hass)["tuning"]["zone_switch_secs"] == 45
    run(h["set_tuning"](_Call(reset=True)))
    assert "zone_switch_secs" not in st.get_layout(hass).get("tuning", {})  # reset drops the key entirely


def test_calibration_refusals_become_service_errors(tmp_path):
    hass, h = _hass(tmp_path)
    with pytest.raises(Exception, match="No floor named"):
        run(h["start_calibration"](_Call(floor="Nope", duration=600)))
    with pytest.raises(Exception, match="No calibration result"):
        run(h["apply_corrections"](_Call(floor="F")))
    run(h["cancel_calibration"](_Call()))  # nothing running: not an error
    assert run(h["reset_corrections"](_Call(floor="F"))) is None  # nothing to remove: not an error either
