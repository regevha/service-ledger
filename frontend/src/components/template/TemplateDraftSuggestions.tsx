import { useState } from 'react';
import { ApiError, suggestTemplateFields, type TemplateFieldDraft } from '../../api';
import { fieldLabel } from '../../fieldLabels';

type State =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; fields: TemplateFieldDraft[] }
  | { status: 'error'; message: string };

export function TemplateDraftSuggestions({
  attachmentId,
  page,
  onReview,
}: {
  attachmentId: string;
  page: number;
  onReview: (field: TemplateFieldDraft) => void;
}) {
  const [state, setState] = useState<State>({ status: 'idle' });
  async function requestSuggestions() {
    setState({ status: 'loading' });
    try {
      const fields = await suggestTemplateFields(attachmentId, page);
      setState({ status: 'ready', fields });
    } catch (error) {
      setState({ status: 'error', message: error instanceof ApiError ? error.message : 'Could not get model suggestions.' });
    }
  }
  return (
    <div className="pdf-picker-suggestions">
      <div className="pdf-picker-suggestions-actions">
        <button className="btn small" type="button" disabled={state.status === 'loading'} onClick={() => void requestSuggestions()}>
          {state.status === 'loading' ? 'Requesting suggestions…' : 'Suggest fields with AI'}
        </button>
        <p className="pdf-picker-hint">Sends this page to the configured document model. You choose which suggestions to use.</p>
      </div>
      {state.status === 'error' && <div className="banner banner-warn" role="alert">{state.message}</div>}
      {state.status === 'ready' && (state.fields.length === 0 ? (
        <p role="status" className="pdf-picker-hint">No fields were suggested for this page.</p>
      ) : (
        <ul className="pdf-picker-suggestions-list" aria-label="Suggested fields">
          {state.fields.map((field) => (
            <li key={field.name}>
              <button className="btn small" type="button" onClick={() => onReview(field)}>
                Review {fieldLabel(field.name)}
              </button>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}
