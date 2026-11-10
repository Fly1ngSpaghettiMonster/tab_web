import { useCallback, useEffect, useMemo, useState } from 'react';

import { Message, Viewer } from '../App';
import { formatDuration } from '../geo/stats';
import { clockShort } from '../time';
import { clearAdminKey, fetchAdminSessions, UnauthorizedError, type AdminSession } from './adminApi';

const REFRESH_MS = 30_000;

const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });

const STATUS: Record<string, { label: string; className: string }> = {
  live: { label: 'Live', className: 'chip-live' },
  ended: { label: 'Ended', className: 'chip-ended' },
  revoked: { label: 'Stopped', className: 'chip-ended' },
  expired: { label: 'Expired', className: 'chip-expired' },
};

const statusOf = (s: AdminSession) => (s.closedAt == null ? STATUS.live : (STATUS[s.closeReason ?? 'ended'] ?? STATUS.ended));

/**
 * Admin dashboard: every journey in the database, shared right now or not, with the same live
 * viewer as a share link. Opened with the admin key after the # (see App), then lives at #admin and
 * #admin/<sessionId>, so the browser's back button returns to the list.
 */
export function AdminApp({ adminKey, selectedId }: { adminKey: string; selectedId: string | null }) {
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      setSessions(await fetchAdminSessions(adminKey));
      setError(null);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        clearAdminKey();
        setUnauthorized(true);
      } else {
        setError('Could not load the journeys. Retrying…');
      }
    }
  }, [adminKey]);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!sessions || !q) return sessions ?? [];
    return sessions.filter((s) => s.sessionId.toLowerCase().includes(q) || (s.clientTripId ?? '').toLowerCase().includes(q));
  }, [sessions, filter]);

  if (unauthorized) {
    return <Message title="Admin key not accepted">The key was changed or the admin dashboard is turned off. Open the dashboard link again.</Message>;
  }

  const open = (id: string | null) => {
    window.location.hash = id ? `admin/${id}` : 'admin';
  };

  return (
    <div className={`admin ${selectedId ? 'has-selection' : ''}`}>
      <aside className="admin-list">
        <header className="admin-head">
          <div className="brand">TAB</div>
          <span className="muted small">Admin · {sessions ? `${sessions.length} journeys` : 'loading…'}</span>
        </header>
        <input
          className="admin-search"
          type="search"
          placeholder="Filter by session ID or trip ID"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
        {error && <p className="admin-error small">{error}</p>}
        <ul>
          {shown.map((s) => {
            const status = statusOf(s);
            const start = Date.parse(s.firstSampleUtc ?? s.startedAtUtc);
            const end = s.lastSampleUtc ? Date.parse(s.lastSampleUtc) : null;
            return (
              <li key={s.sessionId}>
                <button className={`admin-item ${s.sessionId === selectedId ? 'selected' : ''}`} onClick={() => open(s.sessionId)}>
                  <div className="admin-item-row">
                    <span className="admin-date">{dateFormat.format(start)}</span>
                    <span className={`chip ${status.className}`}>{status.label}</span>
                  </div>
                  <div className="admin-item-row muted small">
                    <span>
                      {clockShort(start)}
                      {end != null && `–${clockShort(end)}`}
                      {end != null && ` · ${formatDuration((end - start) / 1000)}`}
                    </span>
                    <span>{s.sampleCount} fixes</span>
                  </div>
                  <div className="admin-id" title={s.sessionId}>
                    {s.sessionId}
                  </div>
                </button>
              </li>
            );
          })}
          {sessions && shown.length === 0 && <li className="muted small admin-none">{sessions.length ? 'No journey matches.' : 'No journeys stored yet.'}</li>}
        </ul>
      </aside>
      <main className="admin-main">
        {selectedId ? (
          <Viewer
            key={selectedId}
            join={{ method: 'AdminJoin', args: [adminKey, selectedId] }}
            notFound="This journey is not in the database (it may have passed the retention period)."
            controls={
              <button className="pill pill-back" onClick={() => open(null)}>
                ← Journeys
              </button>
            }
          />
        ) : (
          <div className="admin-empty muted">Select a journey on the left.</div>
        )}
      </main>
    </div>
  );
}
