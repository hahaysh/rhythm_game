import copy
import hashlib
import json
import shutil
import sqlite3
import wave
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from rhythm_game.demo import ensure_demo
from rhythm_game.models import Chart
from rhythm_game.server import ROOT, create_app, load_charts


@pytest.fixture(scope="session")
def demo_audio(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("music") / "demo.wav"
    ensure_demo(path)
    return path


@pytest.fixture
def data_dir(tmp_path: Path, demo_audio: Path) -> Path:
    data = tmp_path / "data"
    (data / "audio").mkdir(parents=True)
    shutil.copyfile(demo_audio, data / "audio" / "demo.wav")
    return data


@pytest.fixture
def client(data_dir: Path):
    with TestClient(create_app(data_dir)) as connection:
        yield connection


def result_body(client: TestClient, perfect: int | None = None) -> dict[str, object]:
    total = len(client.get("/api/songs/demo/chart").json()["notes"])
    perfect = total if perfect is None else perfect
    return {
        "attempt_id": str(uuid4()),
        "song_id": "demo",
        "perfect": perfect,
        "good": total - perfect,
        "miss": 0,
        "max_combo": total,
    }


def test_serves_game_chart_and_wav(client: TestClient) -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert 'lang="ko"' in response.text
    for asset in ("engine.mjs", "audio.mjs", "app.mjs", "style.css"):
        asset_response = client.get(f"/static/{asset}")
        assert asset_response.status_code == 200
        if asset.endswith(".mjs"):
            assert asset_response.headers["content-type"].startswith("text/javascript")
    songs = client.get("/api/songs").json()
    chart = client.get("/api/songs/demo/chart").json()
    assert len(songs) == 1
    assert songs[0]["note_count"] == len(chart["notes"])
    assert chart["duration_ms"] == 50000
    assert chart["notes"][0]["time_ms"] >= 3000
    assert chart["notes"][-1]["time_ms"] <= 47000
    assert client.get(chart["audio_path"]).content[:4] == b"RIFF"
    assert client.get("/api/songs/demo/records").json() == {"best": None, "recent": []}


@pytest.mark.parametrize("route", ["chart", "records"])
def test_unknown_song(client: TestClient, route: str) -> None:
    response = client.get(f"/api/songs/unknown/{route}")
    assert response.status_code == 404
    assert response.json()["detail"] == "존재하지 않는 곡입니다."


def test_server_computes_score_and_retry_is_idempotent(client: TestClient) -> None:
    body = result_body(client, 10)
    response = client.post("/api/results", json=body)
    assert response.status_code == 201, response.text
    record = response.json()
    total = body["perfect"] + body["good"]
    assert record["score"] == body["perfect"] * 1000 + body["good"] * 500
    assert record["accuracy"] == round((10 + body["good"] * 0.5) / total * 100, 2)
    assert record["played_at"].endswith("+00:00")
    retry = client.post("/api/results", json=body)
    assert retry.status_code == 201
    assert retry.json() == record
    assert len(client.get("/api/songs/demo/records").json()["recent"]) == 1
    changed = {**body, "perfect": 11, "good": body["good"] - 1}
    assert client.post("/api/results", json=changed).status_code == 409


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("perfect", -1),
        ("perfect", 1.5),
        ("perfect", True),
        ("perfect", "10"),
        ("good", -1),
        ("miss", -1),
        ("max_combo", -1),
        ("max_combo", 0),
        ("max_combo", 20001),
        ("attempt_id", "not-a-uuid"),
        ("song_id", "../demo"),
        ("score", 9999999),
        ("accuracy", 100),
    ],
)
def test_invalid_results(client: TestClient, field: str, value: object) -> None:
    body = result_body(client)
    body[field] = value
    response = client.post("/api/results", json=body)
    assert response.status_code == 422
    assert response.json()["detail"]
    assert client.get("/api/songs/demo/records").json()["recent"] == []


def test_result_totals_and_unknown_song(client: TestClient) -> None:
    body = result_body(client)
    body["perfect"] -= 1
    assert client.post("/api/results", json=body).status_code == 422
    body = result_body(client)
    body["song_id"] = "missing"
    assert client.post("/api/results", json=body).status_code == 404
    body = result_body(client)
    body.update(perfect=0, good=0, miss=0, max_combo=0)
    assert client.post("/api/results", json=body).status_code == 422


def test_all_misses_and_max_combo_validation(client: TestClient) -> None:
    body = result_body(client)
    total = body["perfect"]
    body.update(perfect=0, good=0, miss=total, max_combo=0)
    response = client.post("/api/results", json=body)
    assert response.status_code == 201, response.text
    assert response.json()["score"] == 0
    assert response.json()["accuracy"] == 0
    body["attempt_id"] = str(uuid4())
    body["max_combo"] = 1
    assert client.post("/api/results", json=body).status_code == 422


def test_best_recent_and_persistent_schema(client: TestClient, data_dir: Path) -> None:
    for perfect in range(12):
        response = client.post("/api/results", json=result_body(client, perfect))
        assert response.status_code == 201, response.text
    records = client.get("/api/songs/demo/records").json()
    assert len(records["recent"]) == 10
    assert records["best"]["perfect"] == 11
    assert [row["perfect"] for row in records["recent"]] == list(range(11, 1, -1))
    with TestClient(create_app(data_dir)) as reopened:
        assert reopened.get("/api/songs/demo/records").json() == records


def test_database_failure_is_explicit(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_save(_result):
        raise sqlite3.OperationalError("test disk failure")

    monkeypatch.setattr(client.app.state.store, "save", fail_save)
    response = client.post("/api/results", json=result_body(client))
    assert response.status_code == 503, response.text
    assert "기록 저장소" in response.json()["detail"]


@pytest.fixture
def chart_data() -> dict[str, object]:
    return json.loads((ROOT / "songs" / "demo.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "mutation",
    [
        lambda c: c.update(notes=[]),
        lambda c: c.update(title="   "),
        lambda c: c["notes"][0].update(lane=4),
        lambda c: c["notes"][0].update(lane=True),
        lambda c: c["notes"][0].update(time_ms=-1),
        lambda c: c["notes"][0].update(time_ms=3500.5),
        lambda c: c["notes"].reverse(),
        lambda c: c["notes"].insert(1, copy.deepcopy(c["notes"][0])),
        lambda c: c["notes"][-1].update(time_ms=50000),
        lambda c: c.update(bpm=0),
        lambda c: c.update(bpm=float("nan")),
        lambda c: c.update(audio_path="/audio/../demo.wav"),
        lambda c: c.update(audio_path="https://example.com/demo.wav"),
        lambda c: c.update(id="../demo"),
    ],
)
def test_chart_validation(chart_data, mutation) -> None:
    mutation(chart_data)
    with pytest.raises(ValidationError):
        Chart.model_validate(chart_data)


def test_bad_chart_and_music_are_not_silently_skipped(
    tmp_path: Path, data_dir: Path, chart_data
) -> None:
    songs = tmp_path / "songs"
    songs.mkdir()
    file = songs / "broken.json"
    file.write_text("{", encoding="utf-8")
    with pytest.raises(ValueError, match="broken.json"):
        load_charts(songs, data_dir / "audio")
    chart_data["duration_ms"] = 51000
    file.write_text(json.dumps(chart_data), encoding="utf-8")
    with pytest.raises(ValueError, match="broken.json"):
        load_charts(songs, data_dir / "audio")
    chart_data["duration_ms"] = 50000
    file.write_text(json.dumps(chart_data), encoding="utf-8")
    (songs / "duplicate.json").write_text(json.dumps(chart_data), encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate.json"):
        load_charts(songs, data_dir / "audio")


def test_demo_is_reproducible_and_50_seconds(demo_audio: Path, tmp_path: Path) -> None:
    second = tmp_path / "demo.wav"
    ensure_demo(second)
    original = demo_audio.read_bytes()
    assert hashlib.sha256(original).digest() == hashlib.sha256(second.read_bytes()).digest()
    ensure_demo(second)
    assert second.read_bytes() == original
    with wave.open(str(second)) as source:
        assert source.getnchannels() == 1
        assert source.getsampwidth() == 2
        assert source.getnframes() / source.getframerate() == 50
        assert any(source.readframes(source.getnframes()))
