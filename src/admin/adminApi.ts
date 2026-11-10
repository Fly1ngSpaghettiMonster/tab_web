/** A row of GET /api/admin/sessions. */
export type AdminSession = {
  sessionId: string;
  clientTripId: string | null;
  startedAtUtc: string;
  locationSource: string | null;
  createdAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  closeReason: string | null;
  sampleCount: number;
  firstSampleUtc: string | null;
  lastSampleUtc: string | null;
};

const STORAGE_KEY = 'tab.adminKey';

export class UnauthorizedError extends Error {}

export async function fetchAdminSessions(key: string): Promise<AdminSession[]> {
  const res = await fetch('/api/admin/sessions', { headers: { 'X-Admin-Key': key }, cache: 'no-store' });
  if (res.status === 401) throw new UnauthorizedError('unauthorized');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Whether the backend accepts this as the admin key; "error" when it could not be checked. */
export async function checkAdminKey(key: string): Promise<'admin' | 'not-admin' | 'error'> {
  try {
    await fetchAdminSessions(key);
    return 'admin';
  } catch (e) {
    return e instanceof UnauthorizedError ? 'not-admin' : 'error';
  }
}

// The key lives in sessionStorage: it survives reloads of this tab but not closing it.
// Also kept in memory, for browsers that block storage.
let memoryKey: string | null = null;

export function saveAdminKey(key: string) {
  memoryKey = key;
  try {
    sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* storage blocked: the dashboard will ask for the link again */
  }
}

export function loadAdminKey(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? memoryKey;
  } catch {
    return memoryKey;
  }
}

export function clearAdminKey() {
  memoryKey = null;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
