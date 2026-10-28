import type { PromptPreview } from '../api';

// VIEW_PROMPTS (debug): the exact request about to go to Claude. Documents are
// described, not shown as bytes. Send makes the call; Cancel drops it.
export function PromptReview({
  preview,
  onSend,
  onCancel,
}: {
  preview: PromptPreview;
  onSend: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="prompt-review-backdrop" role="dialog" aria-modal="true" aria-labelledby="prompt-review-title">
      <div className="prompt-review">
        <h2 id="prompt-review-title">Prompt to send to Claude ({preview.verb})</h2>
        <p className="prompt-review-meta">
          Model {preview.model ?? '?'} · max {preview.max_tokens ?? '?'} tokens. Nothing has been sent yet.
        </p>
        {preview.blocks.map((block, i) =>
          block.type === 'text' ? (
            <pre key={i} className="prompt-review-text" data-testid="prompt-text">{block.text}</pre>
          ) : (
            <p key={i} className="prompt-review-doc" data-testid="prompt-document">
              Attached {block.type}: {block.media_type ?? 'unknown type'}, {block.bytes ?? '?'} bytes, SHA-256{' '}
              <code>{block.sha256 ?? '?'}</code>
            </p>
          )
        )}
        {preview.system != null && <pre className="prompt-review-text">{JSON.stringify(preview.system, null, 2)}</pre>}
        <details>
          <summary>Tool definition and tool choice</summary>
          <pre className="prompt-review-text">{JSON.stringify({ tool_choice: preview.tool_choice, tools: preview.tools }, null, 2)}</pre>
        </details>
        <div className="prompt-review-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={onSend} autoFocus>Send to Claude</button>
        </div>
      </div>
    </div>
  );
}
