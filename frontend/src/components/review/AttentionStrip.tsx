/** The strip under the heading that lists the fields still needing a look, each a link to its field. */
export function AttentionStrip({
  flaggedCount,
  flaggedList,
  onGo,
}: {
  flaggedCount: number;
  flaggedList: { name: string; label: string }[];
  onGo: (name: string) => void;
}) {
  return (
    <div className="attention-strip" data-testid="attention-strip" role="status">
      <span className="attention-strip-count">
        {flaggedCount} field{flaggedCount === 1 ? '' : 's'} need{flaggedCount === 1 ? 's' : ''} attention
      </span>
      <span className="attention-strip-chips">
        {flaggedList.map((f) => (
          <button
            key={f.name}
            type="button"
            className="attention-chip"
            aria-label={`Go to ${f.label}`}
            onClick={() => onGo(f.name)}
          >
            {f.label}
          </button>
        ))}
      </span>
    </div>
  );
}
