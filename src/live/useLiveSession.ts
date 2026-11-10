import { HttpTransportType, HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import { useEffect, useState } from 'react';

import type { GpsSample } from '../geo/stats';
import { mergeSamples, type SampleDto, type SessionInfo, type Snapshot } from './samples';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'not-found';

export type LiveSession = {
  status: LiveStatus;
  session: SessionInfo | null;
  samples: GpsSample[];
  /** Why the share ended: "ended" (trip finished), "revoked" or "expired". */
  closeReason: string | null;
};

const HUB_URL = `${window.location.origin}/hubs/trip`;

/** Which hub method opens the session: Join(viewerToken) for share links, AdminJoin(adminKey, sessionId) for the dashboard. */
export type JoinSpec = { method: 'Join' | 'AdminJoin'; args: string[] };

/**
 * Viewer side of the TAB hub: Join(token) returns everything recorded so far, then new samples
 * arrive as "Samples" events. After a reconnect, Join is called again and merged, which fills in
 * whatever was missed while offline.
 */
export function useLiveSession(spec: JoinSpec): LiveSession {
  const specKey = JSON.stringify(spec);
  const [state, setState] = useState<LiveSession>({ status: 'connecting', session: null, samples: [], closeReason: null });

  useEffect(() => {
    let disposed = false;
    let ended = false;
    const update = (fn: (s: LiveSession) => LiveSession) => {
      if (!disposed) setState(fn);
    };

    const conn = new HubConnectionBuilder()
      .withUrl(HUB_URL, { transport: HttpTransportType.WebSockets, skipNegotiation: true })
      .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (c) => Math.min(30_000, 1_000 * 2 ** Math.min(c.previousRetryCount, 5)) })
      .configureLogging(LogLevel.Warning)
      .build();

    conn.on('Samples', (batch: SampleDto[]) => {
      update((s) => ({ ...s, samples: mergeSamples(s.samples, batch) }));
    });
    conn.on('SessionClosed', (reason: string) => {
      ended = true;
      update((s) => ({ ...s, status: 'ended', closeReason: reason }));
    });

    const join = async () => {
      try {
        const { method, args } = JSON.parse(specKey) as JoinSpec;
        const snap = await conn.invoke<Snapshot>(method, ...args);
        if (snap.session.closedAt) {
          // A finished trip (admin dashboard): show it, nothing more will arrive.
          ended = true;
          update((s) => ({ ...s, status: 'ended', closeReason: snap.session.closeReason ?? 'ended', session: snap.session, samples: mergeSamples(s.samples, snap.samples) }));
          await conn.stop();
          return;
        }
        update((s) => ({ ...s, status: 'live', session: snap.session, samples: mergeSamples(s.samples, snap.samples) }));
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        if (!message.includes('not-found') && !message.includes('unauthorized')) return; // connection trouble: automatic reconnect retries
        // Unknown token or key, or the share was closed while we were away.
        ended = true;
        update((s) => ({ ...s, status: s.session ? 'ended' : 'not-found' }));
        await conn.stop();
      }
    };

    conn.onreconnecting(() => update((s) => (ended ? s : { ...s, status: 'reconnecting' })));
    conn.onreconnected(() => join());

    let retry: ReturnType<typeof setTimeout> | undefined;
    const start = async () => {
      try {
        await conn.start();
        await join();
      } catch {
        if (disposed || ended) return;
        update((s) => ({ ...s, status: s.session ? 'reconnecting' : 'connecting' }));
        retry = setTimeout(start, 5_000);
      }
    };
    conn.onclose(() => {
      if (!disposed && !ended) {
        update((s) => ({ ...s, status: 'reconnecting' }));
        retry = setTimeout(start, 5_000);
      }
    });
    start();

    return () => {
      disposed = true;
      clearTimeout(retry);
      conn.stop();
    };
  }, [specKey]);

  return state;
}
