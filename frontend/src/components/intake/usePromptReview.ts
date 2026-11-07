import { useEffect, useState } from 'react';
import { setPromptApprovalHandler, type PromptPreview } from '../../api';

/** VIEW_PROMPTS (debug): the prompt waiting for Send/Cancel, and how to answer it. */
export function usePromptReview() {
  const [promptReview, setPromptReview] = useState<{ preview: PromptPreview; answer: (send: boolean) => void } | null>(null);
  useEffect(() => {
    setPromptApprovalHandler(
      (preview) => new Promise<boolean>((resolve) => {
        setPromptReview({
          preview,
          answer: (send) => {
            setPromptReview(null);
            resolve(send);
          },
        });
      })
    );
    return () => setPromptApprovalHandler(null);
  }, []);
  return promptReview;
}
