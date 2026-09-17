"""Persistent storage for Sextant layout + calibration state.

The floor/zone/receiver layout and the calibration state used to live as flat
files in ``www/sextant_maps`` (``bpsdata.txt`` / ``sextant_calibration_state.json``),
written with ``open(path, "w")`` — which truncates to zero *before* writing, so
an interrupted write left a 0-byte file and wiped the config (issue #104).
Being under ``www/`` also made them readable unauthenticated via ``/local/``.

Both now live in Home Assistant's ``Store`` (``config/.storage/``):
``Store.async_save`` writes atomically (temp file + ``os.replace`` — the live
file is never truncated), and ``.storage`` is not web-served. This module is
the single owner of that data and imports nothing from the rest of the package
(so both ``__init__`` and ``calibration`` can import it without a cycle).
"""
import asyncio
import copy
import json
import logging
from pathlib import Path

import os
import shutil

import aiofiles
import aiofiles.os
from homeassistant.helpers.storage import Store

_LOGGER = logging.getLogger(__name__)

DOMAIN = "sextant"
STORAGE_VERSION = 1
STORAGE_KEY_LAYOUT = "sextant"                       # -> config/.storage/sextant
STORAGE_KEY_CALIB = "sextant_calibration_state"      # -> config/.storage/sextant_calibration_state

# Serializes read-modify-write sequences on the layout across every writer
# (panel save + calibration). Lives here so both importers share one lock
# without an import cycle (was previously defined in calibration.py).
LAYOUT_LOCK = asyncio.Lock()

# The integration was called "bps" before it became Sextant. Its Store keys,
# history directory and maps directory all carried that name.
LEGACY_DOMAIN = "bps"


def _legacy_layout_path(hass) -> Path:
    return Path(hass.config.path("www/sextant_maps")) / "bpsdata.txt"


def _legacy_calib_path(hass) -> Path:
    return Path(hass.config.path("www/sextant_maps")) / "sextant_calibration_state.json"


def _bucket(hass) -> dict:
    return hass.data.setdefault(DOMAIN, {})


def _layout_store(hass) -> Store:
    bucket = _bucket(hass)
    store = bucket.get("_layout_store")
    if store is None:
        store = bucket["_layout_store"] = Store(hass, STORAGE_VERSION, STORAGE_KEY_LAYOUT)
    return store


def _calib_store(hass) -> Store:
    bucket = _bucket(hass)
    store = bucket.get("_calib_store")
    if store is None:
        store = bucket["_calib_store"] = Store(hass, STORAGE_VERSION, STORAGE_KEY_CALIB)
    return store


# --- Layout (bpsdata) --------------------------------------------------------

def get_layout(hass):
    """The cached layout for READ-ONLY consumers.

    Defaults to ``[]`` on a fresh install, matching the old empty-file
    behaviour (a populated layout is a dict; consumers guard with isinstance).
    """
    return _bucket(hass).get("layout", [])


def get_layout_version(hass) -> int:
    """Monotonic counter bumped every time the layout is (re)loaded or saved.

    Derived per-floor data compiled from the layout (e.g. shapely zone/sub-zone
    polygons in ``__init__.py``, rebuilt from scratch on every lookup call
    otherwise) can cache against this instead: a cached entry is valid exactly
    as long as this counter hasn't moved, with no need to hash or diff the
    layout content itself.
    """
    return _bucket(hass).get("layout_version", 0)


def _bump_layout_version(hass) -> None:
    _bucket(hass)["layout_version"] = _bucket(hass).get("layout_version", 0) + 1


def get_layout_for_edit(hass):
    """A deep copy of the layout for read-modify-write callers (calibration).

    Returns ``None`` when there is no layout yet — matching the old
    ``_read_coords`` contract — so callers must never mutate the live cache
    the tracking loop reads.
    """
    data = get_layout(hass)
    return copy.deepcopy(data) if isinstance(data, dict) else None


async def load_layout(hass):
    """Load the layout from the store into the in-memory cache (at setup).

    A corrupt/unreadable store must not abort setup — the old flat-file reader
    tolerated bad JSON and ran with an empty layout, so keep that resilience.
    """
    try:
        data = await _layout_store(hass).async_load()
    except Exception as e:
        _LOGGER.error("Could not load layout from storage; starting empty: %s", e)
        data = None
    _bucket(hass)["layout"] = data if data is not None else []
    _bump_layout_version(hass)
    return _bucket(hass)["layout"]


async def save_layout(hass, data) -> None:
    """Persist the layout dict atomically, THEN refresh the cache.

    Uses ``async_save`` (immediate atomic write), never ``async_delay_save`` —
    a debounced write could still be lost on a crash inside the delay window.
    Persist first so a raising write leaves the cache matching what survives a
    restart rather than running ahead of disk.
    """
    await _layout_store(hass).async_save(data)
    _bucket(hass)["layout"] = data
    _bump_layout_version(hass)


# --- Calibration state -------------------------------------------------------

async def load_calib_state(hass):
    """The persisted calibration state, or None on first run / if unreadable."""
    try:
        return await _calib_store(hass).async_load()
    except Exception as e:
        _LOGGER.warning("Could not load calibration state; starting cold: %s", e)
        return None


async def save_calib_state(hass, payload) -> None:
    await _calib_store(hass).async_save(payload)


# --- One-time migration of the old flat files -------------------------------

async def _read_legacy(path: Path):
    """Read a legacy file. Returns (content, existed)."""
    try:
        async with aiofiles.open(path, "r") as f:
            return await f.read(), True
    except FileNotFoundError:
        return None, False
    except OSError as e:
        _LOGGER.warning("Could not read legacy file %s: %s", path, e)
        return None, True  # exists but unreadable — don't delete it


async def _remove_legacy(path: Path) -> None:
    if not path.exists():
        return
    try:
        await aiofiles.os.remove(path)
        _LOGGER.info("Removed legacy file %s (data now lives in .storage)", path.name)
    except OSError as e:
        _LOGGER.error(
            "Could not remove legacy %s — it stays readable via /local until "
            "removed by hand: %s", path.name, e)


async def migrate_from_bps(hass) -> None:
    """Copy everything the pre-rename "bps" integration kept, once.

    Runs before ``migrate_legacy`` and only fills what is still empty, so a
    fresh install and an already-migrated one are both no-ops. Everything is
    copied rather than moved: rolling back to the old integration must still
    find its data where it left it.
    """
    for store, old_key, new_key, label in (
        (_layout_store(hass), LEGACY_DOMAIN, STORAGE_KEY_LAYOUT, "layout"),
        (_calib_store(hass), f"{LEGACY_DOMAIN}_calibration_state", STORAGE_KEY_CALIB, "calibration state"),
    ):
        try:
            if await store.async_load() is not None:
                continue
            old = await Store(hass, STORAGE_VERSION, old_key).async_load()
        except Exception as e:
            _LOGGER.warning("Could not read the %s while migrating from bps: %s", label, e)
            continue
        if old is None:
            continue
        await store.async_save(old)
        _LOGGER.info("Copied the %s from .storage/%s (bps) into .storage/%s", label, old_key, new_key)

    def _copy_dirs() -> list[str]:
        copied = []
        for old, new in (
            (hass.config.path(f"www/{LEGACY_DOMAIN}_maps"), hass.config.path(f"www/{DOMAIN}_maps")),
            (hass.config.path(".storage", f"{LEGACY_DOMAIN}_history"), hass.config.path(".storage", f"{DOMAIN}_history")),
        ):
            if os.path.isdir(old) and not os.path.exists(new):
                shutil.copytree(old, new)
                copied.append(new)
        return copied

    try:
        for path in await hass.async_add_executor_job(_copy_dirs):
            _LOGGER.info("Copied bps data directory to %s", path)
    except Exception as e:
        _LOGGER.warning("Could not copy bps data directories: %s", e)


async def migrate_legacy(hass) -> None:
    """Move the old ``www/sextant_maps`` files into the store, once.

    Idempotent: only runs while the store is still empty. For each file:
    a blank/whitespace file (the issue-#104 artifact — no recoverable data) is
    deleted; a corrupt-but-non-empty file is LEFT in place (may be
    hand-recoverable); a valid file is saved to the store, verified, and only
    then deleted — closing the ``/local/`` exposure. Map images stay in
    ``www/sextant_maps`` (served via ``/local/``) and are untouched.
    """
    await _migrate_one(
        _layout_store(hass), _legacy_layout_path(hass), "layout",
        lambda parsed: isinstance(parsed, (dict, list)),
    )
    await _migrate_one(
        _calib_store(hass), _legacy_calib_path(hass), "calibration state",
        lambda parsed: isinstance(parsed, dict),
    )


async def _migrate_one(store: Store, legacy: Path, label: str, is_valid) -> None:
    try:
        existing = await store.async_load()
    except Exception as e:
        # Corrupt/unreadable store: don't migrate over it (may be recoverable)
        # and don't touch the legacy file — just don't crash setup.
        _LOGGER.warning("Could not read %s store; leaving legacy file: %s", label, e)
        return
    if existing is not None:
        # Store already owns the data. Retry the cleanup every boot so a
        # previously-failed delete (or a legacy file restored from a backup)
        # can't linger /local-exposed forever.
        await _remove_legacy(legacy)
        return
    content, existed = await _read_legacy(legacy)
    if not existed or content is None:
        return  # fresh install, or unreadable — leave it
    if not content.strip():
        # 0-byte / whitespace: the data-loss artifact, nothing to recover.
        await _remove_legacy(legacy)
        return
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        _LOGGER.warning(
            "Legacy %s file %s is not valid JSON; leaving it in place for "
            "manual recovery and starting empty", label, legacy.name)
        return
    if not is_valid(parsed):
        _LOGGER.warning("Legacy %s file %s has unexpected shape; leaving it", label, legacy.name)
        return
    await store.async_save(parsed)
    if await store.async_load() is None:
        _LOGGER.error("Migrating %s to storage failed to verify; keeping %s", label, legacy.name)
        return
    _LOGGER.info("Migrated %s from %s into .storage", label, legacy.name)
    await _remove_legacy(legacy)
