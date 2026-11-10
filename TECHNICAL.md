# TAB web viewer: technical description

This document explains how the viewer works inside: where the data comes from, how it flows through the components, how the map, route, statistics and graph are calculated and drawn, and what happens when the connection drops. For deployment and day-to-day use, see [README.md](README.md).

## 1. What the viewer is

A static single-page app (Vite + React 19 + TypeScript) served by nginx under `/view`, on the same origin as the backend (`tab_service`):

```
Browser ──https──► Nginx Proxy Manager (tab.aabder.xyz)
                     ├─ /view…   → tab_web container (nginx, static files of this repo)
                     └─ /api, /hubs/trip, /  → tab_service container (ASP.NET Core + SignalR)
```

The backend stores and forwards **raw GPS samples only**. Everything the viewer shows is derived in the browser from those samples, with the same code as the phone, so web and app show the same route and numbers:

| Viewer file | Copied from `tab_mobile` | Purpose |
| --- | --- | --- |
| `src/geo/track.ts` | `src/geo/track.ts` | Kalman filter, stand-still detection, backward smoothing |
| `src/geo/stats.ts` | `src/geo/stats.ts` | Distance, average, moving average, max, number formatting |
| `src/geo/gaps.ts` | `src/geo/gaps.ts` | GPS gaps and the dotted coarse-fix lines |
| `src/geo/spline.ts` | `src/geo/spline.ts` | Smooth route curve (centripetal Catmull-Rom) |
| `src/geo/playback.ts` | `src/geo/playback.ts` | Live playback: route parts, the car's pose between fixes, the playback clock |
| `src/geo/speedColors.ts` | `src/geo/speedColors.ts` | Per-trip speed colour scale |

**Keep these files identical to the app's.** If one side changes, copy it to the other.

## 2. Entry points and routing

There is no router. Everything is decided by the URL fragment (the part after `#`), which browsers never send to a server, so secrets in it don't appear in proxy logs.

| Address | What happens |
| --- | --- |
| `/view` or `/view/` (no fragment) | "No trip selected" |
| `/view#<viewer token>` | Share link: the live trip viewer |
| `/view#<admin key>` | Admin dashboard (the key is then hidden, see below) |
| `/view#admin` | Admin journey list (key taken from this tab's storage) |
| `/view#admin/<sessionId>` | Admin dashboard with that journey open |
| `/` | The backend redirects to `/view/`; the fragment is kept |

`App.tsx` reads the fragment with `useHash()` and picks the screen:

```
App
 ├─ ""                    → Message "No trip selected"
 ├─ "admin" | "admin/<id>" → AdminApp (needs the key from sessionStorage)
 └─ anything else         → TokenGate
                              ├─ admin key?  → store key, replace hash with #admin → AdminApp
                              ├─ not admin   → Viewer (Join with the token)
                              └─ check failed (offline, 429, 5xx) → "Could not open the link" + Try again
```

**TokenGate.** A share link and the admin link both carry a secret after `#`. `TokenGate` asks `GET /api/admin/sessions` with the value as `X-Admin-Key`:
- `200`: it's the admin key. The key goes into `sessionStorage` (plus an in-memory copy for browsers that block storage), and the hash is replaced with `#admin` using `history.replaceState`. That removes the key from the address bar and history without reloading.
- `401`: it's a viewer token. The `Viewer` opens with `Join(token)`.
- Anything else: the gate shows an error with **Try again** instead of guessing.

## 3. Data model

The phone sends each GPS fix unchanged as a `SampleDto` (`src/live/samples.ts`; same fields as `GpsSample` in `src/geo/track.ts`):

`sequence`, `timestampUtc`, `latitude`, `longitude`, `speedMps`, `accuracyMeters`, `altitudeMeters`, `heading`, `provider`, `satellitesUsed`, `satellitesInView`, `speedAccuracyMps`, `bearingAccuracyDeg`.

`sequence` increases by one per fix within a trip and is the identity of a sample. `mergeSamples(known, incoming)` adds new samples by sequence, ignores duplicates and keeps the array sorted. All de-duplication in the viewer relies on this.

`SessionInfo` describes the share: `sessionId`, `startedAtUtc`, `locationSource`, `createdAt`, `lastSeenAt`, `lastSequence`, and for closed sessions (admin only) `closedAt` and `closeReason`.

## 4. Live connection (`src/live/useLiveSession.ts`)

### 4.1 Joining

`useLiveSession(spec)` opens a SignalR connection to `${origin}/hubs/trip`. It uses WebSockets only (`skipNegotiation`), so a single upgraded request goes through the proxy. It then calls the hub method named in `spec`:

- `Join(viewerToken)` for share links,
- `AdminJoin(adminKey, sessionId)` for the dashboard.

Both return a **snapshot**: `{ session, samples[] }` with every sample stored so far. The server adds the connection to the session's SignalR group **before** reading the snapshot. A sample stored in between therefore arrives both in the snapshot and as an event, and is never missed. `mergeSamples` drops the duplicate.

After that the server pushes:

| Event | Payload | Viewer reaction |
| --- | --- | --- |
| `Samples` | newly stored samples, by sequence | merged into `samples`; everything downstream recalculates |
| `SessionClosed` | `ended`, `revoked` or `expired` | status becomes `ended`; the banner shows the reason |

The server sends only samples that were actually inserted, so retries by the phone don't reach viewers twice.

The hook returns `{ status, session, samples, closeReason }`. `status` is one of:

| Status | Meaning | Shown as |
| --- | --- | --- |
| `connecting` | first connection not yet up | amber "Connecting…" pill |
| `live` | joined, receiving events | red "● LIVE" pill |
| `reconnecting` | connection lost, retrying | amber "Reconnecting…" pill |
| `ended` | share closed (or admin opened a finished trip) | "ENDED" pill + banner |
| `not-found` | unknown token, or the share was already closed when the page opened | "Link not available" screen |

### 4.2 Losing the connection

Several layers keep the viewer going:

1. **Detecting it.** The server pings every 15 s and drops clients silent for 30 s. The browser notices a dead socket the same way.
2. **Automatic reconnect.** SignalR's automatic reconnect retries without limit, with back-off delays of 1, 2, 4, 8, 16, then 30 s between attempts. Meanwhile the status is `reconnecting`. The last known state stays on screen: map, route, stats and timeline keep working on the samples already received.
3. **Filling the gap.** After a successful reconnect the hook calls `Join`/`AdminJoin` again. The new snapshot contains everything, including samples sent while the viewer was offline, and `mergeSamples` adds only the missing ones. Nothing is requested "since sequence N"; the snapshot is the single source of truth.
4. **Connection closed for good, or the first start failed.** If SignalR gives up or the very first `start()` fails, the hook schedules a fresh start every 5 s until it works.
5. **Share closed while away.** If the re-join answers `not-found` (or `unauthorized`), the hook stops. With data already shown, the status becomes `ended` and the trip stays visible; without data, the "Link not available" screen appears.
6. **Share closed while connected.** The server sends `SessionClosed` and then disconnects viewers. The hook marks the session ended first, so the disconnect doesn't trigger reconnect attempts.

Errors other than `not-found`/`unauthorized` from `Join` are treated as connection trouble and left to the reconnect logic.

On the phone side, samples recorded while the phone is offline are queued and uploaded in order after it reconnects (`tab_mobile/src/share/ShareClient.ts`). They reach the viewer as one larger `Samples` batch, which the map handles as described in 6.3.

## 5. From samples to a track (`src/live/track.ts`)

Each time `samples` changes, `Viewer` rebuilds a `Track` with `buildTrack(samples)` (memoised):

```
raw samples ──processTrack──► TrackPoint[] (filtered, smoothed)
                │
                ├─ times[]             timestamp per point (ms)
                ├─ cumulativeMeters[]  distance up to each point
                ├─ bearings[]          heading per point, kept while slow
                ├─ parts[]             route split at GPS gaps, each a smooth curve
                └─ coarseLines[]       dotted lines through Wi-Fi/cell fixes
```

### 5.1 Filtering: `processTrack` (`src/geo/track.ts`)

1. **Rejecting bad fixes.** Fixes worse than 25 m accuracy, and implausible jumps (faster than 470 km/h), are not part of the track. They stay in the data and are used for the dotted lines (5.3).
2. **Kalman filter.** It assumes constant velocity in a local metric frame. The measurements are:
   - the position, weighted by the fix's accuracy;
   - the Doppler velocity (speed + bearing), weighted by `speedAccuracyMps` / `bearingAccuracyDeg`, with defaults when missing.
3. **Detecting standing still.** Doppler speed stays near zero even while positions jump by metres:
   - below 1.8 km/h on 3 fixes in a row, the position is held and no distance is added;
   - at 3.6 km/h on 2 fixes, or 9 km/h once, the track moves again;
   - fixes without a speed count as still after staying within 1.5× their accuracy (at least 5 m) for 5 s, and as moving again after getting clearly away (2× accuracy, at least 15 m) on 2 fixes.
4. **Backward smoothing.** A Rauch–Tung–Striebel pass refines every point using the fixes after it. Because the track is rebuilt from all samples whenever samples arrive, the recent part of the route can still shift slightly as later fixes come in.

Each `TrackPoint` keeps its raw `sample`, the filtered `latitude`/`longitude`, the filtered `speedMps` and the distance it added (`segmentMeters`).

### 5.2 Route curve and gaps

- **Splitting at gaps:** the route is split where two consecutive points are at least 8 s **and** 120 m apart (`isGap`, e.g. a tunnel).
- **Smoothing each part:** each part is drawn with `smoothLine` (`src/geo/spline.ts`). This is a centripetal Catmull-Rom spline, which never overshoots or loops between unevenly spaced points. Extra points are only inserted where the line turns (more than 8°, segments over 3 m, about every 5 m, at most 8 per segment), so straight stretches cost nothing. `smoothLine` also returns, for every track point, its index in the curve, so the route can be cut exactly at a track point.

### 5.3 Dotted lines (`liveCoarseLines`, `src/geo/gaps.ts`)

Stretches without accurate fixes are drawn dotted through the coarse Wi-Fi/cell fixes recorded there: before the first accurate fix, inside gaps, and after the last one (a gap still in progress). A simple filter smooths the coarse fixes so a single bad cell fix doesn't dominate. The app additionally fills gaps along roads and rail lines after a trip; the viewer doesn't, so live gaps stay dotted.

### 5.4 Splitting at the timeline cursor

`splitRoute(track, index)` returns `done` (up to and including point `index`) and `rest` (from there on). With `index = null` (live), everything is `done`. `indexAt(track, timeMs)` binary-searches the last point at or before a time.

## 6. The map (`src/components/LiveMap.tsx`)

MapLibre GL JS 6 with the OpenFreeMap "positron" style (same as the app), north-up, rotation disabled.

**Worker setup.** MapLibre runs a web worker that looks for its file next to its own module. That file doesn't exist after bundling, so the worker is imported as a separate asset (`maplibre-gl-worker.mjs?url`) and registered with `setWorkerUrl`. nginx serves `.mjs` files as `application/javascript`, because browsers refuse module workers with other MIME types.

### 6.1 Layers (bottom to top)

| Layer | Data | Style |
| --- | --- | --- |
| `route-rest` | `splitRoute().rest` (only while scrubbing) | grey `#8a96a3`, 4 px |
| `route-done` | `splitRoute().done` | primary blue `#043870`, 5 px |
| `route-head` | live: the curve from the last passed fix to the car (playback `head`) | same as `route-done` |
| `coarse` | `track.coarseLines` | muted, 4 px, dotted |
| `accuracy` | circle at the marker | accent blue, 15 % fill |

On top of the layers sits an HTML marker (`.car`) made of:
- the **puck**: a white circle with an arrow, rotated by the bearing;
- the **speed bubble**: a 40 px circle with whole km/h and the unit, at the puck's top right. It never rotates. It's hidden while the details popup is open, which shows the speed too.

While scrubbing, clicking the car toggles a MapLibre popup above the marker with the point's details. The React content is rendered into the popup through a portal.

**Accuracy circle.** MapLibre circle radii are in pixels, so the radius is computed as metres per pixel at zoom 22 for the marker's latitude and interpolated exponentially down to 0 at zoom 0. The circle keeps its real size in metres at every zoom.

### 6.2 Which position is shown

`Viewer` computes a `MapPosition` `{ latitude, longitude, accuracyMeters, bearing, speedMps }`:

Live with playback (§6.3), only its accuracy and speed are used; the car's place and bearing come from the playback.

- **Live:**
  - if the newest sample made it into the track, its **filtered** position (held still while standing still), like the app's arrow; otherwise the newest raw fix (e.g. a coarse fix inside a tunnel);
  - the bearing is the last `heading` from a sample moving at least 1 m/s (`liveBearing`), so the arrow doesn't spin while stopped;
  - the speed is the newest raw `speedMps` (same as the Speed tile), hidden once the trip has ended.
- **Scrubbing:** the track point at the cursor with its filtered position, bearing and speed.

### 6.3 Smooth movement: live playback (`src/geo/playback.ts`)

New fixes arrive about once a second. Gliding the car to each new fix makes it stop and go, and drawing the line to each new fix makes the line run ahead of the car. Live, the viewer therefore **plays the track back slightly in the past**, exactly like the app (see the app's TECHNICAL.md §9.3). The newest fix is about 2.25 s ahead of what is shown, so the next fix is always known and the car moves continuously.

- **Playback clock** (`PlaybackClock`): track time that advances with the wall clock, aiming at 1.5 s behind the newest track point.
  - The offset between track time and wall clock is averaged over the last ~5 fixes. The clock runs at most 10% faster or slower, so uneven arrival (on the web, also network delays) doesn't change the car's speed.
  - It never passes the newest point; during a GPS gap the car waits there.
  - When it is more than 5 s off (first data, a backlog after a reconnect), it jumps.
- **Pose** (`poseAt`): a point on the drawn spline. Between fixes, the distance along the line follows a Hermite curve through the fixes' speeds. It is then averaged over the last 1.5 s, so the speed stays even despite noisy fixes. That averaging adds 0.75 s of delay.
- **Forward filter while live.** The track is built with `processTrack(samples, { smooth: false })` while playing back live. Points the car has passed then never shift when new fixes arrive. The smoothed track is used once the trip has ended, or while scrubbing.
- **Bearing** (`BearingSmoother`): the direction of the route 2 s ahead of the car, turned towards smoothly (0.7 s). It only turns when the difference is larger than a zoom-dependent dead band: 2° at zoom 16, up to 10° at zoom 12. Zoomed out, small wiggles don't turn the arrow.
- **Marker** is created with `subpixelPositioning: true`, so it sits exactly at the end of the GL-drawn line instead of snapping to whole pixels.
- **Every animation frame** (`requestAnimationFrame` in `LiveMap`, imperatively, no React re-render) moves the marker, the accuracy circle and the `route-head` to the pose. If following, it also moves the camera there with `jumpTo`, so the car stays in the middle while the map moves underneath.
- **The route** is drawn up to the car. `route-done` gets `routeUpTo(track, index)`, re-sent only when the car passes a fix or new data arrives. `route-head` is the pose's short `head` from that fix to the car. The line therefore never runs ahead of the car and appears to be drawn by it.
- **Playback is off** while scrubbing, and while the newest sample is more than 3 s newer than the last track point (a GPS gap in progress). The car is then placed from the `MapPosition` in §6.2:
  - it jumps on the first fix (the camera centres at zoom 15), while scrubbing, when switching between scrubbing and live, and for targets more than 2 km away;
  - otherwise it glides with ease-in-out over the time since the previous target (200 ms to 1.5 s), with `route-head` running from the second-to-last route point to the marker.

### 6.4 Following and Recenter

`following` lives in `Viewer` and is passed down. Rules:

- **Panning stops following.** MapLibre's `dragstart` fires only for user drags, and turns it off; the **◎ Recenter** pill then appears at the top. Recenter (and any timeline move, and Go live) turns it back on, and the camera eases to the car in 600 ms.
- **Zooming keeps following.** While following, wheel and pinch zoom are switched to `around: 'center'`, so the zoom centres on the car. After a double-click zoom (which zooms around the click), the camera eases back to the car.
- **The camera never fights the user.** Any MapLibre `jumpTo`/`easeTo` cancels the gesture in progress. So while a mouse button or finger is down (`pointerdown` until `pointerup`), and while zooming or during the recenter animation, the per-frame camera update is skipped. The camera catches up right after.

## 7. Statistics (`src/components/StatusCard.tsx`, `src/geo/stats.ts`)

The status card always shows the **whole trip up to now** and is never affected by the timeline. It re-renders every second while the trip is live.

| Tile | Calculation |
| --- | --- |
| Speed | newest raw `speedMps` ("–" once ended) |
| Distance | sum of `segmentMeters` of the filtered track (no distance while standing still), plus stretches before the first / after the last accurate fix |
| Time | from `startedAtUtc` to now (to the last fix once ended) |
| Avg | distance ÷ total elapsed time, stops included |
| Moving avg | distance ÷ time spent moving (≥ 1 km/h per fix, or enough distance since the previous fix, which counts a tunnel as moving) |
| Max | highest filtered speed among fixes whose `speedAccuracyMps` ≤ 3 m/s |

The footer shows "Last fix N s ago · ±accuracy", or "Last fix at HH:MM:SS" once ended. Clock times use 24-hour format (`src/time.ts`); durations use `formatDuration` (`HH:MM:SS`).

## 8. Timeline and scrubbing (`src/components/Timeline.tsx`)

The time state is one value in `Viewer`: `cursorMs` (`null` = live).

- **The bar.** A themed `<input type="range">` spans the first track point to the newest sample. It works with mouse, touch and keyboard. Its red fill is a CSS gradient driven by a `--pct` variable.
- **The clock card** above the bar shows the cursor's time, and while scrubbing the offset from the end (`−00:01:22`).
- **Step buttons** (‹ and › at the ends of the bar) move the cursor exactly one track point back or forward, for fine adjustment on long trips where one pixel of the bar covers many points. Back from live starts at the second-to-last point. Forward from the last point goes live. Points sharing a timestamp are skipped, so every press lands on a different point.
- **Dragging sets `cursorMs`. Releasing leaves it there.** While samples keep arriving the bar grows to the right and the cursor keeps its time, like a YouTube live stream. Dragging to the right end is the same as **Go live**.
- **The top pill** switches between `● LIVE` / `ENDED` and a **Go live** / **Go to end** button, which sets `cursorMs = null` and follows the car again.

While scrubbing, the map draws the route before the cursor in blue and after it in grey, and puts the car at the cursor point (jump, no glide).

**Details popup.** Clicking the car (`showDetails` in `Viewer`, toggled through `LiveMap`'s `onCarClick`) shows a popup with time, speed, distance so far, elapsed time, accuracy, satellites used/in view and altitude, all taken from the track arrays at that index. Clicking the car again hides it. The toggle stays as set while you keep scrubbing. The popup appears only while looking back. While it's open, the speed bubble is hidden.

## 9. Speed graph (`src/components/SpeedGraph.tsx`)

An inline SVG at the bottom left: speed (km/h) over time, as one continuous line.

- **Data.** Filtered track speeds (`TrackPoint.speedMps × 3.6`) against `track.times`. Long trips are downsampled to about two points per pixel by averaging each time bucket.
- **Axes.** The y range is rounded up to a nice step (5, 10, 20, 25, 50 or 100 km/h, about three gridlines). The x axis shows the start and end times (24 h).
- **Colour.** The app's per-trip scale (`speedScale`), which is anchored to the trip's moving average:

  | Speed | Colour |
  | --- | --- |
  | 0 | red |
  | ½ × moving average | yellow |
  | moving average | green |
  | halfway to max | light blue |
  | max | deep blue |

  The colour depends only on the speed, which is the y value, so a single **vertical** `linearGradient` in user space colours the whole line correctly at every point. The cursor dot uses the same gradient.
- **Scrubbing.** The line is drawn twice with clip paths: full colour left of the cursor and `FADED_OPACITY` (0.3) right of it. A dashed line marks the cursor.
- **Interaction.** Clicking or dragging on the graph scrubs exactly like the timeline (pointer capture; the right end goes live). Hovering shows a crosshair with time and speed.
- **Size.** The card is as tall as the status card (measured with a `ResizeObserver` in `Viewer`) and as wide as it. The SVG sizes itself to its box with another `ResizeObserver`. Equal left and right margins keep the line clear of the rounded corners.

## 10. Layout and styling (`src/styles.css`)

- **Colours.** CSS variables on `:root`, copied from the app's `theme.ts`. Overlays are white cards with the same shadow.
- **Container queries.** The layout adapts to the **viewer's own width**, not the window, because the viewer is narrower inside the admin dashboard. `.app` is a size container, and `--side-w` (`max(340px, 25cqw − 24px)`) sets the width of both the status card and the speed graph.

| Viewer width | Layout |
| --- | --- |
| ≥ 1100 px | card top left, graph bottom left, timeline centred between the two side columns |
| < 1100 px | graph hidden, timeline in the middle 50 % |
| ≤ 900 px | card centred as a strip at the top, pills below it |
| ≤ 640 px (phones) | compact tiles, timeline across the full width, map controls and attribution moved clear of the overlays |

## 11. Admin dashboard (`src/admin/`)

- **`adminApi.ts`:** `GET /api/admin/sessions` with `X-Admin-Key`, plus the key storage in `sessionStorage` (it survives reloads of the tab, not closing it).
- **`AdminApp.tsx`:** a journey list on the left (refreshed every 30 s, filterable by session or trip ID) and the normal `Viewer` on the right, opened with `AdminJoin(adminKey, sessionId)`. Selecting a journey sets `#admin/<id>`, so Back returns to the list. On narrow screens only one side is shown, with a **← Journeys** pill to go back.
- **Open journeys** update live. Admins aren't tracked as viewers, so closing a share doesn't disconnect them.
- **Closed journeys** load once (`closedAt` set in the snapshot) and show as ended.
- **Key rejected later** (e.g. after a change): the key is cleared from storage and a message is shown.

## 12. Build and serving

- **Development:** `npm run dev` serves `http://localhost:5173/view/` and proxies `/api` and `/hubs` (WebSocket) to `TAB_BACKEND` (default `http://localhost:8080`). Open `/view/#…` with the slash; the dev server doesn't serve `/view`.
- **Production build:** `npm run build` type-checks, then bundles into `dist/` with base `/view/`. The output is one JS bundle (MapLibre is most of it), the CSS, and the MapLibre worker as its own asset.
- **Docker:** a Node 22 build stage, then `nginx-unprivileged` on port 8080 serving `dist` at `/usr/share/nginx/html/view`. `nginx.conf`:
  - `index.html` (`/view`, `/view/`, SPA fallback): `Cache-Control: no-store`, so a redeploy is picked up immediately;
  - `/view/assets/*` (hashed file names): cached for a year as immutable;
  - `.mjs`: `application/javascript` (module worker);
  - every response: `Referrer-Policy: no-referrer`, so map tile servers don't learn the page URL, and `X-Content-Type-Options: nosniff`.

## 13. Component overview

```
main.tsx
└─ App (useHash)
   ├─ Message                       static screens
   ├─ TokenGate                     admin key or viewer token?
   │   └─ Viewer
   └─ AdminApp                      journey list, polling
       └─ Viewer (AdminJoin)

Viewer
├─ useLiveSession(join)       → status, session, samples       (SignalR)
├─ buildTrack(samples)        → track                          (filter, curve, gaps)
├─ splitRoute(track, cursor)  → route.done / route.rest
├─ speedScale(computeStats)   → speed colour stops
├─ LiveMap        position, routes, coarse lines, following, popup
├─ StatusCard     samples, status                (whole trip, ticks every second)
├─ top pills      LIVE/ENDED · Go live · Recenter · (admin) ← Journeys
├─ SpeedGraph     track, stops, cursor           (scrubs too)
└─ Timeline       start, end, cursor             (scrubs)
```

Data flows one way: samples → track → derived values → components. The only state that components send back up is `cursorMs` (timeline and graph) and `following` (map drag, Recenter).
