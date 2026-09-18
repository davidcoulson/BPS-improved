"""Stacking floors from shared pins: the fit, its audit of the scale, and its refusals."""
import math

import pytest

from sextant import registration as reg

# A 12 m x 9 m house. Corner names are the pins.
HOUSE = {"NW": (0.0, 0.0), "NE": (12.0, 0.0), "SE": (12.0, 9.0), "SW": (0.0, 9.0), "Stair": (5.0, 4.0)}


def _floor(name, level, scale, *, shift=(0.0, 0.0), turn_deg=0.0, pins=HOUSE, drawn_scale=None, **extra):
    """A plan of the house drawn at `scale` px/m, cropped by `shift` px and
    rotated by `turn_deg`. `drawn_scale` is what the user *believes* the scale
    to be, when that differs from the truth."""
    t = math.radians(turn_deg)
    out = []
    for pin, (hx, hy) in pins.items():
        x = (math.cos(t) * hx - math.sin(t) * hy) * scale + shift[0]
        y = (math.sin(t) * hx + math.cos(t) * hy) * scale + shift[1]
        out.append({"pin_id": f"{name}-{pin}", "name": pin, "cords": {"x": x, "y": y}})
    return {"name": name, "level": level, "scale": drawn_scale or scale, "pins": out, **extra}


def test_floors_at_different_scales_and_crops_land_in_one_frame():
    layout = {"floor": [
        _floor("Ground", 0, 102.0, shift=(340, 210)),
        _floor("Second", 1, 127.8, shift=(95, 60)),
        _floor("Basement", -1, 104.9, shift=(40, 400), turn_deg=90),
    ]}
    solved = reg.solve(layout)
    assert solved["reference"] == "Ground"
    for name in ("Second", "Basement"):
        frame = solved["floors"][name]
        assert frame["ok"] and frame["shared"] == 5 and frame["rms_m"] < 1e-9
    # The same physical spot, 3 m east and 2 m south of the NW corner, drawn on
    # each plan, must come out as one house position.
    spots = []
    for f, turn in zip(layout["floor"], (0, 0, 90)):
        t = math.radians(turn)
        shift = {"Ground": (340, 210), "Second": (95, 60), "Basement": (40, 400)}[f["name"]]
        x = (math.cos(t) * 3 - math.sin(t) * 2) * f["scale"] + shift[0]
        y = (math.sin(t) * 3 + math.cos(t) * 2) * f["scale"] + shift[1]
        spots.append(reg.to_house(solved["floors"][f["name"]], x, y))
    for hx, hy in spots[1:]:
        assert hx == pytest.approx(spots[0][0], abs=1e-6) and hy == pytest.approx(spots[0][1], abs=1e-6)
    assert math.degrees(solved["floors"]["Basement"]["theta"]) == pytest.approx(-90, abs=1e-6)


def test_round_trip_through_the_house_frame():
    layout = {"floor": [_floor("Ground", 0, 100.0), _floor("Second", 1, 130.0, shift=(77, -12), turn_deg=7)]}
    frame = reg.solve(layout)["floors"]["Second"]
    hx, hy = reg.to_house(frame, 640.0, 410.0)
    back = reg.from_house(frame, hx, hy)
    assert back == pytest.approx((640.0, 410.0), abs=1e-6)


def test_a_wrong_scale_is_reported_not_absorbed():
    """Second is really drawn at 130 px/m but the user measured 126. A
    similarity fit would hide that; the rigid fit must leave it visible, both
    as misses that grow away from the centre and as the scale the pins imply."""
    layout = {"floor": [_floor("Ground", 0, 100.0), _floor("Second", 1, 130.0, drawn_scale=126.0)]}
    frame = reg.solve(layout)["floors"]["Second"]
    assert frame["implied_scale"] == pytest.approx(130.0, rel=1e-6)
    assert 0.1 < frame["rms_m"] < 0.4 and frame["ok"]      # visibly off, still usable
    assert frame["misses"]["Stair"] < frame["misses"]["SE"]  # worst at the far corners


def test_one_bad_pin_is_named():
    layout = {"floor": [_floor("Ground", 0, 100.0), _floor("Second", 1, 100.0)]}
    next(p for p in layout["floor"][1]["pins"] if p["name"] == "NE")["cords"]["x"] += 120   # 1.2 m off
    frame = reg.solve(layout)["floors"]["Second"]
    assert frame["worst"] == "NE" and frame["max_m"] > 2 * sorted(frame["misses"].values())[-2]


def test_a_floor_is_reached_through_another_floor():
    """The attic shares no pin with the ground floor, only with the second."""
    second_only = {"Chimney": (8.0, 3.0), "Hatch": (2.0, 7.0)}
    second = _floor("Second", 1, 120.0, shift=(30, 30), pins={**HOUSE, **second_only})
    attic = _floor("Attic", 2, 90.0, shift=(500, 10), pins=second_only)
    solved = reg.solve({"floor": [_floor("Ground", 0, 100.0), attic, second]})
    assert solved["floors"]["Attic"]["ok"] and solved["floors"]["Attic"]["rms_m"] < 1e-9
    x, y = 8.0 * 90.0 + 500, 3.0 * 90.0 + 10
    assert reg.to_house(solved["floors"]["Attic"], x, y) == pytest.approx((8.0, 3.0), abs=1e-6)


def test_floors_that_cannot_be_registered_say_why():
    layout = {"floor": [
        _floor("Ground", 0, 100.0),
        _floor("Loft", 2, 100.0, pins={"NW": HOUSE["NW"]}),
        {"name": "Shed", "level": 0, "scale": 100.0},
        {**_floor("Cellar", -1, 100.0), "scale": None},
    ]}
    rep = reg.report(layout)
    assert rep["floors"]["Loft"]["ok"] is False and "shares 1 pin" in rep["floors"]["Loft"]["why"]
    assert rep["floors"]["Shed"]["why"] == "no pins" and rep["floors"]["Cellar"]["why"] == "no scale"
    assert reg.to_house(reg.solve(layout)["floors"]["Loft"], 1, 1) is None


def test_pins_bunched_together_do_not_count_as_a_registration():
    close = {"A": (5.0, 5.0), "B": (5.3, 5.1)}
    layout = {"floor": [_floor("Ground", 0, 100.0, pins={**HOUSE, **close}), _floor("Second", 1, 100.0, pins=close)]}
    frame = reg.solve(layout)["floors"]["Second"]
    assert frame["ok"] is False and frame["implied_scale"] is None


def test_unlinked_pins_and_no_pins_at_all():
    layout = {"floor": [_floor("Ground", 0, 100.0, pins={**HOUSE, "Porch": (6.0, -2.0)}), _floor("Second", 1, 100.0)]}
    assert reg.report(layout)["unlinked"] == ["Porch"]
    empty = reg.report({"floor": [{"name": "Ground", "scale": 100.0}]})
    assert empty["reference"] is None and empty["floors"] == {} and empty["pins"] == {}
    assert reg.report({}) == {"reference": None, "floors": {}, "pins": {}, "unlinked": []}


def test_junk_pins_are_skipped_and_the_first_of_a_name_wins():
    floor = {"name": "G", "scale": 100.0, "pins": [
        {"name": "NW", "cords": {"x": 100, "y": 200}}, {"name": "NW", "cords": {"x": 999, "y": 999}},
        {"name": "", "cords": {"x": 1, "y": 1}}, {"name": "Bad", "cords": {"x": float("nan"), "y": 1}},
        "nonsense", {"name": "NoCords"},
    ]}
    assert reg.floor_pins(floor) == {"NW": (1.0, 2.0)}


def test_elevation_is_explicit_or_a_storey_per_level():
    assert reg.elevation({"level": 1}) == 3.0 and reg.elevation({"level": -1}) == -3.0
    assert reg.elevation({"level": 1, "elevation": 3.66}) == 3.66
    assert reg.elevation({"level": 1, "elevation": "tall"}) == 3.0 and reg.elevation({}) == 0.0
