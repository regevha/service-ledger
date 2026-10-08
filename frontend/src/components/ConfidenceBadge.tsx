// A tiny shared component — used by IntakeFlow.tsx (both the
// classification-confirmation step and, via ReviewScreen, the field review
// step) and by ReviewScreen.tsx directly when a report's still-live
// extraction confidences are available. Pulled into its own file, the same
// way labels.ts pulls out label maps, so those call sites don't have to
// import it from one another.
//
// A percentage is only shown where a model produced it. Without an API key the
// numbers are fixed constants or hash-derived placeholders, not measurements,
// so the badge says what actually happened instead (`label`). The colour still
// follows the threshold, so a "not found" value is still flagged for review.
export function ConfidenceBadge({
  confidence,
  threshold,
  label,
}: {
  confidence: number;
  threshold: number;
  label?: string;
}) {
  const pct = Math.round(confidence * 100);
  const ok = confidence >= threshold;
  return (
    <span className={`badge ${ok ? 'badge-good' : 'badge-warn'}`}>
      {label ?? `${pct}% ${ok ? 'confident' : 'needs review'}`}
    </span>
  );
}

type Reader = 'model' | 'text_layer' | 'stub' | undefined;

// The wording for a classification badge. `fromTaskCode` is true when the
// report type came from the form's task code rather than a guess.
export function classificationLabel(reader: Reader, confidence: number, fromTaskCode = false): string | undefined {
  if (reader === 'text_layer') {
    if (confidence <= 0) return 'not found';
    return fromTaskCode ? 'from task code' : 'read from document text';
  }
  if (reader === 'stub') return 'demo value';
  return undefined;
}
