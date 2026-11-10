import { isGap, liveCoarseLines } from '../geo/gaps';
import { smoothLine } from '../geo/spline';
import { processTrack, type GpsSample, type TrackPoint } from '../geo/stats';

// Same rule as the app: only trust the GPS course when moving fast enough.
const MIN_SPEED_FOR_BEARING_MPS = 1;

type Line = [number, number][];

/** A continuous piece of the route (between GPS gaps), drawn as a smooth curve. */
type RoutePart = {
  /** Index of the part's first point in Track.points. */
  first: number;
  /** Index of the part's last point in Track.points. */
  last: number;
  coords: Line;
  /** For each of the part's points, the index of its position in `coords`. */
  index: number[];
};

export type Track = {
  /** Filtered, smoothed points (the phone's processTrack). */
  points: TrackPoint[];
  /** Point timestamps in ms. */
  times: number[];
  /** Distance travelled up to and including each point, in metres. */
  cumulativeMeters: number[];
  /** Direction of travel at each point, kept while standing still. */
  bearings: number[];
  /** The route split at GPS gaps, each part smoothed (as drawn in the app). */
  parts: RoutePart[];
  /** Dotted lines through coarse Wi-Fi/cell fixes: gaps, and the start or end without GPS. */
  coarseLines: Line[];
};

export function buildTrack(samples: GpsSample[]): Track {
  const points = processTrack(samples);
  const times: number[] = [];
  const cumulativeMeters: number[] = [];
  const bearings: number[] = [];
  let distance = 0;
  let bearing = 0;
  for (const p of points) {
    distance += p.segmentMeters;
    const s = p.sample;
    if (s.heading != null && (s.speedMps ?? 0) >= MIN_SPEED_FOR_BEARING_MPS) bearing = s.heading;
    times.push(Date.parse(s.timestampUtc));
    cumulativeMeters.push(distance);
    bearings.push(bearing);
  }

  const parts: RoutePart[] = [];
  let first = 0;
  for (let i = 1; i <= points.length; i++) {
    if (i < points.length && !isGap(points[i - 1], points[i])) continue;
    if (points.length > 0) {
      const line = smoothLine(points.slice(first, i).map((p) => [p.longitude, p.latitude]));
      parts.push({ first, last: i - 1, coords: line.coords, index: line.index });
    }
    first = i;
  }

  return { points, times, cumulativeMeters, bearings, parts, coarseLines: liveCoarseLines(points, samples) };
}

/**
 * The route split at a point: `done` up to and including point `index`, `rest` from there on.
 * With index null (live), everything is done.
 */
export function splitRoute(track: Track, index: number | null): { done: Line[]; rest: Line[] } {
  const done: Line[] = [];
  const rest: Line[] = [];
  for (const part of track.parts) {
    if (index == null || part.last <= index) done.push(part.coords);
    else if (part.first > index) rest.push(part.coords);
    else {
      const at = part.index[index - part.first];
      done.push(part.coords.slice(0, at + 1));
      rest.push(part.coords.slice(at));
    }
  }
  return { done: done.filter((l) => l.length >= 2), rest: rest.filter((l) => l.length >= 2) };
}

/** Index of the last point at or before the given time (0 if the time is before the first point). */
export function indexAt(track: Track, timeMs: number): number {
  let lo = 0;
  let hi = track.times.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (track.times[mid] <= timeMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Bearing for the live position: the last trustworthy course among all raw samples. */
export function liveBearing(samples: GpsSample[]): number {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s.heading != null && (s.speedMps ?? 0) >= MIN_SPEED_FOR_BEARING_MPS) return s.heading;
  }
  return 0;
}
