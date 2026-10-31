import { DEFAULT_SETTINGS, GameEngine, KEYS, validateChart, validateSettings } from "./engine.mjs";
import { AudioClock } from "./audio.mjs";

const $ = (id) => document.getElementById(id);
const canvas = $("game-canvas");
const context = canvas.getContext("2d");
const colors = ["#79b9ff", "#bc9bff", "#72f0d0", "#ffbe7a"];
const labels = ["D", "F", "J", "K"];
let chart = null;
let engine = null;
let clock = null;
let audioBuffer = null;
let busy = false;
let pendingResult = null;
let savingAttempt = null;
let savedAttempt = null;
let attemptId = null;
let canvasWidth = 0;
let canvasHeight = 0;
let settings = { ...DEFAULT_SETTINGS };

function showError(error, prefix = "") {
  console.error(prefix || "리듬게임 오류", error);
  const message = error instanceof Error ? error.message : String(error);
  $("notice").textContent = `${prefix}${message}`;
  $("notice").hidden = false;
}

function clearError() {
  $("notice").hidden = true;
  $("notice").textContent = "";
}

async function action(operation) {
  if (busy) return;
  busy = true;
  clearError();
  updateControls();
  try {
    await operation();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    updateControls();
  }
}

async function api(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new Error("서버에 연결하지 못했습니다. 서버 실행 상태와 연결을 확인하세요.", { cause: error });
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`서버 응답 형식이 잘못되었습니다. (HTTP ${response.status})`, { cause: error });
  }
  if (!response.ok) throw new Error(body.detail || `요청에 실패했습니다. (HTTP ${response.status})`);
  return body;
}

function active() {
  return engine?.phase === "running" || engine?.phase === "paused";
}

function updateControls() {
  $("start").disabled = busy || !chart || active();
  $("pause").disabled = busy || !active();
  $("pause").textContent = engine?.phase === "paused" ? "재개" : "일시정지";
  $("restart").disabled = busy || !chart || engine?.phase === "idle";
  $("back").disabled = busy || !chart || engine?.phase === "idle";
  $("song-select").disabled = busy || active() || !chart;
  $("reload").disabled = busy || active();
  $("speed").disabled = busy || active();
  $("offset").disabled = busy || active();
  $("records-retry").disabled = busy || !chart;
  $("retry-save").disabled = savingAttempt === pendingResult?.attempt_id;
}

function readSettings() {
  try {
    const value = localStorage.getItem("neon-step-settings");
    if (value !== null) settings = validateSettings(JSON.parse(value));
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof Error)) throw error;
    settings = { ...DEFAULT_SETTINGS };
    showError(error, "저장된 설정을 읽지 못해 기본 설정을 사용합니다. ");
  }
  $("volume").value = settings.volume * 100;
  $("speed").value = settings.speed;
  $("offset").value = settings.offset;
  settingsLabels();
}

function settingsLabels() {
  $("volume-value").textContent = `${Math.round(settings.volume * 100)}%`;
  $("speed-value").textContent = `${settings.speed} px/s`;
}

function changeSettings() {
  try {
    settings = validateSettings({
      volume: Number($("volume").value) / 100,
      speed: Number($("speed").value),
      offset: $("offset").value === "" ? NaN : Number($("offset").value),
    });
    clock?.setVolume(settings.volume);
    settingsLabels();
    localStorage.setItem("neon-step-settings", JSON.stringify(settings));
  } catch (error) {
    showError(error, "설정을 적용하거나 저장하지 못했습니다. ");
  }
}

async function refreshRecords() {
  const songId = chart.id;
  const records = await api(`/api/songs/${songId}/records`);
  if (chart.id !== songId) return;
  $("best").textContent = records.best
    ? `${records.best.score.toLocaleString()}점 · ${records.best.accuracy.toFixed(2)}%`
    : "아직 기록이 없습니다.";
  $("recent").replaceChildren(...records.recent.map((record) => {
    const item = document.createElement("li");
    item.textContent = `${record.score.toLocaleString()}점 / 콤보 ${record.max_combo} / ${new Date(record.played_at).toLocaleString("ko-KR")}`;
    return item;
  }));
}

async function selectSong() {
  clock?.stop();
  chart = null;
  engine = null;
  audioBuffer = null;
  pendingResult = null;
  $("result").hidden = true;
  $("best").textContent = "기록을 불러오는 중...";
  $("recent").replaceChildren();
  const selected = $("song-select").value;
  chart = validateChart(await api(`/api/songs/${encodeURIComponent(selected)}/chart`));
  engine = new GameEngine(chart, settings.offset);
  $("song-title").textContent = chart.title;
  $("song-info").textContent = `${chart.bpm} BPM · ${chart.duration_ms / 1000}초 · ${chart.notes.length}개 노트`;
  $("progress").max = chart.duration_ms;
  render();
  await refreshRecords();
}

async function loadSongs() {
  const songs = await api("/api/songs");
  if (!Array.isArray(songs) || !songs.length) throw new Error("플레이할 곡이 없습니다.");
  $("song-select").replaceChildren(...songs.map((song) => {
    const option = document.createElement("option");
    option.value = song.id;
    option.textContent = song.title;
    return option;
  }));
  await selectSong();
}

async function loadAudio() {
  let response;
  try {
    response = await fetch(chart.audio_path);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new Error("음악을 불러오지 못했습니다. 연결을 확인하고 다시 시작하세요.", { cause: error });
  }
  if (!response.ok) throw new Error(`음악을 불러오지 못했습니다. (HTTP ${response.status})`);
  try {
    const decoded = await clock.context.decodeAudioData(await response.arrayBuffer());
    if (Math.abs(decoded.duration * 1000 - chart.duration_ms) > 2) {
      throw new Error("음악 길이가 채보와 일치하지 않습니다.");
    }
    return decoded;
  } catch (error) {
    throw new Error("음악을 해석하지 못했습니다. WAV 파일과 채보를 확인하세요.", { cause: error });
  }
}

async function startGame() {
  if (!chart) throw new Error("먼저 곡을 선택하세요.");
  settings = validateSettings({
    volume: Number($("volume").value) / 100,
    speed: Number($("speed").value),
    offset: $("offset").value === "" ? NaN : Number($("offset").value),
  });
  clock?.stop();
  engine.reset();
  pendingResult = null;
  $("result").hidden = true;
  if (!clock) {
    if (!globalThis.AudioContext) throw new Error("이 브라우저는 Web Audio API를 지원하지 않습니다.");
    clock = new AudioClock(new AudioContext());
    clock.context.addEventListener("statechange", () => {
      if (clock.context.state !== "running" && engine?.phase === "running") {
        pauseGame("오디오가 중단되었습니다. 재개 버튼을 눌러주세요.");
      }
    });
  }
  await clock.activate();
  $("state-label").textContent = "음악 로딩 중";
  if (!audioBuffer) audioBuffer = await loadAudio();
  clock.buffer = audioBuffer;
  clock.setVolume(settings.volume);
  engine = new GameEngine(chart, settings.offset);
  attemptId = crypto.randomUUID();
  clock.start(3);
  engine.start(-3000);
  if (document.hidden || !document.hasFocus()) pauseGame("창으로 돌아와 재개 버튼을 눌러주세요.");
  render();
}

function pauseGame(message = "재개 버튼 또는 Esc로 이어서 플레이하세요.") {
  if (engine?.phase !== "running") return;
  clock.pause();
  engine.advance(clock.positionMs);
  if (engine.phase === "finished") {
    finishGame();
    return;
  }
  engine.pause();
  $("overlay-detail").textContent = message;
  updateControls();
  render();
}

async function togglePause() {
  if (engine?.phase === "paused") {
    await clock.activate();
    clock.resume();
    engine.resume();
    if (document.hidden || !document.hasFocus()) pauseGame("창으로 돌아와 재개 버튼을 눌러주세요.");
  } else if (engine?.phase === "running") {
    pauseGame();
  } else {
    throw new Error("진행 중인 게임이 없습니다.");
  }
}

function backToSelection() {
  clock?.stop();
  engine.reset();
  pendingResult = null;
  $("result").hidden = true;
  render();
}

function finishGame() {
  clock.stop();
  const summary = engine.summary();
  pendingResult = {
    attempt_id: attemptId,
    song_id: chart.id,
    perfect: summary.perfect,
    good: summary.good,
    miss: summary.miss,
    max_combo: summary.max_combo,
  };
  $("result-score").textContent = summary.score.toLocaleString();
  $("result-combo").textContent = summary.max_combo;
  $("result-accuracy").textContent = `${summary.accuracy.toFixed(2)}%`;
  $("result-counts").textContent = `${summary.perfect} / ${summary.good} / ${summary.miss}`;
  $("result").hidden = false;
  updateControls();
  void saveResult();
}

async function saveResult() {
  const result = pendingResult;
  if (!result || savingAttempt === result.attempt_id || savedAttempt === result.attempt_id) return;
  savingAttempt = result.attempt_id;
  $("retry-save").hidden = true;
  $("save-status").textContent = "결과를 저장하는 중...";
  updateControls();
  try {
    await api("/api/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    });
    savedAttempt = result.attempt_id;
    if (pendingResult?.attempt_id === result.attempt_id) {
      $("save-status").textContent = "결과가 저장되었습니다.";
      try {
        await refreshRecords();
      } catch (error) {
        showError(error, "결과는 저장됐지만 기록 목록을 갱신하지 못했습니다. ");
      }
    }
  } catch (error) {
    if (pendingResult?.attempt_id === result.attempt_id) {
      $("save-status").textContent = "결과 저장에 실패했습니다. 결과는 화면에 유지됩니다.";
      $("retry-save").hidden = false;
      showError(error, "결과 저장 실패: ");
    } else {
      showError(error, "이전 플레이 결과 저장 실패: ");
    }
  } finally {
    if (savingAttempt === result.attempt_id) savingAttempt = null;
    updateControls();
  }
}

function timeLabel(ms) {
  const seconds = Math.max(0, ms) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
}

function render() {
  if (!context) throw new Error("이 브라우저에서 Canvas를 사용할 수 없습니다.");
  const width = canvasWidth;
  const height = canvasHeight;
  const laneWidth = width / 4;
  const line = height - 68;
  context.clearRect(0, 0, width, height);
  for (let lane = 0; lane < 4; lane += 1) {
    const left = lane * laneWidth;
    context.fillStyle = engine?.pressed.has(lane) ? `${colors[lane]}30` : "#111a2c";
    context.fillRect(left + 2, 0, laneWidth - 4, height);
    context.fillStyle = colors[lane];
    context.fillRect(left + 8, line, laneWidth - 16, 3);
    context.font = "bold 22px Segoe UI";
    context.textAlign = "center";
    context.fillText(labels[lane], left + laneWidth / 2, height - 24);
  }
  if (!engine) return;
  for (const note of engine.notes) {
    if (note.judgement !== null) continue;
    const y = line - (note.time_ms - engine.effectiveMs) * settings.speed / 1000;
    if (y < -18) break;
    if (y > height) continue;
    context.fillStyle = colors[note.lane];
    context.fillRect(note.lane * laneWidth + 10, y - 8, laneWidth - 20, 16);
    context.fillStyle = "#ffffff66";
    context.fillRect(note.lane * laneWidth + 10, y - 8, laneWidth - 20, 3);
  }
  const summary = engine.summary();
  $("score").textContent = summary.score.toLocaleString();
  $("combo").textContent = engine.combo;
  $("max-combo").textContent = summary.max_combo;
  $("accuracy").textContent = `${summary.accuracy.toFixed(2)}%`;
  for (const kind of ["perfect", "good", "miss"]) $(kind).textContent = summary[kind];
  $("progress").value = Math.max(0, Math.min(chart.duration_ms, engine.audioMs));
  $("clock").dataset.timeMs = engine.audioMs.toFixed(2);
  $("clock").textContent = `${timeLabel(engine.audioMs)} / ${timeLabel(chart.duration_ms).slice(0, -3)}`;
  $("play-area").dataset.phase = engine.phase;
  const recent = engine.lastJudgement && engine.audioMs - engine.lastJudgement.audioMs < 650;
  $("judgement").textContent = recent ? engine.lastJudgement.kind.toUpperCase() : "—";
  $("judgement").className = recent ? engine.lastJudgement.kind : "";
  const countdown = engine.phase === "running" && engine.audioMs < 0;
  $("overlay").hidden = engine.phase === "running" && !countdown;
  if (countdown) {
    $("overlay-title").textContent = Math.ceil(-engine.audioMs / 1000);
    $("overlay-detail").textContent = "D · F · J · K — 준비하세요!";
    $("state-label").textContent = "카운트다운";
  } else if (engine.phase === "paused") {
    $("overlay-title").textContent = "일시정지";
    $("state-label").textContent = "일시정지";
  } else if (engine.phase === "finished") {
    $("overlay-title").textContent = "TRACK COMPLETE";
    $("overlay-detail").textContent = "아래에서 결과를 확인하고 다시 도전하세요.";
    $("state-label").textContent = "완료";
  } else if (engine.phase === "idle") {
    $("overlay-title").textContent = "준비됐나요?";
    $("overlay-detail").textContent = "시작 버튼을 누르고 판정선에 맞춰 입력하세요.";
    $("state-label").textContent = "곡 선택";
  } else {
    $("state-label").textContent = "플레이 중";
  }
}

function frame() {
  try {
    if (engine?.phase === "running") {
      engine.advance(clock.positionMs);
      if (engine.phase === "finished") finishGame();
    }
    render();
  } catch (error) {
    clock?.stop();
    if (engine?.phase === "running") engine.pause();
    showError(error, "게임 진행 오류: ");
    updateControls();
    return;
  }
  requestAnimationFrame(frame);
}

$("start").addEventListener("click", () => void action(startGame));
$("restart").addEventListener("click", () => void action(startGame));
$("pause").addEventListener("click", () => void action(togglePause));
$("back").addEventListener("click", () => void action(backToSelection));
$("reload").addEventListener("click", () => void action(loadSongs));
$("song-select").addEventListener("change", () => void action(selectSong));
$("records-retry").addEventListener("click", () => void action(refreshRecords));
$("retry-save").addEventListener("click", () => { clearError(); void saveResult(); });
for (const id of ["volume", "speed", "offset"]) {
  $(id).addEventListener("input", changeSettings);
}
document.addEventListener("keydown", (event) => {
  if (event.target instanceof Element && event.target.matches("input,select,textarea")) return;
  if (event.code === "Escape" && active()) {
    event.preventDefault();
    if (!event.repeat) void action(togglePause);
    return;
  }
  const lane = KEYS.indexOf(event.code);
  if (lane >= 0 && engine?.phase === "running") {
    event.preventDefault();
    try {
      engine.press(lane, clock.positionMs, event.repeat);
    } catch (error) {
      pauseGame();
      showError(error, "입력 처리 오류: ");
    }
  }
});
document.addEventListener("keyup", (event) => engine?.release(KEYS.indexOf(event.code)));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pauseGame("탭이 숨겨져 자동 정지했습니다. 재개 버튼을 눌러주세요.");
});
window.addEventListener("blur", () => pauseGame("포커스를 잃어 자동 정지했습니다. 재개 버튼을 눌러주세요."));
new ResizeObserver(() => {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvasWidth = rect.width;
  canvasHeight = rect.height;
  canvas.width = Math.round(canvasWidth * ratio);
  canvas.height = Math.round(canvasHeight * ratio);
  context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  render();
}).observe(canvas);
void action(async () => {
  readSettings();
  await loadSongs();
});
requestAnimationFrame(frame);
