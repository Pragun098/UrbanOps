"use client";

/**
 * App-wide user location.
 *
 * Starts watching the browser's position as soon as the site opens (the browser
 * asks for permission once), so every map can centre on the user and the sidebar
 * can show where they are. One watchPosition for the whole app.
 *
 * The place name comes from OpenStreetMap Nominatim reverse geocoding. It is only
 * re-requested after the user moves more than REGEOCODE_METERS, to respect
 * Nominatim's usage policy (max ~1 request/second, no bulk use).
 *
 * Geolocation only works on secure origins: http://localhost, or https in production.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export type UserPosition = { lat: number; lng: number; accuracy: number };
export type LocationStatus = "locating" | "ok" | "denied" | "unavailable" | "unsupported";

type LocationContextValue = {
  status: LocationStatus;
  position: UserPosition | null;
  /** Human-readable place, e.g. "MG Road, Bengaluru". null until resolved. */
  place: string | null;
  /** Ask again (e.g. after the user re-enables permission). */
  refresh: () => void;
};

const LocationContext = createContext<LocationContextValue | null>(null);

const REGEOCODE_METERS = 150;

const distanceMeters = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

type NominatimAddress = Record<string, string | undefined>;

const formatPlace = (address: NominatimAddress | undefined, fallback?: string) => {
  if (!address) return fallback?.split(",").slice(0, 2).join(",").trim() || null;
  const local = address.road || address.neighbourhood || address.suburb || address.quarter || address.village;
  const area = address.suburb && address.suburb !== local ? address.suburb : undefined;
  const city = address.city || address.town || address.county || address.state_district || address.state;
  return [local, area, city].filter(Boolean).slice(0, 3).join(", ") || fallback || null;
};

const reverseGeocode = async (lat: number, lng: number, signal: AbortSignal) => {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&addressdetails=1&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, { signal, headers: { "Accept-Language": "en" } });
  if (!res.ok) throw new Error(`Reverse geocoding failed (${res.status})`);
  const data = (await res.json()) as { address?: NominatimAddress; display_name?: string };
  return formatPlace(data.address, data.display_name);
};

export function LocationProvider({ children }: { children: React.ReactNode }) {
  const supported = typeof navigator !== "undefined" && "geolocation" in navigator;
  // Same initial value on server and client (avoids a hydration mismatch).
  const [status, setStatus] = useState<LocationStatus>("locating");
  const [position, setPosition] = useState<UserPosition | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const geocodedAt = useRef<{ lat: number; lng: number } | null>(null);
  const geocodeAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!supported) {
      Promise.resolve().then(() => setStatus("unsupported"));
      return undefined;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setPosition({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });
        setStatus("ok");
      },
      (err) => setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [supported, attempt]);

  // Resolve a place name, but only when the user has moved meaningfully.
  useEffect(() => {
    if (!position) return;
    if (geocodedAt.current && distanceMeters(geocodedAt.current, position) < REGEOCODE_METERS) return;
    geocodedAt.current = { lat: position.lat, lng: position.lng };
    geocodeAbort.current?.abort();
    const controller = new AbortController();
    geocodeAbort.current = controller;
    reverseGeocode(position.lat, position.lng, controller.signal)
      .then((name) => setPlace(name))
      .catch(() => {
        /* offline or rate-limited: keep showing coordinates */
      });
  }, [position]);

  useEffect(() => () => geocodeAbort.current?.abort(), []);

  const refresh = useCallback(() => {
    if (!supported) return;
    setStatus("locating");
    setAttempt((n) => n + 1);
  }, [supported]);

  const value = useMemo(() => ({ status, position, place, refresh }), [status, position, place, refresh]);
  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

export function useUserLocation() {
  const ctx = useContext(LocationContext);
  if (!ctx) throw new Error("useUserLocation must be used inside <LocationProvider>");
  return ctx;
}
