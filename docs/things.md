[Sextant](../README.md) › Things

# Things

![The Things page: what is tracked, with its class icon, and everything Bermuda hears but does not track, with where the loudest proxy is](../img/screenshots/sextant-things.png)

Bermuda's device management without its options flow. **Add a thing…** asks
what you are adding, because how a thing is followed depends on whether its
Bluetooth address stays put:

| What | What it needs |
|---|---|
| A phone or watch | Its Identity Resolving Key. A phone changes its address every few minutes and only that key follows it. Paste the key here and Sextant fills in Home Assistant's own Private BLE Device form, which will only take a key it can watch resolve an address right now — so keep the phone awake and near a proxy. |
| An AirTag or FindMy tag | Its pairing keys, exported from the Mac it was paired from or from iCloud, depending on the macOS version. Opens the walkthrough on the [Bermuda page](bermuda.md). |
| A Tile | A binding, on the [Bermuda page](bermuda.md), so one Tile is followed across its rotations. |
| Anything else | Nothing. An iBeacon, a fitness band or a tag with a fixed address simply appears below once a couple of proxies hear it. |

The top list is what
is tracked: click the name or the icon to open the thing dialog and set a
display name, a class (person, dog, cat, phone, watch, headphones, keys, tag and more,
each with its icon on the map), pronouns (he, she, they or it: how the panel
refers to it; left unset, a man is he, a woman she, a device it, and a
person, child or pet they), a colour used everywhere it is drawn, a
photo framed in a circle that replaces the icon, the height it is carried
at, a reference-power trim, and its own position estimator. **Untrack** removes it from Bermuda and
removes its five Sextant sensors and its device with it; a device untracked
while Home Assistant was down is cleaned up on the next cycle.

Below is everything Bermuda hears but does not track, with the kind of
device (iBeacon, Tile, Apple, IRK, plain address), what it appears to be
(the Bermuda fork names families the Bluetooth SIG's lists cannot — a Govee
sensor, a Samsung SmartTag — and says when that kind rotates its address,
which is why some of them cannot be followed at all), where it is (the room
of the loudest placed proxy) and the signal there in dBm, and for Apple
adverts what they are (AirPods and accessories, an iPhone, Watch or Mac
nearby, a Find My tag). Search by name, address, room, floor, proxy, kind
or maker. Adverts heard only by unplaced proxies are ignored, and the
proxies' own probe beacons are hidden. **Track…** opens the same dialog
first, so you choose the name, class and height before Bermuda is told and
reloads.
