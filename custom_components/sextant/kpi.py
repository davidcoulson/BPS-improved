"""Room-stability metrics over recorder history (the panel's Health page).

The same numbers tools/flap_kpi.py prints from the command line, computed
here from Home Assistant's recorder so the panel can show them without a
token or a shell. The metric functions are pure and duplicated from the
tool on purpose: tools/ runs outside Home Assistant and must not import
the integration, and the integration must not import tools/.
"""

from __future__ import annotations

import statistics
from collections import Counter
from datetime import datetime

SUFFIXES = ("_sextant_zone", "_sextant_floor")
DEAD_STATES = {"unknown", "unavailable", "", None}


def _parse_ts(value):
    """ISO-8601 (HA's format, with offset) or an aware datetime -> aware datetime."""
    if isinstance(value, datetime):
        return value
    text = str(value).replace("Z", "+00:00")
    return datetime.fromisoformat(text)


def compute_metrics(rows, window_hours=None):
    """Stability metrics for one entity's history.

    ``rows`` is a chronological list of ``{"state", "last_changed"}`` (the
    first row being the state at the window start). Consecutive duplicate
    states collapse first, so a re-report of the same value is not a change.
    """
    seq = []
    for row in rows:
        state = row.get("state")
        ts = _parse_ts(row.get("last_changed") or row.get("last_updated"))
        if seq and seq[-1][1] == state:
            continue
        seq.append((ts, state))

    changes = max(len(seq) - 1, 0)
    if window_hours:
        hours = float(window_hours)
    elif len(seq) >= 2:
        hours = max((seq[-1][0] - seq[0][0]).total_seconds() / 3600.0, 1e-9)
    else:
        hours = 0.0

    flips = sum(
        1
        for i in range(len(seq) - 2)
        if seq[i][1] == seq[i + 2][1] and seq[i][1] != seq[i + 1][1]
    )
    dwells = [(seq[i + 1][0] - seq[i][0]).total_seconds() for i in range(len(seq) - 1)]
    short = sum(1 for d in dwells if d < 60.0)
    dead = sum(1 for _ts, s in seq[1:] if s in DEAD_STATES)

    transitions = Counter(
        (seq[i][1], seq[i + 1][1])
        for i in range(len(seq) - 1)
        if seq[i][1] not in DEAD_STATES and seq[i + 1][1] not in DEAD_STATES
    )
    pairs = Counter()
    for (a, b), n in transitions.items():
        pairs[tuple(sorted((a, b)))] += n

    return {
        "changes": changes,
        "hours": round(hours, 3),
        "changes_per_hour": round(changes / hours, 2) if hours else None,
        "flips": flips,
        "flip_ratio": round(flips / changes, 3) if changes else None,
        "median_dwell_s": round(statistics.median(dwells), 1) if dwells else None,
        "short_dwell_ratio": round(short / len(dwells), 3) if dwells else None,
        "dead": dead,
        "states": len({s for _ts, s in seq if s not in DEAD_STATES}),
        "top_pairs": [{"pair": list(pair), "count": n} for pair, n in pairs.most_common(3)],
    }


def summarise(per_entity):
    """Fleet-level roll-up: totals over every entity of one kind."""
    out = {}
    for suffix in SUFFIXES:
        members = {k: v for k, v in per_entity.items() if k.endswith(suffix)}
        if not members:
            continue
        changes = sum(m["changes"] for m in members.values())
        flips = sum(m["flips"] for m in members.values())
        hours = sum(m["hours"] for m in members.values())
        dwells = [m["median_dwell_s"] for m in members.values() if m["median_dwell_s"] is not None]
        out[suffix.lstrip("_")] = {
            "entities": len(members),
            "changes": changes,
            "changes_per_tracker_hour": round(changes / hours, 2) if hours else None,
            "flip_ratio": round(flips / changes, 3) if changes else None,
            "median_of_median_dwell_s": round(statistics.median(dwells), 1) if dwells else None,
        }
    return out


def rows_from_recorder(states):
    """Recorder rows (State objects, or minimal-response dicts) -> metric rows."""
    rows = []
    for item in states or []:
        if isinstance(item, dict):
            state = item.get("state")
            ts = item.get("last_changed") or item.get("last_updated")
        else:
            state = getattr(item, "state", None)
            ts = getattr(item, "last_changed", None) or getattr(item, "last_updated", None)
        if ts is None:
            continue
        rows.append({"state": state, "last_changed": ts})
    return rows
