import assert from "node:assert/strict";
import test from "node:test";
import { GameEngine } from "../static/engine.mjs";
import { drawStage, hitEffects, HIT_DURATION_MS, notePosition, stageGeometry } from "../static/renderer.mjs";

function game() {
  return new GameEngine({
    id: "test", title: "시각 효과 테스트", bpm: 120, duration_ms: 5000,
    audio_path: "/audio/test.wav",
    notes: [
      { lane: 0, time_ms: 1000 }, { lane: 2, time_ms: 1000 },
      { lane: 1, time_ms: 2000 }, { lane: 3, time_ms: 3000 },
    ],
  }, 75);
}

function recordingContext() {
  const calls = [];
  const context = { calls };
  for (const method of [
    "save", "restore", "clearRect", "fillRect", "beginPath", "roundRect",
    "moveTo", "lineTo", "closePath", "fill", "stroke", "ellipse", "fillText",
  ]) context[method] = (...args) => calls.push([method, ...args]);
  context.createLinearGradient = (...args) => {
    calls.push(["gradient", ...args]);
    return { addColorStop: (position, color) => calls.push(["stop", position, color]) };
  };
  return context;
}

test("화면 크기와 노트 속도가 달라도 오프셋 보정 시각에 판정선 도착", () => {
  const engine = game();
  engine.start();
  engine.advance(1075);
  for (const height of [380, 610]) {
    for (const speed of [250, 420, 850]) {
      assert.equal(notePosition(engine.notes[0], engine, speed, height), height - 68);
    }
  }
  const geometry = stageGeometry(300, 380);
  assert.equal(geometry.inset + 4 * geometry.laneWidth, 300 - geometry.inset);
  engine.advance(1125);
  assert.equal(notePosition(engine.notes[0], engine, 420, 380), 312 + 21);
  assert.equal(engine.press(0, 1125), "perfect");
});

test("동시 히트는 각각의 레인에 독립적인 파동 생성, 빈 입력은 생성하지 않음", () => {
  const engine = game();
  engine.start();
  engine.press(1, 800);
  assert.deepEqual(hitEffects(engine), []);
  engine.press(0, 1075);
  engine.press(2, 1075);
  assert.equal(engine.notes[0].judgedAtMs, 1075);
  assert.equal(engine.notes[1].judgedAtMs, 1075);
  assert.deepEqual(hitEffects(engine).map(({ lane, kind }) => ({ lane, kind })), [
    { lane: 0, kind: "perfect" }, { lane: 2, kind: "perfect" },
  ]);
});

test("히트 효과는 오디오 시간에 따라 사라지고 일시정지에 고정, 재시작에 초기화", () => {
  const engine = game();
  engine.start();
  engine.press(0, 1075);
  engine.press(2, 1075);
  engine.advance(1075 + HIT_DURATION_MS / 2);
  assert.equal(hitEffects(engine)[0].strength, .5);
  engine.pause();
  const paused = hitEffects(engine);
  engine.advance(4500);
  assert.deepEqual(hitEffects(engine), paused);
  engine.resume();
  engine.advance(1075 + HIT_DURATION_MS);
  assert.deepEqual(hitEffects(engine), []);
  engine.start();
  assert.ok(engine.notes.every((note) => note.judgedAtMs === null));
  assert.deepEqual(hitEffects(engine), []);
});

test("Miss는 성공 히트와 구분되며 렌더링은 점수와 게임 상태를 수정하지 않음", () => {
  const engine = game();
  engine.start();
  engine.advance(1176);
  assert.ok(hitEffects(engine).every((effect) => effect.kind === "miss"));
  const before = JSON.stringify(engine);
  const ctx = recordingContext();
  drawStage(ctx, 700, 500, engine, 420);
  assert.equal(JSON.stringify(engine), before);
  assert.ok(ctx.calls.filter(([method]) => method === "gradient").length > 12);
  assert.equal(ctx.calls.filter(([method]) => method === "save").length,
    ctx.calls.filter(([method]) => method === "restore").length);
  drawStage(ctx, 0, 0, engine, 420);
});

test("모션 감소에서 파동과 스파크를 생략하되 노트와 히트 색상은 유지", () => {
  const engine = game();
  engine.start();
  engine.press(0, 1075);
  const animated = recordingContext();
  const reduced = recordingContext();
  drawStage(animated, 700, 500, engine, 420);
  drawStage(reduced, 700, 500, engine, 420, true);
  assert.ok(animated.calls.some(([method]) => method === "ellipse"));
  assert.ok(!reduced.calls.some(([method]) => method === "ellipse"));
  assert.ok(reduced.calls.some(([method]) => method === "roundRect"));
  assert.ok(reduced.calls.some(([method]) => method === "gradient"));
  const snapshot = JSON.stringify(engine);
  drawStage(reduced, 300, 380, engine, 850, true);
  assert.equal(JSON.stringify(engine), snapshot);
});
