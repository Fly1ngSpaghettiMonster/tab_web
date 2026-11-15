import { useEffect, useMemo, useRef, useState, type RefObject, type ReactNode } from 'react';

import { LiveMap, type MapPosition } from './components/LiveMap';
import { SpeedGraph } from './components/SpeedGraph';
import { StatusCard } from './components/StatusCard';
import { Timeline } from './components/Timeline';
import { speedScale } from './geo/speedColors';
import { computeStats, formatDuration, km, kmh, type GpsSample } from './geo/stats';
import { buildTrack, indexAt, liveBearing, splitRoute } from './live/track';
import { clock } from './time';
import { useLiveSession, type JoinSpec, type LiveStatus } from './live/useLiveSession';
import { AdminApp } from './admin/AdminApp';
import { checkAdminKey, loadAdminKey, saveAdminKey } from './admin/adminApi';

/**
 * Everything after # in the address: a share link's viewer token (https://tab.aabder.xyz/view#<token>),
 * the admin key, or "admin" / "admin/<sessionId>" inside the dashboard.
 */
function useHash(): [string, (hash: string) => void] {
  const read = () => {
    const raw = window.location.hash.replace(/^#/, '');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };
  const [hash, setHash] = useState(read);
  useEffect(() => {
    const onChange = () => setHash(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  /** Replaces the hash without a navigation or a history entry. */
  const replace = (next: string) => {
    window.history.replaceState(window.history.state, '', `#${next}`);
    setHash(next);
  };
  return [hash, replace];
}

export default function App() {
  const [hash, replaceHash] = useHash();
  if (!hash) {
    return <Message title="No trip selected">Open the link that was shared with you from the TAB app.</Message>;
  }
  if (hash === 'admin' || hash.startsWith('admin/')) {
    const key = loadAdminKey();
    if (!key) return <Message title="Admin key needed">Open the dashboard with the admin key after the # in the address.</Message>;
    return <AdminApp adminKey={key} selectedId={hash.slice('admin/'.length) || null} />;
  }
  return <TokenGate key={hash} token={hash} onAdmin={() => replaceHash('admin')} />;
}

/**
 * A share link and the admin dashboard both put a secret after the #. Ask the backend whether this
 * one is the admin key; if not, it is a viewer token.
 */
function TokenGate({ token, onAdmin }: { token: string; onAdmin: () => void }) {
  const [kind, setKind] = useState<'checking' | 'viewer' | 'error'>('checking');
  const [attempt, setAttempt] = useState(0);
  const onAdminRef = useRef(onAdmin);
  onAdminRef.current = onAdmin;
  useEffect(() => {
    let cancelled = false;
    setKind('checking');
    checkAdminKey(token).then((result) => {
      if (cancelled) return;
      if (result === 'admin') {
        // Keep the key in this tab only and take it out of the address bar and history.
        saveAdminKey(token);
        onAdminRef.current();
      } else if (result === 'not-admin') {
        setKind('viewer');
      } else {
        // Could not tell (offline, rate limited, server error): don't guess, let the user retry.
        setKind('error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);
  if (kind === 'checking') return null;
  if (kind === 'error') {
    return (
      <Message title="Could not open the link">
        The server could not be reached or is busy.{' '}
        <button className="pill pill-go" onClick={() => setAttempt((a) => a + 1)}>
          Try again
        </button>
      </Message>
    );
  }
  return <Viewer join={{ method: 'Join', args: [token] }} />;
}

export function Viewer({ join, controls, notFound }: { join: JoinSpec; controls?: ReactNode; notFound?: string }) {
  const { status, session, samples, closeReason } = useLiveSession(join);
  // Timeline position; null = follow the latest position.
  const [cursorMs, setCursorMs] = useState<number | null>(null);
  // Smoothed like the app's trip review once the trip has ended or while looking back; forward
  // only while playing back live, so the line under the moving car never shifts.
  const smooth = status === 'ended' || cursorMs != null;
  const track = useMemo(() => buildTrack(samples, { smooth }), [samples, smooth]);
  // Route up to the shown position and after it (grey while scrubbing).
  const route = useMemo(
    () => splitRoute(track, cursorMs != null && track.points.length > 0 ? indexAt(track, cursorMs) : null),
    [track, cursorMs],
  );
  // The app's speed colours, anchored at this trip's moving average (stops excluded) and max.
  const speedStops = useMemo(() => {
    const last = samples[samples.length - 1];
    const stats = computeStats(samples, last ? Date.parse(last.timestampUtc) : Date.now());
    const average = stats.movingAvgSpeedMps > 0 ? stats.movingAvgSpeedMps : stats.avgSpeedMps;
    return speedScale(average * 3.6, stats.maxSpeedMps * 3.6);
  }, [samples]);
  // The speed graph is as tall as the status card.
  const cardRef = useRef<HTMLElement>(null);
  const cardHeight = useHeight(cardRef);
  const [showDetails, setShowDetails] = useState(false);
  // Camera locked to the car; panning the map turns it off, Recenter / the timeline turn it back on.
  const [following, setFollowing] = useState(true);

  if (status === 'not-found') {
    return <Message title="Link not available">{notFound ?? 'This trip is no longer shared, or the link (or admin key) is wrong.'}</Message>;
  }

  const n = track.points.length;
  const last = samples[samples.length - 1];
  const startMs = n > 0 ? track.times[0] : 0;
  const endMs = n > 0 ? Math.max(track.times[n - 1], Date.parse(last.timestampUtc)) : 0;
  const scrubbing = cursorMs != null && n > 0;
  const index = scrubbing ? indexAt(track, cursorMs) : n - 1;

  // Live, the track is played back slightly in the past so the car moves continuously (as in the
  // app), as long as the newest sample is part of it; a coarse Wi-Fi/cell fix in a GPS gap is shown as it is.
  const playable = !scrubbing && n > 0 && last != null && Date.parse(last.timestampUtc) - track.times[n - 1] <= MAX_PLAYBACK_LAG_MS;

  let position: MapPosition | null = null;
  if (scrubbing) {
    const p = track.points[index];
    position = { latitude: p.latitude, longitude: p.longitude, accuracyMeters: p.sample.accuracyMeters, bearing: track.bearings[index], speedMps: p.speedMps };
  } else if (last) {
    // Live: like the app's arrow, the filtered position when the latest fix is accurate (held still
    // while standing still), otherwise the latest coarse Wi-Fi/cell fix as it is.
    const latest = n > 0 && track.points[n - 1].sample === last ? track.points[n - 1] : null;
    position = {
      latitude: latest?.latitude ?? last.latitude,
      longitude: latest?.longitude ?? last.longitude,
      accuracyMeters: last.accuracyMeters,
      bearing: liveBearing(samples),
      // Same value as the Speed tile: the latest raw GPS speed, nothing once the trip has ended.
      speedMps: status === 'ended' ? null : last.speedMps,
    };
  }


  // Details card above the car while looking back: toggled by clicking the car.
  const popup = scrubbing && showDetails ? (
    <PointDetails
      timeMs={track.times[index]}
      speedMps={track.points[index].speedMps}
      distanceMeters={track.cumulativeMeters[index]}
      elapsedSeconds={(track.times[index] - startMs) / 1000}
      sample={track.points[index].sample}
    />
  ) : null;

  const ended = status === 'ended';
  const goLive = () => {
    setCursorMs(null);
    setFollowing(true);
  };
  /** Moves the cursor one track point back or forward; forward past the last point goes live. */
  const step = (direction: -1 | 1) => {
    if (n === 0) return;
    let next = index + direction;
    // Points can share a timestamp; skip until the cursor really lands on another point.
    while (next >= 0 && next < n && indexAt(track, track.times[next]) === index) next += direction;
    if (next >= n) return goLive();
    setCursorMs(track.times[Math.max(0, next)]);
    setFollowing(true);
  };
  return (
    <div className="app">
      <LiveMap
        routeDone={route.done}
        routeRest={route.rest}
        coarseLines={track.coarseLines}
        position={position}
        playback={playable ? track : null}
        animate={!scrubbing}
        following={following}
        onUserPan={() => setFollowing(false)}
        onCarClick={() => setShowDetails((v) => !v)}
        popup={popup}
      />
      <div className="hud">
        <StatusCard cardRef={cardRef} status={status} samples={samples} startedAtUtc={session?.startedAtUtc ?? null} />
        <div className="top-center">
          {controls}
          {scrubbing ? (
            <button className="pill pill-go" onClick={goLive}>
              {ended ? 'Go to end' : 'Go live'}
            </button>
          ) : (
            <span className={`pill pill-${status}`}>{PILL_TEXT[status]}</span>
          )}
          {!following && position && (
            <button className="pill pill-recenter" onClick={() => setFollowing(true)}>
              ◎ Recenter
            </button>
          )}
        </div>
      </div>
      {ended && (
        <div className="banner">
          {closeReason === 'revoked' ? 'The owner stopped sharing this trip.' : 'This trip has ended.'}
        </div>
      )}
      {n > 1 && (
        <SpeedGraph
          height={cardHeight}
          track={track}
          stops={speedStops}
          startMs={startMs}
          endMs={endMs}
          cursorMs={scrubbing ? cursorMs : null}
          onScrub={(t) => {
            setCursorMs(t);
            setFollowing(true);
          }}
          onGoLive={goLive}
        />
      )}
      {n > 1 && (
        <Timeline
          startMs={startMs}
          endMs={endMs}
          cursorMs={scrubbing ? cursorMs : null}
          onScrub={(t) => {
            setCursorMs(t);
            setFollowing(true);
          }}
          onGoLive={goLive}
          onStep={step}
          canStepBack={index > 0}
          canStepForward={scrubbing}
        />
      )}
    </div>
  );
}

// Same as the app: a newer sample this much later than the last track point is a GPS gap in progress.
const MAX_PLAYBACK_LAG_MS = 3000;

const PILL_TEXT: Record<LiveStatus, string> = {
  connecting: 'Connecting…',
  live: '● LIVE',
  reconnecting: 'Reconnecting…',
  ended: 'ENDED',
  'not-found': '',
};

function PointDetails(props: {
  timeMs: number;
  speedMps: number;
  distanceMeters: number;
  elapsedSeconds: number;
  sample: GpsSample;
}) {
  const s = props.sample;
  return (
    <div className="details">
      <div className="details-time">{clock(props.timeMs)}</div>
      <dl>
        <dt>Speed</dt>
        <dd>{kmh(props.speedMps)} km/h</dd>
        <dt>Distance</dt>
        <dd>{km(props.distanceMeters)} km</dd>
        <dt>Elapsed</dt>
        <dd>{formatDuration(props.elapsedSeconds)}</dd>
        <dt>Accuracy</dt>
        <dd>±{s.accuracyMeters?.toFixed(0) ?? '?'} m</dd>
        <dt>Satellites</dt>
        <dd>
          {s.satellitesUsed ?? '?'}/{s.satellitesInView ?? '?'}
        </dd>
        {s.altitudeMeters != null && (
          <>
            <dt>Altitude</dt>
            <dd>{s.altitudeMeters.toFixed(0)} m</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function useHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return height;
}

export function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="message">
      <div className="brand big">TAB</div>
      <h1>{title}</h1>
      <p className="muted">{children}</p>
    </div>
  );
}
