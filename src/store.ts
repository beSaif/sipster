// Everything Sipster knows lives here, in IndexedDB on the phone.
// Shared by the page and the service worker (which logs drinks from notification buttons).

export interface Settings {
  goalMl: number;
  /** Sip, glass, bottle. */
  cups: [number, number, number];
  intervalMin: number;
  startMin: number;
  endMin: number;
  smart: boolean;
  pushEnabled: boolean;
  introDone: boolean;
  /** Local date (YYYY-MM-DD) Gerald moved in. */
  firstDay: string;
  /** Last next-nudge time the server reported. */
  nextNudgeAt: number | null;
}

export interface Sip {
  id?: number;
  at: number;
  ml: number;
}

export const DEFAULT_SETTINGS: Settings = {
  goalMl: 2000,
  cups: [150, 250, 500],
  intervalMin: 60,
  startMin: 8 * 60,
  endMin: 22 * 60,
  smart: true,
  pushEnabled: false,
  introDone: false,
  firstDay: '',
  nextNudgeAt: null,
};

const DB_NAME = 'sipster';
const SETTINGS_KEY = 'settings';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('kv');
      db.createObjectStore('sips', { keyPath: 'id', autoIncrement: true }).createIndex('at', 'at');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function localDate(t: number = Date.now()): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function startOfDay(t: number = Date.now()): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfTomorrow(t: number = Date.now()): number {
  const d = new Date(startOfDay(t));
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

export async function getSettings(): Promise<Settings> {
  const db = await openDb();
  const saved = await done(db.transaction('kv').objectStore('kv').get(SETTINGS_KEY));
  return { ...DEFAULT_SETTINGS, firstDay: localDate(), ...(saved ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const db = await openDb();
  const tx = db.transaction('kv', 'readwrite');
  const kv = tx.objectStore('kv');
  const current = { ...DEFAULT_SETTINGS, firstDay: localDate(), ...((await done(kv.get(SETTINGS_KEY))) ?? {}) };
  const next = { ...current, ...patch };
  kv.put(next, SETTINGS_KEY);
  await committed(tx);
  return next;
}

export async function addSip(ml: number, at: number = Date.now()): Promise<Sip> {
  const db = await openDb();
  const tx = db.transaction('sips', 'readwrite');
  const sip: Sip = { at, ml };
  sip.id = (await done(tx.objectStore('sips').add(sip))) as number;
  await committed(tx);
  return sip;
}

export async function deleteSip(id: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('sips', 'readwrite');
  tx.objectStore('sips').delete(id);
  await committed(tx);
}

export async function sipsSince(t: number): Promise<Sip[]> {
  const db = await openDb();
  return done(db.transaction('sips').objectStore('sips').index('at').getAll(IDBKeyRange.lowerBound(t)));
}

export async function lastSip(): Promise<Sip | null> {
  const db = await openDb();
  const cursor = await done(db.transaction('sips').objectStore('sips').index('at').openCursor(null, 'prev'));
  return (cursor?.value as Sip | undefined) ?? null;
}

export async function deleteSipsSince(t: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('sips', 'readwrite');
  const index = tx.objectStore('sips').index('at');
  const keys = await done(index.getAllKeys(IDBKeyRange.lowerBound(t)));
  for (const key of keys) tx.objectStore('sips').delete(key);
  await committed(tx);
}

export interface Backup {
  app: 'sipster';
  version: 1;
  exportedAt: string;
  settings: Settings;
  sips: Sip[];
}

export async function exportBackup(): Promise<Backup> {
  const db = await openDb();
  const sips = await done(db.transaction('sips').objectStore('sips').getAll());
  return { app: 'sipster', version: 1, exportedAt: new Date().toISOString(), settings: await getSettings(), sips };
}

export async function importBackup(data: unknown): Promise<void> {
  const b = data as Partial<Backup>;
  if (!b || b.app !== 'sipster' || b.version !== 1 || !Array.isArray(b.sips) || typeof b.settings !== 'object') {
    throw new Error('This is not a Sipster backup.');
  }
  const sips = b.sips.filter((s) => Number.isFinite(s?.at) && Number.isFinite(s?.ml) && s.ml > 0 && s.ml <= 5000);
  const db = await openDb();
  const tx = db.transaction(['sips', 'kv'], 'readwrite');
  const store = tx.objectStore('sips');
  store.clear();
  for (const s of sips) store.add({ at: s.at, ml: s.ml });
  const current = await done(tx.objectStore('kv').get(SETTINGS_KEY));
  // Push state belongs to this phone, not the backup.
  const { pushEnabled: _p, nextNudgeAt: _n, ...rest } = b.settings as Settings;
  tx.objectStore('kv').put({ ...DEFAULT_SETTINGS, ...(current ?? {}), ...rest }, SETTINGS_KEY);
  await committed(tx);
}
