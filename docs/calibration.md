[Sextant](../README.md) › Calibration

# Calibration

![The Calibration page: a run's per-proxy factors with a before and after error and a warning not to apply a worse solve](../img/screenshots/sextant-calibration.png)

Proxies calibrate each other: every proxy hears every other proxy's beacon
at a known distance, a run collects those readings for the floor picked
in the header and solves one range correction per proxy. Start a timed run
or leave **Auto
calibration** on: it samples every 30 s into a rolling six-hour window
across every floor and re-solves every 15 minutes. With the Bermuda fork the
samples come straight from its scanner-ranging table, which holds only how
each proxy hears the others; stock Bermuda is asked for a full device dump
each round instead, which is several megabytes on a large install. Before writing anything
it judges each floor's solve with the self-test (how far each proxy lands
from where it is placed) three ways: with no corrections, with the
corrections in place, and with the new ones. It applies the new set only
when that median improves by at least 2 %, takes its own earlier
corrections out again if none beats them, and otherwise leaves the floor
alone; the decision and the three figures show against each floor's
result. A manual solve gets the same verdict, and a solve that would not
help is marked *do not apply* (Apply then asks for a confirmation). **Apply** stores the
factors with the layout, or with `calibration_target: bermuda` writes them
into Bermuda as per-scanner RSSI offsets so Bermuda's own sensors are
corrected too. **Reset** removes them.

How the solve works, and how a factor maps onto a Bermuda RSSI offset, is in
[How positioning works](positioning.md).
