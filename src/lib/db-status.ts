import type Dexie from 'dexie';

/*
 * Whether the local database could be opened, as a small store for useSyncExternalStore (read
 * it with `useDatabaseStatus()`; `<DatabaseGate/>` in the root layout shows anything but
 * 'opening'/'ready' full screen).
 *
 * Why this exists: a schema upgrade (db.version(n+1)) can only run once every other open
 * connection to the database has closed. Dexie closes its connection when another tab asks
 * (the `versionchange` event), but a tab that is suspended can't run that handler — iOS
 * freezes background tabs (Chrome for iOS keeps every tab around) and home-screen apps — so
 * the upgrade waits forever and every query in the new version waits with it: the gallery
 * showed "Loading..." and Settings "Checking sync…" indefinitely. Now:
 *
 * - 'blocked': the upgrade waits for other tabs; the gate asks to close them, and the app
 *   carries on by itself as soon as they release the database.
 * - 'slow': opening takes unusually long without the browser saying why; same advice.
 * - 'outdated': this tab runs an older version than another tab that just upgraded the
 *   database; it has let go of the database and must reload.
 * - 'error': opening failed; the gate shows the error with Reload instead of a spinner.
 *
 * And so that this tab never blocks a later upgrade itself, it closes its connection while
 * hidden (a hidden tab may be frozen at any moment) and Dexie reopens it on the next query.
 */

export type DatabaseStatus =
  | { state: 'opening' | 'ready' | 'blocked' | 'slow' | 'outdated' }
  | { state: 'error'; message: string };

/** Opening longer than this without a `blocked` event is shown as 'slow'. */
export const SLOW_OPEN_MS = 8_000;

let status: DatabaseStatus = { state: 'opening' };
const subscribers = new Set<() => void>();

function setStatus(next: DatabaseStatus) {
  if (next.state === status.state && (next.state !== 'error' || (status.state === 'error' && next.message === status.message))) return;
  status = next;
  for (const notify of subscribers) notify();
}

export function getDatabaseStatus(): DatabaseStatus {
  return status;
}

export function subscribeDatabaseStatus(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** Wire the status to a Dexie instance's events. Called once, where the database is declared. */
export function trackDatabase(db: Dexie): void {
  db.on('blocked', (ev: IDBVersionChangeEvent) => {
    // Our own upgrade waits for other connections (a deletion — newVersion null — isn't ours)
    if (ev.newVersion && ev.newVersion > ev.oldVersion) setStatus({ state: 'blocked' });
  });
  db.on('versionchange', (ev: IDBVersionChangeEvent) => {
    // Another tab runs a newer version and upgrades. Dexie's default handler closes this
    // connection so the upgrade can go ahead; this tab's code is then out of date.
    if (ev.newVersion && ev.newVersion > ev.oldVersion) setStatus({ state: 'outdated' });
  });
}

let openPromise: Promise<void> | null = null;

/**
 * Open the database and follow how that goes. Safe to call repeatedly; while an open is in
 * flight the same promise is returned. Never rejects: failures become the 'error' status.
 */
export function openDatabase(db: Dexie, slowAfterMs = SLOW_OPEN_MS): Promise<void> {
  if (status.state === 'outdated') return Promise.resolve();
  if (db.isOpen()) {
    if (status.state !== 'error') setStatus({ state: 'ready' });
    return Promise.resolve();
  }
  if (openPromise) return openPromise;
  const slow = setTimeout(() => {
    if (status.state === 'opening') setStatus({ state: 'slow' });
  }, slowAfterMs);
  openPromise = db
    .open()
    .then(
      () => {
        if (getDatabaseStatus().state !== 'outdated') setStatus({ state: 'ready' });
      },
      (err: unknown) => {
        console.error('Opening the local database failed', err);
        setStatus({ state: 'error', message: describe(err) });
      }
    )
    .finally(() => {
      clearTimeout(slow);
      openPromise = null;
    });
  return openPromise;
}

/**
 * Close the connection while the page is hidden or put in the back/forward cache, and open it
 * again when it's shown. Dexie reopens on demand anyway (close keeps auto-open on), and
 * transactions already running finish normally. Returns a cleanup function.
 */
export function releaseWhileHidden(db: Dexie, doc: Document = document, win: Window = window): () => void {
  const release = () => {
    if (db.isOpen()) db.close({ disableAutoOpen: false });
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') release();
    else void openDatabase(db);
  };
  const onPageShow = () => {
    if (doc.visibilityState !== 'hidden') void openDatabase(db);
  };
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', release);
  win.addEventListener('pageshow', onPageShow);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', release);
    win.removeEventListener('pageshow', onPageShow);
  };
}

/** Tests: start over. */
export function resetDatabaseStatus(): void {
  status = { state: 'opening' };
  openPromise = null;
}
