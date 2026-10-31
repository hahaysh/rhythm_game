import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from .models import ResultInput


class ResultConflict(ValueError):
    pass


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.execute(
                """CREATE TABLE IF NOT EXISTS results (
                    id INTEGER PRIMARY KEY,
                    attempt_id TEXT NOT NULL UNIQUE,
                    song_id TEXT NOT NULL,
                    score INTEGER NOT NULL,
                    max_combo INTEGER NOT NULL,
                    perfect INTEGER NOT NULL,
                    good INTEGER NOT NULL,
                    miss INTEGER NOT NULL,
                    accuracy REAL NOT NULL,
                    played_at TEXT NOT NULL
                )"""
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS results_song ON results(song_id, score DESC)"
            )

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def save(self, result: ResultInput) -> dict[str, object]:
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO results
                (attempt_id, song_id, score, max_combo, perfect, good, miss, accuracy, played_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(attempt_id) DO NOTHING""",
                (
                    str(result.attempt_id),
                    result.song_id,
                    result.score,
                    result.max_combo,
                    result.perfect,
                    result.good,
                    result.miss,
                    result.accuracy,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            row = connection.execute(
                "SELECT * FROM results WHERE attempt_id = ?", (str(result.attempt_id),)
            ).fetchone()
            if row is None:
                raise sqlite3.DatabaseError("저장한 플레이 기록을 조회하지 못했습니다.")
            record = dict(row)
            for field in ("song_id", "perfect", "good", "miss", "max_combo"):
                if record[field] != getattr(result, field):
                    raise ResultConflict("동일한 플레이 ID에 다른 결과가 이미 저장되어 있습니다.")
            return record

    def records(self, song_id: str) -> dict[str, object]:
        with self.connect() as connection:
            best = connection.execute(
                """SELECT * FROM results WHERE song_id = ?
                ORDER BY score DESC, accuracy DESC, max_combo DESC, id DESC LIMIT 1""",
                (song_id,),
            ).fetchone()
            recent = connection.execute(
                "SELECT * FROM results WHERE song_id = ? ORDER BY id DESC LIMIT 10",
                (song_id,),
            ).fetchall()
        return {
            "best": dict(best) if best is not None else None,
            "recent": [dict(row) for row in recent],
        }
