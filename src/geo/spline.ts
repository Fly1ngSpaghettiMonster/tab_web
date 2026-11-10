// COPY of tab_mobile/src/geo/spline.ts - keep in sync, so the viewer derives exactly the same
// route and statistics from the raw samples as the phone does.

/**
 * Smooth drawing of a GPS line: a centripetal Catmull-Rom spline through the points. Unlike other
 * spline variants it never overshoots or loops between unevenly spaced points, so the curve stays
 * close to where the car actually was. Extra points are only added where the line turns, so
 * straight stretches cost nothing.
 */

type LonLat = [number, number];

// Points closer together than this are merged (e.g. the held position while standing still).
const MIN_POINT_SPACING_METERS = 0.5;
// Segments only get intermediate points if they are longer than this ...
const MIN_CURVE_SEGMENT_METERS = 3;
// ... and the line turns by more than this at one of their ends.
const MIN_TURN_DEGREES = 8;
// Spacing of the intermediate points, and their maximum number per segment.
const STEP_METERS = 5;
const MAX_STEPS = 8;
// Centripetal parameterisation.
const ALPHA = 0.5;

const M_PER_DEG_LAT = 111_320;

export type SmoothedLine = {
  coords: LonLat[];
  /** For every input point, the index of its position in `coords`. */
  index: number[];
};

export function smoothLine(input: LonLat[]): SmoothedLine {
  if (input.length === 0) return { coords: [], index: [] };
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((input[0][1] * Math.PI) / 180);
  const toXY = ([lon, lat]: LonLat) => ({ x: lon * mPerDegLon, y: lat * M_PER_DEG_LAT });
  const toLonLat = (p: { x: number; y: number }): LonLat => [p.x / mPerDegLon, p.y / M_PER_DEG_LAT];

  // Merge (nearly) repeated points; remember where each input point went.
  const pts: { x: number; y: number }[] = [];
  const keep: LonLat[] = [];
  const inputToKept: number[] = [];
  for (const c of input) {
    const p = toXY(c);
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= MIN_POINT_SPACING_METERS) {
      pts.push(p);
      keep.push(c);
    }
    inputToKept.push(pts.length - 1);
  }

  const coords: LonLat[] = [keep[0]];
  const keptToOut: number[] = [0];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const length = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    // Missing neighbours at the ends are mirrored, which keeps the end segments straight-ish.
    const p0 = pts[i - 1] ?? { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
    const p3 = pts[i + 2] ?? { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };
    const turning = turnDegrees(p0, p1, p2) > MIN_TURN_DEGREES || turnDegrees(p1, p2, p3) > MIN_TURN_DEGREES;
    if (length > MIN_CURVE_SEGMENT_METERS && turning) {
      const steps = Math.min(MAX_STEPS, Math.ceil(length / STEP_METERS));
      for (let s = 1; s < steps; s++) coords.push(toLonLat(catmullRom(p0, p1, p2, p3, s / steps)));
    }
    coords.push(keep[i + 1]);
    keptToOut.push(coords.length - 1);
  }
  return { coords, index: inputToKept.map((k) => keptToOut[k]) };
}

/** Change of direction at b, in degrees (0 = straight on). */
function turnDegrees(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) {
  const h1 = Math.atan2(b.y - a.y, b.x - a.x);
  const h2 = Math.atan2(c.y - b.y, c.x - b.x);
  let d = Math.abs(h2 - h1);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return (d * 180) / Math.PI;
}

/** Point at fraction u (0..1) of the way from p1 to p2 (Barry-Goldman form). */
function catmullRom(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  u: number,
) {
  const knot = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.max(Math.hypot(b.x - a.x, b.y - a.y) ** ALPHA, 1e-6);
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + u * (t2 - t1);
  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, ta: number, tb: number) => ({
    x: ((tb - t) * a.x + (t - ta) * b.x) / (tb - ta),
    y: ((tb - t) * a.y + (t - ta) * b.y) / (tb - ta),
  });
  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}
