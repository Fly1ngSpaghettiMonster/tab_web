# TAB web viewer

This is the browser page behind a TAB share link (`https://tab.aabder.xyz/view#<token>`). It shows a shared trip live:

- **Map:** the car's position, its direction and GPS accuracy, and the route so far. It uses the app's colours and the same OpenFreeMap style.
  - The trip is played back about 2 s behind the newest fix, as in the app. The car therefore moves continuously and at an even speed instead of stopping at every fix, and the route is drawn exactly up to the car. The camera stays locked on it.
  - Zooming keeps the lock.
  - Panning the map releases it, and a **Recenter** button appears at the top to lock on again.
- **Status card:** speed, distance, time, average, moving average and max, computed live.
- **Timeline:** drag it to step back through the trip. The map moves the car to that moment and shows the analytics at that point in a popup. The car stays there when you let go, while the live data keeps coming in.
  - The **LIVE** badge at the top of the page becomes **Go live** while you're looking back.
  - Pressing **Go live** jumps to the current position and follows it again.

The backend (`tab_service`) only stores raw GPS samples. The viewer derives everything with `src/geo/track.ts`, `gaps.ts`, `spline.ts`, `playback.ts`, `stats.ts` and `speedColors.ts`. These are copies of the same files in `tab_mobile/src/geo/`. **Keep them in sync** so the route and numbers on the web match the app:
- the filtered track, held still while standing still,
- the route drawn as a smooth curve,
- dotted lines where there was no GPS,
- the same distance and speeds.

Stack: Vite, React, TypeScript, MapLibre GL JS and the SignalR client. The build output is static files, served by nginx.

How it works inside (data flow, calculations, drawing, reconnects): see [TECHNICAL.md](TECHNICAL.md).

## How it fits together

The viewer is served on the same origin as the API, so it needs no CORS and no configuration:

```
https://tab.aabder.xyz/view...   -> NPM custom location -> tab_web container (nginx, this repo)
https://tab.aabder.xyz/*         -> NPM proxy host      -> tab_service container (API + /hubs/trip)
```

The page reads the token from the URL fragment. Browsers never send the fragment to a server. The page then calls `Join(token)` on `/hubs/trip`, which returns everything recorded so far, followed by live `Samples` events. If the connection drops, it reconnects and joins again to fill the gap.

## Deploy

```bash
docker compose up -d --build        # serves http://<host>:8082/view
```

In **Nginx Proxy Manager**, open the existing `tab.aabder.xyz` proxy host. Under **Custom Locations**, add:

- **Location:** `/view`
- **Scheme / Forward host / port:** `http` / `192.168.1.67` (the machine running this container) / `8082`

NPM passes the path through unchanged. nginx here serves `/view`, `/view/` and `/view/assets/*`. Everything else still goes to the API.

While the container runs on the Windows PC, also allow port 8082 through the firewall (Administrator PowerShell):

```powershell
New-NetFirewallRule -DisplayName "TAB web 8082 (LAN)" -Direction Inbound -Protocol TCP -LocalPort 8082 -Action Allow -Profile Private -RemoteAddress LocalSubnet
```

Check: `https://tab.aabder.xyz/view` should show "No trip selected". A link shared from the app should show the trip.

## Develop

```bash
npm install
npm run dev                          # http://localhost:5173/view/#<token>
```

Vite proxies `/api` and `/hubs` to the backend at `http://localhost:8080`. To use another backend, set `TAB_BACKEND=http://host:port`.

To get a token, start sharing from the app (or `POST /api/sessions`) and take the part of the link after `#`.

`npm run build` type-checks the code and writes the static site to `dist/`.

## Notes

- MapLibre's web worker is shipped as its own asset (`maplibre-gl-worker-*.mjs`, set up via `setWorkerUrl` in `LiveMap.tsx`). nginx serves it as `application/javascript`, which module workers require.
- The page sends `Referrer-Policy: no-referrer`, so the map tile servers don't even learn which page loaded them. The token itself is in the fragment, which browsers never send anyway.
