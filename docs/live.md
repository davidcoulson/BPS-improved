[Sextant](../README.md) › Live

# Live

The floor plan with every tracked thing drawn as an avatar in its own colour, the
same colour as its row in the list. Click a thing (row or avatar) to
focus it: everything else fades, it grows a halo, the panel switches to its
floor, and the side panel shows its room, spot, floor, the proxy it is
anchored to if any, and every proxy that hears it with the distance; a
**Details** disclosure holds the floor odds, spot shares, confidence,
estimator telemetry, trust and speed. **Edit** (administrators) opens the
thing's dialog on the Things page - name, class, colour, photo, height -
without hunting for it in the list. A **blend slider** from geometric to
fingerprint sets how this thing's position is estimated (the two ends
are drawn on the map when the fingerprint switch is on), and **It's
actually here…** records a [truth mark](live.md#truth-marks). A thing with no fix shows *seen 40s
ago* rather than a blank. Switches draw the solver's distance circles, the
fingerprint fix, a trail, and hide the plan image. A history scrubber under
the map replays where a thing has been over the retention window, with a
room band, playback and a jump-to-time picker.

**Ghosts.** A thing nothing has heard for `stale_after_secs` (two minutes
unless you change it on the Tuning page) is drawn as a ghost: faint, with a
dashed outline and *3m ago* under it, and its row in the list fades with a
ghost icon. What you are looking at is where it *was*; the room and spot
sensors still say the same, because nothing has contradicted them yet. It
leaves the map altogether after `position_timeout` (five minutes by
default). The dashboard card draws ghosts the same way.

**How long it has been there, and where it has been.** The focused thing's
card says how long it has been where it is - *Meg's Cafe for 1h 12m, since
2:41 pm*, and when that is a spot, how long it has been in the room around
it too. Below is the **timeline**: the last day as a band, one colour per
room (a spot is the darker shade of its room, a stretch nobody heard it is
hatched), then the stays newest first with their times and lengths. A `+`
means the stay began before the start of what history keeps, so it is at
least that long. Stays come from the position history, which records a
point on every room and spot change.

On a phone the map switches (labels, trails, the grid and so on) collapse
behind a single options button so they never force sideways scrolling, the
floor picker and the cycle-age clock move to a bar under the page, and a
row of **quick actions** — self-test, and for an administrator, adding a
thing and starting calibration — jumps straight to the right page
without hunting through the tabs. Editing the floor plan itself is still
a desktop job.

## Truth marks

When a thing sits in the wrong place, select it on the Live page, click
**It's actually here…** and click the spot on the map where it really is.
Sextant keeps the solver inputs of the last few minutes for every
thing, so it re-solves those cycles under every blend of geometric fit
and fingerprint match and every reference gain, and shows how far each
lands from your mark and how often it gets the room right. **Apply** on a
row makes those the thing's settings (its blend weight, and a gain
multiplier folded into its learned gain). One mark can overfit, so mark a
thing in two or three rooms.

Marks stay, with their samples, in `.storage/sextant_truth`, and do two
more jobs. The Tuning page's **Accuracy** card re-solves every mark under
the settings in force and reports, per thing, the mean error in metres
and the share of cycles in the right room: the accuracy figure the
stability KPI cannot give. And each mark becomes a fingerprint reference
at the marked point, in the marking thing's own scale, so rooms with no
probe nearby get a reference too (`fingerprint_marks` turns that off).
