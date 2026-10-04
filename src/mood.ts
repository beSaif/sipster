import type { Pose } from '../shared/sprite';

export type MoodKey = 'parched' | 'thirsty' | 'happy' | 'sip' | 'full' | 'bloated' | 'sleep';

export interface Mood {
  key: MoodKey;
  label: string;
  chip: string;
  pose: Pose;
  walk: boolean;
  /** CSS classes placing and animating Gerald in the cage. */
  motion: string;
  wall: string;
  lines: string[];
}

export const MOODS: Record<MoodKey, Mood> = {
  parched: {
    key: 'parched', label: 'Parched', chip: '#F4E1C1', pose: 'parched', walk: false, motion: 'spot-mid', wall: '#F3E6CC',
    lines: ['I can see my own skeleton. Is that normal?', 'Dust. I am made of dust now.', 'A tumbleweed just rolled past. I named it Steve.'],
  },
  thirsty: {
    key: 'thirsty', label: 'Thirsty', chip: '#FFE08A', pose: 'thirsty', walk: false, motion: 'spot-walk slump', wall: '#E6EFE6',
    lines: ['Psst. Water. You. Now. Please.', 'My cheeks used to hold seeds. Now they hold sorrow.', 'Is it hot in here or is it just me? It’s me.'],
  },
  happy: {
    key: 'happy', label: 'Happy', chip: '#C9F0D9', pose: 'idle', walk: true, motion: 'spot-walk stroll', wall: '#DDF1EE',
    lines: ['Hydrated and dangerous.', 'Running laps purely on H₂O.', 'Look at me go. Thanks to you. Mostly me.'],
  },
  sip: {
    key: 'sip', label: 'Glug glug', chip: '#CFE8FF', pose: 'sip', walk: false, motion: 'spot-bottle hop', wall: '#DDF1EE',
    lines: ['*glug glug glug*', 'Don’t watch me drink. It’s private.'],
  },
  full: {
    key: 'full', label: 'Full', chip: '#E3D5FF', pose: 'full', walk: false, motion: 'spot-mid bob', wall: '#DDF1EE',
    lines: ['Goal reached. I am a moist little king.', 'Don’t talk to me, I’m digesting water.'],
  },
  bloated: {
    key: 'bloated', label: 'Water balloon', chip: '#BFE3FF', pose: 'bloated', walk: false, motion: 'spot-mid wobble', wall: '#D6ECFA',
    lines: ['I am 98% water and 2% regret.', 'I slosh when I walk. Please stop.'],
  },
  sleep: {
    key: 'sleep', label: 'Asleep', chip: '#E7EAF3', pose: 'sleep', walk: false, motion: 'spot-mid', wall: '#2B3157',
    lines: ['Zzz… dreaming of a bigger bottle.', 'Zzz… no nudges till morning… zzz'],
  },
};

export interface MoodInput {
  ml: number;
  goalMl: number;
  sipping: boolean;
  asleep: boolean;
  hoursSinceSip: number | null;
}

export function moodFor({ ml, goalMl, sipping, asleep, hoursSinceSip }: MoodInput): Mood {
  const pct = goalMl > 0 ? ml / goalMl : 0;
  if (sipping) return MOODS.sip;
  if (asleep) return MOODS.sleep;
  if (pct >= 1.3) return MOODS.bloated;
  if (pct >= 1) return MOODS.full;
  if (pct < 0.15) return MOODS.parched;
  if (pct < 0.4 || (hoursSinceSip !== null && hoursSinceSip >= 2)) return MOODS.thirsty;
  return MOODS.happy;
}

/** A line that changes as you drink but stays put between renders. */
export function lineFor(mood: Mood, ml: number): string {
  return mood.lines[Math.floor(ml / 150) % mood.lines.length];
}
