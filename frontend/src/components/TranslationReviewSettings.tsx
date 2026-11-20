import { useEffect, useState } from 'react';
import { apiFetch } from '../api/http';
import { showToast } from '../toast';
import type { components } from '../generated/api-schema';

type Setting = components['schemas']['TranslationReviewSetting'];
const PATH = '/admin/translation-review';

export function TranslationReviewSettings() {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [showReview, setShowReview] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    apiFetch<Setting>(PATH).then(({ show_translation_review }) => {
      if (!active) return;
      setSaved(show_translation_review);
      setShowReview(show_translation_review);
    }).catch(() => {
      if (active) setError('Could not load the translation review setting.');
    });
    return () => { active = false; };
  }, [loadAttempt]);

  async function save() {
    setSaving(true);
    setError('');
    try {
      const setting = await apiFetch<Setting>(PATH, {
        method: 'PUT',
        body: JSON.stringify({ show_translation_review: showReview }),
      });
      setSaved(setting.show_translation_review);
      showToast('Setting saved');
    } catch {
      setError('Could not save the setting. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="admin-card">
      <h1 className="admin-title">Translation review</h1>
      <p className="admin-lead">
        Choose whether to show the translation before reading the report. Skipping uses the generated
        translation automatically. The setting applies to all users, and report approval is still required.
      </p>
      {error && <p role="alert">{error}</p>}
      {saved === null ? (
        error ? (
          <button className="btn" type="button" onClick={() => {
            setError('');
            setLoadAttempt((attempt) => attempt + 1);
          }}>Try again</button>
        ) : <p role="status">Loading…</p>
      ) : (
        <div className="admin-form">
          <label>
            <span>Translation review screen</span>
            <select value={showReview ? 'show' : 'skip'} onChange={(event) => setShowReview(event.target.value === 'show')} disabled={saving}>
              <option value="show">Show</option>
              <option value="skip">Skip</option>
            </select>
          </label>
          <div>
            <button className="btn primary" type="button" onClick={() => void save()} disabled={saving || showReview === saved}>
              {saving ? 'Saving…' : 'Save setting'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
