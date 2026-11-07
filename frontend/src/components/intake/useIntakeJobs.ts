import { useEffect, useRef } from 'react';
import { ApiError, PollAborted, cancelExtractionJob, deleteReport, pollExtractionJob } from '../../api';

/**
 * The job and draft bookkeeping behind the intake wizard's cancel button: which job and draft the
 * current attempt owns, whether it was cancelled, and how to wait for / resume / forget a job.
 * Pure move out of IntakeFlow; the refs are returned as-is so the container's steps use them
 * exactly as before.
 */
export function useIntakeJobs() {
  // Cancel: set once the person presses it (or the screen goes away). Every step checks it, so a
  // step that is still in flight neither goes on to the next one nor shows an error.
  const cancelledRef = useRef(false);
  const abortRef = useRef<AbortController>(new AbortController());
  // The job the screen is waiting on, so Cancel can stop it.
  const jobIdRef = useRef<string | null>(null);
  // The draft report this attempt created, and whether Cancel (rather than leaving the screen) asked
  // for it to be removed.
  const draftIdRef = useRef<string | null>(null);
  const discardDraftRef = useRef(false);
  // Remove a draft, trying again a few times: a delete that arrives while the upload is still being
  // stored can be refused once. A draft that is already gone counts as removed.
  async function discardDraft(reportId: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await deleteReport(reportId);
        break;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) break;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    if (draftIdRef.current === reportId) draftIdRef.current = null;
  }
  useEffect(() => {
    cancelledRef.current = false;
    abortRef.current = new AbortController();
    return () => {
      cancelledRef.current = true;
      abortRef.current.abort();
    };
  }, []);

  // A job that was submitted but not seen to finish (the wait ran out). "Try again" goes back to
  // waiting for that same job rather than submitting a second one, which would read the scan twice.
  const submittedJobs = useRef(new Map<string, string>());
  async function submitOrResume(key: string, submit: () => Promise<{ id: string }>): Promise<{ id: string }> {
    const earlier = submittedJobs.current.get(key);
    if (earlier) return { id: earlier };
    const job = await submit();
    submittedJobs.current.set(key, job.id);
    return job;
  }
  function forgetJob(jobId: string) {
    for (const [key, id] of submittedJobs.current) if (id === jobId) submittedJobs.current.delete(key);
  }

  // Wait for a job, remembering which one so Cancel can stop it. Returns only if the screen was
  // not cancelled meanwhile; otherwise it throws and the step ends quietly (see attempt).
  async function pollJob(jobId: string, opts: { timeoutMs?: number } = {}) {
    if (cancelledRef.current) {
      // Cancel was pressed while this job was being submitted, before it could be stopped by id.
      void cancelExtractionJob(jobId).catch(() => undefined);
      throw new PollAborted();
    }
    jobIdRef.current = jobId;
    try {
      const job = await pollExtractionJob(jobId, { ...opts, signal: abortRef.current.signal });
      if (cancelledRef.current) throw new PollAborted();
      forgetJob(jobId); // it finished, one way or the other; the next attempt starts a new one
      return job;
    } catch (e) {
      // The job is gone (its report was deleted, say): waiting for it again would never end.
      if (e instanceof ApiError && e.status === 404) forgetJob(jobId);
      throw e;
    } finally {
      if (jobIdRef.current === jobId) jobIdRef.current = null;
    }
  }

  return {
    cancelledRef,
    abortRef,
    jobIdRef,
    draftIdRef,
    discardDraftRef,
    submittedJobs,
    discardDraft,
    submitOrResume,
    forgetJob,
    pollJob,
  };
}
