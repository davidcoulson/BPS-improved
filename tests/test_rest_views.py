"""The REST views: /api/sextant/cords, /api/sextant/selftest, /api/sextant/upload_tracker_icon."""
import asyncio
import io
import types

import sextant
from sextant import storage as st

from conftest import make_hass


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _hass(tmp_path):
    hass = make_hass(tmp_path)
    hass.data["sextant"] = {}
    hass.states = types.SimpleNamespace(async_all=lambda domain=None: [])
    return hass


def test_cords_is_404_until_the_loop_has_published_and_then_the_payload(tmp_path):
    hass = _hass(tmp_path)
    view = sextant.SextantCordsAPI(hass)
    assert run(view.get(None)).status == 404
    hass.data["sextant"]["apitricords"] = {"phone": {"ent": "phone", "zone": "Kitchen", "cords": {"x": 1, "y": 2}}}
    response = run(view.get(None))
    assert response.status == 200 and response.json_body["phone"]["zone"] == "Kitchen"


def test_selftest_answers_even_with_nothing_to_solve(tmp_path):
    hass = _hass(tmp_path)
    run(st.save_layout(hass, {"floor": [{"name": "F", "scale": 100.0, "receivers": [], "zones": [], "subzones": []}], "tuning": {}}))
    response = run(sextant.SextantSelfTestAPI(hass).get(None))
    assert response.status == 200 and isinstance(response.json_body, dict)


def _upload(hass, field):
    async def post():
        return {"icon": field} if field is not None else {}
    request = types.SimpleNamespace(app={"hass": hass}, post=post)
    return run(sextant.SextantUploadTrackerIconAPI().post(request))


def test_icon_upload_stores_a_sanitised_name_under_www(tmp_path):
    hass = _hass(tmp_path)
    field = types.SimpleNamespace(filename="../../dog face?.png", file=io.BytesIO(b"PNGDATA"))
    response = _upload(hass, field)
    assert response.status == 200
    assert response.json_body == {"icon_url": "/local/sextant_icons/dog_face_.png", "icon_name": "dog_face_.png"}
    assert (tmp_path / "www" / "sextant_icons" / "dog_face_.png").read_bytes() == b"PNGDATA"
    assert not (tmp_path / "dog face?.png").exists()


def test_icon_upload_without_a_file_is_a_400(tmp_path):
    assert _upload(_hass(tmp_path), None).status == 400
