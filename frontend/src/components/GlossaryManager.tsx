import { useEffect, useState } from 'react';
import { ApiError, createGlossaryTerm, deleteGlossaryTerm, listGlossaryTerms, updateGlossaryTerm, type GlossaryTerm, type GlossaryTermPayload } from '../api';

const EMPTY: GlossaryTermPayload = { source_term: '', wrong_term: '', english_term: '', note: '' };

function blankToNull(v: string | null): string | null {
  return v && v.trim() ? v.trim() : null;
}

/** Add or edit one term. `initial` prefills a new term (the Accuracy page passes a phrase a reviewer changed). */
export function TermForm({ term, initial, onCancel, onSaved }: { term: GlossaryTerm | null; initial?: GlossaryTermPayload; onCancel: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<GlossaryTermPayload>(
    term ? { source_term: term.source_term ?? '', wrong_term: term.wrong_term ?? '', english_term: term.english_term, note: term.note ?? '' } : (initial ?? EMPTY),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof GlossaryTermPayload) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const payload = { source_term: blankToNull(form.source_term), wrong_term: blankToNull(form.wrong_term), english_term: form.english_term.trim(), note: blankToNull(form.note) };
    if (!payload.english_term) return setError('Give the English term.');
    if (!payload.source_term && !payload.wrong_term) return setError('Give the Hebrew term, the wrong English wording, or both.');
    setSaving(true);
    setError(null);
    try {
      if (term) await updateGlossaryTerm(term.id, payload);
      else await createGlossaryTerm(payload);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the term.');
      setSaving(false);
    }
  }

  return (
    <form className="admin-form glossary-form" onSubmit={(e) => void save(e)} data-testid="glossary-form">
      <label>
        Hebrew term on the form
        <input type="text" dir="rtl" value={form.source_term ?? ''} onChange={set('source_term')} placeholder="כיוון לייזר" />
      </label>
      <label>
        Wrong English wording seen before
        <input type="text" value={form.wrong_term ?? ''} onChange={set('wrong_term')} placeholder="laser direction" />
      </label>
      <label>
        Right English term
        <input type="text" value={form.english_term} onChange={set('english_term')} placeholder="laser alignment" required />
      </label>
      <label>
        Note (optional)
        <input type="text" value={form.note ?? ''} onChange={set('note')} />
      </label>
      {error && (
        <div className="banner banner-crit" role="alert">
          {error}
        </div>
      )}
      <div className="glossary-actions">
        <button type="submit" className="btn primary" disabled={saving}>
          {term ? 'Save' : 'Add term'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The technical glossary: how a term on a Hebrew form should come out in English. Every translation is given the
 * list, and a wrong wording listed here that still appears in a translation is replaced with the right term before
 * the reviewer sees it (with a note saying so).
 */
export function GlossaryManager() {
  const [terms, setTerms] = useState<GlossaryTerm[] | null>(null);
  const [editing, setEditing] = useState<GlossaryTerm | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    listGlossaryTerms()
      .then(setTerms)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the glossary.'));
  }
  useEffect(load, []);

  async function remove(t: GlossaryTerm) {
    if (!window.confirm(`Remove "${t.english_term}" from the glossary?`)) return;
    try {
      await deleteGlossaryTerm(t.id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the term.');
    }
  }

  return (
    <div className="glossary" data-testid="glossary">
      <h2 className="admin-title">Technical glossary</h2>
      <p className="admin-lead">
        How a technical term on a Hebrew form should read in English. Translations are given this list, and a wrong wording listed here is corrected if it still
        appears.
      </p>
      {error && (
        <div className="banner banner-crit" role="alert">
          {error}
        </div>
      )}
      {editing === 'new' ? (
        <TermForm
          term={null}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      ) : (
        <button type="button" className="btn primary" onClick={() => setEditing('new')} data-testid="glossary-add">
          Add a term
        </button>
      )}
      {terms && terms.length === 0 && <p className="hint-text">No terms yet.</p>}
      {terms && terms.length > 0 && (
        <table className="trend-table acc-table glossary-table" data-testid="glossary-table">
          <thead>
            <tr>
              <th scope="col">Hebrew</th>
              <th scope="col">Not</th>
              <th scope="col">But</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {terms.map((t) =>
              editing !== 'new' && editing?.id === t.id ? (
                <tr key={t.id}>
                  <td colSpan={4}>
                    <TermForm
                      term={t}
                      onCancel={() => setEditing(null)}
                      onSaved={() => {
                        setEditing(null);
                        load();
                      }}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={t.id}>
                  <td dir="rtl">{t.source_term ?? <span className="acc-muted">–</span>}</td>
                  <td>{t.wrong_term ? <del className="acc-read">{t.wrong_term}</del> : <span className="acc-muted">–</span>}</td>
                  <td>
                    <strong>{t.english_term}</strong>
                    {t.note && <div className="acc-muted">{t.note}</div>}
                  </td>
                  <td className="glossary-row-actions">
                    <button type="button" className="btn small" onClick={() => setEditing(t)}>
                      Edit
                    </button>
                    <button type="button" className="btn small" onClick={() => void remove(t)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
