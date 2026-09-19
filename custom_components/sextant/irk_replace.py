"""Give a phone or watch a new Identity Resolving Key without losing anything.

Home Assistant's private_ble_device integration has no way to change a key:
the key IS the identity. It is the config entry's data and unique_id, the
device's identifier, and part of every entity's unique_id - its own and
every one Bermuda builds for the device, one per proxy and sensor (146 for
one phone here). Delete and re-add gets a fresh entry, and Bermuda a fresh
set of entities, so the entity ids, their history, and everything Sextant
keyed on them come back as strangers unless the new device is named exactly
as the old one was.

This swaps the key everywhere it is used, through the registries' own API
rather than by editing .storage (a running Home Assistant rewrites those
files from memory): unload the entry and Bermuda, rewrite the entry, the
devices and the entities, set both up again. Every entity keeps its
entity_id, so its history and Sextant's names, classes, spots and marks
carry straight on.
"""

from __future__ import annotations

import base64
import binascii
import logging

from homeassistant.config_entries import ConfigEntryState
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

_LOGGER = logging.getLogger(__name__)

PBD_DOMAIN = "private_ble_device"
BERMUDA_DOMAIN = "bermuda"


class IrkReplaceError(Exception):
    """Why the key could not be replaced, in words for the person asking."""


def parse_irk(value: str) -> str | None:
    """The key as private_ble_device stores it (32 lowercase hex), or None.

    The same forms its own config flow accepts: an optional "irk:" prefix,
    then 32 hex characters, or base64 ending in "=" (byte-reversed, as iOS
    exports it).
    """
    text = str(value or "").strip().removeprefix("irk:")
    try:
        raw = bytes(reversed(base64.b64decode(text))) if text.endswith("=") else binascii.unhexlify(text)
    except (binascii.Error, ValueError):
        return None
    return raw.hex() if len(raw) == 16 else None


def _pbd_entries(hass):
    return [e for e in hass.config_entries.async_entries(PBD_DOMAIN) if isinstance(e.data.get("irk"), str)]


def entry_for_thing(hass, thing: str):
    """The private_ble_device entry behind a Sextant thing, or None.

    A thing is Bermuda's slug for the device. Bermuda's entities for it carry
    the key in their unique_id, so the entry whose key appears there is the one.
    """
    ent_reg = er.async_get(hass)
    uids = [
        e.unique_id for e in ent_reg.entities.values()
        if e.platform == BERMUDA_DOMAIN and e.entity_id.split(".", 1)[1].startswith(f"{thing}_")
    ]
    for entry in _pbd_entries(hass):
        irk = entry.data["irk"]
        if any(irk in uid for uid in uids):
            return entry
    return None


def _device_name(hass, irk: str) -> str | None:
    for device in dr.async_get(hass).devices.values():
        if (PBD_DOMAIN, irk) in device.identifiers:
            return device.name_by_user or device.name
    return None


async def async_replace_irk(hass, entry, new_value: str) -> dict:
    """Swap ``entry``'s key for ``new_value`` everywhere; returns what changed."""
    new = parse_irk(new_value)
    if new is None:
        raise IrkReplaceError("That is not a valid key: it should be 32 hex characters, or base64 ending in '='")
    old = entry.data["irk"]
    if new == old:
        raise IrkReplaceError("That is the key this device already has")
    if any(e.data.get("irk") == new for e in _pbd_entries(hass) if e.entry_id != entry.entry_id):
        raise IrkReplaceError("Another device already uses that key")

    ent_reg, dev_reg = er.async_get(hass), dr.async_get(hass)
    entities = [e for e in ent_reg.entities.values() if old in e.unique_id]
    for e in entities:
        taken = ent_reg.async_get_entity_id(e.domain, e.platform, e.unique_id.replace(old, new))
        if taken and taken != e.entity_id:
            raise IrkReplaceError(f"{taken} already carries the new key; remove it first")
    name = _device_name(hass, old)

    # Nothing may hold the old identity while it is rewritten: the device's
    # own entry and Bermuda, which resolves through it.
    bermuda = [b for b in hass.config_entries.async_entries(BERMUDA_DOMAIN) if b.state is ConfigEntryState.LOADED]
    await hass.config_entries.async_unload(entry.entry_id)
    for b in bermuda:
        await hass.config_entries.async_unload(b.entry_id)
    renamed = devices = 0
    try:
        for e in entities:
            ent_reg.async_update_entity(e.entity_id, new_unique_id=e.unique_id.replace(old, new))
            renamed += 1
        for device in list(dev_reg.devices.values()):
            if any(old in ident[1] for ident in device.identifiers):
                dev_reg.async_update_device(
                    device.id,
                    new_identifiers={(d, v.replace(old, new)) for d, v in device.identifiers},
                )
                devices += 1
        hass.config_entries.async_update_entry(entry, data={**entry.data, "irk": new}, unique_id=new)
    finally:
        # Set everything up again whatever happened above: a failure part way
        # must not leave the device and Bermuda unloaded. (What was already
        # rewritten stays rewritten; the log line below will be missing.)
        await hass.config_entries.async_setup(entry.entry_id)
        for b in bermuda:
            await hass.config_entries.async_setup(b.entry_id)
    _LOGGER.info("Replaced the key of %s: %d entities, %d devices", name or entry.title, renamed, devices)
    return {"device": name or entry.title, "entities": renamed, "devices": devices}
