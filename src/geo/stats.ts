// COPY of tab_mobile/src/geo/stats.ts - keep in sync, so the viewer derives exactly the same
// route and statistics from the raw samples as the phone does.

import { findGaps, gapKey } from './gaps';
import { haversineMeters, processTrack, timeMs, type GpsSample } from './track';

export {
  haversineMeters,
  isAccurate,
  MAX_ACCURACY_METERS,
  MAX_PLAUSIBLE_SPEED_MPS,
  processTrack,
  TrackFilter,
  type GpsSample,
  type TrackPoint,
} from './track';

export type JourneyStats = {
  distanceMeters: number;
  durationSeconds: number;
  avgSpeedMps: number;
  movingAvgSpeedMps: number;
  maxSpeedMps: number;
};

// GPS speeds with a worse reported uncertainty are not trusted for the maximum.
const MAX_SPEED_ACCURACY_MPS = 3;
// Below this speed the car is considered stopped (for the moving average).
const MOVING_THRESHOLD_MPS = 1 / 3.6;

/** Bump when computeStats or the track filter changes, so stored trips are recalculated. */
export const STATS_VERSION = 3;

/**
 * Statistics of a track. Gaps that were filled along the road or rail network count with the
 * path length instead of the straight line between the fixes on either side; stretches recorded
 * before the first or after the last accurate fix (e.g. starting underground) count too.
 */
export function computeStats(
  samples: GpsSample[],
  endTimeMs?: number,
  gapFills: { fromSequence: number; toSequence: number; lengthMeters: number }[] = [],
): JourneyStats {
  const points = processTrack(samples);
  const gaps = findGaps(points, samples);
  const fillLength = new Map(gapFills.map((f) => [gapKey(f.fromSequence, f.toSequence), f.lengthMeters]));
  let distance = 0;
  let maxSpeed = 0;
  let movingSeconds = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const filled = i > 0 ? fillLength.get(gapKey(points[i - 1].sample.sequence, p.sample.sequence)) : undefined;
    const segment = filled ?? p.segmentMeters;
    distance += segment;
    const speedTrusted = p.sample.speedAccuracyMps == null || p.sample.speedAccuracyMps <= MAX_SPEED_ACCURACY_MPS;
    if (speedTrusted) maxSpeed = Math.max(maxSpeed, p.speedMps);
    if (i > 0) {
      const seconds = (timeMs(p.sample) - timeMs(points[i - 1].sample)) / 1000;
      // Moving if the fix says so, or if the distance covered since the previous fix says so:
      // after a long gap (tunnel, underground) the speed at its end can be zero.
      if (p.speedMps >= MOVING_THRESHOLD_MPS || segment / seconds >= MOVING_THRESHOLD_MPS) movingSeconds += seconds;
    }
  }
  // Stretches at the start or end without accurate fixes: the filled path, or the straight line
  // between the coarse position and the first (last) accurate fix. findGaps only reports them
  // when they are clearly longer than the coarse position's uncertainty.
  for (const gap of gaps) {
    if (!gap.edge) continue;
    const filled = fillLength.get(gapKey(gap.from.sample.sequence, gap.to.sample.sequence));
    const straight = haversineMeters(gap.from.latitude, gap.from.longitude, gap.to.latitude, gap.to.longitude);
    distance += filled ?? straight;
    movingSeconds += (timeMs(gap.to.sample) - timeMs(gap.from.sample)) / 1000;
  }
  const start = samples.length ? timeMs(samples[0]) : 0;
  const end = endTimeMs ?? (samples.length ? timeMs(samples[samples.length - 1]) : 0);
  const duration = Math.max(0, (end - start) / 1000);
  return {
    distanceMeters: distance,
    durationSeconds: duration,
    // Spec: average speed = accepted distance / total elapsed time, stops included.
    avgSpeedMps: duration > 0 ? distance / duration : 0,
    movingAvgSpeedMps: movingSeconds > 0 ? distance / movingSeconds : 0,
    maxSpeedMps: maxSpeed,
  };
}

export const kmh = (mps: number | null | undefined) => (mps == null ? '–' : (mps * 3.6).toFixed(1));
export const km = (m: number) => (m / 1000).toFixed(2);

export function formatDuration(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
