[Sextant](../README.md) › Calibration

# Calibration

![The Calibration page: a run's per-proxy factors with a before and after error and a warning not to apply a worse solve](../img/screenshots/sextant-calibration.png)

Proxies calibrate each other: every proxy hears every other proxy's beacon
at a known distance, a run collects those readings for the floor picked
in the header and solves one range correction per proxy. Start a timed run
or leave **Auto
calibration** on (samples every 30 s into a rolling six-hour window,
re-solves every 15 minutes, re-applies when a factor moves by more than
1 %). The result lists each proxy's factor and the equivalent dB, flags
low-confidence proxies, and compares the error before and after; a solve
that makes things worse is marked *do not apply* and Apply asks for a
confirmation before storing it. **Apply** stores the
factors with the layout, or with `calibration_target: bermuda` writes them
into Bermuda as per-scanner RSSI offsets so Bermuda's own sensors are
corrected too. **Reset** removes them.

How the solve works, and how a factor maps onto a Bermuda RSSI offset, is in
[How positioning works](positioning.md).
