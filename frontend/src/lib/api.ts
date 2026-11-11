/**
 * Typed client for the UrbanOps Express API.
 * The base URL comes from NEXT_PUBLIC_API_URL (see frontend/.env.example).
 */

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, "");

export type Role = "citizen" | "dispatcher" | "admin";
export type IssueStatus = "open" | "dispatched" | "resolved";
export type IssueCategory = "hazard" | "infra" | "minor";

export type User = {
  _id: string;
  name: string;
  email: string;
  role: Role;
  ward?: string;
};

export type StaffRef = { _id: string; name: string; email: string; role: Role };

export type Issue = {
  _id: string;
  category: IssueCategory;
  subcategory?: string;
  description?: string;
  address?: string;
  location: { type: "Point"; coordinates: [number, number] }; // [lng, lat]
  geohash: string;
  status: IssueStatus;
  duplicateCount: number;
  reportCount: number;
  severityScore: number;
  lastReportedAt: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
  assignedTo?: StaffRef | null;
  reporterIds?: unknown[];
  reportedByMe?: boolean;
};

export type Paged<T> = { success: true; data: T[]; page: number; limit: number; total: number };

export type Stats = {
  active: number;
  byStatus: Record<IssueStatus, number>;
  openByCategory: Record<IssueCategory, { count: number; avgSeverity: number }>;
  highPriority: number;
  assignedStaff: number;
  resolvedToday: number;
  avgResolutionHours: number | null;
  duplicatesMerged: number;
};

export type ReportResult = {
  success: true;
  merged: boolean;
  alreadyReported: boolean;
  message: string;
  issue: Issue;
};

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

let authToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export const setApiToken = (token: string | null) => {
  authToken = token;
};

/** Called when an authenticated request comes back 401 (expired/invalid token). */
export const onUnauthorized = (handler: (() => void) | null) => {
  unauthorizedHandler = handler;
};

type Options = { method?: string; body?: unknown; signal?: AbortSignal };

export async function api<T>(path: string, { method = "GET", body, signal }: Options = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/v1${path}`, {
      method,
      signal,
      headers: {
        ...(body !== undefined && { "Content-Type": "application/json" }),
        ...(authToken && { Authorization: `Bearer ${authToken}` }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, `Cannot reach the UrbanOps server at ${API_URL}. Is the backend running?`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && authToken && unauthorizedHandler) unauthorizedHandler();
    const message =
      (Array.isArray(data.details) && data.details.every((d: unknown) => typeof d === "string")
        ? data.details.join("; ")
        : data.error) || `Request failed (${res.status})`;
    throw new ApiError(res.status, message, data.details);
  }
  return data as T;
}

export const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : "Something went wrong";
