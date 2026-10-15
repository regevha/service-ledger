import { highlightPieces, type SearchableSegment } from '../searchHighlight';

// Shown above a report's fields when it was opened from search results: every
// searchable text (text fields, table text cells, instrument model and serial)
// that contains the searched words, with the words highlighted. The fields
// below stay ordinary editable inputs, which cannot show highlights themselves.
export function SearchMatches({
  query,
  segments,
  onClear,
}: {
  query: string;
  segments: SearchableSegment[];
  onClear: () => void;
}) {
  const matching = segments
    .map((segment) => ({ segment, pieces: highlightPieces(segment.text, query) }))
    .filter(({ pieces }) => pieces.some((p) => p.matched));

  return (
    <div className="search-matches" data-testid="search-matches">
      <div className="search-matches-head">
        <span>
          Highlighting: <strong>{query}</strong>
        </span>
        <button type="button" className="btn small" onClick={onClear}>
          Clear
        </button>
      </div>
      {matching.length === 0 ? (
        <div className="muted">The searched words are not in this report any more.</div>
      ) : (
        <ul>
          {matching.map(({ segment, pieces }, i) => (
            <li key={i}>
              <span className="excerpt-field">{segment.label}: </span>
              {pieces.map((p, j) => (p.matched ? <mark key={j}>{p.text}</mark> : <span key={j}>{p.text}</span>))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
