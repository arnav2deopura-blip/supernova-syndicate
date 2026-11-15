// Blink, play/pause, speed. Owner: C.

export class Player {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.count = 0;
    this.index = 0;
    this.fps = 3;
    this.playing = true;
    this.timer = null;
  }

  /** Start over with `count` frames, at `index` (default 0). count 0 just stops. */
  load(count, index = 0) {
    this.count = count;
    this.index = Math.min(Math.max(0, index ?? 0), Math.max(0, count - 1));
    if (count) this.onFrame(this.index);
    this._restart();
  }

  setSpeed(fps) {
    this.fps = fps;
    this._restart();
  }

  toggle() {
    this.playing = !this.playing;
    this._restart();
    return this.playing;
  }

  step(delta) {
    if (!this.count) return;
    this.index = (this.index + delta + this.count) % this.count;
    this.onFrame(this.index);
  }

  _restart() {
    clearInterval(this.timer);
    if (this.playing && this.count > 1) this.timer = setInterval(() => this.step(1), 1000 / this.fps);
  }
}
