// COPY of tab_mobile/src/geo/gaps.ts - keep in sync, so the viewer derives exactly the same
// route and statistics from the raw samples as the phone does.

import { haversineMeters, isAccurate, timeMs, type GpsSample, type TrackPoint } from './track';

/**
 * Stretches of a trip without accurate fixes: between two accepted track points (a tunnel), or
 * at the start or end of the trip (recording started or stopped underground). Edge gaps begin or
 * end at an "anchor": the position estimated from the coarse Wi-Fi/cell fixes there.
 */
export type Gap = {
  from: TrackPoint;
  to: TrackPoint;
  /** Raw samples inside the gap (typically coarse Wi-Fi/cell fixes). */
  inner: GpsSample[];
  /** Null for a gap between two accurate fixes; otherwise which end is a coarse anchor. */
  edge: 'start' | 'end' | 'both' | null;
  /** How far from a road each end may lie to be snapped onto it, in metres. */
  snapMeters: [number, number];
};

// A gap must last this long and span this distance before it counts.
const MIN_GAP_SECONDS = 8;
const MIN_GAP_METERS = 120;
// Gap ends at accurate fixes are snapped onto roads within this distance.
const ACCURATE_END_SNAP_METERS = 40;
const MAX_ANCHOR_SNAP_METERS = 300;
// Coarse fixes used to place an edge gap's anchor, and the time window they are taken from.
const ANCHOR_MAX_ACCURACY = 1000;
const ANCHOR_WINDOW_SECONDS = 15;
// Coarse fixes worse than this are left out of the approximate (dotted) line.
const APPROX_MAX_ACCURACY = 300;
// How fast the approximate line may follow the coarse fixes (metro and car speeds).
const APPROX_PROCESS_NOISE_MPS = 20;

const usableCoarse = (s: GpsSample, maxAccuracy: number) =>
  !isAccurate(s) && s.accuracyMeters != null && s.accuracyMeters <= maxAccuracy;

type Anchor = { point: TrackPoint; sigma: number };

/**
 * Position at one end of a run of coarse fixes: the accuracy-weighted mean of the fixes within
 * ANCHOR_WINDOW_SECONDS of that end, keyed by the sample at the very end. Its uncertainty is the
 * best accuracy among them (coarse fixes are not independent, so averaging does not shrink it).
 */
function anchorOf(coarse: GpsSample[], side: 'start' | 'end'): Anchor {
  const endSample = side === 'start' ? coarse[0] : coarse[coarse.length - 1];
  const t0 = timeMs(endSample);
  let wSum = 0;
  let lat = 0;
  let lon = 0;
  let sigma = Infinity;
  for (const s of coarse) {
    if (Math.abs(timeMs(s) - t0) > ANCHOR_WINDOW_SECONDS * 1000) continue;
    const w = 1 / s.accuracyMeters! ** 2;
    wSum += w;
    lat += w * s.latitude;
    lon += w * s.longitude;
    sigma = Math.min(sigma, s.accuracyMeters!);
  }
  return {
    point: {
      sample: endSample,
      latitude: lat / wSum,
      longitude: lon / wSum,
      speedMps: 0,
      segmentMeters: 0,
      stationary: false,
    },
    sigma,
  };
}

const anchorSnap = (sigma: number) => Math.min(Math.max(sigma, ACCURATE_END_SNAP_METERS), MAX_ANCHOR_SNAP_METERS);

function gapBetween(from: TrackPoint, to: TrackPoint): { seconds: number; meters: number } {
  return {
    seconds: (timeMs(to.sample) - timeMs(from.sample)) / 1000,
    meters: haversineMeters(from.latitude, from.longitude, to.latitude, to.longitude),
  };
}

function innerSamples(samples: GpsSample[], from: TrackPoint, to: TrackPoint): GpsSample[] {
  return samples.filter(
    (s) => s.sequence > from.sample.sequence && s.sequence < to.sample.sequence && !isAccurate(s),
  );
}

export function findGaps(points: TrackPoint[], samples: GpsSample[]): Gap[] {
  const gaps: Gap[] = [];
  const firstSeq = points.length ? points[0].sample.sequence : Infinity;
  const lastSeq = points.length ? points[points.length - 1].sample.sequence : -Infinity;
  const leading = samples.filter((s) => s.sequence < firstSeq && usableCoarse(s, ANCHOR_MAX_ACCURACY));
  const trailing = samples.filter((s) => s.sequence > lastSeq && usableCoarse(s, ANCHOR_MAX_ACCURACY));

  // An edge gap only counts if it is clearly longer than the anchor's own uncertainty, so
  // waiting on a platform before the train leaves does not invent a journey.
  const addEdge = (from: Anchor | TrackPoint, to: Anchor | TrackPoint, edge: Gap['edge']) => {
    const a = 'sigma' in from ? from.point : from;
    const b = 'sigma' in to ? to.point : to;
    const sigmaA = 'sigma' in from ? from.sigma : 0;
    const sigmaB = 'sigma' in to ? to.sigma : 0;
    const { seconds, meters } = gapBetween(a, b);
    if (seconds < MIN_GAP_SECONDS || meters < Math.max(MIN_GAP_METERS, 2 * (sigmaA + sigmaB))) return;
    gaps.push({
      from: a,
      to: b,
      inner: innerSamples(samples, a, b),
      edge,
      snapMeters: [
        'sigma' in from ? anchorSnap(sigmaA) : ACCURATE_END_SNAP_METERS,
        'sigma' in to ? anchorSnap(sigmaB) : ACCURATE_END_SNAP_METERS,
      ],
    });
  };

  if (points.length === 0) {
    // No accurate fix at all (e.g. a whole metro ride): from the first coarse position to the last.
    if (leading.length >= 2) addEdge(anchorOf(leading, 'start'), anchorOf(leading, 'end'), 'both');
    return gaps;
  }

  if (leading.length > 0) addEdge(anchorOf(leading, 'start'), points[0], 'start');

  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const { seconds, meters } = gapBetween(from, to);
    if (seconds < MIN_GAP_SECONDS || meters < MIN_GAP_METERS) continue;
    gaps.push({
      from,
      to,
      inner: innerSamples(samples, from, to),
      edge: null,
      snapMeters: [ACCURATE_END_SNAP_METERS, ACCURATE_END_SNAP_METERS],
    });
  }

  if (trailing.length > 0) addEdge(points[points.length - 1], anchorOf(trailing, 'end'), 'end');
  return gaps;
}

export const gapKey = (fromSequence: number, toSequence: number) => `${fromSequence}-${toSequence}`;

/**
 * Approximate line through the coarse fixes recorded between two sequence numbers (exclusive),
 * from `from` to `to`, smoothed by a simple filter so single bad cell fixes do not dominate.
 * Used for the dotted line of gaps that could not be matched to a road or rail line.
 */
export function approximatePath(
  samples: GpsSample[],
  from: TrackPoint | null,
  to: TrackPoint | null,
): [number, number][] {
  const fromSequence = from ? from.sample.sequence : -Infinity;
  const toSequence = to ? to.sample.sequence : Infinity;
  const coarse = samples.filter(
    (s) => s.sequence > fromSequence && s.sequence < toSequence && usableCoarse(s, APPROX_MAX_ACCURACY),
  );
  const out: [number, number][] = [];
  let lon = 0;
  let lat = 0;
  let variance = -1; // m², negative = not initialised
  let lastT = 0;
  if (from) {
    lon = from.longitude;
    lat = from.latitude;
    variance = 0;
    lastT = timeMs(from.sample);
    out.push([lon, lat]);
  }
  for (const s of coarse) {
    const t = timeMs(s);
    const r = s.accuracyMeters! ** 2;
    if (variance < 0) {
      lon = s.longitude;
      lat = s.latitude;
      variance = r;
    } else {
      // The longer since the last fix, the further the line may have moved.
      variance += Math.max((t - lastT) / 1000, 0) * APPROX_PROCESS_NOISE_MPS ** 2;
      const gain = variance / (variance + r);
      lon += gain * (s.longitude - lon);
      lat += gain * (s.latitude - lat);
      variance *= 1 - gain;
    }
    lastT = t;
    out.push([lon, lat]);
  }
  if (to) out.push([to.longitude, to.latitude]);
  return out;
}

/** True when two consecutive track points are far enough apart in time and space to be a gap. */
export function isGap(a: TrackPoint, b: TrackPoint): boolean {
  const { seconds, meters } = gapBetween(a, b);
  return seconds >= MIN_GAP_SECONDS && meters >= MIN_GAP_METERS;
}

/**
 * Live map: dotted lines for everything recorded without accurate fixes so far: the stretch
 * before the first accurate fix, gaps between accurate fixes, and a gap still in progress.
 */
export function liveCoarseLines(points: TrackPoint[], samples: GpsSample[]): [number, number][][] {
  if (samples.length === 0) return [];
  const lines: [number, number][][] = [];
  const add = (line: [number, number][]) => {
    if (line.length >= 2) lines.push(line);
  };
  if (points.length === 0) {
    add(approximatePath(samples, null, null));
    return lines;
  }
  add(approximatePath(samples, null, points[0]));
  for (let i = 1; i < points.length; i++) {
    if (isGap(points[i - 1], points[i])) add(approximatePath(samples, points[i - 1], points[i]));
  }
  add(approximatePath(samples, points[points.length - 1], null));
  return lines;
}
