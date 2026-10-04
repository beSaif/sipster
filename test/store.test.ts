import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  addSip,
  deleteSip,
  deleteSipsSince,
  exportBackup,
  getSettings,
  importBackup,
  lastSip,
  saveSettings,
  sipsSince,
  startOfDay,
  startOfTomorrow,
} from '../src/store';
import { nudgeState } from '../src/sync';

describe('store', () => {
  it('starts with sensible defaults and saves changes', async () => {
    const s = await getSettings();
    expect(s.goalMl).toBe(2000);
    expect(s.cups).toEqual([150, 250, 500]);
    expect((await saveSettings({ goalMl: 2500 })).goalMl).toBe(2500);
    expect((await getSettings()).goalMl).toBe(2500);
    await saveSettings({ goalMl: 2000 });
  });

  it('logs, lists and undoes sips', async () => {
    const today = startOfDay();
    await addSip(400, today - 3_600_000); // yesterday
    const a = await addSip(250, today + 60_000);
    await addSip(500, today + 120_000);
    expect((await sipsSince(today)).map((s) => s.ml)).toEqual([250, 500]);
    expect((await lastSip())?.ml).toBe(500);
    await deleteSip(a.id!);
    expect((await sipsSince(today)).map((s) => s.ml)).toEqual([500]);
  });

  it('tells the server only timestamps, and goes quiet once the goal is reached', async () => {
    const today = startOfDay();
    await deleteSipsSince(today);
    const s = await getSettings();
    await addSip(1000, today + 1000);
    let st = await nudgeState(s);
    expect(st.quietUntil).toBeNull();
    expect(Object.keys(st).sort()).toEqual(['lastSipAt', 'quietUntil']);
    await addSip(1000, today + 2000);
    st = await nudgeState(s);
    expect(st.quietUntil).toBe(startOfTomorrow());
  });

  it('round-trips a backup and rejects foreign files', async () => {
    const backup = await exportBackup();
    await deleteSipsSince(0);
    expect(await sipsSince(0)).toEqual([]);
    await importBackup(JSON.parse(JSON.stringify(backup)));
    expect((await sipsSince(0)).length).toBe(backup.sips.length);
    await expect(importBackup({ hello: 'world' })).rejects.toThrow('not a Sipster backup');
  });
});
