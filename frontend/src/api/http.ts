// Not set: the local backend. Set to an empty string: the same address the page
// came from (the deployed image serves the built page and the API together).
const CONFIGURED_API_BASE = import.meta.env.VITE_API_BASE_URL as string | undefined;
export const API_BASE = CONFIGURED_API_BASE === undefined ? 'http://localhost:8000' : CONFIGURED_API_BASE.replace(/\/+$/, '');

// ---------- Fetch plumbing ----------

export class ApiError extends Error {
  status: number;
  /** Set when an upload is refused because the exact file is already on file under a read report. */
  existingReportId?: string;
  constructor(status: number, message: string, existingReportId?: string) {
    super(message);
    this.status = status;
    this.existingReportId = existingReportId;
    this.name = 'ApiError';
  }
}

/** Like apiFetch, but also gives back the response headers (a paged list's X-Total-Count). */
export async function apiFetchWithHeaders<T>(path: string, init?: RequestInit): Promise<{ data: T; headers: Headers }> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: init?.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    // The backend hardening work (classification.py/extraction.py) added
    // ClassificationError/ExtractionError for the API's own failures — this
    // catches the layer below that: the request never reached the backend
    // at all (server not running, wrong VITE_API_BASE_URL, CORS/network).
    throw new ApiError(0, `Could not reach the backend at ${API_BASE || 'this address'}. Is it running (uvicorn app.main:app), and is VITE_API_BASE_URL correct?`);
  }

  if (!response.ok) {
    // statusText is empty over HTTP/2, so it can't be the only fallback.
    let detail = response.statusText || `Request failed (${response.status})`;
    let existingReportId: string | undefined;
    try {
      const body = await response.json();
      if (typeof body?.existing_report_id === 'string') existingReportId = body.existing_report_id;
      if (typeof body?.detail === 'string') {
        detail = body.detail;
      } else if (Array.isArray(body?.detail) && body.detail.length > 0) {
        // FastAPI's request-validation 422s send `detail` as a list of
        // {loc, msg, ...} entries, not a string — e.g. the template editor
        // saving an enum field with no options, or two fields with the same
        // name. Ignoring the list left the user with a bare "Unprocessable
        // Content" instead of the reason. Pydantic prefixes errors raised
        // from a validator with "Value error, "; drop it so the message
        // reads as written in schemas.py.
        detail = body.detail
          .map((d: { msg?: unknown }) => (typeof d?.msg === 'string' ? d.msg.replace(/^Value error, /, '') : null))
          .filter(Boolean)
          .join('; ') || detail;
      }
    } catch {
      // non-JSON error body — keep the fallback above
    }
    throw new ApiError(response.status, detail, existingReportId);
  }

  if (response.status === 204) return { data: undefined as T, headers: response.headers };
  return { data: (await response.json()) as T, headers: response.headers };
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return (await apiFetchWithHeaders<T>(path, init)).data;
}
