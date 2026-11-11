"use client";

/**
 * Live issue stream over Socket.io.
 *
 * Staff pass a bbox (coverage area or the visible map area); the server joins
 * them to the geohash rooms covering it and only pushes events for issues inside.
 * Changing the bbox re-subscribes on the SAME connection (no reconnect).
 * Citizens pass no bbox and receive updates for issues they reported.
 */

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_URL, type Issue } from "./api";

export type IssueEvent =
  | { type: "created"; issue: Issue }
  | { type: "updated"; issue: Issue; reason: string };

export type Bbox = [number, number, number, number]; // minLng, minLat, maxLng, maxLat

/** Default dispatcher coverage area: Bengaluru. Override with NEXT_PUBLIC_COVERAGE_BBOX. */
export const COVERAGE_BBOX: Bbox = (() => {
  const parts = (process.env.NEXT_PUBLIC_COVERAGE_BBOX || "").split(",").map(Number);
  return parts.length === 4 && parts.every(Number.isFinite) ? (parts as Bbox) : [77.45, 12.85, 77.8, 13.1];
})();

export type StreamState = {
  connected: boolean;
  /** null = no area requested; otherwise whether the server accepted the area. */
  subscription: { ok: true; rooms: number } | { ok: false; error: string } | null;
};

export function useIssueStream(token: string | null, onEvent: (event: IssueEvent) => void, bbox?: Bbox | null) {
  const [connected, setConnected] = useState(false);
  const [subscription, setSubscription] = useState<StreamState["subscription"]>(null);
  const socketRef = useRef<Socket | null>(null);
  const handlerRef = useRef(onEvent);

  useEffect(() => {
    handlerRef.current = onEvent;
  });

  // One connection per token.
  useEffect(() => {
    if (!token) return undefined;
    const s: Socket = io(API_URL, { auth: { token }, transports: ["websocket"] });
    socketRef.current = s;

    s.on("connect", () => setConnected(true));
    s.on("disconnect", () => setConnected(false));
    s.on("connect_error", () => setConnected(false));
    s.on("issue:created", (issue: Issue) => handlerRef.current({ type: "created", issue }));
    s.on("issue:updated", (payload: { issue: Issue; reason: string }) =>
      handlerRef.current({ type: "updated", issue: payload.issue, reason: payload.reason })
    );

    return () => {
      s.disconnect();
      socketRef.current = null;
    };
  }, [token]);

  const bboxKey = bbox ? bbox.map((n) => n.toFixed(4)).join(",") : "";

  // (Re)subscribe whenever the area changes or the connection is (re)established.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !connected || !bboxKey) return;
    socket.emit(
      "subscribe",
      { bbox: bboxKey.split(",").map(Number) },
      (ack: { ok: boolean; rooms?: number; error?: string }) =>
        setSubscription(ack.ok ? { ok: true, rooms: ack.rooms ?? 0 } : { ok: false, error: ack.error || "Subscription failed" })
    );
  }, [connected, bboxKey]);

  return { connected, subscription: bboxKey ? subscription : null };
}
