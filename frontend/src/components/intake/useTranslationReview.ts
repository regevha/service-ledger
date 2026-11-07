import { useState } from 'react';
import { ApiError, acceptTranslation, discardTranslation, type Report, type Translation } from '../../api';

/**
 * The Hebrew translation waiting for review, and the two ways out of it (accept, with or without
 * edits, or discard). Both go on to classify the same document, so the container hands in the
 * pieces they need.
 */
export function useTranslationReview({
  attachmentId,
  report,
  failPhase,
  runClassification,
}: {
  attachmentId: string | null;
  report: Report | null;
  failPhase: (message: string, retry: () => void) => void;
  runClassification: (attId: string, reportId: string) => Promise<void>;
}) {
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [translationBusy, setTranslationBusy] = useState(false);

  async function handleAcceptTranslation(editedText: string | undefined) {
    if (!translation || !attachmentId || !report) return;
    setTranslationBusy(true);
    try {
      await acceptTranslation(translation.id, editedText);
    } catch (e) {
      setTranslationBusy(false);
      failPhase(e instanceof ApiError ? e.message : 'Could not accept the translation.', () => void handleAcceptTranslation(editedText));
      return;
    }
    setTranslationBusy(false);
    await runClassification(attachmentId, report.id);
  }

  async function handleDiscardTranslation() {
    if (!translation || !attachmentId || !report) return;
    setTranslationBusy(true);
    try {
      await discardTranslation(translation.id);
    } catch (e) {
      setTranslationBusy(false);
      failPhase(e instanceof ApiError ? e.message : 'Could not discard the translation.', () => void handleDiscardTranslation());
      return;
    }
    setTranslationBusy(false);
    setTranslation(null);
    await runClassification(attachmentId, report.id);
  }

  return { translation, setTranslation, translationBusy, handleAcceptTranslation, handleDiscardTranslation };
}
