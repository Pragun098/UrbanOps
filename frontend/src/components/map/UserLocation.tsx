"use client";

/**
 * "You are here" layer for react-leaflet maps (render inside <MapContainer>).
 * Reads the app-wide position from LocationProvider (one watcher for the app).
 *
 * - Blue dot + accuracy circle, drawn BELOW issue markers so it never hides one.
 * - Centres the map on the user's first known position (autoCenter).
 * - "My location" button flies back to the user (or re-asks for permission).
 */

import { useEffect, useRef } from "react";
import { Circle, Marker, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import { useUserLocation, type LocationStatus, type UserPosition } from "@/lib/location";

export type { UserPosition };

const dotIcon = L.divIcon({
  className: "user-location-dot",
  html: '<span class="user-location-pulse"></span>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

const STATUS_TEXT: Record<LocationStatus, string> = {
  locating: "Finding your location…",
  ok: "Centre on my location",
  denied: "Location blocked. Allow it in the browser's address bar, then click again.",
  unavailable: "Couldn't determine your location. Click to retry.",
  unsupported: "This browser can't share its location.",
};

type Props = {
  /** Centre the map on the user's first known position. */
  autoCenter?: boolean;
  /** Called on every position update. */
  onLocate?: (pos: UserPosition) => void;
};

export default function UserLocation({ autoCenter = true, onLocate }: Props) {
  const map = useMap();
  const { status, position, place, refresh } = useUserLocation();
  const centered = useRef(false);
  const onLocateRef = useRef(onLocate);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    onLocateRef.current = onLocate;
  });

  useEffect(() => {
    if (!position) return;
    onLocateRef.current?.(position);
    if (autoCenter && !centered.current) {
      centered.current = true;
      map.setView([position.lat, position.lng], Math.max(map.getZoom(), 15));
    }
  }, [map, position, autoCenter]);

  // Clicks on the button must not reach the map (which would e.g. drop a report pin).
  useEffect(() => {
    if (buttonRef.current) {
      L.DomEvent.disableClickPropagation(buttonRef.current);
      L.DomEvent.disableScrollPropagation(buttonRef.current);
    }
  }, []);

  const locate = () => {
    if (position && status === "ok") {
      map.flyTo([position.lat, position.lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
    } else {
      centered.current = false; // centre once the new fix arrives
      refresh();
    }
  };

  return (
    <>
      {position && (
        <>
          <Circle
            center={[position.lat, position.lng]}
            radius={position.accuracy}
            interactive={false}
            pathOptions={{ color: "#2563EB", weight: 1, fillColor: "#2563EB", fillOpacity: 0.08 }}
          />
          <Marker position={[position.lat, position.lng]} icon={dotIcon} zIndexOffset={-1000} keyboard={false}>
            <Tooltip direction="top" offset={[0, -10]}>
              You are here{place ? `: ${place}` : ""} (±{Math.round(position.accuracy)} m)
            </Tooltip>
          </Marker>
        </>
      )}

      <button
        ref={buttonRef}
        type="button"
        className={`locate-button ${status}`}
        onClick={locate}
        title={STATUS_TEXT[status]}
        aria-label={STATUS_TEXT[status]}
        disabled={status === "unsupported"}
      >
        <span aria-hidden="true">◎</span>
        <span className="locate-label">
          {status === "locating" ? "Locating…" : status === "ok" ? "My location" : "Location off"}
        </span>
      </button>
    </>
  );
}
