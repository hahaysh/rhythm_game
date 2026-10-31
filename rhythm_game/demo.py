import math
import random
import sys
import wave
from array import array
from pathlib import Path

RATE = 22050
DURATION_SECONDS = 50


def ensure_demo(path: Path) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    samples = array("d", [0.0]) * (RATE * DURATION_SECONDS)
    randomizer = random.Random(2026)
    melody = (261.63, 329.63, 392.0, 329.63, 293.66, 349.23, 440.0, 392.0)
    for beat in range(1, 99):
        start = int(beat * 0.5 * RATE)
        frequency = melody[(beat - 1) % len(melody)]
        for i in range(int(0.32 * RATE)):
            t = i / RATE
            envelope = min(1.0, t / 0.008) * math.exp(-t * 12)
            samples[start + i] += 0.18 * envelope * (
                math.sin(2 * math.pi * frequency * t)
                + 0.25 * math.sin(4 * math.pi * frequency * t)
            )
        for i in range(int(0.14 * RATE)):
            t = i / RATE
            if beat % 2:
                sound = math.sin(2 * math.pi * (85 * t - 150 * t * t))
                samples[start + i] += 0.35 * math.exp(-t * 30) * sound
            else:
                samples[start + i] += 0.16 * math.exp(-t * 45) * randomizer.uniform(-1, 1)
        for half in (0.0, 0.25):
            hat_start = start + int(half * RATE)
            for i in range(int(0.035 * RATE)):
                samples[hat_start + i] += (
                    0.045 * math.exp(-i / RATE * 110) * randomizer.uniform(-1, 1)
                )
    pcm = array(
        "h",
        (round(max(-1.0, min(1.0, value)) * 32767) for value in samples),
    )
    if sys.byteorder != "little":
        pcm.byteswap()
    temporary = path.with_suffix(".tmp")
    with wave.open(str(temporary), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(pcm.tobytes())
    temporary.replace(path)
