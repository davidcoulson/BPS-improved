[Sextant](../README.md) › How positioning works

# How positioning works

Each cycle (15 s by default) runs this pipeline per thing.

**Distances.** Bermuda's smoothed distance per proxy, or with
`distance_estimator: median` the median of the recent raw RSSI samples
converted with Bermuda's own path-loss parameters, which is symmetric where
Bermuda's running minimum reads far proxies short. Calibration factors and
the proxy and thing heights are applied here: a slant range becomes a
horizontal one before it reaches the solver. Readings under 0.5 m are
weighted as "right here" rather than by 1/r².

**Which proxies.** Every proxy within `solver_near_always` metres plus the
nearest `solver_max_receivers`, dropping readings beyond `solver_max_range`
once three remain. Beyond eight metres a BLE range is mostly noise.

**The fit.** A bounded, robustly weighted least-squares trilateration in
pure numpy (`solver_numpy.py`, benchmarked against SciPy on a 48-proxy
layout), run in the executor. Spiky readings are down-weighted rather
than dropped. A fix that lands outside every room is snapped to the
nearest room; a fix in a no-go area is snapped out of it.

**Fingerprints.** Every proxy that advertises is heard by every other
proxy, so Bermuda continuously measures a labelled vector of ranges at a
known position: one reference fingerprint per proxy, for free. With
`position_estimator: fused` (the recommended setting once the reference
database has a minute of samples) a thing's vector of ranges is matched
against those references and the fix is blended,
`(1 - fingerprint_weight) × fit + fingerprint_weight × fingerprint`. A
wall that makes a proxy read the thing long makes it read the references
behind that wall long too, and the comparison cancels it. The gain
between probe beacons and things is learned from the things themselves
(`fingerprint_auto_gain`): a shared gain, plus a faster multiplier per
thing, because a watch reads weak and a Tile reads hot. It is published
per fix as `fp.gain`. A match whose scale still disagrees with the thing
counts for less (`fp.trust`, zero at a factor of three). A floor with only
one or two proxies can compete on its fingerprint. Any thing can opt out
from its dialog on the Things page: **Positioning** is the estimator for
that thing alone, so a tag the fingerprint makes worse can be geometric
only.

**Smoothing.** A constant-velocity Kalman filter on the position, in
metres so it behaves the same on any plan resolution; it resets on a floor
change or an absence.

**Floors.** Every floor with three or more proxies hearing the thing is
solved and scored by how well its fit explains all of its proxies. A
through-ceiling reading fits one proxy and contradicts the rest. Scores
are scaled by proximity (the mean of the `floor_proximity_k` nearest
distances on this floor against the best competing floor) and by the
floor's `bias`, then smoothed; a challenger must lead for
`floor_switch_secs`, by a margin that grows with the incumbent's tenure.

**Bias fields.** A floor's `bias` is one prior for the whole plan, and a
house is not uniform. Over a slab the floor below is attenuated and the
election has an easy time. Beside a void — a catwalk over a foyer, a gallery
over a great room — both floors hear the thing line-of-sight, fit it equally
well, and nothing in the evidence separates them. So a floor can carry a
*bias field*: a coarse grid of multipliers over its plan, sampled where
**that floor's own solve** put the thing, and multiplied onto the scalar.
Paint the catwalk up ("a fix that lands here is to be believed") and the
void itself down ("there is no floor here to stand on"). Because a field is
only ever read at its own floor's fix, it needs nothing to line one floor's
plan up against another's. It is sampled bilinearly, so a fix jittering
across a cell edge moves the bias smoothly instead of flickering it.

A flat field is all ones and changes nothing, to the last digit — lay it
first, confirm nothing moved, then shape it. Set it with
[`sextant.set_floor_bias_field`](automation.md#services). Every cycle
publishes each contending floor's own fix and score as `floor_cands`, and
`tools/floor_field_replay.py` re-scores a log of those under a proposed
field, so a stroke can be graded against what really happened before it
ships.

**Rooms.** Membership, not a point test: samples on the filter's error
ellipse are attributed to rooms and the shares smoothed. The current room
holds until a challenger leads by `zone_switch_margin` for
`zone_switch_secs`. A thing slower than `stationary_speed` for
`stationary_secs` is on a table and its room locks; it unlocks after
`zone_unlock_secs` more than `zone_unlock_margin` outside, or when it
clearly moves.

**Spots.** The same election scaled down: the share of the ellipse inside
each spot of the elected room, entered at `subzone_enter_prob`, left at
`subzone_unlock_margin` outside, every change waiting
`subzone_switch_secs`. A locked room keeps its spot. A spot can be limited
to certain [classes](things.md) — a bedside table to a phone, a watch and
keys, a cat bed to the cat — and is then not a candidate for anything else
at all, so the cat bed never competes for the phone. A spot with no classes
set takes any thing, which is how every spot drawn before this behaves.
Two of the classes stand for a family: **Person** also takes a man, a woman
or a child, and **Pet** also takes the dog or the cat. The picker shows the
members of a family you have picked outlined, so a spot's real reach is on
the screen. It does not work the other way round — a spot asking for Man is
not satisfied by something classed merely Person.

**Near-field anchor.** A thing one proxy reads inside `anchor_max_m`
with every other proxy at least `anchor_ratio` times farther, for
`anchor_secs`, is placed on that proxy: a watch on the bedside table next
to its proxy, not 1.7 m away where the far proxies' errors pull the fit.
Released once the reading opens past `anchor_release_m`.

**Calibration.** Probe-to-probe ranges against the placed positions (3D
when both proxies have heights) solve a per-proxy multiplier, normalised so
they never rescale everything at once. A multiplier is exactly a
per-scanner RSSI offset in Bermuda's model, which is how
`calibration_target: bermuda` writes it.
