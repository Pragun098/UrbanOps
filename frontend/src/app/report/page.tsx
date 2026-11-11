"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { FormEvent, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, errorMessage, type ReportResult } from "@/lib/api";
import { REPORT_TYPES, issueRef } from "@/lib/format";

const LiveMap = dynamic(() => import("../LiveMap"), { ssr: false });

type Point = { lat: number; lng: number };

export default function ReportPage() {
  return (
    <AppShell title="Report an issue">
      <ReportForm />
    </AppShell>
  );
}

function ReportForm() {
  const [point, setPoint] = useState<Point | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReportResult | null>(null);

  function locateMe() {
    if (!("geolocation" in navigator)) {
      setError("Your browser can't share its location. Click the map instead.");
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission was denied. Click the map to place the pin instead."
            : "Couldn't get your location. Click the map to place the pin instead."
        );
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!point) {
      setError("Pick the location: use your current location or click on the map.");
      return;
    }
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    setBusy(true);
    setError(null);
    try {
      const res = await api<ReportResult>("/issues", {
        method: "POST",
        body: {
          subcategory: form.get("category"),
          address: String(form.get("address") || "").trim() || undefined,
          description: String(form.get("description") || "").trim() || undefined,
          location: point,
        },
      });
      setResult(res);
      formEl.reset();
      setPoint(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="success-message">
        <div className="success-icon">✓</div>
        <p className="eyebrow">{result.merged ? "ADDED TO AN EXISTING ISSUE" : "NEW ISSUE CREATED"}</p>
        <h1>Thanks — your report was received.</h1>
        <p>{result.message}</p>
        <p className="mono">
          {issueRef(result.issue)} · {result.issue.reportCount} report{result.issue.reportCount === 1 ? "" : "s"} · severity{" "}
          {result.issue.severityScore}
        </p>
        <div className="success-actions">
          <Link href="/my-reports" className="submit-button">
            Track my reports
          </Link>
          <button className="location-button" onClick={() => setResult(null)}>
            Submit another report
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="report-layout">
      <form className="report-form" onSubmit={handleSubmit}>
        {error && <div className="alert error">{error}</div>}

        <div className="form-group">
          <label htmlFor="category">What is the issue?</label>
          <select id="category" name="category" required defaultValue="">
            <option value="" disabled>
              Select an issue
            </option>
            {REPORT_TYPES.map((t) => (
              <option key={t.label} value={t.label}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Location</label>
          <div className={`location-readout mono ${point ? "set" : ""}`}>
            {point ? `📍 ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` : "No location yet. Click the map or use your location."}
          </div>
          <button type="button" className="location-button" onClick={locateMe} disabled={locating}>
            {locating ? "Locating…" : "Use my current location"}
          </button>
        </div>

        <div className="form-group">
          <label htmlFor="address">Street / landmark (optional)</label>
          <input id="address" name="address" type="text" maxLength={200} placeholder="e.g. MG Road, near metro pillar 42" />
        </div>

        <div className="form-group">
          <label htmlFor="description">What did you notice?</label>
          <textarea id="description" name="description" rows={4} maxLength={2000} placeholder="Briefly describe the problem…" />
        </div>

        <p className="field-hint">
          If someone already reported the same kind of issue within 100m, your report is added to theirs, which raises its
          priority.
        </p>

        <button type="submit" className="submit-button" disabled={busy}>
          {busy ? "Submitting…" : "Submit report"}
        </button>
      </form>

      <section className="panel pick-map">
        <header className="panel-header">
          <h2 className="panel-title">Click the map to place the pin</h2>
        </header>
        <LiveMap issues={[]} onPick={(lat, lng) => setPoint({ lat, lng })} picked={point} showLegend={false} />
      </section>
    </div>
  );
}
