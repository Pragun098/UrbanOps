"use client";

/**
 * Dispatcher ops map: clustered markers, click-to-select, and viewport reporting
 * so the page can load + subscribe only to the visible area.
 * Client-only: load with next/dynamic({ ssr: false }).
 */

import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import L from "@/lib/leaflet";
import "leaflet.markercluster";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import UserLocation from "@/components/map/UserLocation";
import type { Issue } from "@/lib/api";
import type { Bbox } from "@/lib/socket";
import { issueTitle, priorityOf, type Priority } from "@/lib/format";

const BENGALURU: [number, number] = [12.9716, 77.5946];
const PRIORITY_RANK: Record<Priority, number> = { low: 0, medium: 1, high: 2 };

const markerIcon = (priority: Priority, selected: boolean) =>
  L.divIcon({
    className: `civic-marker ${priority}${selected ? " selected" : ""}`,
    html: priority === "high" ? '<div class="pulse-ring"></div>' : "",
    iconSize: selected ? [20, 20] : [14, 14],
    iconAnchor: selected ? [10, 10] : [7, 7],
  });

type PriorityMarker = L.Marker & { options: L.MarkerOptions & { priority: Priority } };

// Cluster badge coloured by the most severe issue inside it.
const clusterIcon = (cluster: L.MarkerCluster) => {
  const children = cluster.getAllChildMarkers() as PriorityMarker[];
  const worst = children.reduce<Priority>(
    (acc, m) => (PRIORITY_RANK[m.options.priority] > PRIORITY_RANK[acc] ? m.options.priority : acc),
    "low"
  );
  const count = cluster.getChildCount();
  const size = count < 10 ? 30 : count < 100 ? 36 : 44;
  return L.divIcon({
    html: `<span>${count}</span>`,
    className: `civic-cluster ${worst}`,
    iconSize: [size, size],
  });
};

function ClusterLayer({
  issues,
  selectedId,
  onSelect,
}: {
  issues: Issue[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const map = useMap();
  const groupRef = useRef<L.MarkerClusterGroup | null>(null);
  const markersRef = useRef(new Map<string, { marker: PriorityMarker; sig: string }>());
  const onSelectRef = useRef(onSelect);

  useEffect(() => {
    onSelectRef.current = onSelect;
  });

  useEffect(() => {
    const group = L.markerClusterGroup({
      iconCreateFunction: clusterIcon,
      showCoverageOnHover: false,
      maxClusterRadius: 45,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 17,
      chunkedLoading: true,
    });
    map.addLayer(group);
    groupRef.current = group;
    const markers = markersRef.current;
    return () => {
      map.removeLayer(group);
      groupRef.current = null;
      markers.clear();
    };
  }, [map]);

  // Diff markers by id instead of rebuilding the whole layer on every update.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const markers = markersRef.current;
    const seen = new Set<string>();
    const toAdd: L.Marker[] = [];

    for (const issue of issues) {
      seen.add(issue._id);
      const [lng, lat] = issue.location.coordinates;
      const priority = priorityOf(issue.severityScore);
      const selected = issue._id === selectedId;
      const sig = `${lat},${lng},${priority},${selected},${issueTitle(issue)}`;
      const existing = markers.get(issue._id);

      if (existing && existing.sig === sig) continue;
      if (existing) {
        group.removeLayer(existing.marker);
        markers.delete(issue._id);
      }

      const marker = L.marker([lat, lng], {
        icon: markerIcon(priority, selected),
        zIndexOffset: selected ? 1000 : PRIORITY_RANK[priority] * 100,
        keyboard: true,
        title: issueTitle(issue),
      }) as PriorityMarker;
      marker.options.priority = priority;
      marker.bindTooltip(`${issueTitle(issue)} · ${issue.severityScore}`, { direction: "top", offset: [0, -8] });
      marker.on("click", () => onSelectRef.current(issue._id));
      markers.set(issue._id, { marker, sig });
      toAdd.push(marker);
    }

    for (const [id, { marker }] of markers) {
      if (!seen.has(id)) {
        group.removeLayer(marker);
        markers.delete(id);
      }
    }
    if (toAdd.length) group.addLayers(toAdd);
  }, [issues, selectedId]);

  return null;
}

/** Reports the visible bbox on load and after every pan/zoom. */
function ViewportWatcher({
  onViewChange,
  onBackgroundClick,
}: {
  onViewChange: (bbox: Bbox, zoom: number) => void;
  onBackgroundClick: () => void;
}) {
  const report = (map: L.Map) => {
    const b = map.getBounds();
    onViewChange([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], map.getZoom());
  };
  const map = useMapEvents({
    moveend: () => report(map),
    click: () => onBackgroundClick(), // marker clicks don't bubble to the map
  });
  useEffect(() => {
    report(map);
    // run once with the initial view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);
  return null;
}

function FlyToSelected({ issue }: { issue: Issue | null }) {
  const map = useMap();
  const id = issue?._id;
  useEffect(() => {
    if (!issue) return;
    const [lng, lat] = issue.location.coordinates;
    if (!map.getBounds().pad(-0.2).contains([lat, lng])) {
      map.panTo([lat, lng], { animate: true });
    }
    // Only when a different issue is selected, not on every live update of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, id]);
  return null;
}

type Props = {
  issues: Issue[];
  selected: Issue | null;
  onSelect: (id: string | null) => void;
  onViewChange: (bbox: Bbox, zoom: number) => void;
};

export default function OpsMap({ issues, selected, onSelect, onViewChange }: Props) {
  return (
    <div className="map-wrapper ops-map">
      <MapContainer center={BENGALURU} zoom={13} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ClusterLayer issues={issues} selectedId={selected?._id ?? null} onSelect={onSelect} />
        <ViewportWatcher onViewChange={onViewChange} onBackgroundClick={() => onSelect(null)} />
        <FlyToSelected issue={selected} />
        <UserLocation autoCenter />
      </MapContainer>

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
        <div className="legend-note">Numbered squares = clusters, coloured by their most severe issue</div>
      </div>
    </div>
  );
}
