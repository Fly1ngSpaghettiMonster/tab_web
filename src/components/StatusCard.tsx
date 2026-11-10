import { useEffect, useMemo, useState, type Ref } from 'react';

import { computeStats, formatDuration, km, kmh, type GpsSample } from '../geo/stats';
import { clock } from '../time';
import type { LiveStatus } from '../live/useLiveSession';

type Props = { status: LiveStatus; samples: GpsSample[]; startedAtUtc: string | null; cardRef?: Ref<HTMLElement> };

/** Live statistics of the whole trip, computed exactly like the app. Never affected by the timeline. */
export function StatusCard({ status, samples, startedAtUtc, cardRef }: Props) {
  const now = useNow(status !== 'ended');
  const last = samples[samples.length - 1];
  const lastMs = last ? Date.parse(last.timestampUtc) : null;
  const endMs = status === 'ended' && lastMs != null ? lastMs : now;
  // Same as the app's live stats: computed to "now" while recording.
  const stats = useMemo(() => computeStats(samples, endMs), [samples, endMs]);
  const startMs = startedAtUtc ? Date.parse(startedAtUtc) : samples[0] ? Date.parse(samples[0].timestampUtc) : null;
  const elapsed = startMs != null ? Math.max(0, (endMs - startMs) / 1000) : 0;
  const speed = last?.speedMps != null && last.speedMps >= 0 ? last.speedMps : null;
  const fixAge = lastMs != null ? Math.max(0, Math.round((now - lastMs) / 1000)) : null;

  return (
    <section className="card" ref={cardRef}>
      <header className="card-head">
        <span className="brand">TAB</span>
      </header>
      <div className="tiles">
        <Tile label="Speed" value={status === 'ended' ? '–' : kmh(speed)} unit="km/h" />
        <Tile label="Distance" value={km(stats.distanceMeters)} unit="km" />
        <Tile label="Time" value={formatDuration(elapsed)} />
        <Tile label="Avg" value={kmh(stats.avgSpeedMps)} unit="km/h" />
        <Tile label="Moving avg" value={kmh(stats.movingAvgSpeedMps)} unit="km/h" />
        <Tile label="Max" value={kmh(stats.maxSpeedMps)} unit="km/h" />
      </div>
      <p className="muted small">
        {fixAge == null
          ? 'Waiting for the first GPS fix…'
          : status === 'ended'
            ? `Last fix at ${clock(lastMs!)}`
            : `Last fix ${fixAge} s ago · ±${last.accuracyMeters?.toFixed(0) ?? '?'} m`}
      </p>
    </section>
  );
}

function Tile({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">
        {value}
        {unit && <span className="tile-unit"> {unit}</span>}
      </div>
    </div>
  );
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  return now;
}
