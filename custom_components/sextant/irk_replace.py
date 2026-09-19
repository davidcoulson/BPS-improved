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
import re

from homeassistant.config_entries import ConfigEntryState
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

_LOGGER = logging.getLogger(__name__)

PBD_DOMAIN = "private_ble_device"
BERMUDA_DOMAIN = "bermuda"


class IrkReplaceError(Exception):
    """Why the key could not be replaced, in words for the person asking."""


_KEY = re.compile(r"[0-9a-fA-F]{32}")


def mask(text) -> str:
    """Hide anything shaped like a key: an error from the registries quotes identifiers verbatim."""
    return _KEY.sub("<key>", str(text))


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


def _devices(dev_reg):
    """Every device entry, by iterating the registry's devices - not through
    their mapping interface, which Home Assistant deprecated for integrations.
    (Older versions iterate to ids; those are looked up.)"""
    return [d if not isinstance(d, str) else dev_reg.async_get(d) for d in list(dev_reg.devices)]


def _carries(identifier, irk: str) -> bool:
    """Whether a device identifier holds the key. Identifiers are meant to be
    (domain, id) pairs of text, but integrations store numbers, and tuples of
    one or three; look at every part."""
    return any(isinstance(part, str) and irk in part for part in identifier)


def _swap(identifier, old: str, new: str):
    return tuple(part.replace(old, new) if isinstance(part, str) else part for part in identifier)


def _device_name(hass, irk: str) -> str | None:
    device = dr.async_get(hass).async_get_device(identifiers={(PBD_DOMAIN, irk)})
    return (device.name_by_user or device.name) if device else None


def _merge_or_move(ent_reg, dev_reg, device, swapped) -> None:
    """Give ``device`` its new identifiers, merging with a device that already has them.

    A swap that stopped part way leaves a second device on the new key (the
    integration made it when it came back up). Two devices cannot share an
    identifier, so they become one: the older - the one people named and put
    in an area - is kept, the other's entities move onto it (removing a device
    removes its entities), and the other goes.
    """
    other = dev_reg.async_get_device(identifiers=swapped)
    if other is None or other.id == device.id:
        dev_reg.async_update_device(device.id, new_identifiers=swapped)
        return
    born = lambda d: getattr(d, "created_at", None) or 0  # noqa: E731
    keep, drop = (device, other) if born(device) <= born(other) else (other, device)
    for e in er.async_entries_for_device(ent_reg, drop.id, include_disabled_entities=True):
        ent_reg.async_update_entity(e.entity_id, device_id=keep.id)
    dev_reg.async_remove_device(drop.id)
    if keep is device:
        dev_reg.async_update_device(device.id, new_identifiers=swapped | set(other.identifiers))


async def async_replace_irk(hass, entry, new_value: str, dry_run: bool = False) -> dict:
    """Swap ``entry``'s key for ``new_value`` everywhere; returns what changed.

    ``dry_run`` walks every entity and device the same way and says what it
    would change, touching nothing.
    """
    new = parse_irk(new_value)
    if new is None:
        raise IrkReplaceError("That is not a valid key: it should be 32 hex characters, or base64 ending in '='")
    old = entry.data["irk"]
    if new == old:
        raise IrkReplaceError("That is the key this device already has")
    if any(e.data.get("irk") == new for e in _pbd_entries(hass) if e.entry_id != entry.entry_id):
        raise IrkReplaceError("Another device already uses that key")

    ent_reg, dev_reg = er.async_get(hass), dr.async_get(hass)
    entities, copies = [], []
    for e in list(ent_reg.entities.values()):
        if not isinstance(e.unique_id, str) or old not in e.unique_id:
            continue
        # An entity already carrying the new key means a run that stopped
        # part way: the originals were moved, then the device came back up on
        # the old key and made copies of them. The original keeps its id and
        # history; the copy goes.
        if ent_reg.async_get_entity_id(e.domain, e.platform, e.unique_id.replace(old, new)):
            copies.append(e.entity_id)
        else:
            entities.append(e)
    name = _device_name(hass, old)
    carrying = [d for d in _devices(dev_reg) if d is not None and any(_carries(i, old) for i in d.identifiers)]
    if dry_run:
        merges = sum(
            1 for d in carrying
            if (o := dev_reg.async_get_device(identifiers={_swap(i, old, new) for i in d.identifiers})) is not None and o.id != d.id
        )
        return {"device": name or entry.title, "entities": len(entities), "devices": len(carrying),
                "copies_removed": len(copies), "merges": merges, "dry_run": True}

    # Nothing may hold the old identity while it is rewritten: the device's
    # own entry and Bermuda, which resolves through it.
    bermuda = [b for b in hass.config_entries.async_entries(BERMUDA_DOMAIN) if b.state is ConfigEntryState.LOADED]
    await hass.config_entries.async_unload(entry.entry_id)
    for b in bermuda:
        await hass.config_entries.async_unload(b.entry_id)
    renamed = devices = 0
    try:
        for entity_id in copies:
            ent_reg.async_remove(entity_id)
        for e in entities:
            ent_reg.async_update_entity(e.entity_id, new_unique_id=e.unique_id.replace(old, new))
            renamed += 1
        for device in carrying:
            if dev_reg.async_get(device.id) is None:
                continue   # merged into another already
            _merge_or_move(ent_reg, dev_reg, device, {_swap(i, old, new) for i in device.identifiers})
            devices += 1
        hass.config_entries.async_update_entry(entry, data={**entry.data, "irk": new}, unique_id=new)
    finally:
        # Set everything up again whatever happened above: a failure part way
        # must not leave the device and Bermuda unloaded. (What was already
        # rewritten stays rewritten; the log line below will be missing.)
        await hass.config_entries.async_setup(entry.entry_id)
        for b in bermuda:
            await hass.config_entries.async_setup(b.entry_id)
    _LOGGER.info("Replaced the key of %s: %d entities, %d devices, %d leftover copies removed",
                 name or entry.title, renamed, devices, len(copies))
    return {"device": name or entry.title, "entities": renamed, "devices": devices, "copies_removed": len(copies)}
