import type { CSSProperties } from 'react';

import { formatDuration } from '../geo/stats';
import { clock } from '../time';

type Props = {
  startMs: number;
  endMs: number;
  /** Selected time, or null when following live. */
  cursorMs: number | null;
  onScrub: (timeMs: number) => void;
  /** Dragging all the way to the right is the same as going live. */
  onGoLive: () => void;
  /** One data point back (-1) or forward (+1), for fine adjustment on long trips. */
  onStep: (direction: -1 | 1) => void;
  canStepBack: boolean;
  canStepForward: boolean;
};

/** A YouTube-live style scrub bar: drag back in time. The LIVE / Go live control sits at the top of the page. */
export function Timeline({ startMs, endMs, cursorMs, onScrub, onGoLive, onStep, canStepBack, canStepForward }: Props) {
  const span = Math.max(1, endMs - startMs);
  const value = cursorMs ?? endMs;
  const pct = Math.min(100, Math.max(0, ((value - startMs) / span) * 100));
  const behind = Math.max(0, (endMs - value) / 1000);

  return (
    <div className="timeline-dock">
      <div className="time-card">
        {clock(value)}
        {cursorMs != null && <span className="muted"> −{formatDuration(behind)}</span>}
      </div>
      <div className="timeline">
        <button className="step" onClick={() => onStep(-1)} disabled={!canStepBack} aria-label="Previous data point" title="Previous data point">
          ‹
        </button>
        <input
          className="scrub"
          type="range"
          min={startMs}
          max={endMs}
          step={1}
          value={value}
          style={{ '--pct': `${pct}%` } as CSSProperties}
          aria-label="Trip timeline"
          onChange={(e) => {
            const t = Number(e.target.value);
            if (t >= endMs) onGoLive();
            else onScrub(t);
          }}
        />
        <button className="step" onClick={() => onStep(1)} disabled={!canStepForward} aria-label="Next data point" title="Next data point">
          ›
        </button>
      </div>
    </div>
  );
}
