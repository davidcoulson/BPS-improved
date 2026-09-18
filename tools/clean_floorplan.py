#!/usr/bin/env python3
"""Strip a builder's floor plan down to its walls.

A plan drawn for a builder carries far more ink than a positioning map
needs: a tile hatch over every floor, room names, room dimensions, a
title block. All of it competes with what Sextant draws on top - the
rooms you drew, the proxies, the trackers, the spots the Advice page
suggests - and on a phone it wins.

What separates a wall from the rest is weight. A wall is the heaviest
stroke on the sheet; the hatch is hairline, and text and dimension
strings sit in between. So:

* a morphological opening keeps only strokes at least ``thick`` pixels
  across, which is the walls and the heavier door swings;
* a closing then bridges the small gaps in that skeleton, so a short
  partition between two door frames joins the wall network rather than
  being read as a stray mark;
* components that are still too small to be a wall - the title block's
  lettering, a stray dimension tick - are dropped.

The result is written as a new image; the original is never touched.
Check it before pointing Sextant at it: every plan is drawn differently,
and ``--thick`` is the knob that matters (raise it if hatch survives,
lower it if walls break up).

    python3 tools/clean_floorplan.py "Ground Floor.jpg" -o ground-clean.png
"""

from __future__ import annotations

import argparse
import sys

import numpy as np
from PIL import Image
from scipy import ndimage


def clean(
    path: str,
    out: str,
    ink_level: int = 140,
    thick: int = 5,
    bridge: int = 9,
    min_run: int = 110,
    ink: int = 30,
) -> dict:
    """Write a walls-only copy of the plan at `path` to `out`; return the tally."""
    grey = np.asarray(Image.open(path).convert("L"))
    dark = grey < ink_level

    # The walls: the only strokes this heavy.
    heavy = ndimage.binary_opening(dark, structure=np.ones((thick, thick), bool))

    # Bridge the hairline gaps a scan leaves in a wall, so what follows sees
    # one wall network rather than a run of disconnected segments.
    joined = ndimage.binary_closing(heavy, structure=np.ones((bridge, bridge), bool))
    lab, n = ndimage.label(joined, structure=np.ones((3, 3), bool))
    keep = np.zeros(n + 1, bool)
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        keep[i] = max(h, w) >= min_run  # a wall runs; lettering does not
    walls = keep[lab] & heavy

    res = np.full(grey.shape, 255, np.uint8)
    res[walls] = ink
    Image.fromarray(res).save(out)
    return {
        "ink_px": int(dark.sum()),
        "kept_px": int(walls.sum()),
        "removed_pct": round(100 * (1 - walls.sum() / max(1, dark.sum()))),
        "components": n,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("plan", help="the floor-plan image to read")
    ap.add_argument("-o", "--out", required=True, help="where to write the cleaned copy")
    ap.add_argument("--ink-level", type=int, default=140, help="a pixel darker than this is ink (0-255)")
    ap.add_argument("--thick", type=int, default=5, help="a wall is at least this many pixels across")
    ap.add_argument("--bridge", type=int, default=9, help="close gaps up to this wide in the wall network")
    ap.add_argument("--min-run", type=int, default=110, help="drop anything whose longest side is under this")
    args = ap.parse_args(argv)

    tally = clean(args.plan, args.out, args.ink_level, args.thick, args.bridge, args.min_run)
    print(f"{args.plan} -> {args.out}: {tally['kept_px']} of {tally['ink_px']} ink pixels kept "
          f"({tally['removed_pct']}% removed), {tally['components']} components")
    return 0


if __name__ == "__main__":
    sys.exit(main())
