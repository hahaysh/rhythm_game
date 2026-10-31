export class AudioClock {
  constructor(context) {
    this.context = context;
    this.gain = context.createGain();
    this.gain.connect(context.destination);
    this.buffer = null;
    this.source = null;
    this.phase = "idle";
    this.anchor = 0;
    this.offsetSeconds = 0;
  }

  async activate() {
    try {
      await this.context.resume();
    } catch (error) {
      throw new Error("오디오를 활성화하지 못했습니다. 브라우저 오디오 권한을 확인하고 다시 눌러주세요.", { cause: error });
    }
    if (this.context.state !== "running") {
      throw new Error("오디오를 활성화하지 못했습니다. 시작 또는 재개 버튼을 다시 눌러주세요.");
    }
  }

  setVolume(volume) {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new Error("볼륨은 0~1 사이의 숫자여야 합니다.");
    }
    this.gain.gain.setValueAtTime(volume, this.context.currentTime);
  }

  get positionMs() {
    const elapsed = this.phase === "running" ? this.context.currentTime - this.anchor : 0;
    return (this.offsetSeconds + elapsed) * 1000;
  }

  stopSource() {
    if (this.source) {
      this.source.onended = null;
      this.source.stop();
      this.source.disconnect();
      this.source = null;
    }
  }

  schedule() {
    if (!this.buffer || this.context.state !== "running") {
      throw new Error("음악을 불러오고 오디오를 활성화해야 합니다.");
    }
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gain);
    source.onended = () => {
      source.disconnect();
      if (this.source === source) this.source = null;
    };
    const delay = Math.max(0, -this.offsetSeconds);
    const offset = Math.max(0, this.offsetSeconds);
    if (offset < this.buffer.duration) {
      source.start(this.anchor + delay, offset);
      this.source = source;
    } else {
      source.disconnect();
    }
  }

  start(countdownSeconds = 3) {
    if (!Number.isFinite(countdownSeconds) || countdownSeconds < 0) {
      throw new Error("카운트다운이 잘못되었습니다.");
    }
    this.stop();
    this.offsetSeconds = -countdownSeconds;
    this.anchor = this.context.currentTime;
    this.schedule();
    this.phase = "running";
  }

  pause() {
    if (this.phase !== "running") throw new Error("음악이 재생 중이 아닙니다.");
    this.offsetSeconds = this.positionMs / 1000;
    this.stopSource();
    this.phase = "paused";
  }

  resume() {
    if (this.phase !== "paused") throw new Error("음악이 일시정지 상태가 아닙니다.");
    this.anchor = this.context.currentTime;
    this.schedule();
    this.phase = "running";
  }

  stop() {
    this.stopSource();
    this.phase = "idle";
    this.offsetSeconds = 0;
    this.anchor = this.context.currentTime;
  }
}
