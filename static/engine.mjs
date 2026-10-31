export const KEYS = ["KeyD", "KeyF", "KeyJ", "KeyK"];
export const DEFAULT_SETTINGS = Object.freeze({ volume: 0.6, speed: 420, offset: 0 });

function finite(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name}: 유한한 숫자가 필요합니다.`);
  }
}

export function validateSettings(settings) {
  if (!settings || typeof settings !== "object") throw new Error("설정 형식이 잘못되었습니다.");
  for (const [key, min, max] of [["volume", 0, 1], ["speed", 250, 850], ["offset", -250, 250]]) {
    finite(settings[key], key);
    if (settings[key] < min || settings[key] > max) throw new Error(`${key}: 설정 범위를 벗어났습니다.`);
  }
  if (!Number.isInteger(settings.speed) || !Number.isInteger(settings.offset)) {
    throw new Error("노트 속도와 오프셋은 정수여야 합니다.");
  }
  return { volume: settings.volume, speed: settings.speed, offset: settings.offset };
}

export function validateChart(chart) {
  if (!chart || typeof chart !== "object" || !/^[a-z0-9_-]{1,64}$/.test(chart.id)) {
    throw new Error("채보의 곡 ID가 잘못되었습니다.");
  }
  if (typeof chart.title !== "string" || !chart.title.trim() || chart.title.length > 100) {
    throw new Error("채보의 제목이 잘못되었습니다.");
  }
  finite(chart.bpm, "BPM");
  finite(chart.duration_ms, "음악 길이");
  if (chart.bpm <= 0 || chart.bpm > 400 || !Number.isInteger(chart.duration_ms) || chart.duration_ms <= 0) {
    throw new Error("채보의 BPM 또는 음악 길이가 잘못되었습니다.");
  }
  if (typeof chart.audio_path !== "string" || !/^\/audio\/[a-zA-Z0-9_-]+\.wav$/.test(chart.audio_path)) {
    throw new Error("채보의 오디오 경로가 잘못되었습니다.");
  }
  if (!Array.isArray(chart.notes) || !chart.notes.length || chart.notes.length > 20000) {
    throw new Error("채보에는 1~20,000개의 노트가 필요합니다.");
  }
  let previous = -1;
  const seen = new Set();
  const notes = chart.notes.map((note) => {
    if (!note || !Number.isInteger(note.lane) || note.lane < 0 || note.lane > 3 ||
        !Number.isInteger(note.time_ms) || note.time_ms < 0 ||
        note.time_ms < previous || note.time_ms + 100 > chart.duration_ms) {
      throw new Error("노트의 레인, 시각 또는 정렬 순서가 잘못되었습니다.");
    }
    const key = `${note.lane}:${note.time_ms}`;
    if (seen.has(key)) throw new Error("같은 레인과 시각의 노트가 중복되었습니다.");
    seen.add(key);
    previous = note.time_ms;
    return { lane: note.lane, time_ms: note.time_ms };
  });
  return { ...chart, notes };
}

export function judgementFor(deltaMs) {
  finite(deltaMs, "판정 오차");
  const distance = Math.abs(deltaMs);
  if (distance <= 50) return "perfect";
  if (distance <= 100) return "good";
  return null;
}

export class GameEngine {
  constructor(chart, offsetMs = 0) {
    this.chart = validateChart(chart);
    finite(offsetMs, "타이밍 오프셋");
    if (!Number.isInteger(offsetMs) || Math.abs(offsetMs) > 250) {
      throw new Error("타이밍 오프셋은 -250~250ms 정수여야 합니다.");
    }
    this.offsetMs = offsetMs;
    this.reset();
  }

  reset() {
    this.notes = this.chart.notes.map((note) => ({ ...note, judgement: null, judgedAtMs: null }));
    this.phase = "idle";
    this.pressed = new Set();
    this.perfect = 0;
    this.good = 0;
    this.miss = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.audioMs = 0;
    this.lastJudgement = null;
  }

  start(audioMs = -3000) {
    finite(audioMs, "음악 시각");
    this.reset();
    this.phase = "running";
    this.audioMs = audioMs;
  }

  get effectiveMs() {
    // Positive offsets move both the visible target and accepted input later.
    return this.audioMs - this.offsetMs;
  }

  get endMs() {
    return Math.max(this.chart.duration_ms, this.notes.at(-1).time_ms + this.offsetMs + 101);
  }

  judge(note, judgement) {
    if (note.judgement !== null) throw new Error("이미 판정한 노트입니다.");
    note.judgement = judgement;
    note.judgedAtMs = this.audioMs;
    this[judgement] += 1;
    this.combo = judgement === "miss" ? 0 : this.combo + 1;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.lastJudgement = { kind: judgement, audioMs: this.audioMs };
  }

  advance(audioMs) {
    finite(audioMs, "음악 시각");
    if (this.phase !== "running") return;
    if (audioMs < this.audioMs) throw new Error("게임 시각이 이전으로 이동했습니다.");
    this.audioMs = audioMs;
    for (const note of this.notes) {
      if (note.time_ms >= this.effectiveMs - 100) break;
      if (note.judgement === null) this.judge(note, "miss");
    }
    if (audioMs >= this.endMs) {
      this.phase = "finished";
      this.pressed.clear();
    }
  }

  press(lane, audioMs, repeat = false) {
    if (!Number.isInteger(lane) || lane < 0 || lane > 3) throw new Error("잘못된 입력 레인입니다.");
    finite(audioMs, "입력 시각");
    if (this.phase !== "running" || repeat || this.pressed.has(lane)) return null;
    this.advance(audioMs);
    if (this.phase !== "running") return null;
    this.pressed.add(lane);
    let closest = null;
    let distance = Infinity;
    for (const note of this.notes) {
      const candidateDistance = Math.abs(this.effectiveMs - note.time_ms);
      if (note.lane === lane && note.judgement === null && candidateDistance <= 100 &&
          candidateDistance < distance) {
        closest = note;
        distance = candidateDistance;
      }
    }
    if (closest === null) return null;
    const judgement = judgementFor(this.effectiveMs - closest.time_ms);
    this.judge(closest, judgement);
    return judgement;
  }

  release(lane) {
    this.pressed.delete(lane);
  }

  pause() {
    if (this.phase !== "running") throw new Error("진행 중인 게임만 일시정지할 수 있습니다.");
    this.phase = "paused";
    this.pressed.clear();
  }

  resume() {
    if (this.phase !== "paused") throw new Error("일시정지한 게임만 재개할 수 있습니다.");
    this.phase = "running";
  }

  summary() {
    const total = this.notes.length;
    return {
      perfect: this.perfect,
      good: this.good,
      miss: this.miss,
      max_combo: this.maxCombo,
      score: this.perfect * 1000 + this.good * 500,
      accuracy: Math.round((this.perfect + this.good * 0.5) / total * 10000) / 100,
    };
  }
}
