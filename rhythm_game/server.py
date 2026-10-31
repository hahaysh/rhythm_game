import logging
import mimetypes
import os
import sqlite3
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from .demo import ensure_demo
from .models import Chart, ResultInput
from .store import ResultConflict, Store

ROOT = Path(__file__).resolve().parent.parent
logger = logging.getLogger("rhythm_game")
mimetypes.add_type("text/javascript", ".mjs")


def load_charts(chart_dir: Path, audio_dir: Path) -> dict[str, Chart]:
    charts: dict[str, Chart] = {}
    for path in sorted(chart_dir.glob("*.json")):
        try:
            chart = Chart.model_validate_json(path.read_text(encoding="utf-8"))
            audio = audio_dir / chart.audio_path.removeprefix("/audio/")
            with wave.open(str(audio), "rb") as source:
                duration_ms = source.getnframes() / source.getframerate() * 1000
                if abs(duration_ms - chart.duration_ms) > 2:
                    raise ValueError("채보의 음악 길이가 WAV 파일과 일치하지 않습니다.")
            if chart.id in charts:
                raise ValueError("곡 ID가 중복되었습니다.")
            charts[chart.id] = chart
        except (OSError, ValueError, ValidationError, wave.Error, EOFError) as error:
            logger.exception("채보 로딩 실패: %s", path.name)
            raise ValueError(f"{path.name}: 채보 또는 음악 파일을 확인하세요.") from error
    if not charts:
        raise ValueError("사용 가능한 채보가 없습니다.")
    return charts


def create_app(
    data_dir: Path | None = None, chart_dir: Path | None = None
) -> FastAPI:
    data = data_dir if data_dir is not None else Path(
        os.environ.get("RHYTHM_DATA_DIR", str(ROOT / "data"))
    )
    songs = chart_dir if chart_dir is not None else ROOT / "songs"

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        ensure_demo(data / "audio" / "demo.wav")
        application.state.charts = load_charts(songs, data / "audio")
        application.state.store = Store(data / "records.sqlite3")
        yield

    application = FastAPI(title="리듬게임", lifespan=lifespan)

    @application.exception_handler(RequestValidationError)
    async def validation_error(
        request: Request, error: RequestValidationError
    ) -> JSONResponse:
        logger.warning("잘못된 API 입력: %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=422,
            content={
                "detail": "요청 형식이나 숫자 값을 확인하세요.",
                "fields": [".".join(map(str, entry["loc"])) for entry in error.errors()],
            },
        )

    @application.exception_handler(sqlite3.Error)
    async def database_error(request: Request, error: sqlite3.Error) -> JSONResponse:
        logger.error("기록 저장소 오류: %s", request.url.path, exc_info=error)
        return JSONResponse(
            status_code=503,
            content={"detail": "기록 저장소에 접근하지 못했습니다. 잠시 후 재시도하세요."},
        )

    def find_chart(song_id: str) -> Chart:
        chart = application.state.charts.get(song_id)
        if chart is None:
            raise HTTPException(status_code=404, detail="존재하지 않는 곡입니다.")
        return chart

    @application.get("/")
    def index() -> FileResponse:
        return FileResponse(ROOT / "static" / "index.html")

    @application.get("/api/songs")
    def song_list() -> list[dict[str, object]]:
        return [
            {
                **chart.model_dump(exclude={"notes"}),
                "note_count": len(chart.notes),
            }
            for chart in application.state.charts.values()
        ]

    @application.get("/api/songs/{song_id}/chart")
    def get_chart(song_id: str) -> Chart:
        return find_chart(song_id)

    @application.get("/api/songs/{song_id}/records")
    def records(song_id: str) -> dict[str, object]:
        find_chart(song_id)
        store: Store = application.state.store
        return store.records(song_id)

    @application.post("/api/results", status_code=201)
    def save_result(result: ResultInput) -> dict[str, object]:
        chart = find_chart(result.song_id)
        try:
            result.validate_for(chart)
        except ValueError as error:
            logger.warning("플레이 결과 검증 실패: %s", error)
            raise HTTPException(status_code=422, detail=str(error)) from error
        store: Store = application.state.store
        try:
            return store.save(result)
        except ResultConflict as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    application.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
    application.mount(
        "/audio", StaticFiles(directory=data / "audio", check_dir=False), name="audio"
    )
    return application


app = create_app()
