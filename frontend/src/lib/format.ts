import type { Issue, IssueStatus } from "./api";

export type Priority = "high" | "medium" | "low";

/** Severity score → display priority. Hazards start at 50, infra 30, minor 10. */
export const priorityOf = (score: number): Priority => (score >= 50 ? "high" : score >= 30 ? "medium" : "low");

export const STATUS_LABEL: Record<IssueStatus, string> = {
  open: "Open",
  dispatched: "Dispatched",
  resolved: "Resolved",
};

export const issueTitle = (issue: Issue) =>
  issue.subcategory || issue.category.charAt(0).toUpperCase() + issue.category.slice(1);

export const issueRef = (issue: Issue) => `INC-${issue._id.slice(-5).toUpperCase()}`;

export const issuePlace = (issue: Issue) => {
  const [lng, lat] = issue.location.coordinates;
  return issue.address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
};

export const timeAgo = (iso: string) => {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

/** Report form options. Labels match the backend's subcategory → category map. */
export const REPORT_TYPES = [
  { label: "Road hazard", hint: "hazard" },
  { label: "Water leak", hint: "hazard" },
  { label: "Fallen tree", hint: "hazard" },
  { label: "Pothole", hint: "infrastructure" },
  { label: "Street light", hint: "infrastructure" },
  { label: "Broken sidewalk", hint: "infrastructure" },
  { label: "Garbage", hint: "minor" },
  { label: "Graffiti", hint: "minor" },
  { label: "Other", hint: "minor" },
] as const;

/** Insert or replace an issue in a list, then sort by severity (highest first). */
export const upsertBySeverity = (list: Issue[], issue: Issue) => {
  const next = list.filter((i) => i._id !== issue._id);
  next.push(issue);
  return next.sort((a, b) => b.severityScore - a.severityScore);
};
