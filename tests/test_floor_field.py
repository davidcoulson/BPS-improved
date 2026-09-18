"""The bias field on its own: sampling, laying, painting, and refusing junk."""
import math

import pytest

from sextant import floor_field as ff


def _floor(values, cell_m=1.0, scale=100.0, x0=0.0, y0=0.0):
    return {"name": "F", "scale": scale, "bias_field": {"cell_m": cell_m, "x0": x0, "y0": y0, "values": values}}


def test_no_field_and_a_flat_field_are_both_exactly_neutral():
    assert ff.sample({"name": "F", "scale": 100.0}, (10, 10)) == 1.0
    flat = {"name": "F", "scale": 100.0}
    flat["bias_field"] = ff.flat((0, 0, 1000, 700), 100.0)
    for pt in ((0, 0), (-500, -500), (333.3, 471.9), (999, 699), (5000, 5000)):
        assert ff.sample(flat, pt) == 1.0  # ==, not approx: the no-op must be bit-exact


def test_sampling_is_bilinear_between_cell_centres_and_holds_at_the_edges():
    floor = _floor([[1.0, 2.0], [3.0, 4.0]])
    assert ff.sample(floor, (50, 50)) == 1.0 and ff.sample(floor, (150, 150)) == 4.0
    assert ff.sample(floor, (100, 50)) == pytest.approx(1.5)
    assert ff.sample(floor, (100, 100)) == pytest.approx(2.5)
    assert ff.sample(floor, (-999, -999)) == 1.0 and ff.sample(floor, (999, 999)) == 4.0


def test_sampling_is_continuous_across_a_cell_boundary():
    floor = _floor([[1.0, 3.0]])
    left, right = ff.sample(floor, (99.999, 50)), ff.sample(floor, (100.001, 50))
    assert abs(left - right) < 1e-3


def test_the_grid_is_in_metres_so_it_means_the_same_at_any_plan_resolution():
    coarse = _floor([[1.0, 2.0]], scale=50.0)
    fine = _floor([[1.0, 2.0]], scale=200.0)
    # 1.0 m from the grid's left edge: the boundary between the two cells.
    assert ff.sample(coarse, (50, 25)) == pytest.approx(ff.sample(fine, (200, 100)))


@pytest.mark.parametrize("broken", [
    {"cell_m": 1.0, "x0": 0, "y0": 0, "values": [[1, 2], [3]]},          # ragged
    {"cell_m": 0, "x0": 0, "y0": 0, "values": [[1]]},                     # nonsense cell
    {"cell_m": 1.0, "x0": float("nan"), "y0": 0, "values": [[1]]},
    {"cell_m": 1.0, "x0": 0, "y0": 0, "values": []},
    {"cell_m": 1.0, "x0": 0, "y0": 0, "values": "1,2,3"},
    "not a dict",
])
def test_a_broken_field_behaves_exactly_like_no_field(broken):
    floor = {"name": "F", "scale": 100.0, "bias_field": broken}
    assert ff.parse(floor) is None and ff.sample(floor, (10, 10)) == 1.0


def test_junk_cells_read_as_neutral_and_values_are_clamped():
    floor = _floor([[None, "x", float("inf"), -2, 0, True, 1e9, 1e-9]])
    got = [ff.sample(floor, (c * 100 + 50, 50)) for c in range(8)]
    assert got == [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, ff.FIELD_MAX, ff.FIELD_MIN]


def test_a_floor_without_a_scale_cannot_carry_a_field():
    floor = _floor([[2.0]])
    floor["scale"] = None
    assert ff.sample(floor, (10, 10)) == 1.0
    with pytest.raises(ValueError, match="no scale"):
        ff.flat((0, 0, 100, 100), None)


def test_flat_covers_the_bounds_and_refuses_an_absurd_grid():
    field = ff.flat((100, 50, 1130, 760), 100.0, cell_m=1.0)
    assert (field["x0"], field["y0"]) == (100, 50)
    assert len(field["values"]) == 8 and len(field["values"][0]) == 11  # ceil(7.1), ceil(10.3)
    with pytest.raises(ValueError, match="larger cell_m"):
        ff.flat((0, 0, 100000, 100), 100.0, cell_m=0.25)
    with pytest.raises(ValueError, match="no extent"):
        ff.flat((5, 5, 5, 5), 100.0)


def test_paint_takes_cells_by_their_centres_and_reports_a_miss_honestly():
    floor = {"name": "F", "scale": 100.0}
    floor["bias_field"] = ff.flat((0, 0, 400, 300), 100.0)
    # An L-shaped (concave) room: the ray cast must not fill its notch.
    ell = [(0, 0), (400, 0), (400, 100), (100, 100), (100, 300), (0, 300)]
    assert ff.paint(floor, ell, 2.0) == 6
    assert ff.sample(floor, (350, 50)) == 2.0 and ff.sample(floor, (50, 250)) == 2.0
    assert ff.sample(floor, (350, 250)) == 1.0  # the notch
    # Smaller than a cell and between centres: nothing painted, and it says so.
    assert ff.paint(floor, [(90, 90), (110, 90), (110, 110), (90, 110)], 5.0) == 0
    with pytest.raises(ValueError, match="three points"):
        ff.paint(floor, [(0, 0), (1, 1)], 2.0)
    with pytest.raises(ValueError, match="positive"):
        ff.paint(floor, ell, 0)


def test_describe_tells_flat_from_shaped():
    floor = {"name": "F", "scale": 100.0}
    assert ff.describe(floor) is None
    floor["bias_field"] = ff.flat((0, 0, 300, 200), 100.0)
    assert ff.describe(floor)["flat"] is True
    ff.paint(floor, [(0, 0), (100, 0), (100, 100), (0, 100)], 1.5)
    d = ff.describe(floor)
    assert d["flat"] is False and d["shaped_cells"] == 1 and d["max"] == 1.5 and math.isclose(d["min"], 1.0)
