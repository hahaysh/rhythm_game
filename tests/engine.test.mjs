import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, GameEngine, judgementFor, validateChart, validateSettings } from "../static/engine.mjs";

function chart(notes = [{ lane: 0, time_ms: 1000 }], duration = 2000) {
  return { id: "test", title: "테스트", bpm: 120, duration_ms: duration, audio_path: "/audio/test.wav", notes };
}

for (const [delta, expected] of [
  [-100.01, null], [-100, "good"], [-99.99, "good"],
  [-50.01, "good"], [-50, "perfect"], [-49.99, "perfect"],
  [0, "perfect"], [49.99, "perfect"], [50, "perfect"],
  [50.01, "good"], [99.99, "good"], [100, "good"], [100.01, null],
]) {
  test(`판정 경계 ${delta}ms -> ${expected}`, () => {
    assert.equal(judgementFor(delta), expected);
    const game = new GameEngine(chart());
    game.start();
    assert.equal(game.press(0, 1000 + delta), expected);
  });
}

test("가장 가까운 노트와 동점일 때 먼저 작성된 노트", () => {
  const notes = [{ lane: 0, time_ms: 1000 }, { lane: 0, time_ms: 1100 }];
  const game = new GameEngine(chart(notes));
  game.start();
  assert.equal(game.press(0, 1075), "perfect");
  assert.equal(game.notes[0].judgement, null);
  assert.equal(game.notes[1].judgement, "perfect");
  game.start();
  assert.equal(game.press(0, 1050), "perfect");
  assert.equal(game.notes[0].judgement, "perfect");
  assert.equal(game.notes[1].judgement, null);
});

test("중복 판정, 자동 반복, 누른 키 상태와 동시 입력", () => {
  const game = new GameEngine(chart([
    { lane: 0, time_ms: 1000 }, { lane: 1, time_ms: 1000 }, { lane: 0, time_ms: 1100 },
  ]));
  game.start();
  assert.equal(game.press(0, 1000, true), null);
  assert.equal(game.press(0, 1000), "perfect");
  assert.equal(game.press(1, 1000), "perfect");
  assert.equal(game.press(0, 1100, true), null);
  assert.equal(game.press(0, 1100), null);
  game.release(0);
  assert.equal(game.press(0, 1100), "perfect");
  game.release(0);
  assert.equal(game.press(0, 1100), null);
  assert.equal(game.perfect, 3);
  assert.equal(game.maxCombo, 3);
});

test("빈 입력은 패널티 없음, 100ms를 지난 노트만 Miss", () => {
  const game = new GameEngine(chart());
  game.start();
  game.press(3, 800);
  assert.equal(game.miss, 0);
  game.advance(1100);
  assert.equal(game.miss, 0);
  game.advance(1100.01);
  assert.equal(game.miss, 1);
  game.advance(1500);
  assert.equal(game.miss, 1);
});

test("Miss 콤보 초기화와 점수·정확도", () => {
  const game = new GameEngine(chart([
    { lane: 0, time_ms: 500 }, { lane: 1, time_ms: 1000 }, { lane: 2, time_ms: 1500 },
  ]));
  game.start();
  game.press(0, 500);
  game.press(1, 1075);
  assert.equal(game.combo, 2);
  game.advance(1601);
  assert.equal(game.combo, 0);
  assert.deepEqual(game.summary(), {
    perfect: 1, good: 1, miss: 1, max_combo: 2, score: 1500, accuracy: 50,
  });
  game.advance(2000);
  assert.equal(game.phase, "finished");
  assert.equal(game.pressed.size, 0);
});

test("일시정지 시 판정과 시간 정지, 키 초기화, 재개와 재시작", () => {
  const game = new GameEngine(chart());
  game.start();
  game.press(3, 700);
  game.pause();
  assert.equal(game.pressed.size, 0);
  game.advance(2000);
  assert.equal(game.audioMs, 700);
  assert.equal(game.press(0, 1000), null);
  game.resume();
  assert.equal(game.press(0, 1000), "perfect");
  game.start();
  assert.equal(game.audioMs, -3000);
  assert.equal(game.phase, "running");
  assert.equal(game.perfect, 0);
  assert.equal(game.notes[0].judgement, null);
  game.reset();
  assert.equal(game.phase, "idle");
});

for (const offset of [-250, -75, 0, 75, 250]) {
  test(`오프셋 ${offset}ms: 화면과 입력 모두 같은 시각 이동`, () => {
    const game = new GameEngine(chart(), offset);
    game.start();
    game.advance(1000 + offset);
    assert.equal(game.effectiveMs, 1000);
    assert.equal(game.press(0, 1000 + offset), "perfect");
  });
}

test("양수 오프셋에서도 마지막 노트 판정 범위를 보장", () => {
  const game = new GameEngine(chart([{ lane: 0, time_ms: 1900 }]), 250);
  game.start();
  game.advance(2000);
  assert.equal(game.phase, "running");
  assert.equal(game.press(0, 2150), "perfect");
  game.advance(game.endMs);
  assert.equal(game.phase, "finished");
});

test("설정 범위와 잘못된 입력 검증", () => {
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  for (const changes of [{ volume: NaN }, { volume: -1 }, { speed: 249 }, { offset: 251 }, { offset: 0.5 }]) {
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, ...changes }));
  }
  const game = new GameEngine(chart());
  assert.throws(() => game.press(-1, 0));
  assert.throws(() => game.press(0, Infinity));
  assert.throws(() => judgementFor(NaN));
  assert.throws(() => game.pause());
  assert.throws(() => game.resume());
  game.start();
  game.advance(100);
  assert.throws(() => game.advance(99));
});

test("클라이언트 채보 검증", () => {
  for (const invalid of [
    { notes: [] }, { bpm: 0 }, { bpm: NaN }, { id: "../test" },
    { audio_path: "/audio/../test.wav" }, { duration_ms: 0 },
    { notes: [{ lane: 4, time_ms: 1000 }] },
    { notes: [{ lane: true, time_ms: 1000 }] },
    { notes: [{ lane: 0, time_ms: -1 }] },
    { notes: [{ lane: 0, time_ms: 1000.5 }] },
    { notes: [{ lane: 0, time_ms: 2000 }] },
    { notes: [{ lane: 0, time_ms: 1000 }, { lane: 0, time_ms: 1000 }] },
    { notes: [{ lane: 0, time_ms: 1000 }, { lane: 1, time_ms: 500 }] },
  ]) assert.throws(() => validateChart({ ...chart(), ...invalid }));
});

test("실제 데모 채보 전체 Perfect 완주와 모든 노트 합계", async () => {
  const demo = JSON.parse(await readFile(new URL("../songs/demo.json", import.meta.url), "utf8"));
  const game = new GameEngine(demo);
  game.start();
  for (const note of demo.notes) {
    assert.equal(game.press(note.lane, note.time_ms), "perfect");
    game.release(note.lane);
  }
  game.advance(demo.duration_ms);
  assert.equal(game.phase, "finished");
  assert.equal(game.perfect, demo.notes.length);
  assert.equal(game.summary().accuracy, 100);
  assert.equal(game.summary().score, demo.notes.length * 1000);
});
