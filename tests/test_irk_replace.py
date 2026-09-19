"""Replacing a phone's key in place (sextant.irk_replace): every entity keeps its id."""
import asyncio
import types

import pytest

import sextant  # noqa: F401
from sextant import irk_replace as ir
from homeassistant.config_entries import ConfigEntryState

OLD = "00112233445566778899aabbccddeeff"
NEW = "ffeeddccbbaa99887766554433221100"


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class Ent:
    def __init__(self, entity_id, platform, unique_id, device_id=None):
        self.entity_id, self.platform, self.unique_id, self.device_id = entity_id, platform, unique_id, device_id
        self.domain = entity_id.split(".")[0]


class EntReg:
    def __init__(self, ents):
        self.entities = {e.entity_id: e for e in ents}

    def async_get_entity_id(self, domain, platform, uid):
        return next((e.entity_id for e in self.entities.values() if (e.domain, e.platform, e.unique_id) == (domain, platform, uid)), None)

    def async_update_entity(self, entity_id, new_unique_id=None, device_id=None):
        if new_unique_id:
            self.entities[entity_id].unique_id = new_unique_id
        if device_id:
            self.entities[entity_id].device_id = device_id

    def async_remove(self, entity_id):
        del self.entities[entity_id]


class DevReg:
    def __init__(self, devices):
        self.devices = devices

    def async_get(self, device_id):
        return self.devices.get(device_id)

    def async_get_device(self, identifiers=None):
        return next((d for d in self.devices.values() if d.identifiers & set(identifiers)), None)

    def async_remove_device(self, device_id):
        # As Home Assistant does: removing a device removes its entities.
        del self.devices[device_id]
        for e in [e for e in self.er.entities.values() if e.device_id == device_id]:
            del self.er.entities[e.entity_id]

    def async_update_device(self, device_id, new_identifiers=None):
        self.devices[device_id].identifiers = new_identifiers


class Entry:
    def __init__(self, entry_id, domain, irk=None):
        self.entry_id, self.domain, self.title = entry_id, domain, "53:F7:E4:39:6D:47"
        self.data = {"irk": irk} if irk else {}
        self.unique_id = irk
        self.state = ConfigEntryState.LOADED


class Entries:
    def __init__(self, entries):
        self.entries, self.calls = entries, []

    def async_entries(self, domain):
        return [e for e in self.entries if e.domain == domain]

    async def async_unload(self, entry_id):
        self.calls.append(("unload", entry_id))

    async def async_setup(self, entry_id):
        self.calls.append(("setup", entry_id))

    def async_update_entry(self, entry, data=None, unique_id=None):
        entry.data, entry.unique_id = data, unique_id


@pytest.fixture
def house(monkeypatch):
    phone = Entry("pbd1", "private_ble_device", OLD)
    other = Entry("pbd2", "private_ble_device", "aa" * 16)
    bermuda = Entry("b1", "bermuda")
    ents = [
        Ent("device_tracker.eilee_phone", "private_ble_device", OLD),
        Ent("sensor.eilee_phone_signal_strength", "private_ble_device", f"{OLD}_signal_strength"),
        Ent("sensor.private_ble_device_eilee_phone_area", "bermuda", f"{OLD}_area"),
        Ent("sensor.private_ble_device_eilee_phone_distance_to_kitchen", "bermuda", f"{OLD}_kitchen_range"),
        Ent("sensor.someone_else_area", "bermuda", "aa" * 16 + "_area"),
    ]
    er_, dr_ = EntReg(ents), DevReg({
        "d1": types.SimpleNamespace(id="d1", identifiers={("private_ble_device", OLD)}, name="Eilee Phone", name_by_user=None),
        "d2": types.SimpleNamespace(id="d2", identifiers={("bermuda", OLD)}, name="Eilee Phone", name_by_user=None),
        "d3": types.SimpleNamespace(id="d3", identifiers={("hue", 17)}, name="Lamp", name_by_user=None),   # a number, not text
        "d4": types.SimpleNamespace(id="d4", identifiers={("solo",), ("a", "b", "c")}, name="Odd", name_by_user=None),  # not pairs
    })
    dr_.er = er_
    monkeypatch.setattr(ir.er, "async_get", lambda hass: er_)
    monkeypatch.setattr(ir.er, "async_entries_for_device", lambda reg, device_id, include_disabled_entities=False:
                        [e for e in reg.entities.values() if e.device_id == device_id], raising=False)
    monkeypatch.setattr(ir.dr, "async_get", lambda hass: dr_)
    hass = types.SimpleNamespace(config_entries=Entries([phone, other, bermuda]))
    return hass, phone, er_, dr_


def test_parse_accepts_the_forms_the_integration_does():
    assert ir.parse_irk(OLD.upper()) == OLD
    assert ir.parse_irk("irk:" + OLD) == OLD
    import base64
    assert ir.parse_irk(base64.b64encode(bytes(reversed(bytes.fromhex(OLD)))).decode()) == OLD
    assert ir.parse_irk("abc") is None and ir.parse_irk("zz" * 16) is None


def test_the_thing_finds_its_entry_through_bermudas_entities(house):
    hass, phone, _er, _dr = house
    assert ir.entry_for_thing(hass, "private_ble_device_eilee_phone") is phone
    assert ir.entry_for_thing(hass, "nobody") is None


def test_replace_moves_every_entity_device_and_the_entry_then_reloads(house):
    hass, phone, er_, dr_ = house
    out = run(ir.async_replace_irk(hass, phone, NEW))
    assert out == {"device": "Eilee Phone", "entities": 4, "devices": 2, "copies_removed": 0}
    assert all(OLD not in e.unique_id for e in er_.entities.values())
    assert er_.entities["sensor.private_ble_device_eilee_phone_area"].unique_id == f"{NEW}_area"
    assert er_.entities["sensor.someone_else_area"].unique_id == "aa" * 16 + "_area"   # untouched
    assert dr_.devices["d1"].identifiers == {("private_ble_device", NEW)}
    assert phone.data == {"irk": NEW} and phone.unique_id == NEW
    calls = hass.config_entries.calls
    assert calls[:2] == [("unload", "pbd1"), ("unload", "b1")] and ("setup", "pbd1") in calls and ("setup", "b1") in calls


def test_replace_refuses_bad_or_taken_keys_and_changes_nothing(house):
    hass, phone, er_, _dr = house
    for bad, why in (("nope", "not a valid key"), (OLD, "already has"), ("aa" * 16, "Another device")):
        with pytest.raises(ir.IrkReplaceError, match=why):
            run(ir.async_replace_irk(hass, phone, bad))
    assert phone.data["irk"] == OLD and hass.config_entries.calls == []


def test_a_rerun_after_a_half_done_swap_drops_the_copies_and_finishes(house):
    # The first run moved the entities, then the device came back on the old
    # key and made "_2" copies of them.
    hass, phone, er_, dr_ = house
    for e in [e for e in er_.entities.values() if OLD in e.unique_id]:
        e.unique_id = e.unique_id.replace(OLD, NEW)
        copy = Ent(e.entity_id + "_2", e.platform, e.unique_id.replace(NEW, OLD))
        er_.entities[copy.entity_id] = copy
    out = run(ir.async_replace_irk(hass, phone, NEW))
    assert out["copies_removed"] == 4 and out["entities"] == 0 and out["devices"] == 2
    assert not [e for e in er_.entities if e.endswith("_2")]
    assert er_.entities["sensor.private_ble_device_eilee_phone_area"].unique_id == f"{NEW}_area"
    assert phone.data["irk"] == NEW and dr_.devices["d3"].identifiers == {("hue", 17)}


def test_a_dry_run_counts_and_changes_nothing(house):
    hass, phone, er_, dr_ = house
    out = run(ir.async_replace_irk(hass, phone, NEW, dry_run=True))
    assert out == {"device": "Eilee Phone", "entities": 4, "devices": 2, "copies_removed": 0, "merges": 0, "dry_run": True}
    assert phone.data["irk"] == OLD and hass.config_entries.calls == []
    assert er_.entities["sensor.private_ble_device_eilee_phone_area"].unique_id == f"{OLD}_area"


def test_two_devices_on_the_new_key_become_the_older_one_keeping_every_original(house):
    # The live state after two runs that stopped part way: the original
    # Bermuda entities hang off a device made today on the NEW key; the user's
    # July device still has the OLD key and holds only copies.
    hass, phone, er_, dr_ = house
    dr_.devices = {
        "july": types.SimpleNamespace(id="july", identifiers={("bermuda", OLD)}, name="562ea2", name_by_user="Eilee Phone", created_at=1),
        "today": types.SimpleNamespace(id="today", identifiers={("bermuda", NEW)}, name="Eilee Phone", name_by_user=None, created_at=2),
    }
    er_.entities = {}
    for eid, uid, dev in (("sensor.private_ble_device_eilee_phone_area", f"{NEW}_area", "today"),
                          ("sensor.private_ble_device_eilee_phone_area_2", f"{OLD}_area", "july")):
        er_.entities[eid] = Ent(eid, "bermuda", uid, dev)
    out = run(ir.async_replace_irk(hass, phone, NEW, dry_run=True))
    assert out["merges"] == 1 and out["copies_removed"] == 1
    run(ir.async_replace_irk(hass, phone, NEW))
    assert list(dr_.devices) == ["july"] and dr_.devices["july"].identifiers == {("bermuda", NEW)}
    assert list(er_.entities) == ["sensor.private_ble_device_eilee_phone_area"]
    assert er_.entities["sensor.private_ble_device_eilee_phone_area"].device_id == "july"


def test_mask_hides_keys():
    assert ir.mask(f"Identifiers {{('private_ble_device', '{NEW}')}} taken") == "Identifiers {('private_ble_device', '<key>')} taken"

