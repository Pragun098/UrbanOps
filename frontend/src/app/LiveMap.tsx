"use client";

/**
 * Leaflet map of real issues. Load with next/dynamic({ ssr: false }).
 *
 * - issues:  markers coloured by severity priority
 * - onPick:  if set, clicking the map picks a location (report form)
 * - picked:  the currently picked location, shown as a pin
 */

import { MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect } from "react";
import UserLocation, { type UserPosition } from "@/components/map/UserLocation";
import type { Issue } from "@/lib/api";
import { STATUS_LABEL, issuePlace, issueRef, issueTitle, priorityOf, timeAgo, type Priority } from "@/lib/format";

const BENGALURU: [number, number] = [12.9716, 77.5946];

const icons: Record<Priority, L.DivIcon> = {
  high: L.divIcon({ className: "civic-marker high", html: '<div class="pulse-ring"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
  medium: L.divIcon({ className: "civic-marker medium", html: "", iconSize: [14, 14], iconAnchor: [7, 7] }),
  low: L.divIcon({ className: "civic-marker low", html: "", iconSize: [14, 14], iconAnchor: [7, 7] }),
};

const pickIcon = L.divIcon({ className: "pick-marker", html: "", iconSize: [18, 18], iconAnchor: [9, 9] });

const SEVERITY_COLOR: Record<Priority, string> = {
  high: "#CC3333",
  medium: "#D97706",
  low: "#4A7C59",
};

function ClickToPick({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function FlyTo({ target }: { target: { lat: number; lng: number } | null | undefined }) {
  const map = useMap();
  // Key on rounded coordinates: GPS re-reports the same spot every few seconds and
  // we must not keep yanking the map back while the user pans.
  const key = target ? `${target.lat.toFixed(5)},${target.lng.toFixed(5)}` : "";
  useEffect(() => {
    if (!key) return;
    const [lat, lng] = key.split(",").map(Number);
    map.flyTo([lat, lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
  }, [map, key]);
  return null;
}

type Props = {
  issues: Issue[];
  onPick?: (lat: number, lng: number) => void;
  picked?: { lat: number; lng: number } | null;
  showLegend?: boolean;
  /** Centre on the user's position when it's first known (default: false = city overview). */
  centerOnUser?: boolean;
  onLocate?: (pos: UserPosition) => void;
};

export default function LiveMap({ issues, onPick, picked, showLegend = true, centerOnUser = false, onLocate }: Props) {
  return (
    // Height comes from CSS (.map-wrapper / .pick-map / .full-map); an inline 100%
    // would collapse to 0 inside containers without an explicit height.
    <div className="map-wrapper" style={{ position: "relative", width: "100%" }}>
      <MapContainer center={BENGALURU} zoom={13} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {onPick && <ClickToPick onPick={onPick} />}
        <FlyTo target={picked} />
        <UserLocation autoCenter={centerOnUser} onLocate={onLocate} />

        {picked && <Marker position={[picked.lat, picked.lng]} icon={pickIcon} />}

        {issues.map((issue) => {
          const [lng, lat] = issue.location.coordinates;
          const priority = priorityOf(issue.severityScore);
          return (
            <Marker key={issue._id} position={[lat, lng]} icon={icons[priority]}>
              <Popup>
                <div className="mono" style={{ fontSize: "12px", lineHeight: 1.6, minWidth: "190px" }}>
                  <strong>
                    [{issueRef(issue)}] {issueTitle(issue)}
                  </strong>
                  <br />
                  {issuePlace(issue)}
                  <br />
                  <span style={{ color: SEVERITY_COLOR[priority], fontWeight: 600 }}>
                    SEVERITY: {issue.severityScore} ({priority.toUpperCase()})
                  </span>
                  <br />
                  Status: {STATUS_LABEL[issue.status]}
                  {issue.assignedTo ? ` → ${issue.assignedTo.name}` : ""}
                  <br />
                  Reports: {issue.reportCount} · last {timeAgo(issue.lastReportedAt)}
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      {showLegend && (
        <>
          <div className="map-legend">
            <div className="legend-title">SEVERITY</div>
            <div className="legend-item">
              <span className="legend-marker high"></span>High (50+)
            </div>
            <div className="legend-item">
              <span className="legend-marker medium"></span>Medium (30–49)
            </div>
            <div className="legend-item">
              <span className="legend-marker low"></span>Low (&lt;30)
            </div>
          </div>

          <div className="map-counter">
            <strong>{issues.length}</strong>
            <span> active incidents</span>
          </div>
        </>
      )}
    </div>
  );
}
