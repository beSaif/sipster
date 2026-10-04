import { SPRITE_H, SPRITE_W, spritePixels, type Frame, type Pose } from '../shared/sprite';

/** Gerald on a canvas. Legs alternate every 260 ms while walking. */
export class Hamster {
  readonly canvas: HTMLCanvasElement;
  private pose: Pose;
  private walking = false;
  private frame: Frame = 'a';
  private timer: number | undefined;

  constructor(px: number, pose: Pose = 'idle', label = 'Gerald the hamster') {
    this.pose = pose;
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(SPRITE_W * px * dpr);
    this.canvas.height = Math.round(SPRITE_H * px * dpr);
    this.canvas.style.width = `${SPRITE_W * px}px`;
    this.canvas.style.height = `${SPRITE_H * px}px`;
    this.canvas.className = 'sprite';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', label);
    this.draw();
  }

  set(pose: Pose, walking = false): void {
    if (pose === this.pose && walking === this.walking) return;
    this.pose = pose;
    this.walking = walking;
    clearInterval(this.timer);
    this.timer = undefined;
    this.frame = 'a';
    if (walking && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.timer = window.setInterval(() => {
        this.frame = this.frame === 'a' ? 'b' : 'a';
        this.draw();
      }, 260);
    }
    this.draw();
  }

  private draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const cell = this.canvas.width / SPRITE_W;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    spritePixels(this.pose, this.frame).forEach((row, y) =>
      row.forEach((color, x) => {
        if (!color) return;
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(x * cell), Math.round(y * cell), Math.ceil(cell), Math.ceil(cell));
      }),
    );
  }

  destroy(): void {
    clearInterval(this.timer);
  }
}
