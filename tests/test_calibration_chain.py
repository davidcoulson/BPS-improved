"""Calibration end to end (sextant.calibration): a Bermuda dump is ingested,
scanners are matched to placed receivers, the floor is solved, the corrections
are applied to the layout and reset again.

The synthetic house has five proxies on a 10 m square with one (r2) reading
30 % long; every proxy hears every other's beacon in every dump.
"""
import asyncio
import math
import random
import types

import pytest

import sextant  # noqa: F401
from sextant import calibration as cal_mod
from sextant import storage as st

from conftest import make_hass


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


ADDR = {f"r{i}": f"aa:aa:aa:aa:aa:{i:02x}" for i in range(5)}
POS = {"r0": (1, 1), "r1": (9, 1), "r2": (9, 9), "r3": (1, 9), "r4": (5, 5)}  # metres


def _layout():
    recs = [{"entity_id": s, "address": ADDR[s], "cords": {"x": x * 100, "y": y * 100}} for s, (x, y) in POS.items()]
    return {"floor": [{"name": "F", "scale": 100.0, "receivers": recs, "zones": [], "subzones": []}], "tuning": {}}


def _hass(tmp_path):
    hass = make_hass(tmp_path)
    hass.data["sextant"] = {}
    hass.states = types.SimpleNamespace(async_all=lambda domain=None: [])
    run(st.save_layout(hass, _layout()))
    return hass


def _prepared(hass):
    cal = cal_mod.get_calibration_state(hass)
    coords = st.get_layout(hass)
    cal["receivers"] = cal_mod._build_receiver_map(coords, "F")
    cal["all_placed_slugs"] = cal_mod._all_placed_slugs(coords)
    return cal


def _dump(bias, rng, stamp):
    """A bermuda.dump_devices payload: each scanner advertises its beacon and
    the other scanners' readings of it live on its own device."""
    devices = {}
    for tx, a in ADDR.items():
        adverts = {}
        for rx, b in ADDR.items():
            if rx == tx:
                continue
            true = math.hypot(POS[tx][0] - POS[rx][0], POS[tx][1] - POS[rx][1])
            adverts[b] = {"scanner_address": b, "stamp": stamp, "rssi_distance_raw": true * bias[rx] * rng.uniform(0.95, 1.05)}
        devices[a] = {"_is_scanner": True, "name": f"Proxy {tx}", "address": a, "adverts": adverts}
    return devices


def test_ingest_solve_apply_reset_round_trip(tmp_path):
    hass = _hass(tmp_path)
    cal = _prepared(hass)
    rng = random.Random(3)
    bias = {s: 1.0 for s in ADDR}
    bias["r2"] = 1.3
    for k in range(12):
        cal_mod._ingest_dump(cal, _dump(bias, rng, stamp=1000.0 + k))
    assert len(cal["samples"]) == 20 and all(len(v) == 12 for v in cal["samples"].values())
    assert set(cal["matched_placed"]) == set(ADDR)  # every placement matched by its address

    result = cal_mod.solve(cal_mod.solve_snapshot(cal), "F")
    assert result["floor"] == "F" and result["pairs_used"] == 20
    assert result["receivers"]["r2"] < 0.9
    honest = [result["receivers"][s] for s in ADDR if s != "r2"]
    assert max(honest) - min(honest) < 0.1
    assert result["error_factor_after"] < result["error_factor_before"]

    cal["results"]["F"] = result
    assert run(cal_mod.apply_corrections(hass, cal, "F")) == 5
    stored = {r["entity_id"]: r.get("correction") for r in st.get_layout(hass)["floor"][0]["receivers"]}
    assert stored["r2"] < 0.9 and all(v is not None for v in stored.values())
    assert cal["applied"]["F"] == result["receivers"]

    assert run(cal_mod.reset_corrections(hass, cal, "F")) == 5
    assert all("correction" not in r for r in st.get_layout(hass)["floor"][0]["receivers"])
    assert "F" not in cal["applied"]


def test_solve_refuses_too_little_data_and_apply_refuses_without_a_result(tmp_path):
    hass = _hass(tmp_path)
    cal = _prepared(hass)
    cal_mod._ingest_dump(cal, _dump({s: 1.0 for s in ADDR}, random.Random(1), 1000.0))  # one sample per pair
    with pytest.raises(ValueError):
        cal_mod.solve(cal_mod.solve_snapshot(cal), "F")
    with pytest.raises(ValueError, match="No calibration result"):
        run(cal_mod.apply_corrections(hass, cal, "F"))


def test_stale_adverts_strangers_and_self_readings_are_ignored(tmp_path):
    hass = _hass(tmp_path)
    cal = _prepared(hass)
    dump = _dump({s: 1.0 for s in ADDR}, random.Random(2), 1000.0)
    dump[ADDR["r0"]]["adverts"][ADDR["r1"]]["stamp"] = 900.0  # 100 s older than the newest advert
    dump[ADDR["r0"]]["adverts"][ADDR["r0"]] = {"scanner_address": ADDR["r0"], "stamp": 1000.0, "rssi_distance_raw": 0.4}
    dump["ff:ff:ff:ff:ff:ff"] = {"_is_scanner": True, "name": "Stranger", "address": "ff:ff:ff:ff:ff:ff",
                                 "adverts": {ADDR["r0"]: {"scanner_address": ADDR["r0"], "stamp": 1000.0, "rssi_distance_raw": 3.0}}}
    cal_mod._ingest_dump(cal, dump)
    assert "r0|r1" not in cal["samples"] and "r1|r0" in cal["samples"]
    assert not any("r0|r0" in k or "stranger" in k.lower() for k in cal["samples"])
    assert len(cal["samples"]) == 19


def test_scanner_matching_by_address_then_name_then_mac_tail():
    def rec(address=None):
        return {"address": address, "x": 0.0, "y": 0.0, "scale": 100.0, "floor": "F", "uid": None, "height": None}

    cal = {"receivers": {"office": rec("bb:bb:bb:bb:bb:02"), "kitchen_rrn00_aaaa01": rec(), "hall_rrn00_cccc10": rec()},
           "all_placed_slugs": {"office", "kitchen_rrn00_aaaa01", "hall_rrn00_cccc10"}}
    devices = {
        # Tier 0: the placement carries the scanner's address; the name is irrelevant.
        "bb:bb:bb:bb:bb:02": {"_is_scanner": True, "name": "Whatever", "address": "BB:BB:BB:BB:BB:02"},
        # Tier 1: the device name (slugified) is the placed slug.
        "aa:aa:aa:aa:aa:01": {"_is_scanner": True, "name": "kitchen_rrn00_aaaa01", "address": "aa:aa:aa:aa:aa:01"},
        # Tier 2: renamed, but its Bluetooth MAC sits within +3 of the slug's hex tail.
        "cc:cc:cc:cc:cc:12": {"_is_scanner": True, "name": "Renamed Hall", "address": "cc:cc:cc:cc:cc:12"},
        # Not a scanner at all.
        "dd:dd:dd:dd:dd:dd": {"_is_scanner": False, "name": "hall_rrn00_cccc10", "address": "dd:dd:dd:dd:dd:dd"},
    }
    matched = cal_mod._match_scanners(cal, devices)
    assert matched == {"bb:bb:bb:bb:bb:02": "office", "aa:aa:aa:aa:aa:01": "kitchen_rrn00_aaaa01", "cc:cc:cc:cc:cc:12": "hall_rrn00_cccc10"}
    assert set(cal["matched_placed"]) == {"office", "kitchen_rrn00_aaaa01", "hall_rrn00_cccc10"}


def test_ambiguous_mac_tail_matches_nothing():
    cal = {"receivers": {"hall_rrn00_cccc10": {"address": None, "x": 0.0, "y": 0.0, "scale": 100.0, "floor": "F", "uid": None, "height": None}},
           "all_placed_slugs": {"hall_rrn00_cccc10"}}
    devices = {a: {"_is_scanner": True, "name": "Proxy", "address": a} for a in ("cc:cc:cc:cc:cc:11", "cc:cc:cc:cc:cc:12")}
    assert cal_mod._match_scanners(cal, devices) == {}


def test_true_distance_is_3d_only_when_both_heights_are_known():
    cal = {"receivers": {
        "a": {"x": 0.0, "y": 0.0, "scale": 100.0, "floor": "F", "height": 0.3},
        "b": {"x": 300.0, "y": 0.0, "scale": 100.0, "floor": "F", "height": 2.2},
        "c": {"x": 300.0, "y": 0.0, "scale": 100.0, "floor": "F", "height": None},
        "d": {"x": 300.0, "y": 0.0, "scale": 100.0, "floor": "Other", "height": 2.2},
    }}
    assert cal_mod._true_distance_m(cal, "a", "b") == pytest.approx(math.hypot(3.0, 1.9))
    assert cal_mod._true_distance_m(cal, "a", "c") == pytest.approx(3.0)
    assert cal_mod._true_distance_m(cal, "a", "d") is None


def test_status_payload_reports_the_window_start_for_the_panel(tmp_path):
    hass = _hass(tmp_path)
    cal = cal_mod.get_calibration_state(hass)
    cal.update({"state": "sampling", "mode": "auto", "started_at": 1234.5})
    payload = cal_mod._status_payload(cal)
    assert payload["started_at"] == 1234.5 and payload["first_solve_after"] == cal_mod.AUTO_MIN_WINDOW
    assert payload["mode"] == "auto" and "seconds_left" not in payload  # only a manual run has an end


def test_auto_apply_rewrites_corrections_the_layout_lost(tmp_path):
    """cal["applied"] remembers what auto calibration wrote; if a Save from the
    editor removed them from the layout, the next auto solve must write them
    again instead of concluding that nothing moved."""
    hass = _hass(tmp_path)
    hass.async_create_task = lambda coro: coro.close()
    cal = _prepared(hass)
    rng = random.Random(5)
    bias = {s: 1.0 for s in ADDR}
    bias["r2"] = 1.3
    for k in range(12):
        cal_mod._ingest_dump(cal, _dump(bias, rng, stamp=1000.0 + k))
    run(cal_mod._auto_solve_and_apply_locked(hass, cal))
    first = {r["entity_id"]: r["correction"] for r in st.get_layout(hass)["floor"][0]["receivers"]}
    assert first["r2"] < 0.9 and cal["applied"]["F"] == cal["results"]["F"]["receivers"]
    # An older copy of the layout is saved over it: corrections gone, "applied" still remembers them.
    lost = st.get_layout(hass)
    for r in lost["floor"][0]["receivers"]:
        r.pop("correction", None)
    run(st.save_layout(hass, lost))
    run(cal_mod._auto_solve_and_apply_locked(hass, cal))
    again = {r["entity_id"]: r.get("correction") for r in st.get_layout(hass)["floor"][0]["receivers"]}
    assert again["r2"] is not None and abs(again["r2"] - first["r2"]) < 0.05
