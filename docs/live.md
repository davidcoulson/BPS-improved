[Sextant](../README.md) › Live

# Live

The floor plan with every tracker drawn as an avatar in its own colour, the
same colour as its row in the list. Click a tracker (row or avatar) to
focus it: everything else fades, it grows a halo, the panel switches to its
floor, and the side panel shows its room, spot, floor, the proxy it is
anchored to if any, and every proxy that hears it with the distance; a
**Details** disclosure holds the floor odds, spot shares, confidence,
estimator telemetry, trust and speed. A **blend slider** from geometric to
fingerprint sets how this tracker's position is estimated (the two ends
are drawn on the map when the fingerprint switch is on), and **It's
actually here…** records a [truth mark](live.md#truth-marks). A tracker with no fix shows *seen 40s
ago* rather than a blank. Switches draw the solver's distance circles, the
fingerprint fix, a trail, and hide the plan image. A history scrubber under
the map replays where a tracker has been over the retention window, with a
room band, playback and a jump-to-time picker.

## Truth marks

When a tracker sits in the wrong place, select it on the Live page, click
**It's actually here…** and click the spot on the map where it really is.
Sextant keeps the solver inputs of the last few minutes for every
tracker, so it re-solves those cycles under every blend of geometric fit
and fingerprint match and every reference gain, and shows how far each
lands from your mark and how often it gets the room right. **Apply** on a
row makes those the tracker's settings (its blend weight, and a gain
multiplier folded into its learned gain). One mark can overfit, so mark a
tracker in two or three rooms.

Marks stay, with their samples, in `.storage/sextant_truth`, and do two
more jobs. The Tuning page's **Accuracy** card re-solves every mark under
the settings in force and reports, per tracker, the mean error in metres
and the share of cycles in the right room: the accuracy figure the
stability KPI cannot give. And each mark becomes a fingerprint reference
at the marked point, in the marking tracker's own scale, so rooms with no
probe nearby get a reference too (`fingerprint_marks` turns that off).
