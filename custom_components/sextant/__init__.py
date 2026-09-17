import aiofiles
import aiofiles.os
import time
from pathlib import Path
from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.components.frontend import async_remove_panel
from homeassistant.components import panel_custom
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.dispatcher import async_dispatcher_connect, async_dispatcher_send
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import device_registry as dr
from homeassistant.const import UnitOfLength
from homeassistant.util.unit_conversion import DistanceConverter
from homeassistant.util import slugify
import numpy as np
from .solver_numpy import least_squares_bounded_soft_l1
import voluptuous as vol
from homeassistant.core import ServiceCall
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
import logging
import asyncio
import math
import os
import json
import re
import copy
import difflib
from shapely.geometry import Point, Polygon
from shapely.ops import nearest_points, unary_union
try:
    from shapely.validation import make_valid as shapely_make_valid
except ImportError:  # very old shapely
    shapely_make_valid = None
from asyncio import Lock, Queue, wait_for, TimeoutError

from .calibration import (
    apply_corrections,
    async_cancel_calibration,
    async_restore_calibration_state,
    async_shutdown_calibration,
    async_start_auto_if_enabled,
    get_calibration_state,
    refresh_receivers_from_coords,
    reset_corrections,
    save_calibration_state,
    set_auto_calibration,
    start_calibration,
)
from .storage import (
    LAYOUT_LOCK,
    get_layout,
    get_layout_for_edit,
    get_layout_version,
    load_layout,
    migrate_from_bps,
    migrate_legacy,
    save_layout,
)
from .const import ACCURACY_ENTITY_ID
from . import history as history_mod
from . import bermuda_source
from . import fingerprint
from .zone_adjust import adjust_zones, adjust_subzones

_LOGGER = logging.getLogger(__name__)

DOMAIN = "sextant"
OPTION_SHOW_SIDEBAR_PANEL = "show_sidebar_panel"
OPTION_UPDATE_INTERVAL = "update_interval"
# Trilateration (scipy least_squares, multi-start) is real CPU work. 1s was
# fine for a handful of trackers but scales linearly with tracker count and
# adds up fast - profiling showed it as the largest chunk of custom-component
# CPU time on a live instance. 15s still updates a tracker's room/position
# fast enough for presence automations while cutting recompute volume ~15x.
DEFAULT_UPDATE_INTERVAL = 15
FRONTEND_PATH = Path(__file__).parent / "frontend"
LEGACY_BPS_ENTITY_PATTERN = re.compile(r"^sensor\.(.+)_\1_sextant_(zone|floor)$")

# Global data (the layout now lives in the Store; see storage.get_layout)
state_change_lock = Lock()
state_change_counter = {}
update_queue = Queue()
tracked_listeners = {}
tracked_entities = []
new_global_data = {}
secToUpdate = DEFAULT_UPDATE_INTERVAL
# A scanner Bermuda hasn't heard for this long is treated as offline; the
# liveness is polled from dump_devices every RECEIVER_DUMP_INTERVAL seconds.
RECEIVER_OFFLINE_SECS = 30
RECEIVER_DUMP_INTERVAL = 15
apitricords = []
# A tracker not detected by any receiver for this long disappears from the
# map and its zone/floor sensors go to unknown. Override with a top-level
# "position_timeout" (seconds) in bpsdata.txt.
STALE_POSITION_SECS = 300

# --- Stale distance readings (per receiver, per tracker) ----------------------
# A distance_to sensor keeps its last value when its scanner stops hearing the
# tracker: the reading goes STUCK rather than unavailable (most visible on
# Bermuda's unfiltered distance entities, which have no timeout of their own).
# Fed to the solver, a stuck radius anchors the fix to a receiver that can no
# longer see the device. Readings older than this are dropped from the solve;
# override with a top-level "reading_max_age" (seconds) in the layout, or set it
# to 0 to disable the gate entirely.
#
# Raised from 30. Observed live on a real 48-receiver install (using the
# direct Bermuda API path in bermuda_source.py): "stale, dropped" rejections
# clustered almost entirely at exactly 30-31s old, with no long tail of much
# older readings, and enough of them that at least one tracker went unsolved
# for a full 5 minutes and had its position cleared. That tight clustering
# right on the boundary, rather than a spread of ages, points to real per-pair
# advertise cadence (some scanner/device pairs just don't hear each other more
# often than ~30s - common when a BLE tracker throttles its advertise rate
# while stationary to save battery) landing on a threshold with almost no
# margin, not to genuinely dead receivers (which would show much larger ages
# and wouldn't cluster this tightly). 45 gives that normal cadence headroom
# while still dropping anything actually stuck.
#
# Not fully isolated from a second, related variable: this gate's `age` now
# comes from Bermuda's own advert timestamp (the true "last heard" time)
# rather than an entity's last_updated, which is a step change in how this
# value is measured even though the intent - age since last heard - is the
# same. Whether that alone explains the clustering, or the real cadence was
# already this marginal and the entity path happened to mask it, was not
# separately isolated (the entity path cannot run concurrently to A/B, since
# the entities are disabled by design). Either way the fix is the same.
READING_MAX_AGE_SECS = 45

# --- Output-position smoothing (constant-velocity Kalman filter) -------------
# The published position is smoothed with a constant-velocity 2D Kalman filter
# (state [x, y, vx, vy]) instead of a fixed-length moving average. Unlike the
# old 3-sample mean, the filter carries a motion model, so it lags less while a
# tracker is walking and settles more while it is still, and it adapts its gain
# to the estimated uncertainty rather than weighting every past fix equally.
#
# The noise parameters are defined in METRES (and metres/second) and converted
# into each floor's pixel space via the floor scale, so the filter behaves the
# same on maps of any resolution. They are deliberately "trusting": Sextant already
# reads Bermuda's smoothed rssi_distance (20-sample average + velocity gate), so
# the trilateration fixes fed in here are not raw-RSSI noisy. Tune KF_MEAS_NOISE_M
# up for more smoothing, or KF_ACCEL_NOISE_MS2 up for a snappier response.
KF_MEAS_NOISE_M = 1.5        # per-fix position uncertainty (m); larger = smoother
KF_ACCEL_NOISE_MS2 = 0.5     # expected acceleration (m/s^2); larger = more responsive
KF_INIT_VEL_UNC_MS = 1.0     # initial velocity uncertainty (m/s) at (re)init
KF_MAX_DT_S = 10.0           # cap the prediction step so a gap can't blow up P
KF_MAX_GAP_S = 30.0          # gap beyond which state is reset (tracker was away)
# Soft-gate scale for spiky per-receiver distances: a reading whose radius
# changed by this fraction versus the previous update is down-weighted to 0.5
# (was a hard 50% discard). Nothing is dropped, so the solver keeps enough
# points to fix a position even while every distance is legitimately changing
# during movement.
RADIUS_JUMP_TOL = 0.5
# Robust-loss knee for the trilateration solver, in units of the objective's
# residual (~relative radius error). soft_l1 down-weights any receiver whose
# radius disagrees with the fit by more than ~this fraction, so one persistently
# wrong (through-wall / body-shadowed) reading can't drag the position — the
# temporal jump gate only sees a one-tick change and is blind to a steady liar.
SOLVER_ROBUST_F_SCALE = 0.3
# Multi-start (see trilaterate()) solves up to 3x per tracker per cycle to
# escape local minima. That's only needed when something could have actually
# changed since last cycle; a stationary tracker gains nothing from starting
# fresh from the centroid every tick when last cycle's own answer is right
# there. _jump_weight() already scores this per-point (1.0 = unchanged since
# last update); the minimum across a floor's points must clear this before
# trilaterate() is allowed to skip straight to a single solve from the
# previous fix. Comfortably above _jump_weight's own 0.5 spike-gate floor, so
# a receiver that's merely started to drift still forces the full battery.
STABLE_HINT_MIN_JUMP_WEIGHT = 0.85

# Uploaded floor-plan maps: accepted image extensions and a size cap. Client
# filenames are never trusted for filesystem paths (see _safe_maps_child).
# .jfif/.jpe are ordinary JPEG variants a browser's image/jpeg picker yields.
_ALLOWED_MAP_EXTS = {
    ".png", ".jpg", ".jpeg", ".jfif", ".jpe", ".gif", ".webp", ".bmp", ".svg", ".avif",
}
MAX_MAP_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB
# Non-map files that live in www/sextant_maps and must never be deletable via the
# save_text "remove" field (that field is only meant to drop an old map image).
_PROTECTED_MAPS_FILES = {"bpsdata.txt", "sextant_calibration_state.json"}
# Longest to wait on Bermuda's dump_devices before treating it as unavailable,
# so a hung/slow service can't stall the liveness or calibration loops.
DUMP_DEVICES_TIMEOUT_S = 10.0


def _safe_maps_child(maps_path, raw_name, allowed_exts=None):
    """Resolve raw_name to a path guaranteed to sit directly inside maps_path.

    Returns the resolved Path, or None if raw_name is unsafe. Path(name).name
    strips any directory component (so '../x' and '/etc/x' both collapse to a
    bare filename), and the resolved result is re-checked against maps_path as
    belt-and-suspenders. Client-supplied filenames must never reach the
    filesystem unfiltered (unauthenticated write endpoints, issue: audit #2).
    """
    if not raw_name:
        return None
    name = Path(str(raw_name)).name
    if not name or name in (".", ".."):
        return None
    if allowed_exts is not None and Path(name).suffix.lower() not in allowed_exts:
        return None
    base = Path(maps_path).resolve()
    target = (base / name).resolve()
    try:
        if not target.is_relative_to(base):
            return None
    except AttributeError:  # Python < 3.9 (HA is 3.12+; defensive only)
        if base != target and base not in target.parents:
            return None
    return target

# --- Receiver mount heights (optional per-receiver "height", metres) ---------
# Bermuda's distance estimates are line-of-sight SLANT ranges, but the map
# solve is 2D: a ceiling probe reading 2.3 m to a tracker right below it is
# really ~0.6 m away horizontally. When a receiver's mount height is set in
# the panel, the vertical leg is removed before trilateration
# (horizontal = sqrt(slant^2 - dz^2)). Trackers are assumed to be carried at
# TRACKER_HEIGHT_M above the floor; override with a top-level
# "tracker_height" (metres) in bpsdata.txt.
TRACKER_HEIGHT_M = 1.0

# --- Per-tracker reference-power trim (issue #92) -----------------------------
# Bermuda turns RSSI into distance with an exponential path-loss model,
# d = 10 ** ((ref_power - rssi) / (10 * attenuation)). Cheap beacons vary in
# transmit power, so one Bermuda ref_power can read consistently long or short
# for a given tag. Sextant can't change Bermuda's config, but an offset of `delta`
# dB on ref_power is exactly a MULTIPLICATIVE scale on every distance from that
# tracker: 10 ** (delta / (10 * attenuation)). So a per-tracker offset (stored
# in metres-free dB under the top-level "tracker_ref_offsets" map) is applied
# here as a distance factor — tunable live from the panel while watching the
# map, and portable back into Bermuda's own ref_power once a value is found.
# The exponent below is Bermuda's default attenuation; a user whose Bermuda
# uses a different one still gets a monotonic trim, just on a slightly
# different dB scale (this is a relative knob, not a calibrated instrument).
PATH_LOSS_EXPONENT = 3.0
TRACKER_REF_OFFSET_MAX_DB = 20.0  # +/- range accepted from the panel/API
# Slant->horizontal legitimately produces very short radii (tracker nearly
# under a ceiling probe). The solver's geometric 1/r^2 weight would explode
# there and let that one receiver dominate the fit, so for WEIGHTING (not for
# the residual) radii are clamped to this physical minimum, converted to each
# floor's pixel scale.
MIN_WEIGHT_RADIUS_M = 0.5

# --- Floor election by hypothesis competition ---------------------------------
# The floor used to be elected by the single nearest receiver — one noisy
# reading through a ceiling could steal the tracker for a cycle (kitchen <->
# bedroom flapping, issue #94). Now every plausible floor is SOLVED and
# SCORED: the fit's agreement with all of that floor's receivers feeds a
# smoothed per-floor probability, and the elected floor only changes when a
# challenger clearly and persistently outscores the incumbent.
FLOOR_CANDIDATES = 3         # solve at most this many floors per cycle
FLOOR_PROB_SMOOTHING = 0.7   # EMA weight on the previous probability
FLOOR_SWITCH_MARGIN = 0.05   # probability lead that starts/keeps a challenge
# Dwell is WALL-CLOCK, not cycles: "three cycles" was 30 s at the default
# interval, and 20 of 39 floor changes in a 12 h sample were A->B->A flips.
# The default lives in TUNING_SPEC ("floor_switch_secs") so it can be changed
# live; this is the fallback when _elect_floor is called without one.
FLOOR_SWITCH_SECS = 60.0
FLOOR_DARK_GRACE_CYCLES = 3  # cycles a dark incumbent holds everything frozen
FLOOR_RESIDUAL_SCALE_M = 2.0 # weighted RMS residual (m) at which fit quality = 0.5
COVERAGE_TARGET_N = 5.0      # heard receivers at which the coverage term saturates

# No-go zones (issue #60): areas a tracker can't physically be — the upper
# footprint of a double-height foyer/great room open to the floor below.
# When a floor's fit lands in one of its no-go zones the fit is impossible on
# THAT floor, so its election confidence is multiplied down: the competition
# then prefers the floor where the same spot is a real room (the open space
# means that floor's receivers already hear the tracker and solve it as a
# candidate). The penalty only DOWN-WEIGHTS — a no-go floor that is the sole
# candidate still wins and its position is snapped out to the nearest allowed
# zone — so a tracker is never left position-less.
NO_GO_CONF_PENALTY = 0.15
# When snapping a fix out of dead space, grow the no-go footprint by this many
# pixels before subtracting it from the allowed region, so the snap target's
# boundary sits clear of the (boundary-inclusive) no-go edge rather than
# exactly on it — otherwise the snapped point still reads as "in the no-go
# zone" to covers()-based tests.
NO_GO_SNAP_MARGIN_PX = 3.0

# Per-tracker election state, all reset when the tracker is pruned:
# smoothed floor probabilities (entity -> {floor name: P}), the pending
# challenge (a floor out-scoring the incumbent, counted per cycle: entity ->
# {"floor": name, "count": n}), and how many consecutive cycles the incumbent
# floor has been dark (unsolvable) while a competitor solved.
_floor_probability = {}
_floor_challenge = {}
_floor_dark_cycles = {}
# When the incumbent floor was elected (wall clock), for the tenure bonus.
_floor_since = {}

# Per-tracker Kalman state: entity -> {"x": np.array(4), "P": np.array(4,4),
# "ts": float, "floor": str}. Reset on floor change, long gap, or prune.
_kf_position_state = {}

# Per-tracker zone election state (see _elect_zone) and the published
# sub-zone's dwell state (see _subzone_with_dwell). Reset on floor change and
# on prune, like the Kalman state.
_zone_state = {}
_subzone_state = {}

# --- Runtime tuning (sextant.set_tuning) ------------------------------------------
# Knobs for the accuracy work that are safe to flip on a live install without
# a code change. They live under a top-level "tuning" map in the layout store
# and are set through the sextant.set_tuning service (never by editing
# .storage/sextant under a running HA, which is silently lost on the next save).
# Each entry is (default, type, min, max) for numbers, (default, bool) for
# switches, or (default, str, allowed) for choices.
TUNING_SPEC = {
    # Which per-pair distance feeds the solver. "bermuda" is Bermuda's own
    # smoothed distance: a running-minimum-biased average built for "which
    # scanner is nearest", which lags on the way out and reads far receivers
    # short - and a short far receiver drags a least-squares fit toward it.
    # "median" takes the median of the recent raw RSSI samples and converts it
    # with the same path-loss parameters Bermuda used: symmetric, no low bias.
    # It needs a Bermuda build with the rssi_history feature and falls back to
    # "bermuda" per reading when history is missing or too thin.
    "distance_estimator": ("bermuda", str, ("bermuda", "median")),
    "median_window_secs": (15.0, float, 3.0, 120.0),    # samples newer than this
    "median_min_samples": (3, int, 1, 20),              # fewer -> fall back
    # Receivers per solve: everything within solver_near_always metres, plus
    # the nearest solver_max_receivers (0 = unlimited); readings beyond
    # solver_max_range (0 = no cap) are dropped unless needed to reach three
    # points. At 8 m and beyond a BLE range estimate is mostly noise, and the
    # 1/r^2 weight does not zero it out.
    "solver_max_receivers": (8, int, 0, 100),
    "solver_max_range": (12.0, float, 0.0, 100.0),
    "solver_near_always": (3.0, float, 0.0, 50.0),
    # Zone election (see _elect_zone). Off = publish the instantaneous zone.
    "zone_hysteresis": (True, bool),
    "zone_prob_smoothing": (0.6, float, 0.0, 0.95),     # EMA weight on the previous probability
    "zone_switch_margin": (0.15, float, 0.0, 1.0),      # lead a challenger needs
    "zone_switch_secs": (20.0, float, 0.0, 600.0),      # ...held this long, wall clock
    "stationary_speed": (0.3, float, 0.0, 5.0),         # m/s; below this the tracker is still
    "stationary_secs": (20.0, float, 0.0, 600.0),       # still this long -> zone locked
    "zone_unlock_margin": (1.0, float, 0.0, 20.0),      # m outside the locked zone...
    "zone_unlock_secs": (30.0, float, 0.0, 600.0),      # ...for this long -> unlocked
    "subzone_switch_secs": (20.0, float, 0.0, 600.0),
    # Sub-zone election (see _elect_subzone): the smoothed share of the fix's
    # uncertainty that must fall inside a sub-zone before it is entered, and
    # how far (m) outside its polygon the fix must sit before it is left.
    "subzone_enter_prob": (0.5, float, 0.1, 0.95),
    "subzone_unlock_margin": (1.0, float, 0.0, 5.0),
    # Floor election dwell (see _elect_floor).
    "floor_switch_secs": (FLOOR_SWITCH_SECS, float, 0.0, 3600.0),
    "floor_tenure_bonus": (0.05, float, 0.0, 0.5),      # extra margin at full tenure
    "floor_tenure_full_secs": (600.0, float, 1.0, 86400.0),
    # How much a floor's confidence is scaled by how near its nearest receiver
    # is, relative to the nearest receiver on any competing floor (see
    # _proximity_weighted_scores). 0 = pure fit-quality election.
    "floor_proximity_weight": (0.5, float, 0.0, 1.0),
    # How many of a floor's nearest receivers that proximity term averages.
    # One receiver straight through a wood floor can read nearer than the
    # receivers in the room (a dog on the sun-room floor: basement 1.7 m,
    # ground 1.9 m); the three nearest cannot (3.1 m vs 4.9 m).
    "floor_proximity_k": (3, int, 1, 8),
    # Where receiver calibration writes its corrections. "sextant": a per-receiver
    # distance multiplier in this layout (the original behaviour). "bermuda":
    # the equivalent per-scanner rssi offset written into Bermuda itself
    # (needs a Bermuda build with the rssi_offsets API), so Bermuda's own
    # area/distance sensors are corrected too and Sextant applies nothing twice.
    "calibration_target": ("sextant", str, ("sextant", "bermuda")),
    # Fingerprint fusion (fingerprint.py). "geometric" is the trilateration
    # alone. "fingerprint" places the tracker at the best-matching reference
    # receivers and only falls back to the fit where no reference exists.
    # "fused" blends both: the fix is (1 - fingerprint_weight) x geometric +
    # fingerprint_weight x fingerprint, and each floor's election confidence
    # is blended the same way with fingerprint_floor_weight. Either non-
    # geometric mode also lets a floor with fewer than three receivers
    # compete, on its fingerprint alone.
    "position_estimator": ("geometric", str, ("geometric", "fingerprint", "fused")),
    "fingerprint_weight": (0.5, float, 0.0, 1.0),
    "fingerprint_floor_weight": (0.5, float, 0.0, 1.0),
    "fingerprint_k": (3, int, 1, 8),                    # references averaged per fix
    "fingerprint_missing_m": (12.0, float, 2.0, 50.0),  # "not heard" counts as this far
    "fingerprint_ref_gain": (1.0, float, 0.25, 4.0),    # probe beacons hotter (<1) / cooler (>1) than trackers
    # Learn the rest of that gain from the trackers themselves: every match
    # yields the median ratio between the tracker's ranges and its best
    # reference's, and the learned factor (fingerprint.ReferenceDB.learn)
    # multiplies fingerprint_ref_gain. Reported per fix as fp.gain.
    "fingerprint_auto_gain": (True, bool),
}

# Reference fingerprints: receiver-to-receiver ranges, refreshed on a slow
# cadence at the top of the loop (the receivers do not move).
FINGERPRINT_REFRESH_SECS = 20.0
_fingerprint_db = fingerprint.ReferenceDB()


def _refresh_fingerprint_references(hass, layout, now_ts):
    """Sample Bermuda's scanner ranging into the reference DB when due."""
    if _tuning(layout, "position_estimator") == "geometric":
        return
    if now_ts - getattr(_refresh_fingerprint_references, "last", 0.0) < FINGERPRINT_REFRESH_SECS:
        return
    _refresh_fingerprint_references.last = now_ts
    ranging = bermuda_source.async_get_scanner_ranging(hass, max_age=fingerprint.REF_MAX_AGE_SECS)
    if ranging is None:
        if not getattr(_refresh_fingerprint_references, "warned", False):
            _refresh_fingerprint_references.warned = True
            _LOGGER.warning(
                "position_estimator is %s but this Bermuda build has no scanner_ranging API; "
                "fingerprinting stays off until Bermuda is updated",
                _tuning(layout, "position_estimator"),
            )
        return
    _fingerprint_db.ingest(ranging)


def _coerce_tuning(key, value, fallback=None):
    """Validate one tuning value against TUNING_SPEC; ``fallback`` when invalid."""
    spec = TUNING_SPEC[key]
    kind = spec[1]
    if kind is bool:
        return value if isinstance(value, bool) else fallback
    if kind is str:
        return value if isinstance(value, str) and value in spec[2] else fallback
    # not-bool: isinstance(True, int) holds in Python.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    if not spec[2] <= value <= spec[3]:
        return fallback
    return kind(value)


def _tuning(data, key):
    """A validated tuning value from the layout's top-level "tuning" map.

    Out-of-range, wrong-type or unknown values fall through to the default,
    so a hand-edited store can never poison the loop. ``data`` may be the
    layout dict or anything else (-> defaults).
    """
    default = TUNING_SPEC[key][0]
    tuning = data.get("tuning") if isinstance(data, dict) else None
    if not isinstance(tuning, dict) or key not in tuning:
        return default
    return _coerce_tuning(key, tuning[key], default)


def _layout_for(new_global_data, entity):
    """The layout dict a tracker's per-cycle data was built from (or None)."""
    for ent in new_global_data:
        if ent.get("entity") == entity:
            return ent.get("data")
    return None


# --- Per-pair distance from raw RSSI (distance_estimator = "median") ---------
MEDIAN_TARGET_SAMPLES = 5  # sample count at which a median's weight saturates


def _median_distance(reading, window_secs, min_samples):
    """(distance_m, quality) from a reading's raw RSSI history, or None.

    ``reading`` is one bermuda_source reading carrying ``history`` (newest
    first ``[rssi, stamp]`` pairs, monotonic stamps), ``age`` (seconds since
    the newest sample) and the path-loss parameters Bermuda applied. Samples
    older than ``window_secs`` are ignored; with fewer than ``min_samples``
    left the caller keeps Bermuda's own distance. The median is taken in the
    RSSI (log) domain, where the noise is closer to symmetric, and converted
    once. quality in (0, 1] rises with the sample count, so a distance backed
    by one packet pulls the fit less than one backed by five.
    """
    history = reading.get("history")
    ref_power = reading.get("ref_power")
    attenuation = reading.get("attenuation")
    if (
        not history
        or not isinstance(ref_power, (int, float)) or isinstance(ref_power, bool)
        or not isinstance(attenuation, (int, float)) or isinstance(attenuation, bool)
        or attenuation <= 0
    ):
        return None
    offset = reading.get("rssi_offset") or 0.0
    age = reading.get("age") or 0.0
    newest = None
    samples = []
    for item in history:
        try:
            rssi, stamp = float(item[0]), float(item[1])
        except (TypeError, ValueError, IndexError):
            continue
        if newest is None:
            newest = stamp
        if age + (newest - stamp) <= window_secs:
            samples.append(rssi)
    if len(samples) < max(1, int(min_samples)):
        return None
    rssi_med = float(np.median(samples))
    distance = 10.0 ** ((ref_power - (rssi_med + offset)) / (10.0 * attenuation))
    quality = min(1.0, len(samples) / MEDIAN_TARGET_SAMPLES)
    return distance, quality


def _select_receivers(entries, max_receivers, max_range, near_always):
    """Cap the receivers that feed one floor's solve.

    ``entries`` are ``(distance_m, point)`` pairs. Keeps every receiver within
    ``near_always`` metres plus the ``max_receivers`` nearest (0 = all), and
    drops anything beyond ``max_range`` (0 = no cap) once three points are
    already kept, so a floor can never be starved below the solver's minimum
    by the cap alone. Returns the points nearest-first.
    """
    entries = sorted(entries, key=lambda e: e[0])
    limit = max(int(max_receivers), 3) if max_receivers else 0
    kept = []
    for i, (distance, point) in enumerate(entries):
        if limit and i >= limit and distance > near_always:
            continue
        if max_range and distance > max_range and len(kept) >= 3:
            continue
        kept.append(point)
    return kept


def _tracker_height(data, entity=None):
    """Assumed tracker height above the floor (m) for slant correction.

    Precedence: the device's own entry in "tracker_heights" (set per tracker
    in the panel — an ankle beacon at 0.1 m and a phone at 1.0 m need
    different vertical legs), then the top-level "tracker_height" override,
    then the 1.0 m default. Out-of-range/garbage values fall through.
    """
    if isinstance(data, dict):
        per_tracker = data.get("tracker_heights")
        if entity is not None and isinstance(per_tracker, dict):
            configured = per_tracker.get(entity)
            # not-bool: isinstance(True, int) holds in Python, so a hand-edited
            # true/false would otherwise read as a valid 1.0/0.0 m height.
            if isinstance(configured, (int, float)) and not isinstance(configured, bool) \
                    and 0 <= configured <= 5:
                return float(configured)
        configured = data.get("tracker_height")
        if isinstance(configured, (int, float)) and not isinstance(configured, bool) \
                and 0 <= configured <= 5:
            return float(configured)
    return TRACKER_HEIGHT_M


HISTORY_FLUSH_INTERVAL = 60  # s between appends of buffered history to disk


def get_position_history(hass):
    """The per-install position history, created on first use."""
    bucket = hass.data.setdefault(DOMAIN, {})
    hist = bucket.get("_history")
    if hist is None:
        hist = bucket["_history"] = history_mod.PositionHistory(
            history_mod.history_config(get_layout(hass)))
    return hist


def history_dir(hass):
    """Where the NDJSON day segments live (under .storage, never web-served)."""
    return hass.config.path(".storage", history_mod.HISTORY_DIRNAME)


def _history_lock(hass):
    """Serialises every history disk operation (flush, prune, restore, clear).

    Without it a Clear can be undone: the periodic flush drains the queue and
    hands it to the executor, the Clear deletes the segments, and then the
    append lands - putting the forgotten positions back on disk, where the next
    restart reads them in again. The per-tracker rewrite has the mirror problem
    (read-filter-replace losing rows an append wrote in the meantime).
    """
    bucket = hass.data.setdefault(DOMAIN, {})
    lock = bucket.get("_history_lock")
    if lock is None:
        lock = bucket["_history_lock"] = asyncio.Lock()
    return lock


def _history_prunable_max_age(hass, hist):
    """The retention to prune against, or None when it can't be trusted.

    Pruning DELETES days of record irreversibly, so it must never run on a
    guessed window: if the layout cache isn't a dict (a fresh install, or a
    store that failed to load this boot) history_config falls back to the 6 h
    default, which would take a configured 7-day record down to six hours.
    """
    layout = get_layout(hass)
    if not isinstance(layout, dict):
        return None
    return hist.cfg["max_age"]


async def flush_position_history(hass, prune=False):
    """Append buffered points to today's segment; optionally prune old days.

    All file work happens in the executor. Failing here loses at most the
    buffered points (the in-memory ring is untouched), so it must never
    propagate into the tracking loop.
    """
    hist = get_position_history(hass)
    hist.configure(history_mod.history_config(get_layout(hass)))
    # Age every track, not just the ones that recorded this cycle: a tracker
    # that went silent (or a history since switched off) would otherwise keep
    # serving points past the configured window.
    hist.evict_all()
    if not hist.pending_count() and not prune:
        return
    dirpath = history_dir(hass)
    max_age = _history_prunable_max_age(hass, hist) if prune else None

    async with _history_lock(hass):
        # Drain INSIDE the lock so a Clear cannot slip between the drain and
        # the write and be overwritten by it.
        grouped = hist.drain_pending()
        if not grouped and max_age is None:
            return

        def _work():
            if grouped:
                history_mod.append_segments(dirpath, grouped)
            if max_age is not None:
                history_mod.prune_segments(dirpath, max_age)

        try:
            await hass.async_add_executor_job(_work)
        except Exception:
            # The write failed; put the rows back rather than dropping them on
            # the floor. requeue() honours the pending cap, so a disk that
            # stays broken cannot grow this without bound.
            hist.requeue(grouped)
            raise


async def restore_position_history(hass):
    """Reload the retained window from disk at startup.

    Every restored track is gap-marked afterwards: the integration was down
    for an unknown span, so the first new fix must start a fresh polyline
    rather than draw a straight line across the outage.
    """
    hist = get_position_history(hass)
    # A config-entry reload re-enters setup with the SAME PositionHistory:
    # async_unload_entry cancels the tracking task but leaves hass.data[DOMAIN]
    # alone, so re-reading the segments would append a second copy of every
    # point already held and leave the arrays unsorted, breaking every bisect
    # in query() and evict(). There is nothing to restore into a live ring.
    if hist.entities() or hist.pending_count():
        hist.mark_all_gaps()
        return
    dirpath = history_dir(hass)
    cfg = dict(hist.cfg)
    # Same rule as the periodic flush: pruning DELETES days irreversibly, so it
    # must never run on a guessed window. At startup the layout may not have
    # loaded (or may be unreadable this boot), in which case history_config
    # hands back the 6 h default - and pruning with that would take a
    # configured 7-day record down to six hours on every restart.
    prune_max_age = _history_prunable_max_age(hass, hist)

    # Parse AND build the tracks off the loop: the retained window can be
    # hundreds of thousands of rows and this runs during setup.
    def _work():
        if prune_max_age is not None:
            history_mod.prune_segments(dirpath, prune_max_age)
        loaded = history_mod.PositionHistory(cfg)
        loaded.load_rows(history_mod.restore_recent(dirpath, cfg))
        # The rows came FROM disk; nothing here needs writing back out.
        loaded.drain_pending()
        return loaded

    try:
        async with _history_lock(hass):
            loaded = await hass.async_add_executor_job(_work)
    except Exception as e:
        _LOGGER.warning("Sextant position history could not be restored: %s", e)
        return
    hist.adopt(loaded)
    hist.mark_all_gaps()
    ents = hist.entities()
    _LOGGER.info("Sextant position history restored: %d points across %d trackers",
                 sum((hist.retained(e) or {}).get("points", 0) for e in ents), len(ents))


def _reading_max_age(data):
    """Seconds after which a distance reading is ignored (0 = never)."""
    if isinstance(data, dict):
        configured = data.get("reading_max_age")
        if isinstance(configured, (int, float)) and not isinstance(configured, bool) \
                and configured >= 0:
            return float(configured)
    return READING_MAX_AGE_SECS


def _reading_age_secs(state):
    """Age of a state in seconds, or None when it can't be determined.

    Uses ``last_updated`` (falling back to ``last_changed``) rather than
    ``last_reported``: Home Assistant only bumps ``last_updated`` when the
    value actually changes, so a sensor that keeps re-reporting the SAME stale
    distance still ages out — which is exactly the stuck-reading case. Returns
    None (i.e. "don't gate") if the timestamps are missing or unusable, so an
    unexpected state object can never blank out the whole map.
    """
    ts = getattr(state, "last_updated", None) or getattr(state, "last_changed", None)
    if ts is None:
        return None
    try:
        return max(0.0, time.time() - ts.timestamp())
    except (AttributeError, OSError, OverflowError, TypeError, ValueError):
        return None


def _tracker_ref_offset(data, entity):
    """This tracker's ref-power trim in dB (0.0 when unset). See issue #92."""
    if not isinstance(data, dict) or entity is None:
        return 0.0
    offsets = data.get("tracker_ref_offsets")
    if not isinstance(offsets, dict):
        return 0.0
    value = offsets.get(entity)
    # not-bool: isinstance(True, int) holds in Python, so a hand-edited
    # true/false would otherwise read as a valid +1 dB trim.
    if isinstance(value, (int, float)) and not isinstance(value, bool) \
            and abs(value) <= TRACKER_REF_OFFSET_MAX_DB:
        return float(value)
    return 0.0


def _tracker_distance_factor(data, entity):
    """Multiplicative distance scale from this tracker's ref-power trim.

    A ref_power offset of `delta` dB scales every distance by
    10 ** (delta / (10 * attenuation)) in Bermuda's path-loss model, so a
    positive trim reads the tracker as FARTHER and a negative one as nearer.
    Returns 1.0 (no-op) when no trim is configured.
    """
    offset = _tracker_ref_offset(data, entity)
    if offset == 0.0:
        return 1.0
    return 10.0 ** (offset / (10.0 * PATH_LOSS_EXPONENT))


def _floor_scale(data, entity, floor_name):
    """Pixels-per-metre for a tracker's elected floor (None if unknown)."""
    for ent in data:
        if ent.get("entity") == entity:
            for floor in ent["data"]["floor"]:
                if floor["name"] == floor_name:
                    return floor.get("scale")
    return None


def _jump_weight(r, prev_r, min_wr):
    """Soft down-weight for a radius that jumped since the previous update.

    Radii are clamped to the physical minimum for the comparison: a tracker
    genuinely next to a receiver bounces between sub-clamp readings from pure
    RSSI noise (0.1 <-> 0.3 m is noise, not motion), and an unclamped relative
    gate would penalize that — its most informative receiver — every tick.
    The slant-collapse pathology needs no gate help: the projection floor
    keeps a collapsed radius constant at the clamp (rel = 1 either way) and
    the measured-slant weight radius bounds its influence in the solve.
    """
    if prev_r is None:
        return 1.0  # first sighting on this floor: no basis to distrust it
    r_eff, prev_eff = max(r, min_wr), max(prev_r, min_wr)
    rel = max(r_eff / prev_eff, prev_eff / r_eff)  # symmetric relative change, >= 1
    return 1.0 / (1.0 + ((rel - 1.0) / RADIUS_JUMP_TOL) ** 2)


def _kalman_position_update(entity, floor_name, meas, scale, bounds):
    """Constant-velocity Kalman filter on the trilaterated pixel position.

    ``meas`` is the newest ``(x, y)`` fix in this floor's pixel space. Noise is
    specified in metres via the module KF_* constants and scaled to pixels with
    ``scale`` (pixels per metre) so the smoothing is resolution-independent. The
    state is (re)initialised at the measurement with zero velocity whenever there
    is no prior state, the elected floor changed (coordinates live in a different
    pixel space), or the gap since the last fix exceeds KF_MAX_GAP_S (the tracker
    was out of range, so its velocity is meaningless). Returns the filtered
    ``(x, y)`` clipped to ``bounds``; the raw fix is what feeds the filter, so the
    estimate is never biased by zone snapping applied downstream.
    """
    s = scale if isinstance(scale, (int, float)) and scale > 0 else 1.0
    r_var = (KF_MEAS_NOISE_M * s) ** 2          # measurement variance (px^2)
    a_var = (KF_ACCEL_NOISE_MS2 * s) ** 2       # accel variance (px^2/s^4)
    zx, zy = float(meas[0]), float(meas[1])
    now = time.time()
    st = _kf_position_state.get(entity)

    def _clip(px, py):
        if bounds is None:
            return px, py
        minx, miny, maxx, maxy = bounds
        return min(max(px, minx), maxx), min(max(py, miny), maxy)

    if st is None or st["floor"] != floor_name or now - st["ts"] > KF_MAX_GAP_S:
        v_var = (KF_INIT_VEL_UNC_MS * s) ** 2
        _kf_position_state[entity] = {
            "x": np.array([zx, zy, 0.0, 0.0], dtype=float),
            "P": np.diag([r_var, r_var, v_var, v_var]).astype(float),
            "ts": now,
            "floor": floor_name,
        }
        return _clip(zx, zy)

    dt = min(max(now - st["ts"], 1e-3), KF_MAX_DT_S)
    x, P = st["x"], st["P"]
    F = np.array(
        [[1, 0, dt, 0], [0, 1, 0, dt], [0, 0, 1, 0], [0, 0, 0, 1]], dtype=float
    )
    # Piecewise white-noise-acceleration process covariance, per axis.
    dt2 = dt * dt
    dt3 = dt2 * dt
    dt4 = dt3 * dt
    q_axis = np.array([[dt4 / 4.0, dt3 / 2.0], [dt3 / 2.0, dt2]]) * a_var
    Q = np.zeros((4, 4))
    Q[np.ix_([0, 2], [0, 2])] = q_axis  # x, vx
    Q[np.ix_([1, 3], [1, 3])] = q_axis  # y, vy

    # Predict.
    x = F @ x
    P = F @ P @ F.T + Q
    # Update with the position measurement.
    H = np.array([[1, 0, 0, 0], [0, 1, 0, 0]], dtype=float)
    R = np.diag([r_var, r_var]).astype(float)
    z = np.array([zx, zy], dtype=float)
    S = H @ P @ H.T + R
    K = P @ H.T @ np.linalg.inv(S)
    x = x + K @ (z - H @ x)
    P = (np.eye(4) - K @ H) @ P

    st["x"], st["P"], st["ts"], st["floor"] = x, P, now, floor_name
    return _clip(float(x[0]), float(x[1]))


def cleanup_legacy_sextant_registry_and_states(hass: HomeAssistant):
    """Remove legacy duplicated Sextant ids from entity registry and state machine."""
    entity_registry = er.async_get(hass)
    legacy_registry_ids = [
        entry.entity_id
        for entry in entity_registry.entities.values()
        if LEGACY_BPS_ENTITY_PATTERN.match(entry.entity_id)
    ]
    for entity_id in legacy_registry_ids:
        _LOGGER.info("Removing legacy Sextant registry entity: %s", entity_id)
        entity_registry.async_remove(entity_id)

    legacy_state_ids = [
        state.entity_id
        for state in hass.states.async_all()
        if LEGACY_BPS_ENTITY_PATTERN.match(state.entity_id)
    ]
    for entity_id in legacy_state_ids:
        _LOGGER.info("Removing legacy Sextant state: %s", entity_id)
        hass.states.async_remove(entity_id)

async def update_tracked_entities(hass):
    """Update tracked_entities with the result of the Jinja code once per second."""
    global tracked_entities, tracked_listeners, new_global_data
    global secToUpdate
    while True:
        # Receiver liveness and the self-localization accuracy sensor are
        # receiver-side diagnostics, independent of how many beacons are being
        # tracked — so they run on their own slow cadence at the TOP of the loop,
        # BEFORE the "too few trackers" early-continues below (otherwise a fresh
        # deploy, or any time nobody is home, would never publish them).
        now_ts = time.time()
        if now_ts - getattr(update_tracked_entities, "last_liveness", 0.0) >= RECEIVER_DUMP_INTERVAL:
            update_tracked_entities.last_liveness = now_ts
            await update_receiver_liveness(hass)

        # Runs on the first tick too, so a fresh deploy shows a value quickly.
        # The scipy solves run in the executor so the loop is never blocked; the
        # calibration sample deques are snapshotted here on the loop thread first
        # to avoid a "mutated during iteration" race with calibration's ingest.
        # Skipped entirely while the accuracy sensor is not live in HA (the
        # user disabled it, or it has not been added yet): a leave-one-out
        # solve over every placed receiver is real work, and its only consumer
        # here is that sensor. The /api/sextant/selftest endpoint computes on
        # demand and is unaffected.
        if (
            now_ts - getattr(update_tracked_entities, "last_selftest", 0.0) >= SELFTEST_SENSOR_INTERVAL
            and _sensor_is_live(hass, ACCURACY_ENTITY_ID)
        ):
            update_tracked_entities.last_selftest = now_ts
            try:
                samples = {k: list(v) for k, v in get_calibration_state(hass).get("samples", {}).items()}
                result = await hass.async_add_executor_job(run_selftest, hass, samples)
                state, attrs = _selftest_summary(result)
                update_sextant_sensor_state(hass, ACCURACY_ENTITY_ID, state, attrs)
            except Exception as e:  # never let the diagnostic sensor stall tracking
                _LOGGER.warning("Sextant self-test sensor update failed: %s", e)

        # Persist the position history at a slow cadence (and prune expired day
        # segments hourly), so a restart does not lose the scrubback window.
        if now_ts - getattr(update_tracked_entities, "last_history_flush", 0.0) >= HISTORY_FLUSH_INTERVAL:
            update_tracked_entities.last_history_flush = now_ts
            prune_due = now_ts - getattr(update_tracked_entities, "last_history_prune", 0.0) >= 3600
            if prune_due:
                update_tracked_entities.last_history_prune = now_ts
            try:
                await flush_position_history(hass, prune=prune_due)
            except Exception as e:  # disk trouble must not stop tracking
                _LOGGER.warning("Sextant position history flush failed: %s", e)

        try:
            # This used to render a Jinja template that selected every
            # "sensor.*_distance_to_*" and then intersect it with the Bermuda
            # ones. The intersection was provably the second list: both walk
            # hass.states.async_all("sensor") and both require "_distance_to_"
            # in the id, so the template only ever added look-alikes from other
            # integrations for the next line to discard again. Rendering a
            # template over every sensor state, once a second, to compute a
            # superset of a list we already have was the single cost in this
            # loop that grew with the size of the user's Home Assistant rather
            # than with the number of beacons.
            tracked_entities = _bermuda_distance_sensor_ids(hass)

            await prune_stale_positions(hass)

            # Which devices to track, and how many usable readings exist.
            #
            # Both used to be derived from the distance entities, which meant
            # "trackable" really meant "has entities enabled". Ask Bermuda what
            # it is actually tracking instead: it creates those entities only
            # for devices with create_sensor set, so the two agree - except the
            # API answer still works when the entities are disabled.
            tracked_prefixes = bermuda_source.async_get_tracked_device_prefixes(hass)
            if tracked_prefixes is not None:
                unique_values = sorted(tracked_prefixes)
                readings = bermuda_source.async_get_readings(hass) or {}
                # Count device<->scanner pairs with a live distance, which is
                # what the entity count approximated before.
                num_points = sum(
                    1
                    for (prefix, _slug), reading in readings.items()
                    if prefix in tracked_prefixes and reading.get("distance") is not None
                )
            else:
                num_points = len(tracked_entities)
                unique_values = list(
                    {item.split("_distance_to_")[0].replace("sensor.", "") for item in tracked_entities}
                )

            if not unique_values:
                _LOGGER.info("There are no devices present to track, sleep 10 seconds")
                await asyncio.sleep(10)
                continue  # Skip and start over
            if num_points < 3:
                _LOGGER.info("There are not enough trackers with available data to track, sleep 10 seconds")
                await asyncio.sleep(10)
                continue  # Skip and start over
            # A tracker added to Bermuda since setup has no sensors yet.
            from .sensor import ensure_sensors_for_trackers  # sensor.py imports this package
            ensure_sensors_for_trackers(hass, unique_values)
            # Use a separate copy per entity to avoid cross-entity mutation side effects.
            layout = get_layout(hass)
            _refresh_fingerprint_references(hass, layout, now_ts)
            new_global_data = [{"entity": ent, "data": copy.deepcopy(layout)} for ent in unique_values]

            await process_entities(hass, new_global_data)
            async_dispatcher_send(hass, SIGNAL_BPS_UPDATE, _push_payload(hass))

        except Exception as e:
            _LOGGER.info(f"Error executing Jinja code: {e}")

        await asyncio.sleep(secToUpdate)  # Run every X seconds, set timer in global variables


# State strings that mean "not working" when a status/availability entity is read.
_OFFLINE_STATES = {
    "", "unavailable", "unknown", "none", "off", "false",
    "not_home", "offline", "disconnected", "no",
}


def _state_looks_online(state):
    """Whether a status/availability entity's state reads as online."""
    if state is None:
        return False
    return str(state).strip().lower() not in _OFFLINE_STATES


def _bermuda_distance_sensor_ids(hass):
    """Entity ids of the ``sensor.*_distance_to_*`` sensors that actually belong
    to the ``bermuda`` integration.

    Other integrations expose look-alike distance sensors — e.g. an ESPHome
    mmWave presence sensor's ``..._distance_to_detection_object`` — which are not
    tracker-to-scanner distances and must never feed Sextant. Every place that
    enumerates distance sensors (device tracking, the receiver/beacon debug
    views, the receiver picker) goes through this, mirroring the same
    ``platform == "bermuda"`` guard ``sensor.get_filtered_entities`` already
    applies to the sensor-creation path.
    """
    # Prefer Bermuda's direct API when available. This used to prefer the
    # entity REGISTRY instead (which survives entities being disabled), but
    # that stops working entirely once a user sets `create_scanner_entities
    # = False` on Bermuda's side: with no entities being created, there is
    # nothing in the registry to find, disabled or not. The synthetic ids
    # below aren't real entity_ids - every caller here only ever parses them
    # for their (device, scanner) halves, never resolves them back to an
    # actual entity - so a live-snapshot source works exactly as well and
    # needs no registry at all.
    if bermuda_source.async_api_available(hass):
        pairs = bermuda_source.async_get_snapshot_distance_pairs(hass)
        if pairs is not None:
            return pairs

    ent_reg = er.async_get(hass)
    ids = []
    for st in hass.states.async_all("sensor"):
        eid = st.entity_id
        if "_distance_to_" not in eid:
            continue
        entry = ent_reg.async_get(eid)
        if entry is None or entry.platform != "bermuda":
            continue
        ids.append(eid)
    return ids


def _scanner_slugs_and_readings(hass):
    """Single pass over Bermuda distance sensors: every scanner slug Bermuda
    exposes, and the subset that currently has a live reading (for the heuristic
    tier)."""
    allowed = set(_bermuda_distance_sensor_ids(hass))
    slugs = {eid.split("_distance_to_", 1)[1] for eid in allowed}

    # Which scanners currently have a live reading. With the distance entities
    # disabled there are no states to inspect, so ask Bermuda directly: a
    # non-None distance is exactly what a non-unknown entity state meant.
    readings = bermuda_source.async_get_readings(hass)
    if readings is not None:
        with_reading = {
            scanner_slug
            for (_device_prefix, scanner_slug), reading in readings.items()
            if reading.get("distance") is not None
        }
        return slugs, with_reading

    with_reading = set()
    for st in hass.states.async_all("sensor"):
        eid = st.entity_id
        if eid not in allowed:
            continue
        if st.state not in (None, "", "unknown", "unavailable"):
            with_reading.add(eid.split("_distance_to_", 1)[1])
    return slugs, with_reading


_SCANNER_TOKEN_RE = re.compile(r"^[0-9a-f]{5,12}$")


def _scanner_token(slug):
    """The trailing hardware id Bermuda embeds in a scanner slug — the hex group
    derived from the device's MAC, e.g. 'master_bedroom_esp32c5_f17464' ->
    'f17464'. This survives renames of the human-readable prefix, so it is a
    stable identity for a physical scanner. None when the slug has no hex tail.
    """
    if not slug:
        return None
    last = str(slug).rsplit("_", 1)[-1].lower()
    return last if _SCANNER_TOKEN_RE.match(last) else None


def _suggest_scanner(placement_slug, stored_uid, candidates):
    """Best live scanner slug to re-link a stale placement to. Prefer a shared
    hardware token (an explicitly-stored uid, else the placement's own trailing
    token — the same physical scanner after a rename); otherwise fall back to
    plain string similarity. Returns a candidate slug or None.
    """
    token = stored_uid or _scanner_token(placement_slug)
    if token:
        tok_matches = [c for c in candidates if _scanner_token(c) == token]
        if len(tok_matches) == 1:
            return tok_matches[0]
    best, best_score = None, 0.0
    for c in candidates:
        score = difflib.SequenceMatcher(None, str(placement_slug), c).ratio()
        if score > best_score:
            best, best_score = c, score
    return best if best_score >= 0.55 else None


_MAC_SUFFIX_RE = re.compile(r"_([0-9a-f]{2}(?:_[0-9a-f]{2}){5})$")


def _mac_tail_matches(token, mac):
    """True when a placed slug's hex token is the tail of a MAC/uid."""
    if not token or not mac:
        return False
    return str(mac).lower().replace(":", "").endswith(str(token).lower())


def _resolve_receiver_addresses(layout, directory):
    """Give every placed receiver its scanner ADDRESS as identity.

    Receivers used to be identified by their Bermuda slug alone, which is a
    slugified DEVICE NAME: rename the device (or let Bermuda append a MAC to
    disambiguate it) and the placement silently unlinked, while the
    calibration and linking views grew heuristics to guess the match back.
    A scanner's address never changes, so it is the identity and the slug is
    just the label.

    For each receiver in ``layout`` (mutated in place):
      - a stored ``address`` present in ``directory`` is trusted, and the
        receiver's ``entity_id`` label is refreshed to that scanner's CURRENT
        slug, so a rename follows through everywhere the label is shown or
        used as a key;
      - otherwise the address is resolved by exact slug, then by the
        hardware token in the slug / ``scanner_uid`` against the scanners'
        BLE address, wifi mac and unique_id; only a unique candidate that no
        other placement already claims is taken.

    Returns ``(changed, unresolved)``: whether anything was written, and the
    slugs that could not be resolved (left as they were; slug lookups still
    work for them).
    """
    changed = False
    unresolved = []
    if not isinstance(layout, dict) or not isinstance(directory, dict):
        return changed, unresolved
    claimed = set()
    receivers = [
        r for fl in layout.get("floor") or [] if isinstance(fl, dict)
        for r in fl.get("receivers") or [] if isinstance(r, dict)
    ]
    for receiver in receivers:
        address = receiver.get("address")
        if isinstance(address, str) and address.lower() in directory:
            claimed.add(address.lower())
    for receiver in receivers:
        slug = str(receiver.get("entity_id") or "")
        address = receiver.get("address")
        address = address.lower() if isinstance(address, str) else None
        if address in directory:
            live_slug = directory[address].get("slug")
            if live_slug and live_slug != slug:
                receiver["entity_id"] = live_slug
                changed = True
            if receiver.get("address") != address:
                receiver["address"] = address
                changed = True
            continue
        if not slug:
            continue
        candidates = [a for a, s in directory.items() if s.get("slug") == slug and a not in claimed]
        if not candidates:
            # Bermuda disambiguates duplicate scanner names by appending the
            # MAC, e.g. "sewing_room_rrn00_4e893c_dc_06_75_4e_89_3e". That
            # suffix IS the address; and once the duplicate is gone Bermuda
            # drops it again, so the plain token must be tried on the slug
            # with the suffix stripped.
            mac_suffix = _MAC_SUFFIX_RE.search(slug)
            if mac_suffix:
                mac = mac_suffix.group(1).replace("_", ":")
                if mac in directory and mac not in claimed:
                    candidates = [mac]
            base_slug = slug[: mac_suffix.start()] if mac_suffix else slug
            token = receiver.get("scanner_uid") or _scanner_token(base_slug)
            if token:
                candidates = [
                    a for a, s in directory.items()
                    if a not in claimed and (
                        _mac_tail_matches(token, a)
                        or _mac_tail_matches(token, s.get("address_wifi_mac"))
                        or _mac_tail_matches(token, s.get("unique_id"))
                        or _scanner_token(s.get("slug") or "") == token
                    )
                ]
        if len(candidates) == 1:
            found = candidates[0]
            receiver["address"] = found
            claimed.add(found)
            live_slug = directory[found].get("slug")
            if live_slug and live_slug != slug:
                receiver["entity_id"] = live_slug
            changed = True
        else:
            unresolved.append(slug)
    return changed, unresolved


async def async_resolve_receiver_addresses(hass) -> bool:
    """Resolve/refresh receiver addresses against Bermuda and persist changes.

    Cheap when nothing changed (a dict walk over the placements), so it runs
    at startup and again every liveness tick: Bermuda may not have known a
    scanner yet at boot, and a rename should be picked up within seconds.
    """
    directory = bermuda_source.async_get_scanner_directory(hass)
    if not directory:
        return False
    layout = get_layout(hass)
    if not isinstance(layout, dict):
        return False
    probe = copy.deepcopy(layout)
    changed, _unresolved = _resolve_receiver_addresses(probe, directory)
    if not changed:
        return False
    async with LAYOUT_LOCK:
        data = get_layout_for_edit(hass)
        if not isinstance(data, dict):
            return False
        changed, unresolved = _resolve_receiver_addresses(data, directory)
        if not changed:
            return False
        await save_layout(hass, data)
    _LOGGER.info(
        "Receiver identities refreshed from Bermuda (%s unresolved: %s)",
        len(unresolved), ", ".join(unresolved) if unresolved else "none",
    )
    return True


def _placed_receivers(coordinates_json):
    """Placed receivers as (floor_name, entity_id slug, stored scanner_uid, address).

    Parsed defensively: a malformed or hand-edited bpsdata.txt yields [] rather
    than raising into a caller (diagnostics must never break read_text). Each
    entity_id must be a non-empty string — a non-string slug isn't a real
    scanner name and would be unhashable when callers build a set of slugs.
    """
    placed = []
    try:
        parsed = json.loads(coordinates_json)
        floors = parsed.get("floor") if isinstance(parsed, dict) else None
        for fl in floors if isinstance(floors, list) else []:
            if not isinstance(fl, dict):
                continue
            receivers_ = fl.get("receivers")
            for rec in receivers_ if isinstance(receivers_, list) else []:
                if isinstance(rec, dict) and isinstance(rec.get("entity_id"), str) and rec["entity_id"]:
                    address = rec.get("address")
                    placed.append((fl.get("name"), rec["entity_id"], rec.get("scanner_uid"),
                                   address.lower() if isinstance(address, str) else None))
    except Exception:
        return []
    return placed


# Distance-sensor states that mean "no distance right now" (as opposed to a
# real numeric reading). Shared by the diagnostics and the linking debug view.
_NO_DISTANCE_STATES = (None, "", "unknown", "unavailable")


def _scanner_diagnostics(hass, coordinates_json):
    """Compare placed receivers against the scanner slugs Bermuda actually
    exposes, to flag naming mismatches (issue #64):
      - unmatched_receivers: a placed slug that has NO matching distance sensor
        (a genuinely wrong/stale name), each with a suggested live scanner.
      - unplaced_scanners: scanner slugs currently reporting a distance that
        aren't placed on any floor.
    """
    slugs, with_reading = _scanner_slugs_and_readings(hass)
    placed = _placed_receivers(coordinates_json)
    placed_slugs = {p[1] for p in placed}
    directory = bermuda_source.async_get_scanner_directory(hass) or {}
    # Candidates for a re-link: live scanner slugs not already correctly placed.
    free = [s for s in slugs if s not in placed_slugs]
    unmatched = []
    for fname, slug, uid, address in placed:
        if address and address in directory:
            continue  # identified by address: linked whatever its label says
        if slug in slugs:
            continue  # a real sensor exists (offline is a separate concern)
        unmatched.append({
            "entity_id": slug,
            "floor": fname,
            "suggested": _suggest_scanner(slug, uid, free),
        })
    unplaced = sorted(with_reading - placed_slugs)
    return {"unmatched_receivers": unmatched, "unplaced_scanners": unplaced}


def _scanner_linking(hass, coordinates_json):
    """Debug view for issue #64: for every placed receiver, the Bermuda distance
    sensors that feed it and each one's current state.

    This distinguishes the two failure modes David couldn't tell apart from the
    map alone: a receiver correctly linked but simply not reporting a distance
    right now ("silent" — usually just no recent BLE contact), versus one whose
    name matches no distance sensor at all ("unmatched" — a real naming
    mismatch). Reads live HA state directly, so it does not depend on a device
    being actively tracked. Returns:
      - placed:   one row per placed receiver with its status and per-device
                  readings (the exact `<device>_distance_to_<slug>` sensors
                  update_receiver_radii looks up).
      - unplaced: scanner slugs that have distance sensors but no placement,
                  for context (a superset of the diagnostics' "reporting" list).
    """
    by_slug = {}
    readings = bermuda_source.async_get_readings(hass)
    if readings is not None:
        # Prefer live readings over hass.states: with the distance entities
        # disabled (or, since create_scanner_entities=False, not created at
        # all) there is no entity state to read regardless of what
        # _bermuda_distance_sensor_ids returns. A reading exists here for
        # every (device, scanner) pair Bermuda has EVER built an advert for,
        # with distance=None once that reading times out - which is exactly
        # the "silent" (linked but not reporting) signal below, the same as
        # a disabled entity holding its last state indefinitely used to be.
        for (device_slug, scanner_slug), reading in readings.items():
            eid = f"sensor.{device_slug}_distance_to_{scanner_slug}"
            state = None if reading.get("distance") is None else str(reading["distance"])
            by_slug.setdefault(scanner_slug, []).append({"device": device_slug, "entity_id": eid, "state": state})
    else:
        allowed = set(_bermuda_distance_sensor_ids(hass))
        for st in hass.states.async_all("sensor"):
            eid = st.entity_id
            if eid not in allowed:
                continue
            device_part, slug = eid.split("_distance_to_", 1)
            device = device_part[len("sensor."):] if device_part.startswith("sensor.") else device_part
            state = None if st.state is None else str(st.state)
            by_slug.setdefault(slug, []).append({"device": device, "entity_id": eid, "state": state})

    def _reporting(sensors):
        return [s for s in sensors if s["state"] not in _NO_DISTANCE_STATES]

    placed = _placed_receivers(coordinates_json)
    placed_slugs = {p[1] for p in placed}
    rows = []
    directory = bermuda_source.async_get_scanner_directory(hass) or {}
    for fname, slug, uid, address in placed:
        # Identified by address: read the sensors under the scanner's CURRENT
        # slug, so a placement whose label lags a rename still shows as linked.
        live_slug = directory.get(address, {}).get("slug") if address else None
        sensors = sorted(by_slug.get(live_slug or slug) or by_slug.get(slug, []), key=lambda s: s["device"])
        reporting = _reporting(sensors)
        if not sensors and not (address and address in directory):
            status = "unmatched"
        elif reporting:
            status = "live"
        else:
            status = "silent"
        rows.append({
            "entity_id": slug,
            "floor": fname,
            "scanner_uid": uid,
            "address": address,
            "token": _scanner_token(slug),
            "status": status,
            "sensor_count": len(sensors),
            "reporting_count": len(reporting),
            "sensors": sensors,
        })
    unplaced = []
    for slug, sensors in by_slug.items():
        if slug in placed_slugs:
            continue
        unplaced.append({
            "entity_id": slug,
            "token": _scanner_token(slug),
            "sensor_count": len(sensors),
            "reporting_count": len(_reporting(sensors)),
        })
    unplaced.sort(key=lambda u: u["entity_id"])
    return {"placed": rows, "unplaced": unplaced}


def _beacon_links(hass):
    """Debug view: for every tracked device (beacon), the receivers currently
    detecting it, sorted closest -> farthest. The inverse of _scanner_linking
    (grouped by the tracked device instead of by the scanner). Distances are
    normalized to metres only for sorting — Bermuda reports per-entity feet or
    metres — while the value is shown in its own unit. A beacon with no live
    reading still appears (empty list) so a device that's gone dark is visible.
    """
    beacons = {}  # device -> [{scanner, distance, unit}]
    readings = bermuda_source.async_get_readings(hass)
    if readings is not None:
        # Prefer live readings over hass.states - see _scanner_linking for
        # why hass.states cannot work here at all once entities are disabled
        # or, with create_scanner_entities=False, never created. The API
        # reports distance in metres always, so no unit conversion is needed.
        for (device_slug, scanner_slug), reading in readings.items():
            beacons.setdefault(device_slug, [])
            distance = reading.get("distance")
            if distance is None:
                continue
            beacons[device_slug].append({
                "scanner": scanner_slug,
                "distance": round(distance, 2),
                "unit": "m",
                "_m": distance,
            })
    else:
        allowed = set(_bermuda_distance_sensor_ids(hass))
        for st in hass.states.async_all("sensor"):
            eid = st.entity_id
            if eid not in allowed:
                continue
            device_part, slug = eid.split("_distance_to_", 1)
            device = device_part[len("sensor."):] if device_part.startswith("sensor.") else device_part
            beacons.setdefault(device, [])
            if st.state in _NO_DISTANCE_STATES:
                continue
            try:
                val = float(st.state)
            except (ValueError, TypeError):
                continue
            unit = st.attributes.get("unit_of_measurement")
            meters = val * 0.3048 if unit == "ft" else val
            beacons[device].append({
                "scanner": slug,
                "distance": round(val, 2),
                "unit": unit if isinstance(unit, str) and unit else "m",
                "_m": meters,
            })
    out = []
    for device in sorted(beacons):
        recs = sorted(beacons[device], key=lambda r: r["_m"])
        for r in recs:
            r.pop("_m", None)  # internal sort key only
        out.append({"device": device, "receivers": recs})
    return out


def _refresh_dump_ages(hass, dom, devices):
    """Update the cached per-scanner Bermuda-liveness ages from a dump payload.

    last_seen is monotonic (seconds since HA boot), not epoch; the freshest
    stamp in the payload is "now" on that clock. Re-anchor only when the payload
    aged forward — if newest didn't advance (every scanner stopped hearing
    adverts, a real fleet-wide outage) keep the previous ages so they grow with
    wall time and cross the timeout; a large backward jump is a monotonic clock
    reset (HA reboot), so accept it.
    """
    newest = 0.0
    for dev in devices.values():
        ls = dev.get("last_seen") if isinstance(dev, dict) else None
        if isinstance(ls, (int, float)) and ls > newest:
            newest = ls
    prev_newest = dom.get("rl_newest")
    now = time.time()
    if not (prev_newest is not None and prev_newest - 60 < newest <= prev_newest):
        ages = {}
        for dev in devices.values():
            if not isinstance(dev, dict) or dev.get("_is_scanner") is not True:
                continue
            slug = slugify(str(dev.get("name") or ""))
            if not slug:
                continue
            ls = dev.get("last_seen")
            ages[slug] = (newest - ls) if isinstance(ls, (int, float)) else float("inf")
        dom["rl_newest"] = newest
        dom["rl_anchor_wall"] = now
        dom["rl_ages"] = ages


def _iter_registry_devices(dev_reg):
    """Every DeviceEntry in the device registry, on any supported HA core.

    ``dev_reg.devices.values()`` is deprecated (removed in HA 2027.9): the
    registry's ``devices`` is now a view whose supported use is plain
    iteration, which yields entries. On cores older than that view, iterating
    yields device ids (it was a mapping), so those are resolved through the
    mapping - which on such cores is not deprecated.
    """
    devices = dev_reg.devices
    for item in devices:
        if isinstance(item, str):
            yield devices[item]
        else:
            yield item


def _build_device_availability(hass):
    """Maps for the device-availability tier: slug -> device, device -> entities.

    A device slug that isn't unique is dropped (ambiguous) so a stale/duplicate
    device can't decide a receiver's status.
    """
    ent_reg = er.async_get(hass)
    dev_reg = dr.async_get(hass)
    slug_to_device = {}
    ambiguous = set()
    for d in _iter_registry_devices(dev_reg):
        name = d.name_by_user or d.name
        if not name:
            continue
        slug = slugify(name)
        if not slug:
            continue
        if slug in slug_to_device and slug_to_device[slug] != d.id:
            ambiguous.add(slug)
        else:
            slug_to_device[slug] = d.id
    for slug in ambiguous:
        slug_to_device.pop(slug, None)
    device_entities = {}
    for ent in ent_reg.entities.values():
        if ent.device_id:
            device_entities.setdefault(ent.device_id, []).append(ent.entity_id)
    return slug_to_device, device_entities


async def update_receiver_liveness(hass):
    """Recompute the set of offline receivers, mirroring the Lovelace card's
    tiered status so the panel and the card agree.

    For each receiver slug Bermuda exposes, the first tier that resolves wins:
      1. Bermuda scanner liveness — last advert heard within RECEIVER_OFFLINE_SECS.
         Proximity-independent: the probes advertise iBeacons the scanners hear
         from each other, so a live scanner ages fresh even with no tracked
         device home. But Bermuda drops a downed proxy from the scanner list, so
         this tier can't see it at all — hence the fallbacks below.
      2. A `binary_sensor.<slug>_status` connectivity sensor.
      3. The receiver's HA device: online while any of its entities is not
         `unavailable`; a connectivity entity on the device is authoritative.
      4. Distance heuristic (last resort): working if some tracker got a reading
         through it recently. Only reached for a scanner with no liveness and no
         mapped device (6 of this install's receivers, whose device name doesn't
         slugify to the receiver id). An *up* scanner is caught by tier 1, so
         this can't misfire when every tracked device leaves home — it only
         decides a scanner that is both absent from the dump and deviceless.
    A receiver no tier can resolve at all is left ONLINE (never flagged).
    """
    dom = hass.data.setdefault(DOMAIN, {})
    # Receivers are identified by scanner address; keep the placements'
    # addresses and labels in step with Bermuda (a rename, or a scanner
    # Bermuda only learned about after Sextant started).
    try:
        await async_resolve_receiver_addresses(hass)
    except Exception as e:  # identity upkeep must never stop liveness
        _LOGGER.debug("Receiver identity refresh failed: %s", e)
    # Tier 1's ages come straight from Bermuda's scanner set when its API
    # exposes them: one small dict, already relative to "now", no service
    # call. The dump_devices path below is the fallback for a Bermuda build
    # without that feature - it serialises every scanner's whole advert
    # table on every poll just to reach one last_seen per scanner.
    api_ages = bermuda_source.async_get_scanner_ages(hass)
    if api_ages is not None:
        dom["rl_ages"] = api_ages
        dom["rl_anchor_wall"] = time.time()
        dom["rl_newest"] = None  # not a dump; nothing to re-anchor against
    else:
        try:
            devices = await wait_for(
                hass.services.async_call(
                    "bermuda", "dump_devices", {"configured_devices": True},
                    blocking=True, return_response=True,
                ),
                timeout=DUMP_DEVICES_TIMEOUT_S,
            ) or {}
        except TimeoutError:
            _LOGGER.warning(
                "Receiver liveness: bermuda.dump_devices timed out after %ss; "
                "skipping this refresh", DUMP_DEVICES_TIMEOUT_S,
            )
            devices = None
        except Exception as e:
            _LOGGER.info(f"Receiver liveness: dump_devices unavailable: {e}")
            devices = None

        if isinstance(devices, dict):
            _refresh_dump_ages(hass, dom, devices)
    ages = dom.get("rl_ages", {})
    elapsed = max(0.0, time.time() - dom["rl_anchor_wall"]) if dom.get("rl_anchor_wall") else 0.0

    receivers, with_reading = _scanner_slugs_and_readings(hass)
    slug_to_device, device_entities = _build_device_availability(hass)
    # Placed receivers by address: the placement's own label is what the
    # panel and card match on, so the offline list stays keyed by it, but
    # the liveness lookup goes through the address when there is one.
    directory = bermuda_source.async_get_scanner_directory(hass) or {}
    placed_address = {}
    layout = get_layout(hass)
    if isinstance(layout, dict):
        for fl in layout.get("floor") or []:
            for rec in (fl.get("receivers") or []) if isinstance(fl, dict) else []:
                if isinstance(rec, dict) and isinstance(rec.get("entity_id"), str) and isinstance(rec.get("address"), str):
                    placed_address[rec["entity_id"]] = rec["address"].lower()
        receivers = set(receivers) | set(placed_address)

    def device_online(slug):
        device_id = slug_to_device.get(slug)
        if not device_id:
            return None
        eids = device_entities.get(device_id)
        if not eids:
            return None
        # A connectivity entity reports link state directly and is authoritative:
        # ESPHome keeps its status sensor available with state "off" when the
        # proxy disconnects, so "any entity not unavailable" would miss it.
        for eid in eids:
            st = hass.states.get(eid)
            if st and st.attributes.get("device_class") == "connectivity" and st.state is not None:
                return _state_looks_online(st.state)
        saw_state = False
        for eid in eids:
            st = hass.states.get(eid)
            if st is None or st.state is None:
                continue
            saw_state = True
            if st.state != "unavailable":
                return True
        return False if saw_state else None

    def is_online(slug):
        address = placed_address.get(slug)
        if address and address in directory:
            age = directory[address].get("last_seen_age")
            if isinstance(age, (int, float)):
                return age <= RECEIVER_OFFLINE_SECS
        age = ages.get(slug)
        if age is not None:
            return (age + elapsed) <= RECEIVER_OFFLINE_SECS
        st = hass.states.get(f"binary_sensor.{slug}_status")
        if st and st.attributes.get("device_class") == "connectivity":
            return _state_looks_online(st.state)
        resolved = device_online(slug)
        if resolved is not None:
            return resolved
        # tier 4: distance heuristic (last resort). Matches the card: a receiver
        # here is online only while some tracker reads a distance through it.
        return slug in with_reading

    dom["rl_offline"] = sorted(s for s in receivers if not is_online(s))


async def update_receiver_radii(hass, eids):
    """Update receiver 'r' values (pixels) and raw 'distance' (meters) for an entity"""
    tracker_h = _tracker_height(eids["data"], eids["entity"])
    tracker_factor = _tracker_distance_factor(eids["data"], eids["entity"])
    max_age = _reading_max_age(eids["data"])
    use_median = _tuning(eids["data"], "distance_estimator") == "median"
    median_window = _tuning(eids["data"], "median_window_secs")
    median_min = _tuning(eids["data"], "median_min_samples")
    # Prefer Bermuda's direct API: it serves the same per-scanner readings from
    # memory without any of the distance_to entities existing, which avoids
    # thousands of recorder writes and websocket state_changed fan-outs. None
    # when Bermuda is absent or too old, in which case we scrape entities as
    # before. Fetched once per call, not per receiver.
    readings = bermuda_source.async_get_readings(hass, include_history=use_median)
    # Address-keyed readings need no slug map and cannot drift on a rename;
    # the slug-keyed dict remains for placements not yet resolved.
    by_address = bermuda_source.async_get_readings_by_address(hass, include_history=use_median)
    for floor in (f for f in eids["data"]["floor"] if f["scale"] is not None):
        for receiver in floor["receivers"]:
            entity_id = "sensor." + eids["entity"] + "_distance_to_" + receiver["entity_id"]
            reading = None
            address = receiver.get("address")
            if by_address is not None and isinstance(address, str) and address:
                reading = by_address.get((eids["entity"], address.lower()))
            if reading is None and readings is not None:
                reading = readings.get((eids["entity"], receiver["entity_id"]))
            # Per-point reliability of this reading in (0, 1]; only the
            # median estimator has a basis to rate one below 1.
            quality = 1.0
            if reading is not None:
                # Direct path. Distance is already metres (the API never uses
                # the user's display units), and age is seconds since the
                # scanner last actually HEARD the device rather than since the
                # value last changed - a stronger stuck-reading signal than the
                # entity path can give. A None distance is Bermuda's own
                # "this scanner can no longer hear it" timeout.
                distance_m = reading["distance"]
                age = reading["age"]
                if use_median and distance_m is not None:
                    estimate = _median_distance(reading, median_window, median_min)
                    if estimate is not None:
                        distance_m, quality = estimate
                if distance_m is None:
                    receiver.pop("distance", None)
                    continue
            else:
                rec_value = hass.states.get(entity_id)
                if rec_value is None:
                    continue
                age = _reading_age_secs(rec_value)
                try:
                    distance_m = float(rec_value.state)
                except (TypeError, ValueError):
                    continue
                # Bermuda's distance_to sensors can report in feet or
                # meters, chosen per entity. The floor scale and the
                # calibration corrections are both in meters, so normalize
                # to meters first — otherwise a feet sensor reads ~3.28x too
                # far (treated as metres), inflating its circle and pulling
                # the trilateration toward it.
                unit = rec_value.attributes.get("unit_of_measurement")
                if unit in DistanceConverter.VALID_UNITS and unit != UnitOfLength.METERS:
                    distance_m = DistanceConverter.convert(distance_m, unit, UnitOfLength.METERS)

            # Drop a STUCK reading: when a scanner stops hearing the
            # tracker its distance sensor keeps the last value instead of
            # going unavailable, and that frozen radius would anchor the
            # fix to a receiver that can no longer see the device. Removing
            # "distance" takes this receiver out of the cycle's candidate
            # solve (see extract_candidate_floors).
            if max_age and age is not None and age > max_age:
                receiver.pop("distance", None)
                _LOGGER.debug(
                    "Ignoring stale distance for %s (%.0fs old, max %.0fs)",
                    entity_id, age, max_age,
                )
                continue
            try:
                distance = distance_m
                # Per-receiver correction factor learned by the
                # calibration (calibration.py); equivalent to a
                # per-scanner RSSI offset in Bermuda's exponential model.
                correction = receiver.get("correction")
                if isinstance(correction, (int, float)) and correction > 0:
                    distance = distance * correction
                # Per-TRACKER ref-power trim (issue #92): a tag whose
                # transmit power differs from Bermuda's configured
                # ref_power reads consistently long or short from EVERY
                # receiver, which no per-receiver correction can fix.
                # Applied before the slant leg so the height geometry sees
                # the trimmed range, and included in the election distance
                # below (a per-tracker constant, so cross-floor ordering
                # for this tracker is unchanged).
                distance = distance * tracker_factor
                # Known mount height: the estimate is a slant range, so
                # remove the vertical leg (mount height vs the assumed
                # tracker height) to get the horizontal distance the 2D
                # solve actually needs. A slant shorter than the vertical
                # leg means "practically underneath" — horizontal ~ 0; the
                # solver's MIN_WEIGHT_RADIUS_M clamp keeps such a near-zero
                # radius from monopolizing the fit. The range guard also
                # rejects NaN/Infinity from a hand-edited data file (NaN
                # fails both comparisons), which would otherwise poison
                # every solve on the floor.
                horizontal = distance
                height = receiver.get("height")
                if isinstance(height, (int, float)) and 0 <= height <= 10:
                    dz = float(height) - tracker_h
                    # Floored: sqrt(d^2 - dz^2) has a singularity at
                    # d -> dz where its sensitivity blows up, and any
                    # d <= dz collapsed to EXACTLY 0. Bermuda's filtered
                    # distances are sustainedly biased low, so a filtered
                    # slant could sit below dz for many cycles and the
                    # collapsed radius (clamped to min weight radius at
                    # ~100x the weight of a 5 m receiver) dragged the fix
                    # onto that receiver — the 1.7.0 accuracy regression.
                    # The floor never exceeds the raw slant itself, so a
                    # receiver at ~tracker height (dz ~ 0, no singularity)
                    # keeps honest sub-floor readings like the no-height
                    # path does.
                    floor_sq = min(distance * distance,
                                   MIN_WEIGHT_RADIUS_M * MIN_WEIGHT_RADIUS_M)
                    horizontal = math.sqrt(max(distance * distance - dz * dz, floor_sq))
                receiver["cords"]["r"] = floor["scale"] * horizontal
                # Raw SLANT distance for the floor election: radii are in
                # per-floor pixel scales and must not be compared across
                # floors — and the dz correction must not leak in here
                # either. sqrt(d^2 - dz^2) is only valid when the tracker
                # is on the receiver's own floor, which is exactly what
                # the election hasn't decided yet: electing on corrected
                # values lets a high-mounted probe hearing the tracker
                # through the slab shrink its through-floor slant and
                # steal the election from the correct floor.
                receiver["distance"] = distance
                receiver["quality"] = quality
            except ValueError:
                #_LOGGER.info(f"Invalid numerical value: {rec_value.state}")
                pass

async def update_trilateration_and_zone(hass, new_global_data, entity):
    """Trilateration with floor hypothesis competition, soft radius-jump
    weighting and Kalman position smoothing.

    The floor used to be elected by the single nearest receiver before any
    position existed — one noisy reading through a ceiling could steal the
    tracker for a cycle (issue #94). Now the top FLOOR_CANDIDATES floors (by
    nearest receiver) are each SOLVED, scored by how well the fix explains
    that floor's whole receiver ensemble, folded into smoothed per-floor
    probabilities, and elected with incumbent hysteresis. The winning floor's
    fix continues into the unchanged Kalman/zone/publish pipeline.
    """
    global apitricords

    # Store last r-values per sensor and entity (for soft radius-jump weighting).
    if not hasattr(update_trilateration_and_zone, "last_r_values"):
        update_trilateration_and_zone.last_r_values = {}
    if not hasattr(update_trilateration_and_zone, "last_floor"):
        update_trilateration_and_zone.last_floor = {}

    candidates = extract_candidate_floors(new_global_data, entity)

    if not candidates:
        # No receiver reports any distance for this device: it is out of
        # range. The zone/floor sensors keep their last value (historical
        # behavior), but nearest-zone explicitly reports unknown.
        update_sextant_sensor_state(hass, f"sensor.{entity}_sextant_nearest_zone", "unknown")
        return

    # Get previous r-values for this entity
    last_r = update_trilateration_and_zone.last_r_values.get(entity, {})

    # Remember radii for EVERY floor with data — not only the ones solved
    # below — so a floor stays jump-gated even while unelected or briefly
    # pushed out of the candidate cut (keys include the floor: radii are in
    # per-floor pixel scales and must not be compared across floors).
    new_last_r = {}
    for cand in candidates:
        new_last_r.update({(cand["name"], pt[0], pt[1]): pt[2] for pt in cand["cords"]})

    incumbent = update_trilateration_and_zone.last_floor.get(entity)

    # Only floors with enough receivers to trilaterate compete for the solve
    # slots: an unsolvable floor whose single through-slab receiver reads
    # short must not consume a slot and push the only solvable floor out.
    # The incumbent, when solvable, ALWAYS defends its title — even ranked
    # below the cut — so nearest-slant noise alone can never evict it.
    layout = _layout_for(new_global_data, entity)
    estimator = _tuning(layout, "position_estimator")
    refs_by_floor = {}
    tracker_vec = {}
    fp_gain = 1.0
    if estimator != "geometric":
        fp_gain = _tuning(layout, "fingerprint_ref_gain")
        if _tuning(layout, "fingerprint_auto_gain"):
            fp_gain *= _fingerprint_db.learned_gain
        refs_by_floor = fingerprint.build_references(layout, _fingerprint_db.vectors(), fp_gain)
        tracker_vec = fingerprint.tracker_vector(layout)
    # A floor with references can compete on its fingerprint with a single
    # receiver hearing the tracker; trilateration alone needs three.
    solvable = [
        c for c in candidates
        if len(c["cords"]) >= 3 or (tracker_vec and c["name"] in refs_by_floor)
    ]
    to_solve = solvable[:FLOOR_CANDIDATES]
    if incumbent is not None and not any(c["name"] == incumbent for c in to_solve):
        inc_cand = next((c for c in solvable if c["name"] == incumbent), None)
        if inc_cand is not None:
            to_solve.append(inc_cand)

    # Phase 1 (event loop): prepare every candidate floor's solve inputs.
    # Phase 2 (executor): the solves themselves - the only real CPU work in
    # the cycle - run off the loop, all of this tracker's floors in one job.
    # Phase 3 (event loop): election, filter, zones, publish.
    jobs = []
    for cand in to_solve:
        floor_name, cords = cand["name"], cand["cords"]

        # Physical floor for the geometric weight and the jump comparison, in
        # this floor's pixels. Slant correction (known mount heights) makes
        # near-zero radii a normal reading, and 1/r^2 must not hand one such
        # receiver the whole fit.
        scale = _floor_scale(new_global_data, entity, floor_name)
        min_wr = MIN_WEIGHT_RADIUS_M * scale if scale else 1e-3

        # Soft radius-jump weighting (replaces the old hard 50% discard). A
        # receiver whose radius jumped versus its previous update is
        # DOWN-WEIGHTED rather than dropped, so the solver keeps enough points
        # to fix a position even while every distance is legitimately changing
        # during movement. The measured slant (px) rides along as each point's
        # weight radius, so the solver's 1/r^2 weight reflects what was
        # MEASURED — a projection collapsed to the minimum can't buy influence.
        weighted = []
        min_jump_w = 1.0
        for pt in cords:
            x, y, r, slant_px = pt[0], pt[1], pt[2], pt[3]
            quality = pt[4] if len(pt) > 4 else 1.0
            w = _jump_weight(r, last_r.get((floor_name, x, y)), min_wr)
            # The reading's own reliability (sample count behind a median)
            # multiplies the temporal gate: both are "how much to trust this
            # radius", from independent evidence.
            weighted.append((x, y, r, w * quality, slant_px))
            min_jump_w = min(min_jump_w, w)

        # The device cannot be outside the floor: bound the solver to the
        # extent of the floor's receivers and zones (with some margin) so the
        # fitted position is the best point WITHIN the map, not a runaway fix
        # that would need clamping afterwards.
        zone_polys = _floor_zone_polygons(hass, new_global_data, entity, floor_name)
        xs = [p[0] for p in weighted]
        ys = [p[1] for p in weighted]
        for _zone_id, polygon, _buffer_size, _no_go in zone_polys:
            minx, miny, maxx, maxy = polygon.bounds
            xs.extend((minx, maxx))
            ys.extend((miny, maxy))
        margin = 0.1 * max(max(xs) - min(xs), max(ys) - min(ys), 1.0)
        floor_bounds = (min(xs) - margin, min(ys) - margin, max(xs) + margin, max(ys) + margin)

        # Nothing here has moved much since last cycle (every receiver's jump
        # weight says so) and last cycle settled on this same floor: try
        # continuing from there first instead of a fresh multi-start battery.
        # See STABLE_HINT_MIN_JUMP_WEIGHT and trilaterate()'s stable_hint.
        kf_state = _kf_position_state.get(entity)
        stable_hint = None
        if (
            min_jump_w >= STABLE_HINT_MIN_JUMP_WEIGHT
            and kf_state is not None
            and kf_state.get("floor") == floor_name
        ):
            stable_hint = (float(kf_state["x"][0]), float(kf_state["x"][1]))

        jobs.append({
            "floor": floor_name, "weighted": weighted, "bounds": floor_bounds,
            "min_wr": min_wr, "stable_hint": stable_hint, "scale": scale,
            "zone_polys": zone_polys,
            "fingerprint": None if not tracker_vec or floor_name not in refs_by_floor else {
                "mode": estimator,
                "tracker": tracker_vec,
                "refs": refs_by_floor[floor_name],
                "k": _tuning(layout, "fingerprint_k"),
                "missing_m": _tuning(layout, "fingerprint_missing_m"),
                "weight": _tuning(layout, "fingerprint_weight"),
                "floor_weight": _tuning(layout, "fingerprint_floor_weight"),
                "gain": fp_gain,
            },
        })

    solved = {}  # floor name -> everything the publish pipeline needs
    if jobs:
        # asyncio.gather of synchronous work is sequential: with the solves
        # inline, every tracker's fits ran back to back on the event loop in
        # one burst per cycle. On a Pi that burst visibly stalled HA; this is
        # why the upstream interval had to go from 1 s to 15 s.
        results = await hass.async_add_executor_job(_solve_floor_jobs, jobs)
    else:
        results = []
    for job, outcome in zip(jobs, results, strict=False):
        if outcome is None:
            continue  # this floor's readings don't converge; not a contender
        fix, conf, rms_m, fp = outcome
        floor_name, weighted, floor_bounds = job["floor"], job["weighted"], job["bounds"]
        zone_polys, scale = job["zone_polys"], job["scale"]
        solved[floor_name] = {
            "fix": fix,
            "weighted": weighted,
            "bounds": floor_bounds,
            "zone_polys": zone_polys,
            "scale": scale,
            "conf": conf,
            "rms_m": rms_m,     # kept for the elected floor's telemetry payload
            "fp": fp,           # fingerprint match telemetry (None when unused)
        }

    # Store current r-values for next time
    update_trilateration_and_zone.last_r_values[entity] = new_last_r

    if not solved:
        # No candidate floor has three converging receivers (historical
        # behavior: sensors keep their last value until pruned).
        return

    valid_floors = {f["name"] for f in (layout or {}).get("floor", [])}

    # The elected floor was renamed or deleted in the data file: that is a
    # change of world, not a dark blip — routing it into the grace below
    # would freeze the ghost name for the grace period and then elect
    # whichever OTHER floor inherited the stale probability mass. Reset the
    # whole election state instead (exactly like a prune), so this cycle's
    # fresh scores elect the renamed floor immediately.
    if incumbent is not None and incumbent not in valid_floors:
        _floor_probability.pop(entity, None)
        _floor_challenge.pop(entity, None)
        _floor_dark_cycles.pop(entity, None)
        _floor_since.pop(entity, None)
        update_trilateration_and_zone.last_floor.pop(entity, None)
        incumbent = None

    # Dark-incumbent grace: the elected floor blipping below three receivers
    # (or its solve failing) for a few cycles is a sensor hiccup, not
    # evidence the tracker moved — hold everything frozen: last published
    # values stand, probabilities are NOT updated (a competitor must not
    # accumulate election lead from the incumbent's blind cycles), and no
    # other floor inherits incumbency by forfeit. Only a disappearance
    # longer than the grace lapses the incumbency, and then the best solved
    # floor is adopted on its merits.
    if incumbent is not None and incumbent not in solved \
            and incumbent in _floor_probability.get(entity, {}):
        dark = _floor_dark_cycles.get(entity, 0) + 1
        if dark <= FLOOR_DARK_GRACE_CYCLES:
            _floor_dark_cycles[entity] = dark
            return
        incumbent = None  # dark beyond grace: incumbency lapses
    _floor_dark_cycles.pop(entity, None)
    # Fit quality alone cannot separate floors joined by an open space: a
    # phone in the office below a catwalk is explained about as well by the
    # upstairs receivers around the void as by the office ones (measured
    # live at 0.54 / 0.46, incumbent never challenged). The floor whose
    # receivers are physically nearest gets the benefit of the doubt.
    scores = _proximity_weighted_scores(
        {f: s["conf"] for f, s in solved.items()},
        {c["name"]: c.get("near_k_m", c.get("nearest_m")) for c in candidates},
        _tuning(layout, "floor_proximity_weight"),
    )
    # The floor's own prior (layout floor["bias"], default 1): in a house the
    # ground floor is where things usually are, and a phone on the kitchen
    # counter must not tie with the bedroom directly above it.
    scores = {f: s * _floor_bias(layout, f) for f, s in scores.items()}
    probs = _update_floor_probabilities(entity, scores, valid_floors)
    now = time.time()
    # The incumbent's required lead grows with how long it has held the floor
    # (up to floor_tenure_bonus at floor_tenure_full_secs), so a floor that
    # has been right for ten minutes is not unseated by one geometry fluke.
    tenure = max(0.0, now - _floor_since.get(entity, now))
    margin = FLOOR_SWITCH_MARGIN + _tuning(layout, "floor_tenure_bonus") * min(
        1.0, tenure / _tuning(layout, "floor_tenure_full_secs")
    )
    lowest_floor_name, challenge = _elect_floor(
        probs, incumbent, solved, _floor_challenge.get(entity),
        now=now, switch_secs=_tuning(layout, "floor_switch_secs"), margin=margin,
    )
    if challenge is None:
        _floor_challenge.pop(entity, None)
    else:
        _floor_challenge[entity] = challenge
    if lowest_floor_name is None:
        return  # nothing electable this cycle: keep last values

    if update_trilateration_and_zone.last_floor.get(entity) != lowest_floor_name:
        # The Kalman state holds pixel coordinates in the previously elected
        # floor's map space; it must not carry over to the newly elected floor.
        # Neither may the zone election: its polygons are that floor's.
        _kf_position_state.pop(entity, None)
        _zone_state.pop(entity, None)
        _subzone_state.pop(entity, None)
        _floor_since[entity] = now
        update_trilateration_and_zone.last_floor[entity] = lowest_floor_name

    elected = solved[lowest_floor_name]
    # The elected floor's match is the one whose tracker-vs-reference range
    # ratio says something about the probe gain; fold it in (slowly).
    fp_tel = elected.get("fp")
    if fp_tel and fp_tel.get("ratio") and _tuning(layout, "fingerprint_auto_gain"):
        _fingerprint_db.learn(fp_tel["ratio"], fp_tel.get("conf") or 0.0)
    weighted = elected["weighted"]
    zone_polys = elected["zone_polys"]
    floor_bounds = elected["bounds"]
    scale = elected["scale"]
    tricords = elected["fix"]

    if tricords is not None:
        # Constant-velocity Kalman smoothing of the published position. The RAW
        # trilaterated fix feeds the filter (so the estimate is never biased by
        # the zone snapping applied below); the filtered output is clipped to the
        # floor bounds inside the helper.
        avg_x, avg_y = _kalman_position_update(
            entity, lowest_floor_name, tricords, scale, floor_bounds
        )

        # A fix outside every zone is physically implausible (BLE noise pushed
        # it into a wall or off the apartment): publish the nearest point on
        # the zone union instead. Snapping is applied to the filter OUTPUT only;
        # the filter state keeps the raw fix, so smoothing is not biased toward
        # the boundary.
        test_point = Point(float(avg_x), float(avg_y))
        snapped = snap_point_into_zones(zone_polys, test_point)
        if snapped is not None:
            test_point = snapped
            avg_x, avg_y = float(snapped.x), float(snapped.y)
        # The instantaneous zone of the published point, and the nearest zone
        # no matter how far - both raw, cycle-by-cycle answers, still exposed
        # (nearest_zone as its own sensor, zone_raw in the API) for anything
        # that wants them.
        instant_zone = find_zone_for_point(hass, new_global_data, entity, lowest_floor_name, test_point)
        nearest_zone = find_nearest_zone(hass, new_global_data, entity, lowest_floor_name, test_point)
        # The PUBLISHED zone gets the same treatment floors already had:
        # membership probabilities smoothed over cycles, a margin and a
        # wall-clock dwell before a change, and a lock while the tracker is
        # demonstrably still. Half of all zone changes in a 24 h sample were
        # A->B->A flips at a median dwell of 21 s; this is where they went.
        zone, zone_locked, zone_speed = _elect_zone(
            entity, lowest_floor_name, instant_zone, test_point,
            _kf_position_state.get(entity), zone_polys, scale, layout, now=now,
        )
        # Sub-zone: only the elected zone's own sub-zones are eligible, with
        # membership smoothing, exit hysteresis, dwell and the zone lock (see
        # _elect_subzone). parent_zone always names the enclosing main zone.
        sub_zone, parent_zone = _elect_subzone(
            entity, lowest_floor_name, zone, zone_locked, test_point, _kf_position_state.get(entity),
            _floor_sub_zone_polygons(hass, new_global_data, entity, lowest_floor_name), scale, layout, now=now,
        )
        apitricords = update_or_add_entry(
            apitricords,
            {
                "ent": entity,
                "cords": [avg_x, avg_y],
                "zone": zone,
                "zone_raw": instant_zone,
                "zone_locked": zone_locked,
                "sub_zone": sub_zone,
                # Smoothed sub-zone membership shares (name -> share, plus
                # "unknown"), the sub-zone counterpart of "floors" below.
                "sub_zones": _subzone_probs(entity),
                "speed": None if zone_speed is None else round(zone_speed, 2),
                "floor": lowest_floor_name,
                # The exact solver input (post-correction, post-filter), for
                # the panel's trilateration circles.
                "radii": [[float(pt[0]), float(pt[1]), float(pt[2])] for pt in weighted],
                # Smoothed floor-election probabilities, for debugging "why
                # did it pick this floor" (issue #94).
                "floors": {f: round(p, 3) for f, p in probs.items()},
                # Positioning telemetry for the eval harness (tools/sextant_eval.py)
                # and the debug tab: the pre-Kalman, pre-snap trilaterated fix
                # next to the published (filtered + snapped) `cords`, so solver
                # bias can be told apart from filter lag; plus this fix's
                # weighted RMS residual (m) and the elected floor's confidence.
                # Both frontends read named fields, so these keys are inert.
                "raw": [round(float(tricords[0]), 2), round(float(tricords[1]), 2)],
                "rms_m": None if elected["rms_m"] is None else round(elected["rms_m"], 3),
                "conf": round(elected["conf"], 3),
                # Fingerprint fusion telemetry: which estimator ran, the
                # fingerprint's own fix and confidence, and the reference
                # receivers it was averaged from (see fingerprint.py).
                "estimator": estimator,
                "fp": elected.get("fp"),
                "updated": time.time(),
            },
        )
        await update_apitricords(hass, apitricords)
        # Feed the position history. Stored in METRES in this floor's frame, so
        # a later map re-export (which changes every pixel) cannot move the
        # past; the pixel projection happens at render time. A floor with no
        # scale has no metric frame, so its fixes are not recordable.
        if scale:
            try:
                get_position_history(hass).record(
                    entity, time.time(), avg_x / scale, avg_y / scale,
                    lowest_floor_name, scale, zone)
            except Exception as e:  # history must never break tracking
                _LOGGER.debug("Position history record failed for %s: %s", entity, e)
        update_sextant_sensor_state(hass, f"sensor.{entity}_sextant_zone", zone)
        update_sextant_sensor_state(hass, f"sensor.{entity}_sextant_nearest_zone", nearest_zone)
        update_sextant_sensor_state(hass, f"sensor.{entity}_sextant_floor", lowest_floor_name)
        update_sextant_sensor_state(hass, f"sensor.{entity}_sextant_sub_zone", sub_zone, {"parent_zone": parent_zone})

def _solve_floor_jobs(jobs):
    """Run one tracker's candidate-floor solves. Pure CPU; executor-safe.

    Each job carries everything the fit needs (see the phase comments in
    update_trilateration_and_zone); nothing here touches hass or the
    election state. Returns, per job, ``(fix, confidence, rms_m)`` or None
    when that floor's readings do not converge.
    """
    out = []
    for job in jobs:
        fix = conf = rms_m = None
        if len(job["weighted"]) >= 3:
            fix = trilaterate(
                job["weighted"], bounds=job["bounds"],
                min_weight_radius=job["min_wr"], stable_hint=job["stable_hint"],
            )
        if fix is not None:
            conf, rms_m, _coverage = _score_floor_fit(fix, job["weighted"], job["scale"])
            # A fit landing in this floor's no-go zone is physically impossible
            # here (issue #60): down-weight it so the competition prefers the
            # floor where that spot is a real room. Down-weight, not eliminate -
            # a sole candidate still wins and is snapped out by the caller.
            if _point_in_no_go(fix, job["zone_polys"]):
                conf *= NO_GO_CONF_PENALTY
        fix, conf, fp = _fuse_fingerprint(job.get("fingerprint"), fix, conf)
        if fix is None:
            out.append(None)
            continue
        out.append((fix, conf, rms_m, fp))
    return out


def _fuse_fingerprint(spec, geo_fix, geo_conf):
    """Blend the geometric fit with the fingerprint match for one floor.

    Returns (fix, conf, telemetry). With no fingerprint inputs the geometric
    answer passes through. In "fingerprint" mode the match replaces the
    fit (the fit is the fallback where no reference matched); in "fused"
    mode the fix is the weighted blend of the two and the confidence
    likewise, so a floor that only one estimator can place still competes
    on that estimator alone.
    """
    if spec is None:
        return geo_fix, geo_conf, None
    m = fingerprint.match(spec["tracker"], spec["refs"], k=spec["k"], missing_m=spec["missing_m"])
    telemetry = None if m is None else {
        "fix": [round(m["x"], 1), round(m["y"], 1)],
        "conf": round(m["conf"], 3),
        "score": round(m["score"], 3),
        "refs": m["refs"],
        # Tracker/reference range ratio over the receivers both were heard
        # by (>1: references read short), and the gain the references were
        # built with - the auto-gain loop's input and output.
        "ratio": None if m.get("ratio") is None else round(m["ratio"], 3),
        "gain": round(float(spec.get("gain", 1.0)), 3),
    }
    if m is None:
        return geo_fix, geo_conf, None
    if spec["mode"] == "fingerprint" or geo_fix is None:
        return (m["x"], m["y"]), m["conf"], telemetry
    w, wf = spec["weight"], spec["floor_weight"]
    fix = ((1.0 - w) * geo_fix[0] + w * m["x"], (1.0 - w) * geo_fix[1] + w * m["y"])
    conf = (1.0 - wf) * geo_conf + wf * m["conf"]
    return fix, conf, telemetry


def update_or_add_entry(data, new_entry):
    """Replace the entry for new_entry["ent"] in place, or append it.

    Every field is refreshed (the caller always builds a complete entry), so
    a new telemetry key needs no change here.
    """
    for item in data:
        if item["ent"] == new_entry["ent"]:  # Check if "ent" already exists
            item.update(new_entry)
            return data

    # If "ent" was not found, add as new post
    data.append(new_entry)
    return data


async def prune_stale_positions(hass):
    """Drop trackers not detected by any receiver for the timeout period.

    Without this, a person who left home stayed on the map at their last
    position forever, and the zone/floor sensors kept the stale values.
    """
    global apitricords
    timeout = STALE_POSITION_SECS
    layout = get_layout(hass)
    if isinstance(layout, dict):
        configured = layout.get("position_timeout")
        if isinstance(configured, (int, float)) and configured > 0:
            timeout = configured

    now = time.time()
    stale_ents = {e["ent"] for e in apitricords if now - e.get("updated", now) > timeout}
    if not stale_ents:
        return
    apitricords = [e for e in apitricords if e["ent"] not in stale_ents]
    await update_apitricords(hass, apitricords)
    # History is deliberately NOT pruned with the live entry: the point of it is
    # to survive the absence. Just break the line so the scrubber does not draw
    # a straight segment across the gap.
    try:
        hist = get_position_history(hass)
        for ent in stale_ents:
            hist.mark_gap(ent)
    except Exception as e:
        _LOGGER.debug("Position history gap mark failed: %s", e)
    for ent in sorted(stale_ents):
        # Drop the Kalman state too: a returning tracker should re-seed fresh
        # rather than predict velocity across the whole absence. Same for the
        # whole election state — probabilities, pending challenge, and the
        # INCUMBENCY itself: it may well come back on another floor, and an
        # hours-stale incumbent must not enjoy hysteresis against it (with
        # freshly-reset probabilities the margin could pin the wrong floor
        # indefinitely). Jump-gate radii from before the absence are equally
        # meaningless.
        _kf_position_state.pop(ent, None)
        _zone_state.pop(ent, None)
        _subzone_state.pop(ent, None)
        _floor_probability.pop(ent, None)
        _floor_challenge.pop(ent, None)
        _floor_dark_cycles.pop(ent, None)
        _floor_since.pop(ent, None)
        getattr(update_trilateration_and_zone, "last_floor", {}).pop(ent, None)
        getattr(update_trilateration_and_zone, "last_r_values", {}).pop(ent, None)
        _LOGGER.info("Tracker %s not seen for %ss; clearing its position", ent, timeout)
        update_sextant_sensor_state(hass, f"sensor.{ent}_sextant_zone", "unknown")
        update_sextant_sensor_state(hass, f"sensor.{ent}_sextant_floor", "unknown")
        update_sextant_sensor_state(hass, f"sensor.{ent}_sextant_nearest_zone", "unknown")
        update_sextant_sensor_state(hass, f"sensor.{ent}_sextant_sub_zone", "unknown", {"parent_zone": "unknown"})

async def update_apitricords(hass, new_data):
    """Update apitricords in hass.data"""
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["apitricords"] = new_data


def _sensor_is_live(hass, entity_id):
    """Whether a cached Sextant sensor object is actually attached to HA.

    sensor.py creates the entity objects and caches them before
    async_add_entities runs. An entity the user has DISABLED in the registry
    is never added, so it stays in the cache with ``hass`` unset forever -
    writing state to it raises ("Attribute hass is None"), which the
    accuracy sensor did every self-test cycle.
    """
    sensors_cache = hass.data.get("sextant_sensors")
    if not sensors_cache:
        return False
    sensor = sensors_cache.get(entity_id)
    return sensor is not None and getattr(sensor, "hass", None) is not None


def update_sextant_sensor_state(hass, entity_id, state, attributes=None):
    """Update state (and optional extra attributes) on a registered Sextant SensorEntity."""
    sensors_cache = hass.data.get("sextant_sensors")
    if not sensors_cache:
        return
    sensor = sensors_cache.get(entity_id)
    if sensor is None:
        return
    sensor._state = state
    if attributes is not None:
        sensor._attrs = attributes
    if getattr(sensor, "hass", None) is None:
        # Not added to HA (disabled in the registry, or not yet added). The
        # value is kept on the object so it is current if the entity is
        # enabled later; there is just no state machine to write to yet.
        return
    sensor.async_write_ha_state()

async def process_single_entity(hass, new_global_data, eids):
    """Process a single entity: first receivers, then trilateration"""
    await update_receiver_radii(hass, eids)  # Wait for the receivers to update
    await update_trilateration_and_zone(hass, new_global_data, eids["entity"])  # When it is complete → perform trilateration

async def process_entities(hass, new_global_data):
    """Process multiple entities in parallel, but ensure the correct order for each individual entity"""
    tasks = [process_single_entity(hass, new_global_data, eids) for eids in new_global_data]
    await asyncio.gather(*tasks)  # Run all entities in parallel, but maintain the correct internal order

def extract_candidate_floors(new_global_data, tmpentity):
    """Every floor hearing the tracker, ranked by its nearest receiver.

    Returns a list of {"name", "cords": [(x, y, r, slant_px, quality), ...],
    "nearest_m"} sorted by nearest_m — slant_px is the measured (corrected)
    slant distance in this floor's pixels, carried alongside the projected
    radius r so the solver can weight by what was MEASURED rather than by the
    projection (whose height-corrected value can legitimately collapse to the
    minimum); quality is the reading's own reliability in (0, 1] (see
    _median_distance), folded into the solver weight by the caller. The
    per-floor list is capped to the nearest receivers (_select_receivers,
    tuning solver_max_receivers / solver_max_range / solver_near_always).
    The ranking compares raw slant distances (meters),
    not radii: radii are scaled into each floor's own pixel space, so
    comparing them across floors would let the floor with the smallest scale
    win regardless of where the tracker actually is. Ties (the same receiver
    placed on several floors) keep the data file's floor order. Each floor's
    cords feed that floor's own candidate solve — cords from different floors
    live in different pixel coordinate systems and never mix.
    """
    candidates = []
    for entity in new_global_data:
        if entity["entity"] != tmpentity:
            continue
        layout = entity["data"]
        max_receivers = _tuning(layout, "solver_max_receivers")
        max_range = _tuning(layout, "solver_max_range")
        near_always = _tuning(layout, "solver_near_always")
        prox_k = max(1, int(_tuning(layout, "floor_proximity_k")))
        for floor in layout["floor"]:
            entries = []
            for receiver in floor["receivers"]:
                distance = receiver.get("distance")
                if distance is None or "r" not in receiver.get("cords", {}):
                    continue
                quality = receiver.get("quality")
                if not isinstance(quality, (int, float)) or isinstance(quality, bool) \
                        or not 0 < quality <= 1:
                    quality = 1.0
                entries.append((distance, (
                    receiver["cords"]["x"], receiver["cords"]["y"],
                    receiver["cords"]["r"], distance * floor["scale"], float(quality),
                )))
            # Nearest-K cap: with thirty receivers on a floor, the far ones
            # contribute mostly noise, and 1/r^2 does not zero them out.
            cords = _select_receivers(entries, max_receivers, max_range, near_always)
            nearest = min((e[0] for e in entries), default=float("inf"))
            ranked = sorted(e[0] for e in entries)[:prox_k]
            if cords:
                candidates.append({
                    "name": floor["name"],
                    "cords": cords,
                    "nearest_m": nearest,
                    # Mean of the floor_proximity_k nearest slants: what the
                    # proximity term compares across floors.
                    "near_k_m": sum(ranked) / len(ranked) if ranked else float("inf"),
                })
    candidates.sort(key=lambda c: c["nearest_m"])  # stable: file order breaks ties
    return candidates


def _score_floor_fit(fix, weighted, scale):
    """Score one candidate floor's solve. Returns (confidence, rms_m, coverage).

    Confidence blends how well the fix explains ALL of the floor's reporting
    receivers (weighted RMS residual, converted to metres so floors with
    different pixel scales compare fairly) with how many receivers corroborate
    it. Modelled on ESPresense's scenario confidence (fit quality + node
    coverage): the tracker's true floor tends to explain its whole receiver
    ensemble, while a wrong floor fits one loud through-slab reading and
    contradicts the rest.
    """
    x, y = fix
    n = len(weighted)
    num = den = 0.0
    for pt in weighted:  # (x, y, r, w[, slant_px]) — indexed so both shapes work
        xi, yi, ri, wi = pt[0], pt[1], pt[2], pt[3]
        res = math.hypot(xi - x, yi - y) - ri
        num += wi * res * res
        den += wi
    rms_px = math.sqrt(num / den) if den > 0 else float("inf")
    # Reduced-chi-square-style correction: a 3-receiver floor fits the 2
    # position unknowns almost perfectly no matter what (a single residual
    # degree of freedom), which flatters exactly the floors with the least
    # evidence. Inflate by sqrt(n / (n - 2)) so fits compete on evidence.
    rms_px *= math.sqrt(n / max(n - 2.0, 1.0))
    rms_m = rms_px / scale if scale else rms_px
    quality = 1.0 / (1.0 + (rms_m / FLOOR_RESIDUAL_SCALE_M) ** 2)
    # Corroboration: how many receivers hear the tracker on this floor,
    # saturating at COVERAGE_TARGET_N. An absolute count, NOT a share of the
    # floor's placed receivers: a dead or unmatched placement must not
    # handicap its floor forever, and a tiny fully-reporting 3-receiver floor
    # must not out-cover a floor with 6 of 8 receivers reporting.
    coverage = min(1.0, n / COVERAGE_TARGET_N)
    return 0.5 * coverage + 0.5 * quality, rms_m, coverage


def _floor_bias(layout, floor_name):
    """The floor's election prior from the layout (floor["bias"]), default 1.

    Multiplies the floor's score before the probabilities are updated, so a
    bias of 1.2 is a 20 % head start in every cycle, not a one-off nudge.
    Anything not a number in (0, 10] is ignored.
    """
    floors = layout.get("floor") if isinstance(layout, dict) else None
    for floor in floors or []:
        if isinstance(floor, dict) and floor.get("name") == floor_name:
            bias = floor.get("bias")
            if isinstance(bias, (int, float)) and not isinstance(bias, bool) and 0 < bias <= 10:
                return float(bias)
            return 1.0
    return 1.0


def _proximity_weighted_scores(scores, nearest_by_floor, weight):
    """Scale each solved floor's confidence by receiver proximity.

    ``prox`` for a floor is the nearest measured distance on ANY competing
    floor divided by this floor's own nearest, so the floor with the nearest
    receiver scores 1 and a floor whose closest receiver is twice as far
    scores 0.5; the confidence is then multiplied by
    ``(1 - weight) + weight * prox``. With one solved floor, an unusable
    distance, or weight 0, the scores pass through unchanged. Distances are
    the raw slants (metres) the candidate ranking already uses, so a
    through-slab reading directly below a tracker counts against the floor
    below it just as it did in the old nearest-receiver election - but now
    as one weighted term inside the fit competition, behind the same margin
    and dwell, rather than as the whole answer.
    """
    if not scores or not weight or weight <= 0:
        return dict(scores)
    usable = {
        f: float(d) for f, d in nearest_by_floor.items()
        if f in scores and isinstance(d, (int, float)) and not isinstance(d, bool)
        and d > 0 and math.isfinite(d)
    }
    if len(usable) < 2:
        return dict(scores)
    best = min(usable.values())
    out = {}
    for floor, conf in scores.items():
        prox = best / usable[floor] if floor in usable else 1.0
        out[floor] = conf * ((1.0 - weight) + weight * prox)
    return out


def _update_floor_probabilities(entity, scores, valid_floors=None):
    """Fold this cycle's per-floor confidences into smoothed probabilities.

    Each floor's probability moves 1-FLOOR_PROB_SMOOTHING of the way toward
    its share of this cycle's total confidence; floors with no data this
    cycle decay toward zero and are dropped once negligible, so the dict
    cannot grow unbounded. Floors no longer present in the data file
    (renamed/deleted) are dropped immediately — a ghost name must not hold
    probability mass nor appear in the published election. Returns a
    normalized copy.
    """
    probs = _floor_probability.setdefault(entity, {})
    if valid_floors is not None:
        for floor in [f for f in probs if f not in valid_floors]:
            del probs[floor]
    total = sum(scores.values())
    for floor in set(probs) | set(scores):
        target = (scores.get(floor, 0.0) / total) if total > 0 else 0.0
        probs[floor] = FLOOR_PROB_SMOOTHING * probs.get(floor, 0.0) \
            + (1.0 - FLOOR_PROB_SMOOTHING) * target
    for floor in [f for f, p in probs.items() if p < 0.01]:
        del probs[floor]
    norm = sum(probs.values())
    if norm > 0:
        for floor in probs:
            probs[floor] /= norm
    return dict(probs)


def _elect_floor(probs, incumbent, solved, challenge, now=None,
                 switch_secs=FLOOR_SWITCH_SECS, margin=FLOOR_SWITCH_MARGIN):
    """Pick the floor to publish. Returns (floor, challenge_state).

    The caller guarantees the incumbent is either solved this cycle or None
    (a dark incumbent is handled by the grace hold upstream, and one dark
    beyond the grace loses its standing entirely — incumbency is never
    transferred by forfeit, it lapses).

    A solved incumbent only loses to a challenger that leads its probability
    by ``margin`` continuously for ``switch_secs`` of wall-clock time
    (challenge_state carries the challenge's start between cycles; a cycle
    where the lead lapses ends the challenge). The margin filters share
    noise, the dwell filters geometry flukes, and together they cannot
    permanently dead-band a genuinely better floor the way a large margin
    alone would — floor flapping was the disease (issue #94), a stuck wrong
    floor must not be the cure. Wall clock rather than cycles because the
    update interval is configurable: "three cycles" meant 30 s at one
    setting and 3 s at another.
    """
    now = time.time() if now is None else now
    contenders = {f: p for f, p in probs.items() if f in solved}
    if not contenders:
        return None, None
    best = max(contenders, key=contenders.get)
    if incumbent is None or incumbent not in contenders:
        return best, None  # no standing incumbent: adopt the best immediately
    if best == incumbent or contenders[best] - contenders[incumbent] < margin:
        return incumbent, None
    since = challenge["since"] if challenge and challenge.get("floor") == best else now
    if now - since >= switch_secs:
        return best, None
    return incumbent, {"floor": best, "since": since}


# --- Zone election ------------------------------------------------------------
ZONE_SAMPLE_ANGLES = np.linspace(0.0, 2.0 * np.pi, 8, endpoint=False)
ZONE_SAMPLE_CENTER_WEIGHT = 0.4  # the rest is spread over the 1-sigma ring


def _covariance_samples(center, cov, scale=None):
    """Weighted (x, y, w) samples: the centre plus eight points on the
    1-sigma error ellipse of a 2x2 position covariance (pixels^2).

    Not a Gaussian quadrature - a cheap, deterministic stand-in for "how much
    of the position's uncertainty lies in each zone", which is all the zone
    election needs. Falls back to the centre alone when the covariance is
    unusable.
    """
    x0, y0 = float(center[0]), float(center[1])
    samples = [(x0, y0, ZONE_SAMPLE_CENTER_WEIGHT)]
    try:
        vals, vecs = np.linalg.eigh(np.asarray(cov, dtype=float).reshape(2, 2))
    except (np.linalg.LinAlgError, ValueError, TypeError):
        return [(x0, y0, 1.0)]
    if not np.all(np.isfinite(vals)) or not np.all(np.isfinite(vecs)):
        return [(x0, y0, 1.0)]
    a, b = np.sqrt(np.clip(vals, 0.0, None))
    u, v = vecs[:, 0], vecs[:, 1]
    w = (1.0 - ZONE_SAMPLE_CENTER_WEIGHT) / len(ZONE_SAMPLE_ANGLES)
    for th in ZONE_SAMPLE_ANGLES:
        c, s = math.cos(th), math.sin(th)
        samples.append((x0 + c * a * u[0] + s * b * v[0], y0 + c * a * u[1] + s * b * v[1], w))
    return samples


def _zone_membership(zone_polys, samples):
    """zone_id -> share of sample weight in (or, failing that, nearest to)
    each allowed zone. No-go zones never receive membership."""
    allowed = [(zid, poly) for zid, poly, _b, no_go in zone_polys if not no_go]
    if not allowed:
        return {}
    shares = {}
    for x, y, w in samples:
        pt = Point(x, y)
        hit = None
        for zid, poly in allowed:
            if poly.covers(pt):
                hit = zid
                break
        if hit is None:
            hit = min(allowed, key=lambda zp: zp[1].distance(pt))[0]
        shares[hit] = shares.get(hit, 0.0) + w
    total = sum(shares.values())
    return {z: s / total for z, s in shares.items()} if total > 0 else {}


def _elect_zone(entity, floor_name, instant_zone, point, kf_state, zone_polys, scale, layout, now=None):
    """The zone to PUBLISH for a tracker this cycle. Returns
    (zone, locked, speed_m_s).

    Floors already had hysteresis; zones were assigned point-wise every
    cycle, so a tracker resting near a boundary toggled with every fit.
    Three mechanisms, all tunable (TUNING_SPEC, sextant.set_tuning):

    1. Membership probability. The published point's zone is not a yes/no:
       samples on the Kalman filter's 1-sigma error ellipse are attributed
       to zones, giving a share per zone, smoothed over cycles (EMA).
    2. Margin and dwell. The incumbent zone holds until a challenger leads
       its smoothed share by zone_switch_margin continuously for
       zone_switch_secs of wall clock.
    3. Stationary lock. When the filter's speed stays under stationary_speed
       for stationary_secs, the tracker is on a table and the zone locks.
       The lock releases only when the point sits more than
       zone_unlock_margin metres outside the locked zone for
       zone_unlock_secs (the time already spent away then counts toward
       the dwell, so the switch follows at once), or when the tracker is
       clearly moving again for stationary_secs.

    nearest_zone stays instantaneous for automations that want the raw
    answer, and zone_raw in the API carries the point's own zone. Turning
    zone_hysteresis off publishes zone_raw as before.
    """
    now = time.time() if now is None else now
    valid = {zid for zid, _p, _b, no_go in zone_polys if not no_go}
    if not _tuning(layout, "zone_hysteresis") or not valid:
        _zone_state.pop(entity, None)
        return instant_zone, False, None

    st = _zone_state.get(entity)
    if st is None or st["floor"] != floor_name or (st["zone"] is not None and st["zone"] not in valid):
        st = _zone_state[entity] = {
            "floor": floor_name, "zone": None, "since": now, "probs": {},
            "challenge": None, "still_since": None, "moving_since": None,
            "away_since": None, "locked": False,
        }

    # 1. Membership, smoothed.
    center = (point.x, point.y) if isinstance(point, Point) else (point[0], point[1])
    speed = None
    if kf_state is not None and kf_state.get("floor") == floor_name:
        samples = _covariance_samples(center, kf_state["P"][:2, :2])
        if isinstance(scale, (int, float)) and scale > 0:
            speed = math.hypot(float(kf_state["x"][2]), float(kf_state["x"][3])) / scale
    else:
        samples = [(center[0], center[1], 1.0)]
    shares = _zone_membership(zone_polys, samples)
    if not shares and instant_zone in valid:
        shares = {instant_zone: 1.0}
    alpha = _tuning(layout, "zone_prob_smoothing")
    probs = st["probs"]
    for z in set(probs) | set(shares):
        probs[z] = alpha * probs.get(z, 0.0) + (1.0 - alpha) * shares.get(z, 0.0)
    for z in [z for z, p in probs.items() if p < 0.01 or z not in valid]:
        del probs[z]
    norm = sum(probs.values())
    if norm > 0:
        for z in probs:
            probs[z] /= norm

    # 3a. Stillness / motion clocks.
    if speed is not None:
        if speed < _tuning(layout, "stationary_speed"):
            st["still_since"] = st["still_since"] or now
            st["moving_since"] = None
        else:
            st["still_since"] = None
            st["moving_since"] = st["moving_since"] or now
    else:
        st["still_since"] = st["moving_since"] = None

    incumbent = st["zone"]
    if not probs:
        return (incumbent if incumbent is not None else instant_zone), False, speed
    best = max(probs, key=probs.get)
    if incumbent is None:
        st.update(zone=best, since=now, challenge=None, locked=False, away_since=None)
        return best, False, speed

    # 3b. Lock and unlock.
    stationary_secs = _tuning(layout, "stationary_secs")
    if not st["locked"] and st["still_since"] is not None and now - st["still_since"] >= stationary_secs:
        st["locked"] = True
        st["away_since"] = None
    challenge_since = None
    if st["locked"]:
        incumbent_poly = next((p for zid, p, _b, _n in zone_polys if zid == incumbent), None)
        margin_px = _tuning(layout, "zone_unlock_margin") * (scale if isinstance(scale, (int, float)) and scale > 0 else 1.0)
        pt = point if isinstance(point, Point) else Point(center)
        away = incumbent_poly is None or incumbent_poly.distance(pt) > margin_px
        st["away_since"] = (st["away_since"] or now) if away else None
        left_for_long = st["away_since"] is not None and now - st["away_since"] >= _tuning(layout, "zone_unlock_secs")
        moving_for_long = st["moving_since"] is not None and now - st["moving_since"] >= stationary_secs
        if not left_for_long and not moving_for_long:
            st["challenge"] = None
            return incumbent, True, speed
        # Unlocked. Time already spent outside counts toward the dwell below.
        challenge_since = st["away_since"]
        st.update(locked=False, still_since=None, away_since=None)

    # 2. Margin and dwell.
    margin = _tuning(layout, "zone_switch_margin")
    if best == incumbent or probs[best] - probs.get(incumbent, 0.0) < margin:
        st["challenge"] = None
        return incumbent, False, speed
    ch = st["challenge"]
    if ch and ch.get("zone") == best:
        since = ch["since"]
    else:
        since = challenge_since if challenge_since is not None else now
    if now - since >= _tuning(layout, "zone_switch_secs"):
        st.update(zone=best, since=now, challenge=None)
        return best, False, speed
    st["challenge"] = {"zone": best, "since": since}
    return incumbent, False, speed


def _subzone_with_dwell(entity, candidate, layout, now=None):
    """Publish a (sub_zone, parent_zone) pair only once it has persisted for
    subzone_switch_secs; until then the previous pair stands. Sub-zones are
    small (a couch, a desk), so they flap at least as readily as zones."""
    now = time.time() if now is None else now
    st = _subzone_state.get(entity)
    if st is None:
        _subzone_state[entity] = {"value": candidate, "pending": None}
        return candidate
    if candidate == st["value"]:
        st["pending"] = None
        return candidate
    pending = st["pending"]
    if pending is None or pending[0] != candidate:
        st["pending"] = (candidate, now)
        return st["value"]
    if now - pending[1] >= _tuning(layout, "subzone_switch_secs"):
        st["value"] = candidate
        st["pending"] = None
        return candidate
    return st["value"]

def _subzone_membership(sub_polys, samples):
    """sub-zone id -> share of sample weight inside it; samples in no
    sub-zone count toward "unknown". Unlike zones, sub-zones do not tile the
    room, so a sample outside every one of them is evidence of NO sub-zone,
    never of the nearest."""
    shares = {}
    for x, y, w in samples:
        pt = Point(x, y)
        hit = next((sid for sid, _parent, poly in sub_polys if poly.covers(pt)), "unknown")
        shares[hit] = shares.get(hit, 0.0) + w
    total = sum(shares.values())
    return {s: v / total for s, v in shares.items()} if total > 0 else {}


def _subzone_probs(entity):
    """The tracker's smoothed sub-zone shares for the telemetry payload, or None."""
    st = _subzone_state.get(entity)
    probs = st.get("probs") if isinstance(st, dict) else None
    if not probs:
        return None
    return {name: round(p, 3) for name, p in probs.items()}


def _elect_subzone(entity, floor_name, zone, zone_locked, point, kf_state, sub_polys, scale, layout, now=None):
    """The (sub_zone, parent_zone) pair to publish. parent_zone is always the
    elected main zone; sub_zone is one of its sub-zones or "unknown".

    Sub-zones are a couch, a desk, a key hook: a metre or two across, which
    is the size of the positioning error itself, so a strict point-in-polygon
    test flickered. This is the zone election scaled down:

    1. Membership: the fix's 1-sigma error ellipse is sampled and the share
       inside each sub-zone smoothed over cycles; entering needs a share of
       subzone_enter_prob, and a sample in no sub-zone is evidence of none.
    2. Hysteresis on the way out: an occupied sub-zone is only left once the
       fix sits more than subzone_unlock_margin metres outside its polygon
       (or another sub-zone clearly wins).
    3. Dwell: any change must persist for subzone_switch_secs, wall clock.
    4. The zone lock carries over: a tracker the zone election holds still
       (the phone on the table) keeps its sub-zone too.
    """
    now = time.time() if now is None else now
    polys = [(sid, parent, poly) for sid, parent, poly in sub_polys if parent == zone]
    st = _subzone_state.get(entity)
    if st is None or st.get("floor") != floor_name or st.get("zone") != zone:
        st = _subzone_state[entity] = {
            "floor": floor_name, "zone": zone, "value": ("unknown", zone), "probs": {}, "pending": None,
        }
    if not polys:
        st["value"], st["pending"] = ("unknown", zone), None
        return st["value"]
    center = (point.x, point.y) if isinstance(point, Point) else (float(point[0]), float(point[1]))
    if kf_state is not None and kf_state.get("floor") == floor_name:
        samples = _covariance_samples(center, kf_state["P"][:2, :2])
    else:
        samples = [(center[0], center[1], 1.0)]
    shares = _subzone_membership(polys, samples)
    alpha = _tuning(layout, "zone_prob_smoothing")
    probs = st["probs"]
    for s in set(probs) | set(shares):
        probs[s] = alpha * probs.get(s, 0.0) + (1.0 - alpha) * shares.get(s, 0.0)
    for s in [s for s, p in probs.items() if p < 0.01]:
        del probs[s]
    enter = _tuning(layout, "subzone_enter_prob")
    current = st["value"][0]
    contenders = {s: p for s, p in probs.items() if s != "unknown"}
    best = max(contenders, key=contenders.get) if contenders else None

    if current != "unknown" and zone_locked:
        st["pending"] = None
        return st["value"]  # a still tracker stays on its couch / table / hook

    if current != "unknown":
        cur_poly = next((poly for sid, _p, poly in polys if sid == current), None)
        if cur_poly is None:
            candidate = ("unknown", zone)  # the sub-zone was deleted or renamed
        else:
            pt = Point(*center)
            margin_px = _tuning(layout, "subzone_unlock_margin") * (scale if isinstance(scale, (int, float)) and scale > 0 else 0.0)
            still_near = cur_poly.distance(pt) <= margin_px
            if best is not None and best != current and contenders[best] >= enter and contenders[best] > probs.get(current, 0.0):
                candidate = (best, zone)
            elif still_near or probs.get(current, 0.0) >= enter:
                candidate = st["value"]
            else:
                candidate = ("unknown", zone)
    else:
        candidate = (best, zone) if best is not None and contenders[best] >= enter else ("unknown", zone)

    if candidate == st["value"]:
        st["pending"] = None
        return candidate
    pending = st["pending"]
    if pending is None or pending[0] != candidate:
        st["pending"] = (candidate, now)
        return st["value"]
    if now - pending[1] >= _tuning(layout, "subzone_switch_secs"):
        st["value"], st["pending"] = candidate, None
        return candidate
    return st["value"]


# Compiled zone/sub-zone polygons for a floor, keyed by (cache kind, floor_name)
# -> (layout_version, [result tuples]). A zone's geometry only changes when the
# user edits and saves the floorplan (get_layout_version bumps then), yet
# every position update for every tracked device used to rebuild every zone's
# shapely Polygon from scratch — repeatedly, since the solve step,
# find_zone_for_point, find_nearest_zone and find_sub_zone_for_point each
# called this independently in the same cycle. Caching against the layout
# version means a floor's polygons are compiled once per edit, not once per
# (device x lookup) per cycle.
_ZONE_POLY_CACHE_KEY = "sextant_zone_polygon_cache"


def _zone_poly_cache(hass) -> dict:
    return hass.data.setdefault(_ZONE_POLY_CACHE_KEY, {})


def _floor_zone_polygons(hass, data, entity, floor_name):
    """(zone entity_id, polygon, buffer_size, no_go) tuples for the floor.

    no_go marks a zone a tracker can't be in (issue #60). Callers keep no-go
    zones for the solver bounds (they still bound the floor) but exclude them
    from zone assignment and snapping — a fix must never be reported as, or
    snapped into, dead space.
    """
    cache = _zone_poly_cache(hass)
    cache_key = ("zones", floor_name)
    version = get_layout_version(hass)
    cached = cache.get(cache_key)
    if cached is not None and cached[0] == version:
        return cached[1]

    buffer_percent = 0.05  # set to 5%

    def order_zone_points(coords):
        """Order polygon points clockwise around centroid to avoid self-intersections.

        Only for legacy rectangle zones, whose four corners were stored in
        scan order. Polygon zones (poly: true) keep their drawn order — a
        centroid sort would corrupt concave shapes.
        """
        if len(coords) < 3:
            return coords
        center_x = sum(coord["x"] for coord in coords) / len(coords)
        center_y = sum(coord["y"] for coord in coords) / len(coords)
        return sorted(
            coords,
            key=lambda coord: np.arctan2(coord["y"] - center_y, coord["x"] - center_x)
        )

    results = []
    for entity_data in data:
        if entity_data["entity"] == entity:
            for floor in entity_data["data"]["floor"]:
                if floor["name"] == floor_name:
                    for zone in floor["zones"]:
                        coords = zone.get("cords") or []
                        if len(coords) < 3:
                            continue
                        if not zone.get("poly") and len(coords) == 4:
                            coords = order_zone_points(coords)
                        polygon = Polygon([(coord["x"], coord["y"]) for coord in coords])
                        if not polygon.is_valid:
                            # Self-intersecting drawing; make_valid keeps every
                            # lobe (buffer(0) can drop one). Keep only the
                            # areal parts of the repair.
                            repaired = (
                                shapely_make_valid(polygon)
                                if shapely_make_valid
                                else polygon.buffer(0)
                            )
                            if repaired.geom_type == "GeometryCollection":
                                parts = [
                                    g for g in repaired.geoms
                                    if g.geom_type in ("Polygon", "MultiPolygon")
                                ]
                                repaired = unary_union(parts) if parts else None
                            if repaired is None or repaired.is_empty:
                                continue
                            polygon = repaired
                        xs = [coord["x"] for coord in coords]
                        ys = [coord["y"] for coord in coords]
                        width = max(xs) - min(xs)
                        height = max(ys) - min(ys)
                        buffer_size = ((width + height) / 2) * buffer_percent
                        results.append((zone["entity_id"], polygon, buffer_size, bool(zone.get("no_go"))))
            break

    cache[cache_key] = (version, results)
    return results


def _point_in_no_go(point, zone_polys):
    """True if the point falls strictly inside any no-go zone in zone_polys.

    zone_polys is the (zone_id, polygon, buffer_size, no_go) list from
    _floor_zone_polygons. Accepts a shapely Point or an (x, y) pair. Uses
    strict containment (not boundary-inclusive covers): a no-go zone's edge is
    typically a physical railing, and a tracker genuinely ON the walkway there
    sits on that boundary — it must not be penalised as if over the void.
    """
    if not isinstance(point, Point):
        point = Point(float(point[0]), float(point[1]))
    return any(no_go and polygon.contains(point)
               for _zone_id, polygon, _buffer_size, no_go in zone_polys)


def find_zone_for_point(hass, data, entity, floor_name, point):
    """Find zone for point, prioritize correct polygon, select nearest buffer if no correct zone matches.

    No-go zones (issue #60) are skipped: a tracker can't be in one, so a fix
    there is reported as belonging to the nearest real zone (or "unknown").
    """
    buffer_candidates = []
    for zone_id, polygon, buffer_size, no_go in _floor_zone_polygons(hass, data, entity, floor_name):
        if no_go:
            continue
        # covers() also matches points on the polygon boundary.
        if polygon.covers(point):
            return zone_id  # Prioritize correct polygon
        if polygon.buffer(buffer_size).contains(point):
            # Save candidate: (distance to edge, entity_id)
            # boundary works for Polygon and MultiPolygon alike.
            buffer_candidates.append((polygon.boundary.distance(point), zone_id))
    if buffer_candidates:
        # Select zone whose edge is closest to the point
        buffer_candidates.sort()
        return buffer_candidates[0][1]
    return "unknown"


def snap_point_into_zones(zone_polys, point):
    """Project a point onto valid (allowed, non-no-go) space.

    Returns the snapped Point, or None when the point is already in valid
    space (or there is nowhere valid to put it). No-go zones (issue #60) are
    subtracted from the allowed region — grown by NO_GO_SNAP_MARGIN_PX first —
    so a fix in dead space is pushed to the nearest genuinely-allowed point,
    clear of the boundary-inclusive no-go edge. This holds even when a no-go
    zone is drawn overlapping or nested inside an allowed room (subtraction
    carves the void out of the room), and when the floor's only zones are
    no-go (the point is at least pushed off the dead-space footprint).
    """
    allowed = [polygon for _zone_id, polygon, _buffer_size, no_go in zone_polys if not no_go]
    nogo = [polygon for _zone_id, polygon, _buffer_size, no_go in zone_polys if no_go]
    nogo_union = unary_union(nogo) if nogo else None
    nogo_blocks = nogo_union is not None and not nogo_union.is_empty

    valid = None
    if allowed:
        valid = unary_union(allowed)
        if nogo_blocks:
            # Grow-and-subtract: the snap target's boundary ends up
            # NO_GO_SNAP_MARGIN_PX outside the dead space, so the snapped point
            # is not still read as inside it by the boundary-inclusive tests.
            valid = valid.difference(nogo_union.buffer(NO_GO_SNAP_MARGIN_PX))

    if valid is not None and not valid.is_empty:
        if valid.covers(point):
            return None  # already in valid space
        snapped, _ = nearest_points(valid, point)
        return snapped

    # No allowed space to land in. If the point sits in declared dead space,
    # at least push it just off the no-go footprint; otherwise leave it as-is.
    if nogo_blocks and nogo_union.covers(point):
        snapped, _ = nearest_points(nogo_union.buffer(NO_GO_SNAP_MARGIN_PX).boundary, point)
        return snapped
    return None


def find_nearest_zone(hass, data, entity, floor_name, point):
    """The zone closest to the point, no matter how far away.

    Trilateration jitter can land a fix between two zones or outside the map
    entirely; this always names the closest zone on the elected floor (a point
    inside a zone has distance 0, so it matches find_zone_for_point there).
    Returns "unknown" only when the floor has no usable zones.
    """
    nearest_id = "unknown"
    nearest_distance = None
    for zone_id, polygon, _buffer_size, no_go in _floor_zone_polygons(hass, data, entity, floor_name):
        if no_go:
            continue  # dead space is never "the nearest zone" (issue #60)
        distance = polygon.distance(point)
        if nearest_distance is None or distance < nearest_distance:
            nearest_id, nearest_distance = zone_id, distance
    return nearest_id


def _floor_sub_zone_polygons(hass, data, entity, floor_name):
    """(sub-zone name, parent zone name, polygon) tuples for the entity's floor.

    Sub-zones are small precise areas drawn inside a zone (a couch, a desk), so
    they are matched strictly (no soft buffer). They live in a separate
    "subzones" list, so the main-zone election/snap/nearest logic is untouched.

    Cached the same way and for the same reason as _floor_zone_polygons.
    """
    cache = _zone_poly_cache(hass)
    cache_key = ("subzones", floor_name)
    version = get_layout_version(hass)
    cached = cache.get(cache_key)
    if cached is not None and cached[0] == version:
        return cached[1]

    results = []
    for entity_data in data:
        if entity_data["entity"] != entity:
            continue
        for floor in entity_data["data"]["floor"]:
            if floor["name"] != floor_name:
                continue
            # Sub-zones link to their parent by the zone's stable id; resolve it
            # to the zone's display name for the parent_zone attribute.
            zone_name_by_id = {}
            for z in floor.get("zones") or []:
                zone_name_by_id[z.get("zone_id") or z.get("entity_id")] = z.get("entity_id")
            for sub in floor.get("subzones") or []:
                coords = sub.get("cords") or []
                if len(coords) < 3:
                    continue
                polygon = Polygon([(c["x"], c["y"]) for c in coords])
                if not polygon.is_valid:
                    repaired = (
                        shapely_make_valid(polygon)
                        if shapely_make_valid
                        else polygon.buffer(0)
                    )
                    if repaired is None or repaired.is_empty:
                        continue
                    polygon = repaired
                parent_ref = sub.get("parent")
                results.append((sub.get("entity_id"), zone_name_by_id.get(parent_ref, parent_ref), polygon))
        break

    cache[cache_key] = (version, results)
    return results


def find_sub_zone_for_point(hass, data, entity, floor_name, point):
    """The sub-zone containing the point and its parent zone name.

    Returns (sub_zone_name, parent_zone_name); ("unknown", None) when the point
    is in no sub-zone.
    """
    for sub_id, parent_id, polygon in _floor_sub_zone_polygons(hass, data, entity, floor_name):
        if polygon.covers(point):
            return sub_id, parent_id
    return "unknown", None


# --- Live push (websocket) ------------------------------------------------------
# Fired on the event loop at the end of every positioning cycle with the same
# payload the /api/sextant/cords poll would return, plus receiver health. The
# panel and the Lovelace card can subscribe once instead of polling, and a
# subscriber sees every cycle rather than whichever ones its timer lands on.
SIGNAL_BPS_UPDATE = "sextant_positions_updated"


def _push_payload(hass):
    """What a websocket subscriber gets on subscribe and after each cycle."""
    dom = hass.data.get(DOMAIN, {}) if isinstance(getattr(hass, "data", None), dict) else {}
    return {
        "stamp": time.time(),
        "positions": list(dom.get("apitricords") or []),
        "offline_receivers": list(dom.get("rl_offline") or []),
    }


@websocket_api.websocket_command({vol.Required("type"): "sextant/subscribe"})
@websocket_api.async_response
async def _ws_subscribe(hass, connection, msg):
    """``sextant/subscribe``: stream positions and receiver health, one event per cycle.

    The first event is sent immediately with the current state, so a client
    has something to draw before the next cycle. Unsubscribing is the
    standard ``unsubscribe_events`` on the subscription id.
    """

    @callback
    def _forward(payload):
        connection.send_message(websocket_api.event_message(msg["id"], payload))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(hass, SIGNAL_BPS_UPDATE, _forward)
    connection.send_result(msg["id"])
    _forward(_push_payload(hass))


def _register_websocket(hass) -> None:
    if hass.data.get("sextant_ws_registered"):
        return
    websocket_api.async_register_command(hass, _ws_subscribe)
    from . import ws as ws_module  # noqa: PLC0415 - ws imports this package lazily

    ws_module.async_register(hass)
    hass.data["sextant_ws_registered"] = True


async def async_apply_tuning(hass, settings, reset=False):
    """Validate and store tuning overrides (TUNING_SPEC); returns the stored map.

    Validation is strict here where a human is typing, and lenient in
    _tuning where the store is read: an unknown key or an out-of-range
    value is refused with the allowed range, rather than silently ignored
    later. ``reset`` drops every override first. Shared by the
    sextant.set_tuning service and the panel's websocket command.
    """
    updates = {}
    for key, value in (settings or {}).items():
        if key not in TUNING_SPEC:
            raise HomeAssistantError(f"unknown tuning key {key!r}; known: {', '.join(sorted(TUNING_SPEC))}")
        coerced = _coerce_tuning(key, value, None)
        if coerced is None:
            spec = TUNING_SPEC[key]
            allowed = (
                f"one of {', '.join(spec[2])}" if spec[1] is str
                else "true or false" if spec[1] is bool
                else f"a number between {spec[2]} and {spec[3]}"
            )
            raise HomeAssistantError(f"{key} must be {allowed}, got {value!r}")
        updates[key] = coerced
    async with LAYOUT_LOCK:
        data = get_layout_for_edit(hass)
        if not isinstance(data, dict):
            raise HomeAssistantError("No Sextant layout saved yet; place receivers first.")
        tuning = {} if reset else dict(data.get("tuning") or {})
        tuning.update(updates)
        if tuning:
            data["tuning"] = tuning
        else:
            data.pop("tuning", None)
        await save_layout(hass, data)
    _LOGGER.info("sextant.set_tuning: %s", tuning or "defaults restored")
    return tuning


def _register_calibration_services(hass) -> None:
    """Expose the calibration actions as HA services.

    These mirror async_calibration_action exactly and call the same functions, so the
    panel and an automation cannot diverge. The point of having both is that
    the REST view needs a bearer token and a JSON body, which makes it awkward
    from an automation or a script - and unusable from the Developer Tools
    action UI, which is where anyone would look first.

    ValueError is what the calibration layer raises for the expected refusals
    (unknown floor, a run already going, a floor with no scale). Translating it
    to HomeAssistantError surfaces the message in the UI as a normal action
    failure instead of a traceback in the log.
    """

    async def _start(call: ServiceCall) -> None:
        try:
            await start_calibration(
                hass, call.data["floor"], int(call.data.get("duration", 600))
            )
        except ValueError as err:
            raise HomeAssistantError(str(err)) from err

    async def _cancel(call: ServiceCall) -> None:
        await async_cancel_calibration(hass)

    async def _apply(call: ServiceCall) -> None:
        cal = get_calibration_state(hass)
        floor = call.data.get("floor") or cal.get("floor")
        try:
            await apply_corrections(hass, cal, floor)
        except ValueError as err:
            raise HomeAssistantError(str(err)) from err
        await save_calibration_state(hass)

    async def _reset(call: ServiceCall) -> None:
        cal = get_calibration_state(hass)
        floor = call.data.get("floor") or cal.get("floor")
        try:
            await reset_corrections(hass, cal, floor)
        except ValueError as err:
            raise HomeAssistantError(str(err)) from err
        await save_calibration_state(hass)

    async def _auto(call: ServiceCall) -> None:
        await set_auto_calibration(hass, bool(call.data["enabled"]))

    async def _heights(call: ServiceCall) -> None:
        """Write receiver mount heights through the layout store.

        Deliberately a service rather than a file edit: the layout lives in
        HA's Store, which keeps an in-memory cache and writes it back. Editing
        config/.storage/sextant underneath a running HA is silently lost the next
        time anything saves. Going through save_layout persists atomically
        and refreshes the cache, so calibration sees the change immediately -
        _read_coords rebuilds the receiver map from it on every run.
        """
        heights = {str(k): float(v) for k, v in (call.data.get("heights") or {}).items()}
        default = call.data.get("default")
        for name, value in heights.items():
            if not 0 <= value <= 10:
                raise HomeAssistantError(f"height for {name!r} must be between 0 and 10 m, got {value}")

        async with LAYOUT_LOCK:
            data = get_layout_for_edit(hass)
            if not isinstance(data, dict) or not data.get("floor"):
                raise HomeAssistantError("No Sextant layout saved yet; place receivers first.")

            seen: set[str] = set()
            changed = 0
            for floor in data["floor"]:
                for receiver in floor.get("receivers", []):
                    slug = str(receiver.get("entity_id") or "")
                    if not slug:
                        continue
                    seen.add(slug)
                    if slug in heights:
                        receiver["height"] = heights[slug]
                        changed += 1
                    elif default is not None:
                        receiver["height"] = float(default)
                        changed += 1
            await save_layout(hass, data)

        unmatched = sorted(set(heights) - seen)
        if unmatched:
            # Not fatal: a typo should not silently do nothing, but it should
            # also not discard the heights that did match.
            _LOGGER.warning(
                "sextant.set_receiver_heights: %d receiver(s) updated; no receiver matched %s",
                changed, ", ".join(unmatched),
            )
        else:
            _LOGGER.info("sextant.set_receiver_heights: %d receiver(s) updated", changed)

    hass.services.async_register(
        DOMAIN, "start_calibration", _start,
        schema=vol.Schema({
            vol.Required("floor"): cv.string,
            vol.Optional("duration", default=600): vol.All(
                vol.Coerce(int), vol.Range(min=60, max=3600)
            ),
        }),
    )
    hass.services.async_register(DOMAIN, "cancel_calibration", _cancel, schema=vol.Schema({}))
    hass.services.async_register(
        DOMAIN, "apply_corrections", _apply,
        schema=vol.Schema({vol.Optional("floor"): cv.string}),
    )
    hass.services.async_register(
        DOMAIN, "reset_corrections", _reset,
        schema=vol.Schema({vol.Optional("floor"): cv.string}),
    )
    async def _tracker_heights(call: ServiceCall) -> None:
        """Write per-tracker carry heights into the layout store.

        Same reasoning as _heights: the layout lives in HA's Store, so a direct
        file edit is lost the next time anything saves. Keys are deliberately
        NOT validated against seen devices - a tracker that has not been heard
        yet should be configurable ahead of time, and the read path already
        ignores anything out of range.
        """
        heights = {str(k): float(v) for k, v in call.data["heights"].items()}

        async with LAYOUT_LOCK:
            data = get_layout_for_edit(hass)
            if not isinstance(data, dict):
                raise HomeAssistantError("No Sextant layout saved yet.")
            current = data.get("tracker_heights")
            if not isinstance(current, dict):
                current = {}
            current.update(heights)
            data["tracker_heights"] = current
            await save_layout(hass, data)
        _LOGGER.info("sextant.set_tracker_heights: %d tracker(s) set", len(heights))

    hass.services.async_register(
        DOMAIN, "set_auto_calibration", _auto,
        schema=vol.Schema({vol.Required("enabled"): cv.boolean}),
    )
    hass.services.async_register(
        DOMAIN, "set_tracker_heights", _tracker_heights,
        schema=vol.Schema({
            vol.Required("heights"): vol.Schema({cv.string: vol.All(vol.Coerce(float), vol.Range(min=0, max=5))}),
        }),
    )
    hass.services.async_register(
        DOMAIN, "set_receiver_heights", _heights,
        schema=vol.Schema({
            vol.Optional("heights", default=dict): vol.Schema({cv.string: vol.Coerce(float)}),
            vol.Optional("default"): vol.All(vol.Coerce(float), vol.Range(min=0, max=10)),
        }),
    )

    async def _set_tuning(call: ServiceCall) -> None:
        """Change positioning tuning live (TUNING_SPEC), through the store."""
        await async_apply_tuning(hass, call.data.get("settings") or {}, bool(call.data.get("reset")))

    hass.services.async_register(
        DOMAIN, "set_tuning", _set_tuning,
        schema=vol.Schema({
            vol.Optional("settings", default=dict): dict,
            vol.Optional("reset", default=False): cv.boolean,
        }),
    )


async def async_setup(hass, config):
    """Set up the Sextant integration."""
    _LOGGER.info("Sextant integration initierad.")

    if hass.data.get("sextant_initialized", False):
        _LOGGER.debug("Sextant already initialized in current runtime; skipping duplicate init.")
        return True  # Abort if already running

    hass.data["sextant_initialized"] = True  # Set flag

    async def initialize_sextant():
        """Initialize the Sextant component"""
        _LOGGER.info("Initializing Sextant...")

        if "sextant_views_registered" not in hass.data:
            hass.http.register_view(SextantFrontendView())
            hass.http.register_view(SextantSaveAPIText())
            hass.http.register_view(SextantUploadTrackerIconAPI())
            hass.http.register_view(SextantReadAPIText())
            hass.http.register_view(SextantCordsAPI(hass))
            hass.http.register_view(SextantSelfTestAPI(hass))
            hass.data["sextant_views_registered"] = True

        if "sextant_services_registered" not in hass.data:
            _register_calibration_services(hass)
            hass.data["sextant_services_registered"] = True
        _register_websocket(hass)

        config_path = hass.config.path()
        target_dir = os.path.join(config_path, "www", "sextant_maps")
        tracker_icons_dir = os.path.join(config_path, "www", "sextant_icons")

        try:
            await aiofiles.os.makedirs(target_dir, exist_ok=True)
            _LOGGER.info(f"Folder {target_dir} has been created or already existed")
        except Exception as e:
            _LOGGER.error(f"Could not create the folder {target_dir}: {e}")
            return

        try:
            await aiofiles.os.makedirs(tracker_icons_dir, exist_ok=True)
            _LOGGER.info(f"Folder {tracker_icons_dir} has been created or already existed")
        except Exception as e:
            _LOGGER.error(f"Could not create the folder {tracker_icons_dir}: {e}")
            return

        show_sidebar_panel = True
        update_interval = DEFAULT_UPDATE_INTERVAL
        if hasattr(config, "options"):
            show_sidebar_panel = config.options.get(OPTION_SHOW_SIDEBAR_PANEL, True)
            update_interval = config.options.get(OPTION_UPDATE_INTERVAL, DEFAULT_UPDATE_INTERVAL)
        else:
            entries = hass.config_entries.async_entries(DOMAIN)
            if entries:
                show_sidebar_panel = entries[0].options.get(OPTION_SHOW_SIDEBAR_PANEL, True)
                update_interval = entries[0].options.get(OPTION_UPDATE_INTERVAL, DEFAULT_UPDATE_INTERVAL)
        global secToUpdate
        secToUpdate = update_interval
        panels = hass.data.get("frontend_panels", {})
        if "sextant" in panels:
            async_remove_panel(hass, "sextant")

        if show_sidebar_panel:
            try:
                _LOGGER.debug("Registering the custom panel for Sextant...")
                # A custom panel (not a bare iframe) so the panel element
                # receives `hass` and can hand the app an HA access token to
                # authenticate its /api/sextant/* calls (those views now require
                # auth). The element (sextant-panel.js) still hosts the existing
                # app in an inner iframe and only couriers the token in.
                await panel_custom.async_register_panel(
                    hass,
                    frontend_url_path="sextant",
                    webcomponent_name="sextant-panel",
                    module_url="/sextant/sextant-panel.js",
                    sidebar_title="Sextant",
                    sidebar_icon="mdi:compass-rose",
                    require_admin=False,
                    embed_iframe=False,
                )
                _LOGGER.info("Panel registered successfully.")
            except Exception as e:
                _LOGGER.error(f"Failed to register panel: {e}")
        else:
            _LOGGER.info("Sextant sidebar panel is disabled by integration options.")

        # Move any legacy www/sextant_maps flat files into the Store (once), then
        # load the layout into the in-memory cache. Store writes are atomic, so
        # a crash can no longer leave a 0-byte layout (issue #104).
        await migrate_from_bps(hass)
        await migrate_legacy(hass)
        await load_layout(hass)
        # One-time (and thereafter incremental) migration: identify placed
        # receivers by scanner address rather than by slug alone.
        try:
            await async_resolve_receiver_addresses(hass)
        except Exception as e:
            _LOGGER.debug("Receiver identity migration deferred: %s", e)
        # Layout is loaded, so the history settings are readable: bring the
        # retained window back before the tracking loop starts appending.
        await restore_position_history(hass)

        old_task = hass.data.get("sextant_update_task")
        if old_task:
            old_task.cancel()
        hass.data["sextant_update_task"] = hass.async_create_task(update_tracked_entities(hass))

        async def handle_homeassistant_stop(event):
            """Stop background work promptly so shutdown cannot drag or leave
            the unload half-done (which strands stale registry entries)."""
            update_task = hass.data.pop("sextant_update_task", None)
            if update_task:
                update_task.cancel()
            try:
                await flush_position_history(hass)
            except Exception as e:
                _LOGGER.debug("Sextant position history final flush failed: %s", e)
            await async_shutdown_calibration(hass)

        hass.bus.async_listen_once("homeassistant_stop", handle_homeassistant_stop)

        await async_restore_calibration_state(hass)
        await async_start_auto_if_enabled(hass)

        _LOGGER.info("The Sextant integration is fully initialized")

    async def handle_homeassistant_started(event):
        """Handles the 'homeassistant_started' event"""
        await initialize_sextant()

    if hass.is_running:
        await initialize_sextant()
    else:
        hass.bus.async_listen_once("homeassistant_started", handle_homeassistant_started)

    return True

async def async_unload_entry(hass: HomeAssistant, entry):
    """Remove a configuration entry"""
    _LOGGER.info("Attempting to offload platforms for entry: %s", entry.entry_id)

    state_listener_unsub = hass.data.pop("sextant_state_listener_unsub", None)
    if state_listener_unsub:
        state_listener_unsub()

    # Get whatever the tracking loop buffered since the last 60 s flush onto
    # disk before the task goes away. The in-memory ring survives an unload
    # (hass.data[DOMAIN] is not cleared), so this is belt-and-braces, but an
    # unload followed by a hard stop would otherwise lose that minute.
    try:
        await flush_position_history(hass)
    except Exception as e:
        _LOGGER.debug("Sextant position history flush on unload failed: %s", e)

    cleanup_legacy_sextant_registry_and_states(hass)

    entity_registry = er.async_get(hass)

    # Find and remove all entities that belong to "sextant"
    entities_to_remove = [
        entity.entity_id for entity in entity_registry.entities.values()
        if entity.platform == "sextant"
    ]

    for entity_id in entities_to_remove:
        _LOGGER.info(f"Removes sensor: {entity_id}")
        entity_registry.async_remove(entity_id)

    try: # Attempt to unload platforms
        unload_ok = await hass.config_entries.async_unload_platforms(entry, ["sensor"])
    except Exception as e:
        _LOGGER.error(f"Error during offloading of platforms for entry {entry.entry_id}: {e}")
        return False

    if not unload_ok:
        _LOGGER.error("Failed to offload platforms for entry: %s", entry.entry_id)
        return False

    try: #Remove the frontend panel
        async_remove_panel(hass, frontend_url_path="sextant")
        _LOGGER.info("Frontend-panel removed for entry: %s", entry.entry_id)
    except Exception as e:
        _LOGGER.error(f"Error when removing frontend-panel for entry {entry.entry_id}: {e}")
        return False

    update_task = hass.data.pop("sextant_update_task", None)
    if update_task:
        update_task.cancel()

    await async_shutdown_calibration(hass)

    # Remove Sextant states from the state machine when integration is unloaded.
    sextant_state_ids = [
        state.entity_id
        for state in hass.states.async_all()
        if state.entity_id.startswith("sensor.")
        and state.entity_id.endswith(("_sextant_zone", "_sextant_floor", "_sextant_nearest_zone", "_sextant_sub_zone"))
    ]
    for entity_id in sextant_state_ids:
        hass.states.async_remove(entity_id)

    # Allow clean setup after integration reload/removal.
    hass.data.pop("sextant_initialized", None)
    hass.data.pop("sextant_sensors", None)
    hass.data.pop("sextant_add_entities", None)

    return True


async def async_setup_entry(hass, entry):
    """Set the integration from a configuration entry"""
    _LOGGER.info("async_setup_entry called")
    cleanup_legacy_sextant_registry_and_states(hass)
    await hass.config_entries.async_forward_entry_setups(entry, ["sensor"])
    entry.async_on_unload(entry.add_update_listener(async_update_options))

    """Set up Sextant from a config entry."""
    return await async_setup(hass, entry)


async def async_update_options(hass, entry):
    """Reload integration when options are updated."""
    await hass.config_entries.async_reload(entry.entry_id)

class SextantFrontendView(HomeAssistantView):
    """Serve the frontend files."""

    url = "/sextant/{file_name}"
    name = "sextant:frontend"
    requires_auth = False
    # Dashboards from before the rename still load the card from /bps/.
    extra_urls = ["/bps/{file_name}"]
    _RENAMED_FILES = {"bps-map-card.js": "sextant-map-card.js"}

    async def get(self, request, file_name):
        """Serve static files from the frontend folder."""
        file_name = self._RENAMED_FILES.get(file_name, file_name)
        frontend_path = FRONTEND_PATH / file_name

        _LOGGER.info(f"Serving file: {frontend_path}")

        if not frontend_path.is_file():
            _LOGGER.error(f"Requested file not found: {frontend_path}")
            return web.Response(status=404, text="File not found")

        response = web.FileResponse(path=str(frontend_path))
        # The panel's script.js/CSS change on every integration update. Without
        # an explicit directive, browsers cache these heuristically and keep
        # serving the old panel after an update. "no-cache" keeps the cached
        # copy but forces revalidation (a cheap 304 when unchanged, the new file
        # when it changed), so updates show up on a normal reload.
        response.headers["Cache-Control"] = "no-cache"
        # sextant-panel.js is loaded as an ES module (panel_custom), and browsers
        # refuse a module served with a non-JS MIME type. Force it rather than
        # trust the host's mimetypes registry (a Windows HA host can map .js to
        # text/plain, which would silently blank the panel).
        if file_name.endswith(".js"):
            response.headers["Content-Type"] = "text/javascript"
        return response

class SextantSaveAPIText(HomeAssistantView):
    """Handle saving of Sextant coordinates to a text file."""

    url = "/api/sextant/save_text"
    name = "api:sextant:save_text"
    requires_auth = True

    async def post(self, request):
        """Handle saving coordinates to a text file."""
        hass = request.app["hass"]
        data = await request.post()

        coordinates = data.get("coordinates")

        if not coordinates:
            return web.Response(status=400, text="Missing coordinates")
        # Reject a non-JSON layout blob before it can reach the store.
        try:
            coords_obj = json.loads(coordinates)
        except (ValueError, TypeError):
            return web.Response(status=400, text="Coordinates must be valid JSON")

        maps_path = hass.config.path("www/sextant_maps")

        try: # Persist the layout to the store + handle map upload/removal
            # Serialized with the calibration writers so read-modify-write
            # cycles on the layout cannot interleave.
            async with LAYOUT_LOCK:
                error = await self._write_save(hass, maps_path, data, coords_obj)
            if error is not None:
                return error
            # A calibration window may be sampling right now; hand it the
            # edited placements so a re-linked/added receiver starts matching
            # on the next dump instead of after the next window/solve cycle.
            refresh_receivers_from_coords(hass, coordinates)
            _LOGGER.info(f"Saved coordinates to bpsdata: {coordinates}")
            return web.Response(status=200, text="Coordinates saved successfully")

        except Exception as e:
            _LOGGER.error(f"Failed to save coordinates: {e}")
            return web.Response(status=500, text="Failed to save coordinates")

    async def _write_save(self, hass, maps_path, data, coords_obj):
        """Validate all inputs, THEN persist; returns an error Response or None.

        Ordering matters: the new-floor map upload and the removal target are
        validated (and the upload read + size-checked) BEFORE the layout is
        saved, so a rejected upload can no longer strand the saved layout.
        Every filesystem target derived from client input is constrained to
        maps_path via _safe_maps_child (audit #2: path traversal / arbitrary
        write+delete). The layout goes to the Store (atomic); only the map
        images live under maps_path.
        """
        # --- Validate the optional new-floor map upload ---
        map_target = None
        map_bytes = None
        if data.get("new_floor") == "true":
            map_file = data.get("file")
            if not map_file:
                return web.Response(status=400, text="Missing file")
            map_target = _safe_maps_child(maps_path, map_file.filename, _ALLOWED_MAP_EXTS)
            if map_target is None:
                return web.Response(status=400, text="Invalid map filename")
            map_bytes = map_file.file.read()
            if len(map_bytes) > MAX_MAP_UPLOAD_BYTES:
                return web.Response(status=413, text="Map file too large")

        # --- Validate the optional removal target ---
        # No extension allowlist here: a map stored under any earlier-accepted
        # extension must stay deletable (the allowlist is an UPLOAD guard, not a
        # reason to strand an existing floor). Containment still applies, and
        # the layout/calibration files are explicitly protected.
        remove_target = None
        remove_file = data.get("remove")
        if remove_file:
            remove_target = _safe_maps_child(maps_path, remove_file, None)
            if remove_target is None or remove_target.name in _PROTECTED_MAPS_FILES:
                return web.Response(status=400, text="Invalid remove target")

        # --- Inputs valid: persist. Map first (so the saved layout never names
        # a map that failed to write), then the layout, then delete the old map. ---
        if map_target is not None:
            try:
                async with aiofiles.open(map_target, "wb") as f:
                    await f.write(map_bytes)
            except Exception as e:
                _LOGGER.error(f"Failed to save maps: {e}")
                return web.Response(status=500, text="Failed to save maps")

        await save_layout(hass, coords_obj)

        # Never delete the map we just wrote (a replace with the same filename).
        if remove_target is not None and remove_target != map_target and remove_target.exists():
            try:
                remove_target.unlink()
                _LOGGER.info(f"Removed file: {remove_target.name}")
            except Exception as e:
                _LOGGER.error(f"Failed to remove file {remove_target.name}: {e}")
                return web.Response(status=500, text="Failed to remove file")
        return None


class SextantReadAPIText(HomeAssistantView):
    """Return the stored Sextant layout plus the tracked-device / receiver lists."""

    url = "/api/sextant/read_text"
    name = "api:sextant:read_text"
    requires_auth = True

    async def get(self, request):
        hass = request.app["hass"]
        # Both the tracked devices and their receivers come from the same
        # Bermuda "_distance_to_" sensors — the device is the part before
        # "_distance_to_", the receiver (scanner) the part after. Filtering to
        # Bermuda's own sensors keeps look-alike sensors from other integrations
        # out of both the tracked-device list and the receiver picker.
        entities = []
        receivers = []
        try:
            allowed = _bermuda_distance_sensor_ids(hass)
            entities = sorted({eid[len("sensor."):].split("_distance_to_")[0] for eid in allowed})
            receivers = sorted({eid.split("_distance_to_", 1)[1] for eid in allowed})
        except Exception as e:
            _LOGGER.info(f"Error listing Bermuda distance sensors: {e}")

        # Offline scanners come from the Bermuda-liveness poller (proximity-
        # independent), refreshed on a slower cadence by the background loop.
        offline_receivers = list(hass.data.get(DOMAIN, {}).get("rl_offline", []))

        try:
            # The layout now lives in the Store; a fresh install has none, and
            # the frontend's `if (data.coordinates)` guard expects "" (not "[]")
            # in that case so it never JSON.parses an empty layout.
            layout = get_layout(hass)
            content = json.dumps(layout) if layout else ""
            return web.json_response({
                "coordinates": content,
                "entities": entities,
                "receivers": receivers,
                "offline_receivers": offline_receivers,
                # Naming-mismatch diagnostics (issue #64): placed receivers whose
                # slug has no Bermuda distance sensor, and reporting scanners not
                # placed anywhere.
                "scanner_diagnostics": _scanner_diagnostics(hass, content),
            })

        except Exception as e:
            _LOGGER.error(f"Failed to read coordinates: {e}")
            return web.Response(status=500, text="Failed to read coordinates")

def list_map_files(maps_path):
    """Map image file names on disk (runs in the executor)."""
    with os.scandir(maps_path) as entries:
        return [
            entry.name
            for entry in entries
            if entry.is_file() and entry.name.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))
        ]


def list_tracker_icons(icons_path):
    """Custom tracker icons as picker options (runs in the executor)."""
    if not os.path.isdir(icons_path):
        return []
    with os.scandir(icons_path) as entries:
        return [
            {"value": f"/local/sextant_icons/{entry.name}", "label": entry.name}
            for entry in entries
            if entry.is_file() and entry.name.lower().endswith((".png", ".svg", ".jpg", ".jpeg", ".webp", ".gif"))
        ]


class SextantUploadTrackerIconAPI(HomeAssistantView):
    """API to upload custom tracker icons."""

    url = "/api/sextant/upload_tracker_icon"
    name = "api:sextant:upload_tracker_icon"
    requires_auth = True

    async def post(self, request):
        hass = request.app["hass"]
        data = await request.post()
        icon_file = data.get("icon")
        if not icon_file:
            return web.Response(status=400, text="Missing icon")

        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", Path(icon_file.filename).name)
        if not safe_name:
            return web.Response(status=400, text="Invalid filename")

        icons_path = hass.config.path("www/sextant_icons")
        try:
            await aiofiles.os.makedirs(icons_path, exist_ok=True)
            target_path = Path(icons_path) / safe_name
            async with aiofiles.open(target_path, "wb") as f:
                await f.write(icon_file.file.read())
        except Exception as e:
            _LOGGER.error(f"Failed to upload tracker icon: {e}")
            return web.Response(status=500, text="Failed to upload icon")

        return web.json_response({
            "icon_url": f"/local/sextant_icons/{safe_name}",
            "icon_name": safe_name,
        })


class SextantCordsAPI(HomeAssistantView):
    """API endpoint that returns apitricords."""

    url = "/api/sextant/cords"
    name = "api:sextant:cords"
    requires_auth = True

    def __init__(self, hass):
        """Spara referens till hass"""
        self.hass = hass

    async def get(self, request):
        """Return apitricords from hass.data."""
        apitricords = self.hass.data.get(DOMAIN, {}).get("apitricords", {})

        if not apitricords:
            return web.json_response({"error": "No data available"}, status=404)

        return web.json_response(apitricords)

# Trilateration function
# Floor on the distance used in the Jacobian's direction vector. Only guards
# the 0/0 at a fit sitting exactly on a receiver; far below any real geometry.
_JAC_MIN_DIST = 1e-9


def trilaterate(known_points, bounds=None, min_weight_radius=1e-3, stable_hint=None):
    """Weighted least-squares position fit.

    known_points are (x, y, r[, w[, wr]]) tuples. The optional w is a per-point
    reliability in [0, 1] (1 = fully trusted); it multiplies the geometric
    1/r^2 weight, so a spiky reading pulls the fit less without being dropped.
    Missing w defaults to 1. The optional wr overrides r as the RADIUS USED IN
    THE GEOMETRIC WEIGHT (the residual always uses r): live callers pass the
    measured slant (px) here, so a height-corrected projection that collapsed
    to the floor cannot buy itself dominant 1/r^2 influence — following the
    4-tuple form with collapsed projected radii reintroduces exactly the 1.7.0
    hijack. min_weight_radius clamps whichever weight radius is in use.

    bounds, when given as (minx, miny, maxx, maxy), constrains the solution to
    the floor's extent: the fit then finds the best position WITHIN the map,
    which lands on the boundary when an unconstrained fit would escape it.

    min_weight_radius clamps the radius used in the 1/r^2 WEIGHT (never the
    residual). Callers pass a physical floor in pixels (MIN_WEIGHT_RADIUS_M x
    floor scale): a near-zero radius — device at the receiver, or a slant range
    fully consumed by a known mount height — is an honest reading, but its
    weight must stay finite or that single receiver decides the whole fit. The
    default keeps the bare no-scale fallback safe against division by zero.

    stable_hint, when given, is an (x, y) the caller already believes is close
    (typically last cycle's own fix) because nothing has moved much since. It
    tries ONE solve from there first instead of the usual multi-start battery;
    only when that fails to converge does it fall back to the full battery
    below, so a hint can only save work, never cost accuracy.
    """
    num_points = len(known_points)

    if num_points < 3: # Make sure there are enough points (min 3) to do a trilataration
        _LOGGER.error("At least three known points are required for trilateration.")
        return None

    # The per-point arrays are built ONCE here, not rebuilt inside the
    # objective: least_squares calls the objective (and the Jacobian) many
    # times per solve, and at this problem size the Python loop that used to
    # live in there cost far more than the arithmetic it performed.
    px = np.fromiter((p[0] for p in known_points), dtype=float, count=num_points)
    py = np.fromiter((p[1] for p in known_points), dtype=float, count=num_points)
    pr = np.fromiter((p[2] for p in known_points), dtype=float, count=num_points)
    rel = np.fromiter((p[3] if len(p) > 3 else 1.0 for p in known_points),
                      dtype=float, count=num_points)
    # Weight radius: the MEASURED slant when supplied (5th element), else the
    # fit radius. Height correction can legitimately collapse the projected
    # radius to the minimum while the measured slant is ~dz (metres) —
    # weighting by the projection handed such a receiver ~100x influence and
    # the fit snapped onto it (1.7.0 regression).
    wrad = np.fromiter((p[4] if len(p) > 4 else p[2] for p in known_points),
                       dtype=float, count=num_points)
    # reliability x geometric (1/r^2) weight, pre-rooted: the residual is
    # sqrt(w) * (distance - r), so sqrt() belongs here rather than per call.
    sqrt_w = np.sqrt(rel / np.maximum(wrad, min_weight_radius) ** 2)

    def objective_function(X):
        return sqrt_w * (np.hypot(px - X[0], py - X[1]) - pr)

    def jacobian(X):
        """Exact derivative of the residual: d/dX sqrt(w)(|X - p| - r).

        Supplying it saves least_squares the finite-difference pass, which
        costs one extra objective evaluation per unknown per iteration.
        The distance is floored before dividing: a fit sitting exactly on a
        receiver has an undefined direction, and a NaN there would poison the
        whole step rather than just that row.
        """
        dx = X[0] - px
        dy = X[1] - py
        d = np.maximum(np.hypot(dx, dy), _JAC_MIN_DIST)
        return np.column_stack((sqrt_w * dx / d, sqrt_w * dy / d))

    # MULTI-START. The soft_l1 objective is multi-modal once gross outliers are
    # present, and a single descent from the centroid can settle in a basin
    # that is not the best one — a trust region is no more immune to this than
    # any other local method. Solving from a few cheap, physically-motivated
    # starts and keeping the lowest-cost result measured (tools/solver_bench.py,
    # 2400 fits over the real floorplan geometry) as a median error improvement
    # of ~17 cm and p95 from 9.9 m to 5.6 m. At two parameters the extra solves
    # are nearly free.
    #
    #   1. receiver centroid — always plausible, and inside any bounds.
    #   2. the SMALLEST-radius receiver — the strongest single prior on where
    #      the tracker is.
    #   3. the 1/r^2-weighted centroid — leans the same way as (2) without
    #      committing to one receiver.
    if bounds is not None:
        minx, miny, maxx, maxy = bounds
        lo, hi = [minx, miny], [maxx, maxy]
    else:
        lo, hi = [-np.inf, -np.inf], [np.inf, np.inf]

    # The fits run on the pure-numpy Levenberg-Marquardt solver in
    # solver_numpy.py rather than scipy's least_squares. Benchmarked on this
    # install's real floorplans (tools/solver_bench.py, 3000 fits, 15%
    # gross outliers): identical convergence, median accuracy 1.08 m vs
    # 1.08 m for scipy with the same multi-start, p95 6.1 m vs 6.0 m. The
    # positioning hot path therefore no longer needs scipy at all; the
    # calibration solver still does, until it is reworked.
    result = None
    if stable_hint is not None:
        hint = np.clip(np.asarray(stable_hint, dtype=float), lo, hi)
        r = least_squares_bounded_soft_l1(
            objective_function, hint, jacobian, (lo, hi), f_scale=SOLVER_ROBUST_F_SCALE,
        )
        if r.success:
            result = r

    if result is not None:
        x, y = result.x
        return x, y

    i_near = int(np.argmin(pr))
    wcen = 1.0 / np.maximum(pr, 1e-9) ** 2
    starts = [
        np.array([float(px.mean()), float(py.mean())]),
        np.array([float(px[i_near]), float(py[i_near])]),
        np.array([float((px * wcen).sum() / wcen.sum()),
                  float((py * wcen).sum() / wcen.sum())]),
    ]
    starts = [np.clip(s, lo, hi) for s in starts]

    # Skip a start that is effectively one already tried: with few receivers
    # the three candidates often coincide, and a duplicate solve buys nothing.
    unique_starts = []
    for s in starts:
        if not any(np.allclose(s, u, rtol=0, atol=1e-6) for u in unique_starts):
            unique_starts.append(s)

    # One call solves every start and keeps the lowest robust cost (the cost
    # is the same objective for every start, so it is directly comparable).
    result = least_squares_bounded_soft_l1(
        objective_function, unique_starts[0], jacobian, (lo, hi),
        f_scale=SOLVER_ROBUST_F_SCALE, extra_starts=unique_starts[1:],
    )

    if result is None or not result.success:
        # Non-convergence is an expected, handled outcome on ill-conditioned
        # input — a floor whose readings don't agree, or the self-test's
        # leave-one-out on a corner/degenerate receiver. Every caller treats
        # None as "not a contender" / "unsolved", so this is DEBUG, not ERROR
        # (it was spamming the log once the periodic self-test began running).
        _LOGGER.debug("Trilateration did not converge for %d points; skipping.", len(known_points))
        return None
    x, y = result.x # Extract the calculated coordinates
    return x, y # return the result


# --- Receiver self-localization: a zero-setup, ground-truthed accuracy bench --
# Every receiver's true position is known (it is placed on the map) and Bermuda
# measures the distance between scanners, so each receiver's position can be
# solved from the OTHERS' measured distances -- through the SAME trilaterate() +
# per-receiver correction + slant the live tracker uses -- and compared to where
# it actually is (leave-one-out). This measures the SOLVER, per-receiver
# calibration, and geometry with no parked beacon and no hand-measured truth.
# It does NOT exercise the temporal filtering (a static, always-fresh anchor has
# no motion to smooth or stale readings to reject), and it is an OPTIMISTIC
# bound on real tracker accuracy: calibration is fit on these very inter-receiver
# links, and receiver-to-receiver paths (ceiling height, clean line of sight)
# are easier than a body-worn beacon's. Consumed by tools/sextant_eval.py `selftest`.
SELFTEST_MIN_SAMPLES = 3  # need a median over at least this many raw distances
SELFTEST_SENSOR_INTERVAL = 1800  # refresh the accuracy sensor every 30 min


def _selftest_receivers(coords):
    """slug -> {entity, x, y, scale, floor, height, correction} for every placement."""
    out = {}
    if not isinstance(coords, dict):
        return out
    for floor in coords.get("floor", []):
        scale = floor.get("scale")
        if not scale:
            continue
        for rec in floor.get("receivers", []):
            cords = rec.get("cords") or {}
            eid = rec.get("entity_id")
            if not eid or cords.get("x") is None or cords.get("y") is None:
                continue
            height = rec.get("height")
            corr = rec.get("correction")
            out[str(eid)] = {
                "entity": str(eid),
                "x": float(cords["x"]),
                "y": float(cords["y"]),
                "scale": float(scale),
                "floor": floor.get("name"),
                "height": float(height) if isinstance(height, (int, float)) and 0 <= height <= 10 else None,
                "correction": float(corr) if isinstance(corr, (int, float)) and corr > 0 else 1.0,
            }
    return out


def _selftest_floor_bounds(coords, receivers):
    """Per-floor solver bounds = extent of ALL placed receivers + zone polygons
    (+10% margin), mirroring the live solve (update_trilateration_and_zone).

    Keyed on the floor so a left-out perimeter receiver's own known position
    still lies inside the feasible box — bounding only to the OTHER receivers
    would clamp it and inflate its error.
    """
    xs_by, ys_by = {}, {}
    for r in receivers.values():
        xs_by.setdefault(r["floor"], []).append(r["x"])
        ys_by.setdefault(r["floor"], []).append(r["y"])
    if isinstance(coords, dict):
        for floor in coords.get("floor", []):
            name = floor.get("name")
            for zone in floor.get("zones", []) or []:  # no-go zones still bound the floor
                for c in (zone.get("cords") or []):
                    if isinstance(c, dict) and c.get("x") is not None and c.get("y") is not None:
                        xs_by.setdefault(name, []).append(float(c["x"]))
                        ys_by.setdefault(name, []).append(float(c["y"]))
    out = {}
    for name, xs in xs_by.items():
        ys = ys_by[name]
        margin = 0.1 * max(max(xs) - min(xs), max(ys) - min(ys), 1.0)
        out[name] = (min(xs) - margin, min(ys) - margin, max(xs) + margin, max(ys) + margin)
    return out


def run_selftest(hass, samples=None):
    """Leave-one-out receiver self-localization accuracy against known positions.

    Solves on the RAW inter-receiver distances Sextant collects for calibration
    (median per link), not the Bermuda-filtered distance sensor the live tracker
    reads — so the numbers also exclude Bermuda's own smoothing.

    ``samples`` may be a pre-snapshotted ``{"tx|rx": [floats]}`` taken on the
    event loop; callers running this in the executor MUST pass one, since the
    live calibration deques are appended to on the loop and iterating them off
    thread would race ("deque mutated during iteration"). Defaults to the live
    samples for direct/synchronous callers.
    """
    coords = get_layout(hass)
    receivers = _selftest_receivers(coords)
    floor_bounds = _selftest_floor_bounds(coords, receivers)
    if samples is None:
        samples = get_calibration_state(hass).get("samples", {})

    def _measured_m(target, rx):
        # The live tracker sees the beacon (target) transmit and a receiver hear
        # it, so use exactly that direction ("target|rx") and the receiver's gain.
        vals = [float(v) for v in samples.get(f"{target}|{rx}", [])
                if isinstance(v, (int, float)) and v > 0]
        if len(vals) < SELFTEST_MIN_SAMPLES:
            return None
        return float(np.median(vals))

    solved, unsolved = [], []
    for slug, tgt in receivers.items():
        pts = []
        for oslug, o in receivers.items():
            if oslug == slug or o["floor"] != tgt["floor"]:
                continue
            raw = _measured_m(slug, oslug)
            if raw is None:
                continue
            d = raw * o["correction"]  # receiving scanner's correction (live path)
            horizontal = d
            if tgt["height"] is not None and o["height"] is not None:
                dz = o["height"] - tgt["height"]
                # Same floored projection as the live path (singularity guard;
                # the floor never exceeds the raw slant).
                floor_sq = min(d * d, MIN_WEIGHT_RADIUS_M * MIN_WEIGHT_RADIUS_M)
                horizontal = math.sqrt(max(d * d - dz * dz, floor_sq))
            # (x, y, projected radius, measured slant) in pixels — the slant is
            # the weight radius, mirroring the live solve.
            pts.append((o["x"], o["y"], horizontal * tgt["scale"], d * tgt["scale"]))
        if len(pts) < 3:
            unsolved.append({"entity": slug, "floor": tgt["floor"], "heard_by": len(pts)})
            continue
        fix = trilaterate(
            [(px, py, pr, 1.0, psl) for (px, py, pr, psl) in pts],
            bounds=floor_bounds.get(tgt["floor"]),
            min_weight_radius=MIN_WEIGHT_RADIUS_M * tgt["scale"],
        )
        if fix is None:
            unsolved.append({"entity": slug, "floor": tgt["floor"], "heard_by": len(pts), "reason": "no convergence"})
            continue
        err_px = math.hypot(fix[0] - tgt["x"], fix[1] - tgt["y"])
        solved.append({
            "entity": slug, "floor": tgt["floor"],
            "known": [round(tgt["x"], 1), round(tgt["y"], 1)],
            "est": [round(float(fix[0]), 1), round(float(fix[1]), 1)],
            "error_m": round(err_px / tgt["scale"], 3),
            "heard_by": len(pts),
        })
    return {
        "receivers": solved,
        "unsolved": unsolved,
        "counts": {"placed": len(receivers), "solved": len(solved), "unsolved": len(unsolved)},
    }


def _selftest_summary(result):
    """(state, attributes) for the accuracy sensor from a run_selftest result.

    State is CEP95 in metres (lower is better), or None (-> "unknown") when no
    receiver was solvable. Attributes stay compact (no per-receiver list) so
    they don't bloat recorder history; the full detail is on /api/sextant/selftest.
    """
    recv = [r for r in result.get("receivers", []) if isinstance(r.get("error_m"), (int, float))]
    counts = result.get("counts", {})
    attrs = {
        "solved": counts.get("solved"),
        "placed": counts.get("placed"),
        "unsolved": counts.get("unsolved"),
    }
    if not recv:
        return None, attrs
    errs = np.array([r["error_m"] for r in recv], dtype=float)
    attrs["cep50_m"] = round(float(np.percentile(errs, 50)), 3)
    attrs["cep95_m"] = round(float(np.percentile(errs, 95)), 3)
    attrs["mean_m"] = round(float(errs.mean()), 3)
    attrs["max_m"] = round(float(errs.max()), 3)
    worst = max(recv, key=lambda r: r["error_m"])
    attrs["worst"] = f"{worst.get('entity')} ({worst.get('error_m')} m)"
    by_floor = {}
    for r in recv:
        by_floor.setdefault(r.get("floor"), []).append(r["error_m"])
    attrs["per_floor_cep95_m"] = {
        f: round(float(np.percentile(v, 95)), 3) for f, v in by_floor.items()
    }
    return attrs["cep95_m"], attrs


HISTORY_DEFAULT_POINTS = 3000
HISTORY_MAX_QUERY_POINTS = 20000


class SextantSelfTestAPI(HomeAssistantView):
    """Read-only receiver leave-one-out self-localization accuracy (see run_selftest)."""

    url = "/api/sextant/selftest"
    name = "api:sextant:selftest"
    requires_auth = True

    def __init__(self, hass):
        self.hass = hass

    async def get(self, request):
        # One scipy solve per receiver; run off the event loop. Snapshot the
        # calibration sample deques HERE (on the loop) before handing to the
        # executor, so iterating them off-thread can't race calibration's ingest.
        samples = {k: list(v) for k, v in get_calibration_state(self.hass).get("samples", {}).items()}
        data = await self.hass.async_add_executor_job(run_selftest, self.hass, samples)
        return web.json_response(data)
