"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, errorMessage, type Issue, type Paged } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useIssueStream, type IssueEvent } from "@/lib/socket";
import { STATUS_LABEL, issuePlace, issueRef, issueTitle, priorityOf, timeAgo } from "@/lib/format";

const STEPS = ["open", "dispatched", "resolved"] as const;

export default function MyReportsPage() {
  return (
    <AppShell
      title="My reports"
      actions={
        <Link href="/report" className="report-button">
          [+] Report issue
        </Link>
      }
    >
      <MyReports />
    </AppShell>
  );
}

function MyReports() {
  const { token } = useAuth();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<Paged<Issue>>("/issues/mine?limit=100", { signal: controller.signal })
      .then((res) => setIssues(res.data))
      .catch((err) => {
        if (err.name !== "AbortError") setError(errorMessage(err));
      });
    return () => controller.abort();
  }, []);

  // Status changes by dispatchers arrive live on the citizen's personal channel.
  const handleEvent = useCallback((event: IssueEvent) => {
    setIssues((list) => list && list.map((i) => (i._id === event.issue._id ? { ...event.issue, reportedByMe: true } : i)));
    setChanged(event.issue._id);
    setTimeout(() => setChanged(null), 2500);
  }, []);
  const live = useIssueStream(token, handleEvent);

  return (
    <>
      <div className="board-toolbar">
        <span className="mono muted">Issues you reported. Status updates appear here automatically.</span>
        <span className={`live-badge ${live ? "on" : ""}`}>
          <span className="live-dot" /> {live ? "LIVE" : "OFFLINE"}
        </span>
      </div>
      {error && <div className="alert error">{error}</div>}

      {issues && issues.length === 0 && (
        <div className="panel empty-state large">
          You haven&apos;t reported anything yet. <Link href="/report">Report an issue</Link>.
        </div>
      )}

      <div className="my-reports">
        {issues?.map((issue) => {
          const priority = priorityOf(issue.severityScore);
          const stepIndex = STEPS.indexOf(issue.status);
          return (
            <article key={issue._id} className={`panel my-report ${changed === issue._id ? "flash" : ""}`}>
              <div className="my-report-head">
                <div>
                  <div className="incident-title">{issueTitle(issue)}</div>
                  <div className="incident-location">
                    {issueRef(issue)} · {issuePlace(issue)}
                  </div>
                </div>
                <span className={`severity-text ${priority} mono`}>severity {issue.severityScore}</span>
              </div>

              <ol className="progress">
                {STEPS.map((step, i) => (
                  <li key={step} className={i <= stepIndex ? "done" : ""}>
                    {STATUS_LABEL[step]}
                  </li>
                ))}
              </ol>

              <div className="mono muted small">
                {issue.reportCount > 1
                  ? `${issue.reportCount} people reported this`
                  : "You're the only reporter so far"}{" "}
                · updated {timeAgo(issue.updatedAt)}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
