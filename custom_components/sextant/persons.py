"""Where a person is, from the things they own.

A thing can name its owner, a Home Assistant person (thing_owners in the
layout). A person's location is then one of their things' locations, and the
question is which one speaks for them. The phone left on the couch for an
hour does not; the watch that just crossed the room does. So:

1. Only things heard recently (within stale_after_secs) and placed in a room.
2. A thing moving now, or that arrived where it is within RECENT_MOVE_SECS,
   beats one that has sat there longer - it is being carried. Among those,
   what is usually on a body wins: a pet's own tag, a watch, a phone.
3. When nothing is on the move, the thing that arrived where it is most
   recently wins: the phone that came downstairs this morning, not the
   watch that has sat on its charger since last night. Class does not
   decide here - it did at first, and the watch on the nightstand won.

Only things that give their owner's location take part (locates_owner): by
class a watch, a phone or a person's or pet's own tag; headphones, keys, a
bag only when the thing is switched on for it.
4. Then whichever moved most recently.

Pure: the caller hands in each thing's latest published row.
"""

from __future__ import annotations

# A thing still for longer than this is probably not being carried.
RECENT_MOVE_SECS = 600.0
# Higher speaks for its owner first, among things equally recently moved.
CARRY_PRIORITY = {"cat": 4, "dog": 4, "paw": 4, "watch": 3, "phone": 2, "headphones": 1}
# Classes whose place is their owner's place, unless the thing says otherwise
# (thing_locates_owner). Headphones, keys, a bag go with you some of the time;
# where they are is not where you are.
LOCATES_BY_DEFAULT = {"watch", "phone", "person", "man", "woman", "child", "cat", "dog", "paw"}
# The sensors each person gets: (suffix, label).
PERSON_SENSOR_KINDS = [
    ("sextant_person_location", "Sextant Location"),
    ("sextant_person_room", "Sextant Room"),
    ("sextant_person_floor", "Sextant Floor"),
]


def owners(layout) -> dict[str, list[str]]:
    """person entity id -> the things it owns."""
    out: dict[str, list[str]] = {}
    raw = layout.get("thing_owners") if isinstance(layout, dict) else None
    for thing, person in (raw or {}).items():
        if isinstance(person, str) and person.startswith("person."):
            out.setdefault(person, []).append(thing)
    return out


def locates_owner(layout, ent, cls) -> bool:
    """Whether this thing's place may stand for its owner's: its own setting, else its class."""
    own = (layout.get("thing_locates_owner") or {}).get(ent) if isinstance(layout, dict) else None
    if isinstance(own, bool):
        return own
    return cls in LOCATES_BY_DEFAULT


def pick(things, now: float, stale_after: float):
    """The thing that speaks for its owner now, or None.

    ``things`` are dicts: ent, cls, updated (epoch s), moving (bool),
    arrived (epoch s: when it reached the room or spot it is in now),
    zone, sub_zone, floor.
    """
    fresh = [
        t for t in things
        if isinstance(t.get("updated"), (int, float)) and now - t["updated"] <= stale_after
        and t.get("zone") not in (None, "", "unknown")
    ]
    if not fresh:
        return None

    def key(t):
        arrived = t.get("arrived")
        age = 0.0 if t.get("moving") else max(0.0, now - arrived) if isinstance(arrived, (int, float)) else float("inf")
        recent = age <= RECENT_MOVE_SECS
        return (not recent, -CARRY_PRIORITY.get(t.get("cls"), 0) if recent else 0, age)

    return min(fresh, key=key)


def states(best):
    """(suffix -> (state, attributes)) for a person's sensors from the chosen thing."""
    if best is None:
        blank = {"room": "unknown", "spot": None, "floor": "unknown", "via": None}
        return {
            "sextant_person_location": ("unknown", {"kind": "room", **blank}),
            "sextant_person_room": ("unknown", {"via": None}),
            "sextant_person_floor": ("unknown", {"via": None}),
        }
    spot = best.get("sub_zone")
    spot = spot if spot not in (None, "", "unknown") else None
    room, floor = best.get("zone"), best.get("floor") or "unknown"
    via = {"via": best["ent"]}
    return {
        "sextant_person_location": (spot or room, {"kind": "spot" if spot else "room", "room": room, "spot": spot,
                                                   "floor": floor, **via}),
        "sextant_person_room": (room, via),
        "sextant_person_floor": (floor, via),
    }
