// COPY of tab_mobile/src/geo/track.ts - keep in sync, so the viewer derives exactly the same
// route and statistics from the raw samples as the phone does.

export type GpsSample = {
  journeyId: number;
  sequence: number;
  timestampUtc: string;
  latitude: number;
  longitude: number;
  speedMps: number | null;
  accuracyMeters: number | null;
  altitudeMeters: number | null;
  heading: number | null;
  // Where the fix came from and how good it was, as reported by the device.
  provider: string | null;
  satellitesUsed: number | null;
  satellitesInView: number | null;
  speedAccuracyMps: number | null;
  bearingAccuracyDeg: number | null;
};

/** A sample that passed filtering, with its filtered position. */
export type TrackPoint = {
  sample: GpsSample;
  latitude: number;
  longitude: number;
  speedMps: number;
  /** Distance added by this point (0 while standing still). */
  segmentMeters: number;
  /** True while the device is judged to be standing still; the position is then held. */
  stationary: boolean;
};

// Fixes worse than this are kept in the log but ignored for the route and statistics.
export const MAX_ACCURACY_METERS = 25;
// Anything implying a faster movement than this is treated as a glitch: a bad fix that jumps a
// few hundred metres in a second implies thousands of km/h. Set to the top speed of the fastest
// production cars (~470 km/h), so no real car trip is ever filtered out.
export const MAX_PLAUSIBLE_SPEED_MPS = 470 / 3.6;

// --- Kalman filter tuning -------------------------------------------------------------------
// The filter models constant velocity disturbed by random acceleration of this size. A car
// accelerates or brakes at up to ~3 m/s²; corners add sideways acceleration of the same order.
const MOVING_ACCELERATION_MPS2 = 3;
// While standing still the position may only creep, so jitter averages out instead of being drawn.
const STATIONARY_ACCELERATION_MPS2 = 0.3;
// While standing still a fix counts this many times less than when moving.
const STATIONARY_POSITION_NOISE_FACTOR = 5;
// Uncertainty of a "not moving" velocity measurement while standing still.
const STATIONARY_VELOCITY_NOISE_MPS = 0.05;
// Assumed when a fix carries a speed or bearing without its accuracy.
const DEFAULT_SPEED_ACCURACY_MPS = 1;
const DEFAULT_BEARING_ACCURACY_DEG = 30;
const MIN_SPEED_ACCURACY_MPS = 0.2;
// After a pause longer than this (tunnel, underground) the filter restarts at the next fix
// instead of extrapolating the last velocity across the gap.
const MAX_PREDICT_SECONDS = 5;

// --- Standing still -------------------------------------------------------------------------
// The speed in each fix is GNSS Doppler speed, measured from the frequency shift of the satellite
// signals rather than from consecutive positions, so it stays near zero (0.1-0.3 m/s) when
// standing still even while the positions jump around by several metres.
const STOP_SPEED_MPS = 0.5; // below this (1.8 km/h) ...
const STOP_FIXES = 3; // ... on this many fixes in a row: standing still
const GO_SPEED_MPS = 1; // at or above this (3.6 km/h) ...
const GO_FIXES = 2; // ... on this many fixes in a row: moving again
const GO_SPEED_IMMEDIATE_MPS = 2.5; // or once at this speed (9 km/h)
// Fallbacks for fixes without a speed: still if all fixes stay within this factor of their
// accuracy for STILL_SECONDS; moving again if fixes are this far from the held position twice.
const STILL_RADIUS_FACTOR = 1.5;
const STILL_MIN_RADIUS_METERS = 5;
const STILL_SECONDS = 5;
const AWAY_ACCURACY_FACTOR = 2;
const AWAY_MIN_METERS = 15;
const AWAY_FIXES = 2;

const EARTH_RADIUS_M = 6371000;
const M_PER_DEG_LAT = 111_320;

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export function timeMs(s: Pick<GpsSample, 'timestampUtc'>): number {
  return Date.parse(s.timestampUtc);
}

export function isAccurate(s: Pick<GpsSample, 'accuracyMeters'>): boolean {
  return s.accuracyMeters == null || s.accuracyMeters <= MAX_ACCURACY_METERS;
}

export function validSpeed(v: number | null): number | null {
  return v != null && v >= 0 && v <= MAX_PLAUSIBLE_SPEED_MPS ? v : null;
}

// Covariance of one axis (position, velocity); both axes get the same measurements and model,
// so they share it.
type Cov = { pp: number; pv: number; vv: number };
type State = { x: number; vx: number; y: number; vy: number };

/** One filter step, kept for the backward smoothing pass. */
type Step = {
  filtered: State;
  filteredCov: Cov;
  predicted: State;
  predictedCov: Cov;
  dt: number;
  /** The filter restarted at this step (first fix, or after a long pause). */
  reset: boolean;
};

/**
 * Kalman filter over accepted fixes: constant velocity in a local metric frame, measuring the
 * position (weighted by the fix's accuracy) and the Doppler velocity (speed + bearing).
 * Detects standing still from the Doppler speed and then holds the position, so GPS jitter
 * neither moves the map arrow nor draws zigzags. Feed fixes in order with push().
 */
export class TrackFilter {
  private lat0 = 0;
  private lon0 = 0;
  private mPerDegLon = 0;
  private started = false;

  private s: State = { x: 0, vx: 0, y: 0, vy: 0 };
  private p: Cov = { pp: 0, pv: 0, vv: 0 };
  private lastTime = 0;
  private lastRaw: GpsSample | null = null;
  private last: TrackPoint | null = null;

  private stationary = false;
  private slowCount = 0;
  private fastCount = 0;
  private awayCount = 0;
  private still: { x: number; y: number; t: number } | null = null;

  /** Filter steps for smoothing; only kept when asked for. */
  readonly steps: Step[] | null;

  constructor(options: { keepHistory?: boolean } = {}) {
    this.steps = options.keepHistory ? [] : null;
  }

  get isStationary(): boolean {
    return this.stationary;
  }

  /** Adds a fix; returns its filtered point, or null if the fix was rejected. */
  push(sample: GpsSample): TrackPoint | null {
    if (!isAccurate(sample)) return null;
    const t = timeMs(sample);
    const accuracy = Math.max(sample.accuracyMeters ?? MAX_ACCURACY_METERS, 1);

    if (!this.started) {
      this.lat0 = sample.latitude;
      this.lon0 = sample.longitude;
      this.mPerDegLon = M_PER_DEG_LAT * Math.cos((sample.latitude * Math.PI) / 180);
      this.started = true;
    }

    let dt = 0;
    if (this.lastRaw) {
      dt = (t - this.lastTime) / 1000;
      if (dt <= 0) return null;
      const jump = haversineMeters(this.lastRaw.latitude, this.lastRaw.longitude, sample.latitude, sample.longitude);
      if (jump / dt > MAX_PLAUSIBLE_SPEED_MPS) return null;
    }

    const z = this.toXY(sample.longitude, sample.latitude);
    const speed = validSpeed(sample.speedMps);
    const velocity = velocityMeasurement(sample, speed);
    let predicted: State;
    let predictedCov: Cov;
    const reset = !this.lastRaw || dt > MAX_PREDICT_SECONDS;

    if (reset) {
      this.s = { x: z.x, vx: velocity?.vx ?? 0, y: z.y, vy: velocity?.vy ?? 0 };
      this.p = { pp: accuracy * accuracy, pv: 0, vv: velocity ? velocity.variance : 25 };
      this.stationary = speed != null && speed < STOP_SPEED_MPS;
      this.slowCount = this.fastCount = this.awayCount = 0;
      this.still = null;
      predicted = { ...this.s };
      predictedCov = { ...this.p };
    } else {
      this.detectMotion(speed, z, accuracy, t);
      this.predict(dt, this.stationary ? STATIONARY_ACCELERATION_MPS2 : MOVING_ACCELERATION_MPS2);
      predicted = { ...this.s };
      predictedCov = { ...this.p };
      if (this.stationary) {
        this.updateVelocity(0, 0, STATIONARY_VELOCITY_NOISE_MPS ** 2);
        this.updatePosition(z.x, z.y, (accuracy * STATIONARY_POSITION_NOISE_FACTOR) ** 2);
      } else {
        this.updatePosition(z.x, z.y, accuracy * accuracy);
        if (velocity) this.updateVelocity(velocity.vx, velocity.vy, velocity.variance);
      }
    }

    this.steps?.push({ filtered: { ...this.s }, filteredCov: { ...this.p }, predicted, predictedCov, dt, reset });
    this.lastRaw = sample;
    this.lastTime = t;

    const [longitude, latitude] = this.toLonLat(this.s.x, this.s.y);
    const prev = this.last;
    const point: TrackPoint = {
      sample,
      latitude,
      longitude,
      speedMps: this.stationary ? 0 : (speed ?? Math.hypot(this.s.vx, this.s.vy)),
      segmentMeters:
        prev && !this.stationary ? haversineMeters(prev.latitude, prev.longitude, latitude, longitude) : 0,
      stationary: this.stationary,
    };
    this.last = point;
    return point;
  }

  /**
   * Rauch-Tung-Striebel smoothing: a backward pass that also uses the fixes after each point,
   * which removes most of the remaining wobble and the filter's lag. `points` are the non-null
   * results of push(), in order; their positions, speeds and distances are updated in place.
   */
  smooth(points: TrackPoint[]): void {
    const steps = this.steps;
    if (!steps || steps.length !== points.length || steps.length === 0) return;
    const smoothed: State[] = new Array(steps.length);
    smoothed[steps.length - 1] = steps[steps.length - 1].filtered;
    for (let k = steps.length - 2; k >= 0; k--) {
      const next = steps[k + 1];
      // A restart breaks the chain: the stretch before it is smoothed on its own.
      if (next.reset) {
        smoothed[k] = steps[k].filtered;
        continue;
      }
      const f = steps[k].filteredCov;
      const pp = next.predictedCov;
      const dt = next.dt;
      // C = P_f * F^T * inverse(P_predicted), with F = [[1, dt], [0, 1]].
      const m00 = f.pp + f.pv * dt;
      const m01 = f.pv;
      const m10 = f.pv + f.vv * dt;
      const m11 = f.vv;
      const det = pp.pp * pp.vv - pp.pv * pp.pv;
      if (!(det > 0)) {
        smoothed[k] = steps[k].filtered;
        continue;
      }
      const i00 = pp.vv / det;
      const i01 = -pp.pv / det;
      const i11 = pp.pp / det;
      const c00 = m00 * i00 + m01 * i01;
      const c01 = m00 * i01 + m01 * i11;
      const c10 = m10 * i00 + m11 * i01;
      const c11 = m10 * i01 + m11 * i11;
      const xf = steps[k].filtered;
      const xs = smoothed[k + 1];
      const xp = next.predicted;
      const dx = xs.x - xp.x;
      const dvx = xs.vx - xp.vx;
      const dy = xs.y - xp.y;
      const dvy = xs.vy - xp.vy;
      smoothed[k] = {
        x: xf.x + c00 * dx + c01 * dvx,
        vx: xf.vx + c10 * dx + c11 * dvx,
        y: xf.y + c00 * dy + c01 * dvy,
        vy: xf.vy + c10 * dy + c11 * dvy,
      };
    }
    points.forEach((p, i) => {
      const [longitude, latitude] = this.toLonLat(smoothed[i].x, smoothed[i].y);
      p.latitude = latitude;
      p.longitude = longitude;
      if (!p.stationary && validSpeed(p.sample.speedMps) == null) p.speedMps = Math.hypot(smoothed[i].vx, smoothed[i].vy);
      const prev = points[i - 1];
      p.segmentMeters = prev && !p.stationary ? haversineMeters(prev.latitude, prev.longitude, latitude, longitude) : 0;
    });
  }

  private detectMotion(speed: number | null, z: { x: number; y: number }, accuracy: number, t: number) {
    if (speed != null) {
      if (!this.stationary) {
        this.slowCount = speed < STOP_SPEED_MPS ? this.slowCount + 1 : 0;
        if (this.slowCount >= STOP_FIXES) this.stop();
      } else {
        this.fastCount = speed >= GO_SPEED_MPS ? this.fastCount + 1 : 0;
        if (this.fastCount >= GO_FIXES || speed >= GO_SPEED_IMMEDIATE_MPS) {
          this.go(accuracy);
          return;
        }
      }
    } else if (!this.stationary) {
      // No speed in the fix: standing still if the fixes stay close together for a while.
      const radius = STILL_RADIUS_FACTOR * Math.max(accuracy, STILL_MIN_RADIUS_METERS);
      if (!this.still || Math.hypot(z.x - this.still.x, z.y - this.still.y) > radius) {
        this.still = { x: z.x, y: z.y, t };
      } else if (t - this.still.t >= STILL_SECONDS * 1000) {
        this.stop();
      }
    }
    if (this.stationary) {
      // Fallback for fixes without a (good) speed: clearly away from the held position.
      const away = Math.hypot(z.x - this.s.x, z.y - this.s.y);
      this.awayCount = away > Math.max(AWAY_ACCURACY_FACTOR * accuracy, AWAY_MIN_METERS) ? this.awayCount + 1 : 0;
      if (this.awayCount >= AWAY_FIXES) this.go(accuracy);
    }
  }

  private stop() {
    this.stationary = true;
    this.s.vx = 0;
    this.s.vy = 0;
    this.slowCount = this.fastCount = this.awayCount = 0;
    this.still = null;
  }

  private go(accuracy: number) {
    this.stationary = false;
    this.slowCount = this.fastCount = this.awayCount = 0;
    this.still = null;
    // The held position was very certain; let the next fixes move it freely again.
    this.p.pp = Math.max(this.p.pp, accuracy * accuracy);
    this.p.vv = Math.max(this.p.vv, 4);
  }

  private predict(dt: number, acceleration: number) {
    const s = this.s;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    const { pp, pv, vv } = this.p;
    const q = acceleration * acceleration;
    this.p = {
      pp: pp + 2 * dt * pv + dt * dt * vv + (q * dt ** 4) / 4,
      pv: pv + dt * vv + (q * dt ** 3) / 2,
      vv: vv + q * dt * dt,
    };
  }

  private updatePosition(zx: number, zy: number, variance: number) {
    const { pp, pv, vv } = this.p;
    const sInv = 1 / (pp + variance);
    const kp = pp * sInv;
    const kv = pv * sInv;
    const ex = zx - this.s.x;
    const ey = zy - this.s.y;
    this.s.x += kp * ex;
    this.s.vx += kv * ex;
    this.s.y += kp * ey;
    this.s.vy += kv * ey;
    this.p = { pp: pp - kp * pp, pv: pv - kp * pv, vv: vv - kv * pv };
  }

  private updateVelocity(zvx: number, zvy: number, variance: number) {
    const { pp, pv, vv } = this.p;
    const sInv = 1 / (vv + variance);
    const kp = pv * sInv;
    const kv = vv * sInv;
    const ex = zvx - this.s.vx;
    const ey = zvy - this.s.vy;
    this.s.x += kp * ex;
    this.s.vx += kv * ex;
    this.s.y += kp * ey;
    this.s.vy += kv * ey;
    this.p = { pp: pp - kp * pv, pv: pv - kp * vv, vv: vv - kv * vv };
  }

  private toXY(lon: number, lat: number) {
    return { x: (lon - this.lon0) * this.mPerDegLon, y: (lat - this.lat0) * M_PER_DEG_LAT };
  }

  private toLonLat(x: number, y: number): [number, number] {
    return [this.lon0 + x / this.mPerDegLon, this.lat0 + y / M_PER_DEG_LAT];
  }
}

/** The fix's Doppler velocity as east/north components, with its variance per axis. */
function velocityMeasurement(s: GpsSample, speed: number | null) {
  if (speed == null) return null;
  const speedAccuracy = Math.max(s.speedAccuracyMps ?? DEFAULT_SPEED_ACCURACY_MPS, MIN_SPEED_ACCURACY_MPS);
  if (speed < STOP_SPEED_MPS) {
    // Too slow for the bearing to mean anything; still a good "hardly moving" measurement.
    return { vx: 0, vy: 0, variance: speedAccuracy ** 2 + speed ** 2 };
  }
  if (s.heading == null) return null;
  const bearing = (s.heading * Math.PI) / 180;
  const bearingAccuracy = ((s.bearingAccuracyDeg ?? DEFAULT_BEARING_ACCURACY_DEG) * Math.PI) / 180;
  return {
    vx: speed * Math.sin(bearing),
    vy: speed * Math.cos(bearing),
    variance: speedAccuracy ** 2 + (speed * bearingAccuracy) ** 2,
  };
}

/**
 * Turns raw samples into a clean track:
 * 1. drops inaccurate fixes and implausible jumps,
 * 2. filters positions with a Kalman filter weighted by each fix's accuracy and its Doppler speed,
 * 3. holds the position and adds no distance while standing still,
 * 4. with `smooth` (the default), refines every point using the fixes after it as well.
 * The raw samples stay untouched in the database.
 */
export function processTrack(samples: GpsSample[], options: { smooth?: boolean } = {}): TrackPoint[] {
  const smooth = options.smooth ?? true;
  const filter = new TrackFilter({ keepHistory: smooth });
  const out: TrackPoint[] = [];
  for (const s of samples) {
    const p = filter.push(s);
    if (p) out.push(p);
  }
  if (smooth) filter.smooth(out);
  return out;
}
