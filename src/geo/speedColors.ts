// Copy of tab_mobile/src/geo/speedColors.ts - keep the two in sync so the web uses the same speed colours as the app.
/**
 * Per-trip speed colour scale, anchored at the trip's own average so "slow" and "fast" are
 * relative to how that trip was driven (a motorway trip and a city trip both use the full range):
 *
 *   0 km/h          red
 *   ½ × average     yellow
 *   average         green
 *   halfway to max  light blue
 *   max             deep blue
 *
 * Colours blend linearly between these stops.
 */
export const SPEED_SCALE_COLORS = ['#d32f2f', '#f9a825', '#43a047', '#4fc3f7', '#0d47a1'] as const;

export type SpeedStop = { kmh: number; color: string };

// MapLibre needs strictly increasing stops; used when max is (almost) equal to the average.
const MIN_STOP_GAP_KMH = 0.5;

export function speedScale(averageKmh: number, maxKmh: number): SpeedStop[] {
  const avg = Math.max(averageKmh, 2 * MIN_STOP_GAP_KMH);
  const max = Math.max(maxKmh, avg + 2 * MIN_STOP_GAP_KMH);
  const values = [0, avg / 2, avg, (avg + max) / 2, max];
  return values.map((kmh, i) => ({ kmh, color: SPEED_SCALE_COLORS[i] }));
}

/** MapLibre expression colouring a feature by its `kmh` property along the scale. */
export function speedColorExpression(stops: SpeedStop[]) {
  return ['interpolate', ['linear'], ['get', 'kmh'], ...stops.flatMap((s) => [s.kmh, s.color])];
}
