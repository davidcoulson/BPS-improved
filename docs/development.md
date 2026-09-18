[Sextant](../README.md) › Data and development

# Data and development

## Where the data lives

| What | Where |
|---|---|
| Layout: floors, rooms, spots, proxies, heights, corrections, tuning, tracker names and classes | `config/.storage/sextant` |
| Calibration solves and the rolling sample window | `config/.storage/sextant_calibration_state` |
| Stability baselines | `config/.storage/sextant_kpi_baselines` |
| Truth marks with their samples | `config/.storage/sextant_truth` |
| Learned fingerprint gains, saved every five minutes so a restart starts warm | `config/.storage/sextant_fingerprint_gains` |
| Position history, one NDJSON segment per day, pruned to the retention | `config/.storage/sextant_history/` |
| Floor-plan images, served only to a signed-in user via `/api/sextant/map/<file>` | `config/sextant_maps/` |

Nothing under `.storage` is served over HTTP. Edit the layout from the
panel or the services, not the file: a hand edit under a running Home
Assistant is lost on the next save.

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
