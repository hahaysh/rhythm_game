import assert from "node:assert/strict";
import test from "node:test";
import { AudioClock } from "../static/audio.mjs";
import { GameEngine } from "../static/engine.mjs";

function audioContext() {
  return {
    currentTime: 10,
    state: "running",
    destination: {},
    sources: [],
    createGain() {
      return { connect() {}, gain: { setValueAtTime(value) { this.value = value; } } };
    },
    createBufferSource() {
      const source = {
        connect() {},
        disconnect() { this.disconnected = true; },
        start(when, offset) { this.when = when; this.offset = offset; },
        stop() { this.stopped = true; },
      };
      this.sources.push(source);
      return source;
    },
    async resume() { this.state = "running"; },
  };
}

test("AudioContext 기준 카운트다운과 음악 시작 예약", () => {
  const context = audioContext();
  const clock = new AudioClock(context);
  clock.buffer = { duration: 50 };
  clock.start(3);
  assert.equal(clock.positionMs, -3000);
  assert.equal(context.sources[0].when, 13);
  assert.equal(context.sources[0].offset, 0);
  context.currentTime = 13.5;
  assert.equal(clock.positionMs, 500);
  context.currentTime = 20;
  assert.equal(clock.positionMs, 7000);
});

test("일시정지·재개 시 기존 오디오 위치 유지", async () => {
  const context = audioContext();
  const clock = new AudioClock(context);
  clock.buffer = { duration: 50 };
  clock.start();
  context.currentTime = 14;
  clock.pause();
  assert.equal(clock.positionMs, 1000);
  assert.equal(context.sources[0].stopped, true);
  context.currentTime = 30;
  assert.equal(clock.positionMs, 1000);
  await clock.activate();
  clock.resume();
  assert.equal(context.sources[1].when, 30);
  assert.equal(context.sources[1].offset, 1);
  context.currentTime = 31;
  assert.equal(clock.positionMs, 2000);
});

test("카운트다운 도중 일시정지·재개", () => {
  const context = audioContext();
  const clock = new AudioClock(context);
  clock.buffer = { duration: 50 };
  clock.start();
  context.currentTime = 11;
  clock.pause();
  context.currentTime = 30;
  clock.resume();
  assert.equal(context.sources[1].when, 32);
  assert.equal(context.sources[1].offset, 0);
  assert.equal(clock.positionMs, -2000);
});

test("재시작은 이전 소스와 진행 위치를 초기화", () => {
  const context = audioContext();
  const clock = new AudioClock(context);
  clock.buffer = { duration: 50 };
  clock.start();
  context.currentTime = 25;
  clock.start();
  assert.equal(context.sources[0].stopped, true);
  assert.equal(context.sources[1].when, 28);
  assert.equal(clock.positionMs, -3000);
  clock.stop();
  assert.equal(context.sources[1].stopped, true);
  assert.equal(clock.positionMs, 0);
});

test("음악이 끝난 뒤 오프셋 판정 꼬리 시간에는 소스를 재생하지 않음", () => {
  const context = audioContext();
  const clock = new AudioClock(context);
  clock.buffer = { duration: 50 };
  clock.start(0);
  context.currentTime = 60.1;
  clock.pause();
  clock.resume();
  assert.equal(context.sources.at(-1).when, undefined);
  assert.equal(clock.phase, "running");
});

test("오디오 활성화 및 잘못된 값 오류", async () => {
  const context = audioContext();
  const clock = new AudioClock(context);
  assert.throws(() => clock.start());
  assert.throws(() => clock.setVolume(NaN));
  assert.throws(() => clock.setVolume(2));
  assert.throws(() => clock.start(-1));
  assert.throws(() => clock.pause());
  assert.throws(() => clock.resume());
  clock.setVolume(0.6);
  assert.equal(clock.gain.gain.value, 0.6);
  context.resume = async () => { context.state = "suspended"; };
  await assert.rejects(clock.activate(), /오디오/);
  context.resume = async () => { throw new Error("Audio permission denied"); };
  await assert.rejects(clock.activate(), /오디오를 활성화하지 못했습니다/);
});

test("프레임 누락과 일시정지에도 오디오·렌더링·입력이 같은 시계 사용", () => {
  const context = audioContext();
  const clock = new AudioClock(context);
  clock.buffer = { duration: 50 };
  const game = new GameEngine({
    id: "test", title: "테스트", bpm: 120, duration_ms: 50000,
    audio_path: "/audio/test.wav", notes: [{ lane: 0, time_ms: 7000 }],
  }, 100);
  clock.start();
  game.start();
  context.currentTime = 16;
  game.advance(clock.positionMs);
  clock.pause();
  game.pause();
  context.currentTime = 40;
  assert.equal(clock.positionMs, 3000);
  clock.resume();
  game.resume();
  context.currentTime = 44.1;
  game.advance(clock.positionMs);
  assert.ok(Math.abs(game.effectiveMs - 7000) < 1e-8);
  assert.equal(game.press(0, clock.positionMs), "perfect");
});
