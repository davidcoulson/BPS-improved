"""Calibration corrections written into Bermuda as rssi offsets
(tuning calibration_target = "bermuda"), and the reset path back."""

import asyncio
import math

import bps
from bps import bermuda_source
from bps import calibration as cal_mod
from bps import storage as st
from conftest import make_hass


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _layout(target="bermuda", corrections=None):
    recs = [{"entity_id": "kitchen_rrn00_aaaa01", "cords": {"x": 0, "y": 0}},
            {"entity_id": "office_rrn00_aaaa02", "cords": {"x": 500, "y": 0}},
            {"entity_id": "unlinked_rrn00_ffff00", "cords": {"x": 0, "y": 500}}]
    for r in recs:
        if corrections and r["entity_id"] in corrections:
            r["correction"] = corrections[r["entity_id"]]
    return {"floor": [{"name": "F", "scale": 100.0, "receivers": recs, "zones": [], "subzones": []}],
            "tuning": {"calibration_target": target}}


class _FakeBermuda:
    """Stands in for bermuda_source's offset/scanner helpers."""

    def __init__(self, offsets=None, attenuation=3.0, supported=True):
        self.offsets = dict(offsets or {})
        self.attenuation = attenuation
        self.supported = supported
        self.writes = []

    def install(self, monkeypatch):
        monkeypatch.setattr(bermuda_source, "async_get_rssi_offsets",
                            lambda hass: {"offsets": dict(self.offsets), "attenuation": self.attenuation, "ref_power": -55.0} if self.supported else None)
        monkeypatch.setattr(bermuda_source, "async_get_scanner_addresses_by_slug",
                            lambda hass: {"kitchen_rrn00_aaaa01": "aa:aa:aa:aa:aa:01", "office_rrn00_aaaa02": "aa:aa:aa:aa:aa:02"} if self.supported else None)

        def _set(hass, updates):
            self.writes.append(dict(updates))
            self.offsets.update({k.lower(): v for k, v in updates.items()})
            return dict(self.offsets)
        monkeypatch.setattr(bermuda_source, "async_set_rssi_offsets", _set)
        return self


def _result(corrections):
    return {"floor": "F", "receivers": corrections, "pairs_used": 9,
            "error_factor_before": 1.4, "error_factor_after": 1.1}


def test_target_bermuda_writes_offsets_and_clears_multipliers(monkeypatch, tmp_path):
    hass = make_hass(tmp_path)
    run(st.save_bps_data(hass, _layout(corrections={"kitchen_rrn00_aaaa01": 0.9})))
    fake = _FakeBermuda(offsets={"aa:aa:aa:aa:aa:01": 1.0}).install(monkeypatch)
    cal = cal_mod.get_calibration_state(hass)
    cal["results"]["F"] = _result({"kitchen_rrn00_aaaa01": 0.5, "office_rrn00_aaaa02": 2.0,
                                   "unlinked_rrn00_ffff00": 0.7})

    updated = run(cal_mod.apply_corrections(hass, cal, "F"))

    # c=0.5 -> -30*log10(0.5) = +9.03 dB added to the existing 1.0; c=2.0 -> -9.03 from 0.
    assert updated == 2
    assert fake.writes == [{"aa:aa:aa:aa:aa:01": round(1.0 - 30 * math.log10(0.5), 1),
                            "aa:aa:aa:aa:aa:02": round(-30 * math.log10(2.0), 1)}]
    saved = st.get_bps_data(hass)
    floor = saved["floor"][0]
    # No multiplier survives in the layout (it would apply twice), the
    # unlinked receiver is simply skipped, and Bermuda's prior values are kept.
    assert all("correction" not in r for r in floor["receivers"])
    assert floor["calibration"]["target"] == "bermuda"
    assert saved["bermuda_offset_base"] == {"aa:aa:aa:aa:aa:01": 1.0, "aa:aa:aa:aa:aa:02": 0.0}
    assert cal["applied"]["F"]["kitchen_rrn00_aaaa01"] == 0.5


def test_target_bermuda_accumulates_and_ignores_tiny_residuals(monkeypatch, tmp_path):
    hass = make_hass(tmp_path)
    run(st.save_bps_data(hass, _layout()))
    fake = _FakeBermuda(offsets={"aa:aa:aa:aa:aa:01": 9.0}).install(monkeypatch)
    cal = cal_mod.get_calibration_state(hass)
    # The next solve sees samples that already carry +9 dB, so it fits a
    # residual: 0.8 adds 2.9 dB on top; a 1.01 residual (0.13 dB) is noise.
    cal["results"]["F"] = _result({"kitchen_rrn00_aaaa01": 0.8, "office_rrn00_aaaa02": 1.01})
    run(cal_mod.apply_corrections(hass, cal, "F"))
    assert fake.writes == [{"aa:aa:aa:aa:aa:01": round(9.0 - 30 * math.log10(0.8), 1)}]
    # The base only records a scanner the first time BPS touches it.
    assert st.get_bps_data(hass)["bermuda_offset_base"] == {"aa:aa:aa:aa:aa:01": 9.0}


def test_target_bermuda_refuses_without_the_api(monkeypatch, tmp_path):
    import pytest

    hass = make_hass(tmp_path)
    run(st.save_bps_data(hass, _layout()))
    _FakeBermuda(supported=False).install(monkeypatch)
    cal = cal_mod.get_calibration_state(hass)
    cal["results"]["F"] = _result({"kitchen_rrn00_aaaa01": 0.5})
    with pytest.raises(ValueError, match="rssi_offsets API"):
        run(cal_mod.apply_corrections(hass, cal, "F"))
    # Nothing was written and the layout is untouched.
    assert "calibration" not in st.get_bps_data(hass)["floor"][0]


def test_target_bps_is_unchanged_and_the_default(monkeypatch, tmp_path):
    hass = make_hass(tmp_path)
    layout = _layout(target="bps"); layout.pop("tuning")
    run(st.save_bps_data(hass, layout))
    fake = _FakeBermuda().install(monkeypatch)
    cal = cal_mod.get_calibration_state(hass)
    cal["results"]["F"] = _result({"kitchen_rrn00_aaaa01": 0.5, "office_rrn00_aaaa02": 2.0})
    assert run(cal_mod.apply_corrections(hass, cal, "F")) == 2
    floor = st.get_bps_data(hass)["floor"][0]
    assert floor["receivers"][0]["correction"] == 0.5 and floor["receivers"][1]["correction"] == 2.0
    assert floor["calibration"]["target"] == "bps"
    assert fake.writes == []


def test_reset_restores_bermudas_prior_offsets(monkeypatch, tmp_path):
    hass = make_hass(tmp_path)
    run(st.save_bps_data(hass, _layout()))
    fake = _FakeBermuda(offsets={"aa:aa:aa:aa:aa:01": 1.0}).install(monkeypatch)
    cal = cal_mod.get_calibration_state(hass)
    cal["results"]["F"] = _result({"kitchen_rrn00_aaaa01": 0.5, "office_rrn00_aaaa02": 2.0})
    run(cal_mod.apply_corrections(hass, cal, "F"))

    removed = run(cal_mod.reset_corrections(hass, cal, "F"))

    assert removed == 2
    assert fake.writes[-1] == {"aa:aa:aa:aa:aa:01": 1.0, "aa:aa:aa:aa:aa:02": 0.0}
    saved = st.get_bps_data(hass)
    assert "bermuda_offset_base" not in saved
    assert "calibration" not in saved["floor"][0]
    assert "F" not in cal["applied"]


def test_calibration_target_tuning_is_validated():
    assert bps._tuning({"tuning": {"calibration_target": "bermuda"}}, "calibration_target") == "bermuda"
    assert bps._tuning({"tuning": {"calibration_target": "mars"}}, "calibration_target") == "bps"
    assert cal_mod._calibration_target({"tuning": {"calibration_target": "bermuda"}}) == "bermuda"
    assert cal_mod._calibration_target({}) == "bps"
    assert cal_mod._calibration_target("junk") == "bps"
