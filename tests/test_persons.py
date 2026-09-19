"""A person's location from the things they own (sextant.persons)."""
import sextant  # noqa: F401
from sextant import persons
from sextant import sensor as sensor_mod

NOW = 10_000.0


def thing(ent, cls, still_for=None, heard_ago=5.0, zone="Great Room", spot=None, floor="Ground Floor"):
    return {"ent": ent, "cls": cls, "updated": NOW - heard_ago,
            "still_since": None if still_for is None else NOW - still_for,
            "zone": zone, "sub_zone": spot or "unknown", "floor": floor}


def test_owners_groups_things_by_person():
    layout = {"thing_owners": {"watch": "person.david", "phone": "person.david", "mphone": "person.michelle", "x": "david"}}
    assert persons.owners(layout) == {"person.david": ["watch", "phone"], "person.michelle": ["mphone"]}
    assert persons.owners({}) == {}


def test_the_thing_being_carried_speaks_for_its_owner():
    # Phone on the couch for an hour; the watch walked to the kitchen a minute ago.
    phone = thing("phone", "phone", still_for=3600, spot="Couch")
    watch = thing("watch", "watch", still_for=60, zone="Kitchen")
    assert persons.pick([phone, watch], NOW, 120)["ent"] == "watch"


def test_among_things_moved_recently_the_one_usually_worn_wins():
    phone = thing("phone", "phone", still_for=30)
    watch = thing("watch", "watch", still_for=200)
    pods = thing("pods", "headphones", still_for=10)
    assert persons.pick([phone, watch, pods], NOW, 120)["ent"] == "watch"


def test_unheard_or_unplaced_things_do_not_count():
    old = thing("watch", "watch", still_for=10, heard_ago=900)
    lost = thing("phone", "phone", still_for=10, zone="unknown")
    keys = thing("keys", "keys", still_for=4000)
    assert persons.pick([old, lost, keys], NOW, 120)["ent"] == "keys"
    assert persons.pick([old, lost], NOW, 120) is None


def test_states_give_the_spot_or_the_room_and_say_which_thing():
    s = persons.states(thing("phone", "phone", spot="Couch"))
    assert s["sextant_person_location"] == ("Couch", {"kind": "spot", "room": "Great Room", "spot": "Couch", "floor": "Ground Floor", "via": "phone"})
    assert s["sextant_person_room"] == ("Great Room", {"via": "phone"})
    assert persons.states(None)["sextant_person_location"][0] == "unknown"


def test_person_sensors_are_never_mistaken_for_an_untracked_things():
    for suffix, _label in persons.PERSON_SENSOR_KINDS:
        assert sensor_mod.thing_of_unique_id(f"{suffix}_david_coulson") is None
