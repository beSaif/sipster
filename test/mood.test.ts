import { describe, expect, it } from 'vitest';
import { lineFor, moodFor, MOODS } from '../src/mood';

const base = { goalMl: 2000, sipping: false, asleep: false, hoursSinceSip: 0.5 };

describe('moodFor', () => {
  it('follows the share of the daily goal', () => {
    expect(moodFor({ ...base, ml: 0 }).key).toBe('parched');
    expect(moodFor({ ...base, ml: 500 }).key).toBe('thirsty');
    expect(moodFor({ ...base, ml: 1250 }).key).toBe('happy');
    expect(moodFor({ ...base, ml: 2000 }).key).toBe('full');
    expect(moodFor({ ...base, ml: 2600 }).key).toBe('bloated');
  });

  it('gets thirsty after two hours without a sip, even on track', () => {
    expect(moodFor({ ...base, ml: 1250, hoursSinceSip: 2.5 }).key).toBe('thirsty');
    expect(moodFor({ ...base, ml: 2000, hoursSinceSip: 5 }).key).toBe('full');
  });

  it('drinking beats sleeping beats everything else', () => {
    expect(moodFor({ ...base, ml: 0, asleep: true }).key).toBe('sleep');
    expect(moodFor({ ...base, ml: 0, asleep: true, sipping: true }).key).toBe('sip');
  });

  it('only Happy Gerald walks', () => {
    expect(Object.values(MOODS).filter((m) => m.walk).map((m) => m.key)).toEqual(['happy']);
  });
});

describe('lineFor', () => {
  it('is stable for the same amount and changes as you drink', () => {
    expect(lineFor(MOODS.happy, 900)).toBe(lineFor(MOODS.happy, 900));
    expect(lineFor(MOODS.happy, 900)).not.toBe(lineFor(MOODS.happy, 1050));
  });
});
