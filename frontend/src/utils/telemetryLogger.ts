/**
 * UrbanOps Client Telemetry Logger
 * 
 * Asynchronous, non-blocking utility for dispatching operational logs and client telemetry
 * to the UrbanOps ingestion pipeline. Fail-safe error handling ensures UI interactions
 * and client flows are never interrupted if logging fails.
 */

// Resolves backend API endpoint from environment or defaults to local Express server
const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== 'undefined' ? window.location.origin.replace(/:\d+$/, ':5000') : 'http://localhost:5000');

const TELEMETRY_ENDPOINT = `${API_BASE_URL}/api/v1/telemetry/ingest`;

/**
 * Dispatches client telemetry event asynchronously without blocking UI interactions.
 * 
 * @param eventType - Nature of event (e.g. 'USER_ACTION_DISPATCHED', 'REPORT_FORM_OPENED')
 * @param payloadData - Flexible JSON-serializable object payload
 * @param source - Origin of the event payload (default: 'urbanops-web-frontend')
 * @returns Promise that resolves to boolean (true if queued/dispatched, false on error)
 */
export async function logUrbanOpsTelemetry(
  eventType: string,
  payloadData: unknown,
  source: string = 'urbanops-web-frontend'
): Promise<boolean> {
  // Fail-safe wrapper: Never throw errors to the caller
  try {
    if (!eventType || typeof eventType !== 'string') {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[Telemetry] Skipped dispatch: Missing or invalid eventType');
      }
      return false;
    }

    const payload = {
      source,
      eventType,
      payload: payloadData ?? {},
    };

    // Prefer navigator.sendBeacon when available in browser environment for non-blocking beaconing
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        const queued = navigator.sendBeacon(TELEMETRY_ENDPOINT, blob);
        if (queued) {
          return true;
        }
      } catch {
        // Fallback to fetch if sendBeacon encounters payload limits or restrictions
      }
    }

    // Fallback to asynchronous fetch with keepalive
    if (typeof fetch !== 'undefined') {
      fetch(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        keepalive: true, // Allows request to outlive the page lifecycle
      }).catch((fetchErr) => {
        if (process.env.NODE_ENV === 'development') {
          console.debug('[Telemetry] Background dispatch error (suppressed):', fetchErr);
        }
      });

      return true;
    }

    return false;
  } catch (err) {
    // Fail-safe: Prevent any exception from bubbling up to the user application
    if (process.env.NODE_ENV === 'development') {
      console.debug('[Telemetry] Dispatch fail-safe caught error:', err);
    }
    return false;
  }
}
