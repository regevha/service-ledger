import { useState } from 'react';
import { ApiError, previewTemplateExtraction, type TemplateCreatePayload } from '../../api';
import { fieldLabel } from '../../fieldLabels';

export function TemplateReadTest({ attachmentId, draft }: { attachmentId: string; draft: TemplateCreatePayload }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ fields: Record<string, unknown>; placeholder: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await previewTemplateExtraction(attachmentId, draft));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not test these fields.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="next-card">
      <button type="button" className="btn" disabled={busy} onClick={() => void run()}>{busy ? 'Testing draft…' : 'Test draft on this document'}</button>
      <p className="hint-text">Runs the configured reader on this document without saving the template.</p>
      {error && <div className="banner banner-warn" role="alert">{error}</div>}
      {result && (
        <>
          {result.placeholder && <p className="hint-text">These demo values are placeholders.</p>}
          <dl aria-label="Draft extraction results">
            {draft.fields.map((field) => (
              <div key={field.name}>
                <dt>{fieldLabel(field.name)}</dt>
                <dd>{result.fields[field.name] == null ? 'No value read' : typeof result.fields[field.name] === 'string' ? String(result.fields[field.name]) : JSON.stringify(result.fields[field.name])}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </div>
  );
}
