import type { GpsSample } from '../geo/stats';

/** A raw sample as sent by the backend (SampleDto). */
export type SampleDto = Omit<GpsSample, 'journeyId'>;

export type SessionInfo = {
  sessionId: string;
  startedAtUtc: string;
  locationSource: string | null;
  createdAt: string;
  lastSeenAt: string;
  lastSequence: number;
  /** Set once the share is closed (only the admin dashboard sees closed sessions). */
  closedAt?: string | null;
  closeReason?: string | null;
};

export type Snapshot = { session: SessionInfo; samples: SampleDto[] };

/** Merges new samples into the known ones; duplicates (same sequence) are ignored. Result is sorted. */
export function mergeSamples(known: GpsSample[], incoming: SampleDto[]): GpsSample[] {
  if (incoming.length === 0) return known;
  const bySequence = new Map(known.map((s) => [s.sequence, s]));
  let added = false;
  for (const s of incoming) {
    if (bySequence.has(s.sequence)) continue;
    bySequence.set(s.sequence, { ...s, journeyId: 0 });
    added = true;
  }
  if (!added) return known;
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}
