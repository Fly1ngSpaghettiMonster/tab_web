import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';

import type { SpeedStop } from '../geo/speedColors';
import { clock, clockShort } from '../time';
import type { Track } from '../live/track';

type Props = {
  /** Card height in px (matches the status card); 0 = not measured yet. */
  height: number;
  track: Track;
  /** The app's per-trip speed colour scale. */
  stops: SpeedStop[];
  startMs: number;
  endMs: number;
  /** Selected time, or null when following live. */
  cursorMs: number | null;
  onScrub: (timeMs: number) => void;
  onGoLive: () => void;
};

/** How visible the part of the graph after the timeline cursor stays (0.3 = 70 % fainter). */
export const FADED_OPACITY = 0.3;

// Same margin left and right: the axis labels sit in the left one, the right one keeps the
// line and its end dot clear of the card's rounded corner.
const PAD = { left: 28, right: 28, top: 10, bottom: 18 };


/** Picks a round tick step so the speed axis gets about three gridlines. */
function niceStep(max: number): number {
  for (const step of [5, 10, 20, 25, 50, 100]) if (max / step <= 4) return step;
  return 200;
}

/**
 * Speed over time as one continuous line, coloured by speed exactly like the app's route.
 * The colour depends only on the speed (the y value), so a vertical gradient over the whole
 * plot colours the line correctly at every point. Before the timeline cursor the line is full
 * colour, after it the same colours faded. Clicking or dragging on the graph moves the timeline.
 */
export function SpeedGraph({ height, track, stops, startMs, endMs, cursorMs, onScrub, onGoLive }: Props) {
  const id = useId().replace(/:/g, '');
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const { width } = size;
  const HEIGHT = size.height;
  const [hoverX, setHoverX] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current!;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const span = Math.max(1, endMs - startMs);

  // Downsample to about two points per pixel (averaging each bucket) so long trips stay light.
  const series = useMemo(() => {
    const n = track.points.length;
    const buckets = Math.max(2, Math.round(plotW * 2));
    const out: { t: number; kmh: number }[] = [];
    if (n <= buckets) {
      for (let i = 0; i < n; i++) out.push({ t: track.times[i], kmh: track.points[i].speedMps * 3.6 });
      return out;
    }
    let bucket = -1;
    let sumT = 0;
    let sumV = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const b = Math.min(buckets - 1, Math.floor(((track.times[i] - startMs) / span) * buckets));
      if (b !== bucket && count > 0) {
        out.push({ t: sumT / count, kmh: sumV / count });
        sumT = sumV = count = 0;
      }
      bucket = b;
      sumT += track.times[i];
      sumV += track.points[i].speedMps * 3.6;
      count++;
    }
    if (count > 0) out.push({ t: sumT / count, kmh: sumV / count });
    return out;
  }, [track, plotW, startMs, span]);

  const dataMax = series.reduce((m, p) => Math.max(m, p.kmh), 0);
  const step = niceStep(Math.max(dataMax, 10));
  const yMax = Math.max(step, Math.ceil(Math.max(dataMax, 10) / step) * step);
  const x = (t: number) => PAD.left + ((t - startMs) / span) * plotW;
  const y = (kmh: number) => PAD.top + plotH - (Math.min(kmh, yMax) / yMax) * plotH;
  const path = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.kmh).toFixed(1)}`).join('');

  const ticks: number[] = [];
  for (let v = 0; v <= yMax; v += step) ticks.push(v);

  // Gradient runs from 0 km/h (bottom) to the scale's top stop; above that it stays deep blue.
  const topKmh = stops[stops.length - 1].kmh;
  const cursorT = cursorMs ?? endMs;
  const cx = x(cursorT);
  const speedAt = (t: number) => {
    let best = series[0];
    for (const p of series) {
      if (p.t > t) break;
      best = p;
    }
    return best?.kmh ?? 0;
  };

  const timeAtPointer = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = Math.min(Math.max(e.clientX - r.left, PAD.left), PAD.left + plotW);
    return { px, t: startMs + ((px - PAD.left) / plotW) * span };
  };
  const scrubTo = (t: number) => (t >= endMs - span * 0.005 ? onGoLive() : onScrub(t));

  const hoverT = hoverX != null ? startMs + ((hoverX - PAD.left) / plotW) * span : null;

  return (
    <div className="speed-graph" style={height > 0 ? { height } : undefined}>
      <div className="graph-title">
        Speed <span className="muted">km/h</span>
      </div>
      <div className="graph-plot" ref={wrapRef}>
      {width > 0 && HEIGHT > 40 && series.length > 1 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label="Speed over the trip"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            scrubTo(timeAtPointer(e).t);
          }}
          onPointerMove={(e) => {
            const { px, t } = timeAtPointer(e);
            setHoverX(px);
            if (e.currentTarget.hasPointerCapture(e.pointerId)) scrubTo(t);
          }}
          onPointerLeave={() => setHoverX(null)}
        >
          <defs>
            <linearGradient id={`g${id}`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={y(0)} y2={y(0) - (topKmh / yMax) * plotH}>
              {stops.map((s) => (
                <stop key={s.kmh} offset={Math.min(1, s.kmh / topKmh)} stopColor={s.color} />
              ))}
            </linearGradient>
            <clipPath id={`done${id}`}>
              <rect x={0} y={0} width={cx} height={HEIGHT} />
            </clipPath>
            <clipPath id={`rest${id}`}>
              <rect x={cx} y={0} width={Math.max(0, width - cx)} height={HEIGHT} />
            </clipPath>
          </defs>

          {ticks.map((v) => (
            <g key={v}>
              <line className="grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} />
              <text className="axis" x={PAD.left - 5} y={y(v)} textAnchor="end" dominantBaseline="middle">
                {v}
              </text>
            </g>
          ))}
          <text className="axis" x={PAD.left} y={HEIGHT - 4} textAnchor="start">
            {clockShort(startMs)}
          </text>
          <text className="axis" x={PAD.left + plotW} y={HEIGHT - 4} textAnchor="end">
            {clockShort(endMs)}
          </text>

          <path d={path} className="speed-line" stroke={`url(#g${id})`} clipPath={`url(#done${id})`} />
          <path d={path} className="speed-line" stroke={`url(#g${id})`} clipPath={`url(#rest${id})`} opacity={FADED_OPACITY} />

          {cursorMs != null && <line className="cursor" x1={cx} x2={cx} y1={PAD.top} y2={PAD.top + plotH} />}
          <circle className="cursor-dot" cx={cx} cy={y(speedAt(cursorT))} r={4} fill={`url(#g${id})`} />

          {hoverX != null && hoverT != null && (
            <g pointerEvents="none">
              <line className="crosshair" x1={hoverX} x2={hoverX} y1={PAD.top + 12} y2={PAD.top + plotH} />
              <text className="hover-label" x={Math.min(Math.max(hoverX, PAD.left + 40), PAD.left + plotW - 40)} y={PAD.top + 8} textAnchor="middle">
                {clock(hoverT)} · {speedAt(hoverT).toFixed(0)} km/h
              </text>
            </g>
          )}
        </svg>
      )}
      </div>
    </div>
  );
}
