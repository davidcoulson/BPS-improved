[Sextant](../README.md) › Data and development

# Data and development

## Where the data lives

| What | Where |
|---|---|
| Layout: floors, rooms, spots, proxies, heights, corrections, tuning, thing names and classes | `config/.storage/sextant` |
| Calibration solves and the rolling sample window | `config/.storage/sextant_calibration_state` |
| Stability baselines | `config/.storage/sextant_kpi_baselines` |
| Truth marks with their samples | `config/.storage/sextant_truth` |
| Learned fingerprint gains, saved every five minutes so a restart starts warm | `config/.storage/sextant_fingerprint_gains` |
| Position history, one NDJSON segment per day, pruned to the retention | `config/.storage/sextant_history/` |
| Floor-plan images, served only to a signed-in user via `/api/sextant/map/<file>` | `config/sextant_maps/` |

Nothing under `.storage` is served over HTTP. Edit the layout from the
panel or the services, not the file: a hand edit under a running Home
Assistant is lost on the next save.

## The test bed

Every release runs in the author's house before it ships, which is where most
of the odd cases in this codebase came from. It is three floors: 21 rooms and
12 spots over a Ground Floor, a Second Floor and a Basement, with 58 placed
proxies, a mix of ESPHome and Shelly.

What is tracked is mostly animals, and they are the hard case. A phone sits
on a table at chest height and stays there; a cat sleeps in a cardboard box
under a sideboard, moves three metres in a second, and spends the evening on
a landing that is open to the room below. The pets:

| Name | | Wears |
|---|---|---|
| Meg | he/him, short for Megatron | iBeacon tag |
| Socks | he/him | iBeacon tag |
| Fry | he/him | iBeacon tag |
| Leela | she/her | iBeacon tag |
| Lilibet | she/her | iBeacon tag |
| Willow | she/her | iBeacon tag |
| Primrose | she/her, the dog | iBeacon tag |

**They all wear iBeacons.** The single tracked Tile in the layout is there to
exercise the rotation-following code and is not on an animal, so a change that
only works for Tiles has not been tested on anything that moves like a cat.

The phones and watches come in as Private BLE Devices by their Identity
Resolving Key, and the Find My accessories (two AirTags, a wallet tag and
several AirPods) by their pairing keys. Between them that covers every
identity family Bermuda can follow, which is why the house catches problems
a synthetic fixture does not: a spot that never matches because the floor
above it wins, a key schedule that drifts months behind wall-clock, a room
lock that will not release.

## Development

```bash
pip install -r requirements_test.txt
pytest tests
```

- `tools/flap_kpi.py` computes the stability KPI from the recorder from a
  shell (`--hours 12 --json before.json`, later `--baseline before.json`).
- `tools/sextant_eval.py` replays a layout against recorded readings;
  `tools/solver_bench.py` benchmarks the numpy solver against SciPy.
- `tools/brand/` builds the logo from the same compass rose the sidebar uses.
- The panel is plain Lit modules under `custom_components/sextant/frontend/`
  with no build step. The backend registers the panel module with the
  manifest version in its URL, so a page loaded before an update offers a
  reload on its own.

Issues and pull requests are welcome on
[davidcoulson/sextant](https://github.com/davidcoulson/sextant).
