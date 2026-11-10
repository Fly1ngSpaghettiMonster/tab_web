// COPY of tab_mobile/src/geo/playback.ts - keep in sync, so the viewer derives exactly the same
// route and statistics from the raw samples as the phone does.

/**
 * Live playback of the track: the car is shown slightly in the past, so that the next fix is
 * already known and the arrow can move continuously along the drawn curve between fixes instead
 * of jumping (or gliding and stopping) every time a fix arrives.
 *
 * The arrow and the end of the route line both come from the same pose, so the line never runs
 * ahead of the arrow.
 */
import { isGap } from './gaps';
import { smoothLine } from './spline';
import type { TrackPoint } from './track';

export type LonLat = [number, number];

// How far behind the newest fix the playback clock runs. Fixes arrive about once a second; the
// extra half second absorbs fixes that arrive late (otherwise the car stops and waits for them).
// The speed smoothing in poseAt adds another 0.75 s: the car is shown about 2.25 s behind.
export const PLAYBACK_DELAY_MS = 1500;
// Further off than this (first fix, a backlog after a reconnect, the end of a GPS gap) the
// playback clock jumps instead of catching up gradually.
const MAX_CATCH_UP_MS = 5000;
// The clock runs up to this much faster or slower to stay at PLAYBACK_DELAY_MS behind.
const MAX_RATE_CHANGE = 0.1;
// Seconds of clock error that change the rate by 100% (smaller = more eager catch-up).
const CATCH_UP_SECONDS = 4;
// Weight of each new fix in the averaged wall-clock offset (about the last 5 fixes count).
const OFFSET_SMOOTHING = 0.2;
// Same rule as the app's bearing: only trust the GPS course when moving fast enough.
const MIN_SPEED_FOR_BEARING_MPS = 1;

const M_PER_DEG_LAT = 111_320;

/** A continuous piece of the route (between GPS gaps), drawn as a smooth curve. */
export type RoutePart = {
  /** Index of the part's first point in the track points. */
  first: number;
  /** Index of the part's last point in the track points. */
  last: number;
  coords: LonLat[];
  /** For each of the part's points, the index of its position in `coords`. */
  index: number[];
};

export type Route = {
  points: TrackPoint[];
  /** Point timestamps in ms. */
  times: number[];
  /** Direction of travel at each point, kept while standing still or too slow. */
  bearings: number[];
  parts: RoutePart[];
  /** For each point, the index of its part. */
  partOf: number[];
};

export function buildRoute(points: TrackPoint[]): Route {
  const times: number[] = [];
  const bearings: number[] = [];
  let bearing = 0;
  for (const p of points) {
    const s = p.sample;
    if (s.heading != null && (s.speedMps ?? 0) >= MIN_SPEED_FOR_BEARING_MPS) bearing = s.heading;
    times.push(Date.parse(s.timestampUtc));
    bearings.push(bearing);
  }
  const parts: RoutePart[] = [];
  const partOf: number[] = [];
  let first = 0;
  for (let i = 1; i <= points.length; i++) {
    if (i < points.length && !isGap(points[i - 1], points[i])) continue;
    if (points.length > 0) {
      const line = smoothLine(points.slice(first, i).map((p) => [p.longitude, p.latitude]));
      for (let k = first; k < i; k++) partOf.push(parts.length);
      parts.push({ first, last: i - 1, coords: line.coords, index: line.index });
    }
    first = i;
  }
  return { points, times, bearings, parts, partOf };
}

/** Index of the last point at or before the given time (0 if before the first point, -1 if none). */
export function indexAt(times: number[], timeMs: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= timeMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export type Pose = {
  longitude: number;
  latitude: number;
  /**
   * Direction of travel taken from the drawn route just ahead of the pose, or null when the
   * route does not go anywhere from here (standing still, waiting for the next fix).
   */
  course: number | null;
  /** The GPS bearing of the last fix (used before there is any course). */
  gpsBearing: number;
  /** The last track point at or before the pose. */
  index: number;
  /** The curve from that point's position to the pose (at least the pose itself). */
  head: LonLat[];
};

/** Signed difference b − a in degrees, the short way round (−180..180). */
export function angleDiff(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

// The course is the direction to the point this far ahead on the route (seconds of travel, with
// a minimum in metres), so it follows the road rather than single noisy fixes.
const COURSE_LOOKAHEAD_S = 2;
const MIN_COURSE_LOOKAHEAD_M = 5;
// Less than this far ahead (standing still, or at the newest fix) there is no course.
const MIN_COURSE_METERS = 3;

const mPerDegLonAt = (latitude: number) => M_PER_DEG_LAT * Math.cos((latitude * Math.PI) / 180);
const segmentLength = (mPerDegLon: number, a: LonLat, b: LonLat) =>
  Math.hypot((b[0] - a[0]) * mPerDegLon, (b[1] - a[1]) * M_PER_DEG_LAT);

/** Cumulative length along a part's curve at each of its coordinates (cached per part). */
const partLengths = new WeakMap<RoutePart, number[]>();
function lengthsOf(part: RoutePart): number[] {
  let out = partLengths.get(part);
  if (!out) {
    out = [0];
    const mPerDegLon = mPerDegLonAt(part.coords[0]?.[1] ?? 0);
    for (let k = 1; k < part.coords.length; k++) out.push(out[k - 1] + segmentLength(mPerDegLon, part.coords[k - 1], part.coords[k]));
    partLengths.set(part, out);
  }
  return out;
}

/** The point at distance d along a part's curve, and the index of the coordinate at or before it. */
function pointAt(part: RoutePart, lengths: number[], d: number): { at: LonLat; k: number } {
  const last = part.coords.length - 1;
  if (d <= 0 || last === 0) return { at: part.coords[0], k: 0 };
  if (d >= lengths[last]) return { at: part.coords[last], k: last };
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid] <= d) lo = mid;
    else hi = mid;
  }
  const a = part.coords[lo];
  const b = part.coords[lo + 1];
  const span = lengths[lo + 1] - lengths[lo];
  const t = span > 0 ? (d - lengths[lo]) / span : 0;
  return { at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], k: lo };
}

function bearingBetween(a: LonLat, b: LonLat): number {
  const deg = (Math.atan2((b[0] - a[0]) * mPerDegLonAt(a[1]), (b[1] - a[1]) * M_PER_DEG_LAT) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * Distance travelled along the curve between two fixes at fraction u of the time between them:
 * a monotone cubic (Hermite) whose slopes are the speeds at the two fixes. The speed therefore
 * changes smoothly across fixes instead of jumping to each gap's own average.
 */
function hermiteDistance(length: number, v0: number, v1: number, spanS: number, u: number): number {
  if (length <= 0) return 0;
  // Slopes in metres per unit of u, limited (Fritsch–Carlson) so the car never backs up.
  let m0 = Math.max(0, v0) * spanS;
  let m1 = Math.max(0, v1) * spanS;
  const r = (m0 / length) ** 2 + (m1 / length) ** 2;
  if (r > 9) {
    const k = 3 / Math.sqrt(r);
    m0 *= k;
    m1 *= k;
  }
  const u2 = u * u;
  const u3 = u2 * u;
  const d = (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * length + (u3 - u2) * m1;
  return Math.min(length, Math.max(0, d));
}

// The distance along the route is averaged over the last 2 × SMOOTHING_HALF_WINDOW_MS of track
// time (triangular weights, SMOOTHING_STEPS samples per half). Every fix carries a little
// along-track noise, so passing exactly through each fix on time would make the speed change at
// every fix; averaging over 1.5 fix intervals keeps it even, while the car stays exactly on the
// drawn line. Only the past is used, so newly arriving fixes never change it; the cost is
// SMOOTHING_HALF_WINDOW_MS of extra delay.
const SMOOTHING_HALF_WINDOW_MS = 750;
const SMOOTHING_STEPS = 4;

/**
 * Distance along a part's curve at a time (clamped to the part's time range): between two fixes
 * a Hermite curve, so the speed changes smoothly from one fix's speed to the next.
 */
function distanceAt(route: Route, partIndex: number, timeMs: number): number {
  const { points, times } = route;
  const part = route.parts[partIndex];
  const lengths = lengthsOf(part);
  const t = Math.min(times[part.last], Math.max(times[part.first], timeMs));
  const i = Math.min(part.last, Math.max(part.first, indexAt(times, t)));
  const from = part.index[i - part.first];
  if (i === part.last) return lengths[from];
  const to = part.index[i + 1 - part.first];
  const spanS = (times[i + 1] - times[i]) / 1000;
  const u = spanS > 0 ? Math.min(1, Math.max(0, (t - times[i]) / 1000 / spanS)) : 1;
  const length = lengths[to] - lengths[from];
  // Speeds at the fixes: the filter's, or the gap's average when it reports none while moving.
  const average = spanS > 0 ? length / spanS : 0;
  const speed = (p: TrackPoint) => (p.speedMps > 0 || p.stationary ? p.speedMps : average);
  return lengths[from] + hermiteDistance(length, speed(points[i]), speed(points[i + 1]), spanS, u);
}

/**
 * Where the car was at the given time: on the drawn curve, at an evenly changing speed (see
 * SMOOTHING_HALF_WINDOW_MS). Across a GPS gap it stays at the last fix before the gap.
 */
export function poseAt(route: Route, timeMs: number): Pose | null {
  const { points, times, bearings, parts, partOf } = route;
  const i0 = indexAt(times, timeMs);
  if (i0 < 0) return null;
  const partIndex = partOf[i0];
  const part = parts[partIndex];
  const lengths = lengthsOf(part);

  let sum = 0;
  let weights = 0;
  for (let k = -SMOOTHING_STEPS; k <= SMOOTHING_STEPS; k++) {
    const w = SMOOTHING_STEPS + 1 - Math.abs(k);
    sum += w * distanceAt(route, partIndex, timeMs + ((k - SMOOTHING_STEPS) * SMOOTHING_HALF_WINDOW_MS) / SMOOTHING_STEPS);
    weights += w;
  }
  const d = sum / weights;

  // The last fix the car has passed (on the line, which may differ slightly from the time).
  let lo = part.first;
  let hi = part.last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lengths[part.index[mid - part.first]] <= d) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const from = part.index[i - part.first];

  const { at, k } = pointAt(part, lengths, d);
  const head: LonLat[] = part.coords.slice(from, Math.max(from, k) + 1);
  const end = head[head.length - 1];
  if (end[0] !== at[0] || end[1] !== at[1]) head.push(at);

  // Course: towards the point a little further along the (already known) route.
  const lookahead = Math.max(MIN_COURSE_LOOKAHEAD_M, points[i].speedMps * COURSE_LOOKAHEAD_S);
  const ahead = pointAt(part, lengths, d + lookahead).at;
  const course = segmentLength(mPerDegLonAt(at[1]), at, ahead) >= MIN_COURSE_METERS ? bearingBetween(at, ahead) : null;
  return { longitude: at[0], latitude: at[1], course, gpsBearing: bearings[i], index: i, head };
}

// The shown bearing follows the course with this time constant ...
const BEARING_TIME_CONSTANT_MS = 700;
// ... but only starts turning when the course differs by more than a dead band, which grows when
// zoomed out: small wiggles mean nothing there, while turning the map is very visible ...
const DEAD_BAND_NEAR_DEG = 2;
const DEAD_BAND_FAR_DEG = 10;
const DEAD_BAND_NEAR_ZOOM = 16;
const DEAD_BAND_FAR_ZOOM = 12;
// ... and once turning, keeps turning until it is this close to the course.
const SETTLED_DEG = 0.5;

/** The bearing dead band in degrees at a zoom level. */
export function bearingDeadBand(zoom: number): number {
  const t = Math.min(1, Math.max(0, (DEAD_BAND_NEAR_ZOOM - zoom) / (DEAD_BAND_NEAR_ZOOM - DEAD_BAND_FAR_ZOOM)));
  return DEAD_BAND_NEAR_DEG + (DEAD_BAND_FAR_DEG - DEAD_BAND_NEAR_DEG) * t;
}

/**
 * The bearing shown on the map (the heading-up rotation, or the arrow's direction): turns
 * smoothly towards the course and ignores small wiggles.
 */
export class BearingSmoother {
  private shown: number | null = null;
  private turning = false;

  /** Call every frame. A null course keeps the current bearing; `fallback` is used until there is one. */
  update(course: number | null, fallback: number, zoom: number, dtMs: number): number {
    if (this.shown == null) {
      this.shown = course ?? fallback;
      return this.shown;
    }
    if (course == null) return this.shown;
    const diff = angleDiff(this.shown, course);
    if (Math.abs(diff) > bearingDeadBand(zoom)) this.turning = true;
    if (this.turning) {
      if (Math.abs(diff) < SETTLED_DEG) this.turning = false;
      const k = 1 - Math.exp(-Math.max(0, dtMs) / BEARING_TIME_CONSTANT_MS);
      this.shown = (this.shown + diff * k + 360) % 360;
    }
    return this.shown;
  }

  reset(): void {
    this.shown = null;
    this.turning = false;
  }
}

/**
 * The route already passed at the given point: every part before it, and its own part up to and
 * including the point. The rest of the line up to the car is the pose's `head`.
 */
export function routeUpTo(route: Route, index: number): LonLat[][] {
  const lines: LonLat[][] = [];
  if (index < 0) return lines;
  const current = route.partOf[index];
  for (let k = 0; k < current; k++) lines.push(route.parts[k].coords);
  const part = route.parts[current];
  lines.push(part.coords.slice(0, part.index[index - part.first] + 1));
  return lines.filter((l) => l.length >= 2);
}

/**
 * The playback clock: track time shown on screen, kept PLAYBACK_DELAY_MS behind the newest fix.
 * It runs smoothly with the wall clock, slightly faster or slower to absorb uneven fix arrival,
 * and never passes the newest fix (it waits there, e.g. during a GPS gap).
 */
export class PlaybackClock {
  private shownMs: number | null = null;
  private lastWallMs = 0;
  private latestMs: number | null = null;
  /** Estimated track time minus wall time, averaged over recent fixes. */
  private offsetMs: number | null = null;

  /** Call every animation frame with the newest track point's time; returns the time to show. */
  tick(wallMs: number, latestMs: number): number {
    if (latestMs !== this.latestMs) {
      this.latestMs = latestMs;
      // Each fix's arrival says how far track time is ahead of the wall clock. Single fixes
      // arrive early or late, so the estimate is averaged; a big change (first fix, a backlog
      // after a reconnect, the end of a GPS gap) replaces it.
      const sample = latestMs - wallMs;
      this.offsetMs =
        this.offsetMs == null || Math.abs(sample - this.offsetMs) > MAX_CATCH_UP_MS
          ? sample
          : this.offsetMs + (sample - this.offsetMs) * OFFSET_SMOOTHING;
    }
    const target = wallMs + (this.offsetMs ?? 0) - PLAYBACK_DELAY_MS;
    if (this.shownMs == null || Math.abs(target - this.shownMs) > MAX_CATCH_UP_MS) {
      this.shownMs = target;
    } else {
      const error = target - this.shownMs;
      const rate = 1 + Math.max(-MAX_RATE_CHANGE, Math.min(MAX_RATE_CHANGE, error / (CATCH_UP_SECONDS * 1000)));
      this.shownMs += Math.max(0, wallMs - this.lastWallMs) * rate;
    }
    this.lastWallMs = wallMs;
    this.shownMs = Math.min(this.shownMs, latestMs);
    return this.shownMs;
  }

  reset(): void {
    this.shownMs = null;
    this.latestMs = null;
    this.offsetMs = null;
  }
}
