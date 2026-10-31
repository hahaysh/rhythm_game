import math
import re
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Note(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    lane: int = Field(ge=0, le=3)
    time_ms: int = Field(ge=0)


class Chart(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    id: str = Field(pattern=r"^[a-z0-9_-]+$", max_length=64)
    title: str = Field(min_length=1, max_length=100)
    bpm: float = Field(gt=0, le=400)
    duration_ms: int = Field(gt=0)
    audio_path: str = Field(pattern=r"^/audio/[a-zA-Z0-9_-]+\.wav$")
    notes: list[Note] = Field(min_length=1, max_length=20000)

    @model_validator(mode="after")
    def validate_notes(self) -> "Chart":
        if not self.title.strip():
            raise ValueError("곡 제목이 비어 있습니다.")
        if re.fullmatch(r"/audio/[a-zA-Z0-9_-]+\.wav", self.audio_path) is None:
            raise ValueError("오디오 경로가 올바르지 않습니다.")
        previous = -1
        seen: set[tuple[int, int]] = set()
        for note in self.notes:
            if note.time_ms < previous:
                raise ValueError("노트는 시간순으로 정렬해야 합니다.")
            key = (note.time_ms, note.lane)
            if key in seen:
                raise ValueError("같은 레인과 시각의 노트가 중복되었습니다.")
            if note.time_ms + 100 > self.duration_ms:
                raise ValueError("노트 판정 범위가 음악 길이를 벗어납니다.")
            seen.add(key)
            previous = note.time_ms
        return self


class ResultInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    attempt_id: UUID = Field(strict=False)
    song_id: str = Field(pattern=r"^[a-z0-9_-]+$", max_length=64)
    perfect: int = Field(ge=0, le=20000)
    good: int = Field(ge=0, le=20000)
    miss: int = Field(ge=0, le=20000)
    max_combo: int = Field(ge=0, le=20000)

    def validate_for(self, chart: Chart) -> None:
        hits = self.perfect + self.good
        if hits + self.miss != len(chart.notes):
            raise ValueError("판정 합계가 전체 노트 수와 일치하지 않습니다.")
        minimum_combo = math.ceil(hits / (self.miss + 1))
        if not minimum_combo <= self.max_combo <= hits:
            raise ValueError("최대 콤보가 판정 결과와 일치하지 않습니다.")

    @property
    def score(self) -> int:
        return self.perfect * 1000 + self.good * 500

    @property
    def accuracy(self) -> float:
        total = self.perfect + self.good + self.miss
        if total == 0:
            raise ValueError("판정 결과가 비어 있습니다.")
        return round((self.perfect + self.good * 0.5) / total * 100, 2)
