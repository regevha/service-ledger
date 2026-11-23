import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './http';

function respond(status: number, body: string, contentType = 'text/html') {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': contentType } })));
}

afterEach(() => vi.unstubAllGlobals());

describe('apiFetch when the backend is stopped', () => {
  it('reports an ingress 404 (non-JSON body) as unreachable, status 0', async () => {
    respond(404, '<html>not found</html>');
    const err = await apiFetch('/reports').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Could not reach the backend/);
  });

  it('reports 502/503/504 as unreachable', async () => {
    for (const status of [502, 503, 504]) {
      respond(status, 'upstream down');
      const err = await apiFetch('/reports').catch((e) => e);
      expect(err.status).toBe(0);
    }
  });

  it('keeps a real API 404 (JSON body) as a 404 with its detail', async () => {
    respond(404, JSON.stringify({ detail: 'Report not found' }), 'application/json');
    const err = await apiFetch('/reports/x').catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.message).toBe('Report not found');
  });
});
