[Sextant](../README.md) › Proxies

# Proxies

![The Proxies page: every proxy grouped by floor and room with a health count per group](../img/screenshots/sextant-proxies.png)

Every placed proxy grouped by floor and room, with a count per group of
online, quiet (no reading for two minutes), offline and unmatched (placed
but no scanner by that name or address). Each row shows the last time it
heard anything, its calibration correction and its height. A second card
lists what each proxy hears right now, so a proxy that is up but not
scanning stands out. The leave-one-out self-test solves every proxy from
its siblings' measurements and reports the error, published as
`sensor.sextant_position_accuracy` (CEP95, metres).
