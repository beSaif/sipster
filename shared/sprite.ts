// Gerald, a 24×16 px side-view hamster. Poses are pixel overrides on one base body.

export const SPRITE_W = 24;
export const SPRITE_H = 16;

export type Pose = 'idle' | 'thirsty' | 'parched' | 'sip' | 'full' | 'bloated' | 'sleep';
export type Frame = 'a' | 'b';

type Pixel = [row: number, col: number, ch: string];
type Fill = [row: number, fromCol: number, toCol: number, ch: string];

interface PoseDef {
  pal?: Record<string, string>;
  set?: Pixel[];
  fill?: Fill[];
}

// Run-length rows: space-separated "<char><count>" tokens; a bare char means one pixel.
function decode(rle: string): string {
  return rle
    .split(' ')
    .map((t) => t[0].repeat(t.length > 1 ? parseInt(t.slice(1), 10) : 1))
    .join('')
    .padEnd(SPRITE_W, '.')
    .slice(0, SPRITE_W);
}

const BODY = [
  '.14 K2 .8',
  '.13 K P2 K .7',
  '.8 K6 P2 K4 .4',
  '.6 K2 O6 K2 O4 K2 .2',
  '.5 K O16 K .',
  '.4 K O12 E W O4 K',
  '.3 K O13 E2 O4 K',
  '.3 K O18 P K',
  '.2 K O13 C2 O2 L2 K .',
  '.2 K O12 L7 K .',
  '.2 K O7 L12 K .',
  '.2 K O5 L14 K .',
  '.3 K O3 L14 K .2',
  '.4 K17 .3',
].map(decode);

const LEGS: Record<Frame, string[]> = {
  a: ['.5 K P2 K .5 K P2 K .6', '.5 K4 .5 K4 .6'].map(decode),
  b: ['.6 K P2 K .5 K P2 K .5', '.6 K4 .5 K4 .5'].map(decode),
};

export const PALETTE: Record<string, string> = {
  K: '#3a2418', // outline
  O: '#ec9a4f', // fur
  L: '#fde8cc', // belly
  P: '#f4a3b4', // ears, nose, feet
  E: '#1c1a24', // eye
  W: '#ffffff', // eye shine
  C: '#f2826e', // blush
  B: '#2a86d6', // water
  b: '#a6daf7', // light water
  R: '#e5484d', // heart
  D: '#b8946a', // dust
};

const HAPPY_EYES: Pixel[] = [[5, 17, 'O'], [5, 18, 'K'], [6, 17, 'K'], [6, 18, 'O'], [6, 19, 'K']];
const TONGUE: Pixel[] = [[9, 22, 'P'], [9, 23, 'P'], [10, 23, 'P']];

const POSES: Record<Pose, PoseDef> = {
  idle: {},
  thirsty: {
    set: [[5, 17, 'K'], [5, 18, 'K'], [0, 21, 'B'], [1, 20, 'B'], [1, 21, 'b'], [1, 22, 'B'], [2, 21, 'B'], ...TONGUE],
  },
  parched: {
    pal: { O: '#d6b48f', L: '#f0e3cf', C: '#c79f78' },
    set: [[5, 17, 'O'], [5, 18, 'O'], [6, 17, 'K'], [6, 18, 'K'], [0, 19, 'D'], [1, 22, 'D'], [2, 20, 'D'], ...TONGUE],
  },
  sip: { set: [...HAPPY_EYES, [8, 23, 'B'], [9, 23, 'b'], [10, 23, 'B']] },
  full: {
    set: [
      ...HAPPY_EYES,
      [0, 20, 'R'], [0, 22, 'R'],
      [1, 19, 'R'], [1, 20, 'R'], [1, 21, 'R'], [1, 22, 'R'], [1, 23, 'R'],
      [2, 20, 'R'], [2, 21, 'R'], [2, 22, 'R'],
    ],
  },
  bloated: {
    pal: { O: '#8ec5e8', L: '#d7eefb', K: '#1d4e7a', C: '#6fa8d6' },
    fill: [[11, 8, 21, 'b'], [12, 7, 20, 'B']],
    set: [
      [4, 16, 'E'], [4, 18, 'E'], [5, 17, 'E'], [5, 18, 'O'], [6, 16, 'E'], [6, 17, 'O'], [6, 18, 'E'],
      [0, 20, 'B'], [1, 19, 'b'], [1, 22, 'b'], [2, 21, 'B'],
    ],
  },
  sleep: { set: [[5, 17, 'O'], [5, 18, 'O'], [6, 17, 'K'], [6, 18, 'K']] },
};

/** Colors for every pixel, row by row; `null` is transparent. */
export function spritePixels(pose: Pose, frame: Frame = 'a'): (string | null)[][] {
  const def = POSES[pose] ?? POSES.idle;
  const pal = { ...PALETTE, ...def.pal };
  const grid = [...BODY, ...LEGS[frame]].map((r) => r.split(''));
  for (const [r, from, to, ch] of def.fill ?? []) for (let c = from; c <= to; c++) grid[r][c] = ch;
  for (const [r, c, ch] of def.set ?? []) grid[r][c] = ch;
  return grid.map((row) => row.map((ch) => (ch === '.' ? null : (pal[ch] ?? null))));
}
