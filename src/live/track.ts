import { liveCoarseLines } from '../geo/gaps';
import { buildRoute, indexAt as routeIndexAt, type LonLat, type Route } from '../geo/playback';
import { processTrack, type GpsSample } from '../geo/stats';

// Same rule as the app: only trust the GPS course when moving fast enough.
const MIN_SPEED_FOR_BEARING_MPS = 1;

type Line = LonLat[];

/**
 * The filtered track (the phone's processTrack), its route split at GPS gaps and drawn as smooth
 * curves (as in the app), with the timestamps and bearings used to play it back.
 */
export type Track = Route & {
  /** Distance travelled up to and including each point, in metres. */
  cumulativeMeters: number[];
  /** Dotted lines through coarse Wi-Fi/cell fixes: gaps, and the start or end without GPS. */
  coarseLines: Line[];
};

/**
 * `smooth`: also use the fixes after each point (the trip review's smoothing). Off while playing
 * back live, so points the car has already passed never shift when new fixes arrive.
 */
export function buildTrack(samples: GpsSample[], options: { smooth: boolean }): Track {
  const route = buildRoute(processTrack(samples, { smooth: options.smooth }));
  const cumulativeMeters: number[] = [];
  let distance = 0;
  for (const p of route.points) {
    distance += p.segmentMeters;
    cumulativeMeters.push(distance);
  }
  return { ...route, cumulativeMeters, coarseLines: liveCoarseLines(route.points, samples) };
}

/**
 * The route split at a point: `done` up to and including point `index`, `rest` from there on.
 * With index null, everything is done.
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
export const indexAt = (track: Track, timeMs: number): number => routeIndexAt(track.times, timeMs);

/** Bearing for the live position: the last trustworthy course among all raw samples. */
export function liveBearing(samples: GpsSample[]): number {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s.heading != null && (s.speedMps ?? 0) >= MIN_SPEED_FOR_BEARING_MPS) return s.heading;
  }
  return 0;
}
