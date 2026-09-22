// A tiny shared component — used by IntakeFlow.tsx (both the
// classification-confirmation step and, via ReviewScreen, the field review
// step) and by ReviewScreen.tsx directly when a report's still-live
// extraction confidences are available. Pulled into its own file, the same
// way labels.ts pulls out label maps, so those call sites don't have to
// import it from one another.
export function ConfidenceBadge({ confidence, threshold }: { confidence: number; threshold: number }) {
  const pct = Math.round(confidence * 100);
  const ok = confidence >= threshold;
  return <span className={`badge ${ok ? 'badge-good' : 'badge-warn'}`}>{pct}% {ok ? 'confident' : 'needs review'}</span>;
}
