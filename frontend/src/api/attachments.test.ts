import { afterEach, expect, it, vi } from 'vitest';
import { PollAborted, pollExtractionJob } from './attachments';

afterEach(() => vi.unstubAllGlobals());

it('announces only status changes confirmed by the server', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ status: 'pending' }))
    .mockResolvedValueOnce(Response.json({ status: 'pending' }))
    .mockResolvedValueOnce(Response.json({ status: 'extracting' }))
    .mockResolvedValueOnce(Response.json({ status: 'extracting' }))
    .mockResolvedValueOnce(Response.json({ status: 'succeeded' }));
  vi.stubGlobal('fetch', fetch);
  const onStatusChange = vi.fn();

  await expect(pollExtractionJob('test-job', { intervalMs: 0, onStatusChange })).resolves.toMatchObject({ status: 'succeeded' });
  expect(onStatusChange.mock.calls).toEqual([['pending'], ['extracting'], ['succeeded']]);
  expect(fetch).toHaveBeenCalledTimes(5);
});

it('can finish on the first poll without implying an observed queued or working state', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status: 'failed', error_message: 'Stopped' })));
  const onStatusChange = vi.fn();

  await expect(pollExtractionJob('test-job', { onStatusChange })).resolves.toMatchObject({ status: 'failed' });
  expect(onStatusChange.mock.calls).toEqual([['failed']]);
});

it('does not emit a response received after the user stops waiting', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async () => {
    controller.abort();
    return Response.json({ status: 'extracting' });
  }));
  const onStatusChange = vi.fn();

  await expect(pollExtractionJob('test-job', { signal: controller.signal, onStatusChange })).rejects.toBeInstanceOf(PollAborted);
  expect(onStatusChange).not.toHaveBeenCalled();
});
