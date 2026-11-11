"use client";

/**
 * Live issue stream over Socket.io.
 *
 * Staff pass a bbox (their coverage area); the server joins them to the geohash
 * rooms covering it and only pushes events for issues inside. Citizens pass no
 * bbox and receive updates for issues they reported.
 */

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_URL, type Issue } from "./api";

export type IssueEvent =
  | { type: "created"; issue: Issue }
  | { type: "updated"; issue: Issue; reason: string };

/** Default dispatcher coverage area: Bengaluru. Override with NEXT_PUBLIC_COVERAGE_BBOX. */
export const COVERAGE_BBOX: [number, number, number, number] = (() => {
  const parts = (process.env.NEXT_PUBLIC_COVERAGE_BBOX || "").split(",").map(Number);
  return parts.length === 4 && parts.every(Number.isFinite)
    ? (parts as [number, number, number, number])
    : [77.45, 12.85, 77.8, 13.1];
})();

export function useIssueStream(
  token: string | null,
  onEvent: (event: IssueEvent) => void,
  bbox?: [number, number, number, number]
) {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onEvent);

  useEffect(() => {
    handlerRef.current = onEvent;
  });

  const bboxKey = bbox?.join(",");

  useEffect(() => {
    if (!token) return undefined;

    const socket: Socket = io(API_URL, { auth: { token }, transports: ["websocket"] });

    socket.on("connect", () => {
      setConnected(true);
      // (Re)subscribe on every connect, so rooms survive a reconnect.
      if (bboxKey) socket.emit("subscribe", { bbox: bboxKey.split(",").map(Number) });
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));

    socket.on("issue:created", (issue: Issue) => handlerRef.current({ type: "created", issue }));
    socket.on("issue:updated", (payload: { issue: Issue; reason: string }) =>
      handlerRef.current({ type: "updated", issue: payload.issue, reason: payload.reason })
    );

    return () => {
      socket.disconnect();
    };
  }, [token, bboxKey]);

  return connected;
}
