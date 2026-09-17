"""Fingerprint positioning: receivers as free reference points (fingerprint.py)."""
import copy
import math

import sextant
from sextant import fingerprint as fp

from conftest import make_hass
from test_positioning import _Sensor, _reset_tracker_state, _square_layout, run

# Four receivers on the corners of a 10 m square, 100 px/m, all advertising.
ADDR = {"a": "aa:00:00:00:00:01", "b": "aa:00:00:00:00:02", "c": "aa:00:00:00:00:03", "d": "aa:00:00:00:00:04"}
POS = {"a": (0.0, 0.0), "b": (10.0, 0.0), "c": (10.0, 10.0), "d": (0.0, 10.0)}


def _ranging(noise=0.0):
    scanners = {}
    for tx, (tx_x, tx_y) in POS.items():
        heard = {}
        for rx, (rx_x, rx_y) in POS.items():
            if rx == tx:
                continue
            d = math.hypot(tx_x - rx_x, tx_y - rx_y) * (1.0 + noise)
            heard[ADDR[rx]] = {"distance": d * 0.9, "distance_raw": d, "rssi": -70, "age": 1.0}
        scanners[ADDR[tx]] = heard
    return {"version": 1, "stamp": 100.0, "scanners": scanners}


def _layout_with_addresses():
    layout = _square_layout({"position_estimator": "fused"})
    for i, rx in enumerate(layout["floor"][0]["receivers"]):
        rx["address"] = list(ADDR.values())[i]
    return layout


def _vector_at(x_m, y_m):
    return {ADDR[k]: max(0.3, math.hypot(px - x_m, py - y_m)) for k, (px, py) in POS.items()}


def test_reference_db_medians_raw_ranges_and_skips_stale():
    db = fp.ReferenceDB(samples=3)
    for raw in (4.0, 100.0, 4.2):
        r = _ranging()
        r["scanners"][ADDR["a"]][ADDR["b"]]["distance_raw"] = raw
        db.ingest(r)
    assert db.vectors()[ADDR["a"]][ADDR["b"]] == 4.2          # median, the outlier is gone
    stale = _ranging()
    stale["scanners"][ADDR["a"]][ADDR["b"]] = {"distance_raw": 50.0, "age": 500.0}
    db.ingest(stale)
    assert db.vectors()[ADDR["a"]][ADDR["b"]] == 4.2          # stale sample not taken
    assert db.pairs() == 12


def test_build_references_uses_placed_receivers_only_and_adds_self():
    db = fp.ReferenceDB()
    r = _ranging()
    r["scanners"][ADDR["a"]]["ff:ff:ff:ff:ff:ff"] = {"distance_raw": 1.0, "age": 0.0}  # unplaced scanner
    db.ingest(r)
    layout = _layout_with_addresses()
    layout["floor"][0]["receivers"][1]["correction"] = 2.0     # receiver b reads everything double
    refs = fp.build_references(layout, db.vectors())
    floor = refs[layout["floor"][0]["name"]]
    assert [ref["slug"] for ref in floor] == [rx["entity_id"] for rx in layout["floor"][0]["receivers"]]
    a = next(ref for ref in floor if ref["address"] == ADDR["a"])
    assert "ff:ff:ff:ff:ff:ff" not in a["vector"]
    assert a["vector"][ADDR["a"]] == fp.SELF_DISTANCE_M
    assert abs(a["vector"][ADDR["b"]] - 20.0) < 1e-9           # 10 m x correction 2
    assert abs(a["vector"][ADDR["c"]] - math.hypot(10, 10)) < 1e-9
    # Gain scales every reference range.
    refs2 = fp.build_references(layout, db.vectors(), gain=0.5)
    a2 = next(ref for ref in refs2[layout["floor"][0]["name"]] if ref["address"] == ADDR["a"])
    assert abs(a2["vector"][ADDR["c"]] - 0.5 * math.hypot(10, 10)) < 1e-9


def test_match_lands_on_the_receiver_the_tracker_stands_at():
    db = fp.ReferenceDB(); db.ingest(_ranging())
    refs = fp.build_references(_layout_with_addresses(), db.vectors())["F"]
    m = fp.match(_vector_at(0.0, 0.0), refs, k=3)
    assert m["refs"][0][0] == refs[0]["slug"]
    assert math.hypot(m["x"] - 0.0, m["y"] - 0.0) < 150            # px: within 1.5 m of receiver a
    assert m["conf"] > 0.6
    # Between a and b: the fix sits between them, nearer than any other corner.
    m = fp.match(_vector_at(5.0, 0.0), refs, k=2)
    assert 200 < m["x"] < 800 and m["y"] < 300


def test_match_uses_missing_receivers_as_evidence_and_tolerates_nothing():
    db = fp.ReferenceDB(); db.ingest(_ranging())
    refs = fp.build_references(_layout_with_addresses(), db.vectors())["F"]
    # Only receiver a hears the tracker, close: nothing else can place it.
    m = fp.match({ADDR["a"]: 1.0}, refs, k=3, missing_m=12.0)
    assert m["refs"][0][0] == refs[0]["slug"]
    assert fp.match({}, refs) is None
    assert fp.match({ADDR["a"]: 1.0}, []) is None
    assert fp.similarity({}, {}, 12.0) is None


def test_similarity_is_zero_for_identical_vectors_and_grows_with_disagreement():
    v = _vector_at(3.0, 4.0)
    assert fp.similarity(v, dict(v), 12.0) == 0.0
    off = {k: d * 2 for k, d in v.items()}
    assert abs(fp.similarity(v, off, 12.0) - math.log(2)) < 1e-9


def test_fuse_blends_fix_and_confidence_and_falls_back():
    db = fp.ReferenceDB(); db.ingest(_ranging())
    refs = fp.build_references(_layout_with_addresses(), db.vectors())["F"]
    spec = {"mode": "fused", "tracker": _vector_at(0.0, 0.0), "refs": refs,
            "k": 3, "missing_m": 12.0, "weight": 0.5, "floor_weight": 0.5}
    fix, conf, tele = sextant._fuse_fingerprint(spec, (1000.0, 1000.0), 0.2)
    assert tele["refs"] and 0 < fix[0] < 1000 and conf > 0.2
    # No geometric fix at all: the fingerprint carries the floor.
    fix2, conf2, _ = sextant._fuse_fingerprint(spec, None, None)
    assert fix2 == (tele["fix"][0], tele["fix"][1]) or math.hypot(fix2[0] - tele["fix"][0], fix2[1] - tele["fix"][1]) < 1
    assert abs(conf2 - tele["conf"]) < 1e-3
    # Fingerprint mode replaces the fit.
    spec["mode"] = "fingerprint"
    fix3, _, _ = sextant._fuse_fingerprint(spec, (1000.0, 1000.0), 0.2)
    assert abs(fix3[0] - fix2[0]) < 1e-9
    # No spec, or no match: geometric passes through untouched.
    assert sextant._fuse_fingerprint(None, (1.0, 2.0), 0.3) == ((1.0, 2.0), 0.3, None)
    spec["tracker"] = {}
    assert sextant._fuse_fingerprint(spec, (1.0, 2.0), 0.3) == ((1.0, 2.0), 0.3, None)


def test_full_cycle_fused_mode_publishes_and_places_with_one_receiver(monkeypatch):
    _reset_tracker_state()
    hass = make_hass()
    hass.data["sextant_sensors"] = {f"sensor.e_sextant_{k}": _Sensor() for k in ("zone", "nearest_zone", "floor", "sub_zone")}
    monkeypatch.setattr(sextant, "_fingerprint_db", fp.ReferenceDB())
    sextant._fingerprint_db.ingest(_ranging())
    layout = _layout_with_addresses()
    layout["tuning"]["zone_hysteresis"] = False

    def cycle(x_m, y_m, only_first=False):
        data = copy.deepcopy(layout)
        for i, rx in enumerate(data["floor"][0]["receivers"]):
            if only_first and i > 0:
                continue
            d = max(0.3, math.hypot(rx["cords"]["x"] / 100.0 - x_m, rx["cords"]["y"] / 100.0 - y_m))
            rx["distance"] = d
            rx["cords"]["r"] = d * 100.0
        run(sextant.update_trilateration_and_zone(hass, [{"entity": "e", "data": data}], "e"))
        return next(i for i in sextant.apitricords if i["ent"] == "e")

    entry = cycle(2.0, 5.0)
    assert entry["estimator"] == "fused"
    assert entry["fp"]["refs"] and entry["fp"]["conf"] > 0
    assert entry["zone"] == "Kitchen"
    # A single receiver hearing the tracker cannot be trilaterated, but the
    # fingerprint still places it (at that receiver) instead of going dark.
    _reset_tracker_state()
    hass.data["sextant_sensors"] = {f"sensor.e_sextant_{k}": _Sensor() for k in ("zone", "nearest_zone", "floor", "sub_zone")}
    entry = cycle(0.5, 0.5, only_first=True)
    assert entry["rms_m"] is None and entry["fp"]["refs"][0][0] == layout["floor"][0]["receivers"][0]["entity_id"]


def test_geometric_mode_never_touches_the_reference_db(monkeypatch):
    _reset_tracker_state()
    hass = make_hass()
    calls = []
    monkeypatch.setattr(sextant.bermuda_source, "async_get_scanner_ranging", lambda *a, **k: calls.append(1))
    sextant._refresh_fingerprint_references.last = 0.0
    sextant._refresh_fingerprint_references(hass, _square_layout(), 1e9)
    assert calls == []
    sextant._refresh_fingerprint_references(hass, _square_layout({"position_estimator": "fused"}), 2e9)
    assert calls == [1]
