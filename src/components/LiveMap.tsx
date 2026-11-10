import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre looks for its worker next to its own module file, which no longer exists once Vite
// bundles it. Ship the (self-contained) worker as a separate asset and tell MapLibre where it is.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { colors, MAP_STYLE_URL, ROUTE_REST_COLOR } from '../theme';

maplibregl.setWorkerUrl(workerUrl);

export type MapPosition = {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  /** Direction of travel in degrees from north. */
  bearing: number;
  /** Shown in the bubble next to the car; null hides it. */
  speedMps: number | null;
};

type Line = [number, number][];

type Props = {
  /** Route up to the shown position, one line per piece between GPS gaps ([lon, lat]). */
  routeDone: Line[];
  /** Route after the shown position, drawn grey while scrubbing. */
  routeRest: Line[];
  /** Dotted lines through coarse Wi-Fi/cell fixes (stretches without GPS). */
  coarseLines: Line[];
  position: MapPosition | null;
  /** Live mode: glide the marker to each new fix instead of jumping, and draw the route up to the marker. */
  animate: boolean;
  /** Whether the camera is locked to the marker. */
  following: boolean;
  /** The user panned the map away (stop following). Zooming does not count. */
  onUserPan: () => void;
  /** Shown in a popup above the position marker (timeline scrubbing). */
  popup: ReactNode | null;
};

type Pose = { lon: number; lat: number; bearing: number };

const FOLLOW_ZOOM = 15;
const RECENTER_MS = 600;
/** A glide lasts as long as the gap between fixes (so the car moves continuously), within these limits. */
const MIN_GLIDE_MS = 200;
const MAX_GLIDE_MS = 1500;
/** Farther than this (e.g. after a long reconnect) the marker jumps instead of gliding. */
const MAX_GLIDE_METERS = 2000;

const EMPTY_LINE: GeoJSON.Feature<GeoJSON.LineString> = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } };
const line = (coordinates: Line): GeoJSON.Feature<GeoJSON.LineString> => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates },
});
const lines = (coordinates: Line[]): GeoJSON.Feature<GeoJSON.MultiLineString> => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'MultiLineString', coordinates: coordinates.filter((l) => l.length >= 2) },
});

// MapLibre draws the world 512 px wide at zoom 0.
const metersPerPixelAtZoom22 = (latitude: number) => (40_075_016.686 * Math.cos((latitude * Math.PI) / 180)) / (512 * 2 ** 22);

function approxMeters(a: Pose, b: Pose): number {
  const dLat = (b.lat - a.lat) * 111_320;
  const dLon = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/** Bearing interpolation the short way round (350° → 10° goes through 0°). */
function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * t;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export function LiveMap({ routeDone, routeRest, coarseLines, position, animate, following, onUserPan, popup }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const puckRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [popupNode] = useState(() => document.createElement('div'));
  const [loaded, setLoaded] = useState(false);

  // Animation state lives in refs: it changes every frame and must not re-render React.
  const shown = useRef<Pose | null>(null); // where the marker is drawn right now
  const glide = useRef<{ from: Pose; to: Pose; start: number; duration: number } | null>(null);
  const lastTargetAt = useRef(0);
  const wasAnimating = useRef(animate);
  const headFrom = useRef<[number, number] | null>(null); // last route point before the marker (live mode)
  const followingRef = useRef(following);
  const recenteringUntil = useRef(0);
  // A mouse button or finger is down on the map. Any camera move would cancel the user's gesture
  // (MapLibre stops gestures on jumpTo/easeTo), so the camera waits until it is released.
  const pressed = useRef(false);
  const frame = useRef(0);
  const onUserPanRef = useRef(onUserPan);
  onUserPanRef.current = onUserPan;

  // Create the map once.
  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: MAP_STYLE_URL,
      center: [19.04, 47.5],
      zoom: 3,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    // Only real user drags stop following; zooming keeps the car in the middle.
    map.on('dragstart', () => {
      followingRef.current = false;
      onUserPanRef.current();
    });
    // Double-click zoom zooms around the click; bring the car back to the middle afterwards.
    map.on('zoomend', () => {
      if (followingRef.current && !pressed.current && shown.current) map.easeTo({ center: [shown.current.lon, shown.current.lat], duration: 300 });
    });
    const canvas = map.getCanvasContainer();
    const press = () => (pressed.current = true);
    const release = () => {
      if (!pressed.current) return;
      pressed.current = false;
      if (followingRef.current && shown.current && !glide.current) map.easeTo({ center: [shown.current.lon, shown.current.lat], duration: 300 });
    };
    canvas.addEventListener('pointerdown', press);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    map.on('load', () => {
      map.addSource('route-rest', { type: 'geojson', data: EMPTY_LINE });
      map.addSource('route-done', { type: 'geojson', data: EMPTY_LINE });
      map.addSource('route-head', { type: 'geojson', data: EMPTY_LINE });
      map.addSource('coarse', { type: 'geojson', data: EMPTY_LINE });
      map.addSource('accuracy', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const layout = { 'line-cap': 'round', 'line-join': 'round' } as const;
      const done = { 'line-color': colors.primary, 'line-width': 5 };
      map.addLayer({ id: 'route-rest', type: 'line', source: 'route-rest', layout, paint: { 'line-color': ROUTE_REST_COLOR, 'line-width': 4 } });
      map.addLayer({ id: 'route-done', type: 'line', source: 'route-done', layout, paint: done });
      map.addLayer({ id: 'route-head', type: 'line', source: 'route-head', layout, paint: done });
      // Stretches without GPS (e.g. underground), as in the app: dotted grey through the coarse fixes.
      map.addLayer({
        id: 'coarse',
        type: 'line',
        source: 'coarse',
        layout,
        paint: { 'line-color': colors.textMuted, 'line-width': 4, 'line-dasharray': [0.5, 2] },
      });
      map.addLayer({
        id: 'accuracy',
        type: 'circle',
        source: 'accuracy',
        paint: {
          'circle-color': colors.accent,
          'circle-opacity': 0.15,
          'circle-stroke-color': colors.accent,
          'circle-stroke-width': 1,
          'circle-stroke-opacity': 0.4,
        },
      });
      setLoaded(true);
    });

    const el = document.createElement('div');
    // Only the puck turns with the direction of travel; the speed bubble stays upright at its top right.
    el.className = 'car';
    el.innerHTML = '<div class="puck"><div class="arrow"></div></div><div class="speed-bubble" hidden><span class="speed-value"></span><span class="speed-unit">km/h</span></div>';
    puckRef.current = el.querySelector('.puck');
    bubbleRef.current = el.querySelector('.speed-bubble');
    markerRef.current = new maplibregl.Marker({ element: el });
    popupRef.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 22, maxWidth: '260px' }).setDOMContent(popupNode);

    mapRef.current = map;
    return () => {
      cancelAnimationFrame(frame.current);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      map.remove();
      mapRef.current = null;
    };
  }, [popupNode]);

  // While following, wheel and pinch zoom around the car (the middle of the screen), not the pointer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    followingRef.current = following;
    map.scrollZoom.disable();
    map.touchZoomRotate.disable();
    map.scrollZoom.enable(following ? { around: 'center' } : undefined);
    map.touchZoomRotate.enable(following ? { around: 'center' } : undefined);
    map.touchZoomRotate.disableRotation();
    // Start following again: glide the camera over to the car.
    if (following && shown.current && loaded) {
      recenteringUntil.current = performance.now() + RECENTER_MS;
      map.easeTo({ center: [shown.current.lon, shown.current.lat], duration: RECENTER_MS });
    }
  }, [following, loaded]);

  /** Draws the marker, accuracy circle, route head and camera at the given pose. */
  const draw = (pose: Pose) => {
    const map = mapRef.current!;
    markerRef.current!.setLngLat([pose.lon, pose.lat]);
    puckRef.current!.style.transform = `rotate(${pose.bearing}deg)`;
    (map.getSource('accuracy') as GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [pose.lon, pose.lat] } });
    (map.getSource('route-head') as GeoJSONSource).setData(headFrom.current ? line([headFrom.current, [pose.lon, pose.lat]]) : EMPTY_LINE);
    if (popupRef.current!.isOpen()) popupRef.current!.setLngLat([pose.lon, pose.lat]);
    // Don't fight the user's zoom gesture or a recenter animation; the camera catches up right after.
    if (followingRef.current && !pressed.current && !map.isZooming() && performance.now() > recenteringUntil.current) {
      map.jumpTo({ center: [pose.lon, pose.lat] });
    }
  };

  const tick = () => {
    const g = glide.current;
    if (!g || !mapRef.current) return;
    const t = Math.min(1, (performance.now() - g.start) / g.duration);
    const k = easeInOut(t);
    const pose = {
      lon: g.from.lon + (g.to.lon - g.from.lon) * k,
      lat: g.from.lat + (g.to.lat - g.from.lat) * k,
      bearing: lerpAngle(g.from.bearing, g.to.bearing, k),
    };
    shown.current = pose;
    draw(pose);
    if (t < 1) frame.current = requestAnimationFrame(tick);
    else glide.current = null;
  };

  // Route lines. In live mode the last segment is drawn separately, up to the gliding marker,
  // so the line never runs ahead of the car.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const lastLine = routeDone[routeDone.length - 1];
    const live = animate && lastLine != null && lastLine.length >= 2;
    headFrom.current = live ? lastLine[lastLine.length - 2] : null;
    (map.getSource('route-done') as GeoJSONSource).setData(lines(live ? [...routeDone.slice(0, -1), lastLine.slice(0, -1)] : routeDone));
    (map.getSource('route-rest') as GeoJSONSource).setData(lines(routeRest));
    (map.getSource('coarse') as GeoJSONSource).setData(lines(coarseLines));
    if (!live) (map.getSource('route-head') as GeoJSONSource).setData(EMPTY_LINE);
    else if (shown.current && !glide.current) draw(shown.current);
    // draw only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, animate, routeDone, routeRest, coarseLines]);

  // New position: glide to it (live) or jump to it (scrubbing, first fix, big jumps).
  const lat = position?.latitude;
  const lon = position?.longitude;
  const accuracy = position?.accuracyMeters ?? 0;
  const bearing = position?.bearing ?? 0;
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current!;
    if (!map || !loaded) return;
    cancelAnimationFrame(frame.current);
    glide.current = null;
    if (lat == null || lon == null) {
      marker.remove();
      shown.current = null;
      (map.getSource('accuracy') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    // Circle radius is in pixels: convert metres to pixels at zoom 22 and let it scale with zoom (as in the app).
    map.setPaintProperty('accuracy', 'circle-radius', ['interpolate', ['exponential', 2], ['zoom'], 0, 0, 22, accuracy / metersPerPixelAtZoom22(lat)]);

    const target: Pose = { lon, lat, bearing };
    const now = performance.now();
    const sinceLast = now - lastTargetAt.current;
    lastTargetAt.current = now;
    const from = shown.current;
    // Switching between scrubbing and live jumps straight to the new position.
    const modeChanged = wasAnimating.current !== animate;
    wasAnimating.current = animate;

    if (!from) {
      // First fix: put the car in the middle at a street-level zoom.
      shown.current = target;
      marker.setLngLat([lon, lat]).addTo(map);
      if (followingRef.current) map.jumpTo({ center: [lon, lat], zoom: FOLLOW_ZOOM });
      draw(target);
      return;
    }
    if (!animate || modeChanged || approxMeters(from, target) > MAX_GLIDE_METERS) {
      shown.current = target;
      draw(target);
      return;
    }
    glide.current = { from, to: target, start: now, duration: Math.min(MAX_GLIDE_MS, Math.max(MIN_GLIDE_MS, sinceLast)) };
    frame.current = requestAnimationFrame(tick);
    // tick/draw only read refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, animate, lat, lon, accuracy, bearing]);

  // Speed bubble: whole km/h.
  const speedKmh = position?.speedMps != null && position.speedMps >= 0 ? Math.round(position.speedMps * 3.6) : null;
  useEffect(() => {
    const bubble = bubbleRef.current!;
    bubble.hidden = speedKmh == null;
    bubble.querySelector('.speed-value')!.textContent = speedKmh == null ? '' : String(speedKmh);
    bubble.title = speedKmh == null ? '' : `${speedKmh} km/h`;
  }, [speedKmh]);

  const hasPopup = popup != null;
  useEffect(() => {
    const map = mapRef.current;
    const p = popupRef.current!;
    if (!map || !loaded || !hasPopup || lat == null || lon == null) {
      p.remove();
      return;
    }
    p.setLngLat([lon, lat]);
    if (!p.isOpen()) p.addTo(map);
  }, [loaded, hasPopup, lat, lon]);

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map" />
      {createPortal(popup, popupNode)}
    </div>
  );
}
