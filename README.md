![Sextant](img/logo.png)

# Sextant

**Indoor positioning for Home Assistant, powered by [Bermuda](https://github.com/agittins/bermuda).**

Bermuda's Bluetooth proxies measure how far each phone, watch, pet tag or
Tile is from each proxy. Sextant turns those distances into a dot on your
floor plan, and from the dot into the four things automations want: which
**floor**, which **room**, which **spot** in the room, and the **nearest
room** when the fix sits between two.

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=davidcoulson&repository=sextant&category=Integration)

![The Live page: the floor plan with every tracker, the selected one focused with a halo, and its room, spot, floor and proxies in the side panel](img/screenshots/sextant-live.png)

## TL;DR

- Bermuda gives you a distance from every Bluetooth proxy to every device.
  Sextant turns those into a position on your floor plan and four sensors
  per device: floor, room, spot and nearest room.
- Install from HACS, add the integration, draw your rooms and place your
  proxies in the panel, pick what to track. Nothing else to configure.
- Positions come from trilateration fused with fingerprints the proxies
  build by hearing each other; rooms need a margin and a dwell before
  they change, so sensors do not flap.
- If a tracker sits in the wrong place, tell it where it really is on the
  Live page and Sextant works out which settings fit that tracker best.

## Docs

| Install | Configure | Tune | Automate |
|---|---|---|---|
| [Installing](docs/install.md) · [What you need](docs/install.md#what-you-need) · [Upgrading from BPS](docs/install.md#upgrading-from-bps-or-bps-improved) | [Edit](docs/edit.md) · [Trackers](docs/trackers.md) · [Bermuda](docs/bermuda.md) · [Proxies](docs/proxies.md) | [Live](docs/live.md) · [Calibration](docs/calibration.md) · [Tuning](docs/tuning.md) · [How positioning works](docs/positioning.md) | [Sensors, card, services and API](docs/automation.md) |

Also [Where Sextant fits](docs/compared.md) (Bermuda, BPS, BPS-improved and
Sextant side by side) and [Data and development](docs/development.md).

## Quick start

1. HACS → Integrations → ⋮ → **Custom repositories**: add
   `davidcoulson/sextant` as an Integration, install **Sextant**, restart.
2. **Settings → Devices & Services → Add Integration → Sextant**. Bermuda
   must already be set up; for everything Sextant can do, run the
   [Bermuda fork](https://github.com/davidcoulson/bermuda).
3. Open **Sextant** in the sidebar. On **Edit**, add a floor from a plan
   image, set its scale, place the proxies, draw the rooms, Save.
4. On **Trackers**, pick what to track. Positions appear on **Live**
   within a cycle.

You want three or more proxies per floor, and each ESPHome proxy should
advertise an iBeacon so its siblings can range it. The details, including
the beacon block, are in [What you need](docs/install.md#what-you-need).

## The panel

A native Home Assistant panel at `/sextant`, no iframe and no pasted
token, in Home Assistant's own theme and unit system. Seven pages:

| Page | For |
|---|---|
| [Live](docs/live.md) | every tracker on the plan; focus one for its room, spot, floor and proxies; blend slider and truth marks |
| [Edit](docs/edit.md) | place proxies, draw rooms, spots and no-go areas, set the scale and floor levels |
| [Trackers](docs/trackers.md) | what is tracked and everything Bermuda hears; name, class, colour, photo, height and estimator per tracker |
| [Bermuda](docs/bermuda.md) | Bermuda's global options, Find My accessories, Tiles |
| [Proxies](docs/proxies.md) | proxy health by floor and room, what each proxy hears, the self-test |
| [Calibration](docs/calibration.md) | proxies calibrate each other; apply into Sextant or into Bermuda |
| [Tuning](docs/tuning.md) | the stability KPI, accuracy from truth marks, every knob live |

## What Sextant adds to Bermuda

- A position on the floor plan: trilateration fused with fingerprints the
  proxies build by hearing each other's beacons.
- Rooms as polygons with spots and no-go areas. Room and spot elections
  with a margin, a dwell and a stationary lock, so sensors do not flap.
- Floor election by competition between floors, scaled by proximity and a
  per-floor bias.
- Proxy calibration with 3D heights, written into Bermuda if you like.
- Truth marks: say where a tracker really is and Sextant finds the settings
  that fit it, and reports accuracy in metres.
- Bermuda management from the panel: track, untrack, Find My accessories,
  Tiles followed across address rotation (with the fork).
- Four sensors per tracker, a map card, services and a websocket push per
  cycle. Pure numpy, no SciPy.

## Credits

Sextant began as a fork of [Hogster/BPS](https://github.com/Hogster/BPS)
via [maxi1134/BPS-improved](https://github.com/maxi1134/BPS-improved).
Full credit for the original integration goes to
[@Hogster](https://github.com/Hogster) and [@maxi1134](https://github.com/maxi1134),
to [@agittins](https://github.com/agittins) for
[Bermuda](https://github.com/agittins/bermuda), and to
[Megarushing](https://github.com/Megarushing/bermuda) for the Find My
accessory support merged into the Bermuda fork. MIT licensed, see
[LICENSE](LICENSE).
