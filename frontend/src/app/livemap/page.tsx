"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, errorMessage, type Issue, type Paged } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { COVERAGE_BBOX, useIssueStream, type IssueEvent } from "@/lib/socket";
import { upsertBySeverity } from "@/lib/format";

const LiveMap = dynamic(() => import("../LiveMap"), { ssr: false });

export default function LiveMapPage() {
  return (
    <AppShell title="Live map" roles={["dispatcher", "admin"]}>
      <FullMap />
    </AppShell>
  );
}

function FullMap() {
  const { token } = useAuth();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<Paged<Issue>>("/issues?limit=500", { signal: controller.signal })
      .then((res) => setIssues(res.data))
      .catch((err) => {
        if (err.name !== "AbortError") setError(errorMessage(err));
      });
    return () => controller.abort();
  }, []);

  const handleEvent = useCallback((event: IssueEvent) => {
    setIssues((list) =>
      event.issue.status === "resolved"
        ? list.filter((i) => i._id !== event.issue._id)
        : upsertBySeverity(list, event.issue)
    );
  }, []);
  const live = useIssueStream(token, handleEvent, COVERAGE_BBOX);

  return (
    <>
      <div className="board-toolbar">
        <span className="mono muted">Open and dispatched issues. Click a marker for details.</span>
        <span className={`live-badge ${live ? "on" : ""}`}>
          <span className="live-dot" /> {live ? "LIVE" : "OFFLINE"}
        </span>
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="panel full-map">
        <LiveMap issues={issues} />
      </div>
    </>
  );
}
