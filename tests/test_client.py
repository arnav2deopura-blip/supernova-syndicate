"""Owner: A. Offline only: no live IRSA calls (keeps CI fast and stable)."""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import cache, schemas
from backend.server import app
from backend.spherex_client import cutout_url

MOCK = Path(__file__).resolve().parent.parent / "frontend" / "mock"
client = TestClient(app)


def test_cache_key_stable_and_rounded():
    assert cache.cache_key("frames", 10.0, 20.0, 0.1, "D2") == cache.cache_key("frames", 10.0000001, 20.0, 0.1, "D2")
    assert cache.cache_key("frames", 10.0, 20.0, 0.1, "D2") != cache.cache_key("frames", 10.0, 20.0, 0.1, "D3")


def test_cache_roundtrip(tmp_path):
    cache.put_json("abcd1234", {"x": 1}, root=tmp_path)
    assert cache.get_json("abcd1234", root=tmp_path) == {"x": 1}
    assert cache.get_json("missing0", root=tmp_path) is None


def test_cutout_url():
    assert cutout_url("https://x/y.fits", 1.5, -2.0, 0.1) == "https://x/y.fits?center=1.5,-2.0&size=0.1"
    assert cutout_url("https://x/y?a=1", 1, 2, 0.1).startswith("https://x/y?a=1&center=")


def test_health():
    assert client.get("/api/health").json() == {"ok": True}


def test_errors_share_one_shape():
    for url, code in [
        ("/api/frames?ra=999&dec=0", "bad_request"),
        ("/api/frames?ra=10&dec=0", "not_implemented"),
        ("/api/overlay?ra=10&dec=0&cat=nope", "bad_request"),
    ]:
        r = client.get(url)
        body = r.json()
        assert set(body) == {"error", "message"}, url
        assert body["error"] == code, url
        schemas.ErrorResponse(**body)


@pytest.mark.parametrize("name,model", [
    ("resolve", schemas.ResolveResponse),
    ("frames", schemas.FramesResponse),
    ("exposures", schemas.ExposuresResponse),
    ("spectrum", schemas.SpectrumResponse),
    ("overlay", schemas.OverlayResponse),
])
def test_mocks_match_contract(name, model):
    """frontend/mock/ must always match backend/schemas.py (docs/API.md)."""
    model(**json.loads((MOCK / f"{name}.json").read_text()))


def test_mock_frames_sizes_consistent():
    f = schemas.FramesResponse(**json.loads((MOCK / "frames.json").read_text()))
    for fr in f.frames:
        assert len(fr.data) == fr.width * fr.height
