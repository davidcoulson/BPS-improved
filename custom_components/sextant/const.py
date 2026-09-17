DOMAIN = "sextant"

# Global diagnostic sensor: receiver self-localization accuracy (CEP95, m).
# Shared by sensor.py (the entity) and __init__.py (the periodic publisher).
ACCURACY_ENTITY_ID = "sensor.sextant_position_accuracy"
# The iBeacon UUID every calibration probe advertises (README, "make each probe advertise"), lower-case
# hex without dashes. Bermuda names such a beacon <uuid>_<major>_<minor>; it is never a device to track.
PROBE_BEACON_UUID = "fde3b1502f6443baaee9867f75ee4a6f"
