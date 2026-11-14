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

  load(count) {
    this.count = count;
    this.index = 0;
    this.onFrame(0);
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
