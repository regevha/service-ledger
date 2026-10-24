import { useEffect, useState } from 'react';
import {
  ApiError,
  createFieldAliasGroup,
  deleteFieldAliasGroup,
  listFieldAliases,
  replaceFieldAliasGroup,
  type FieldAliasGroup,
} from '../api';

/**
 * Field aliases: sets of field names that mean the same thing under different
 * wording, kept by hand (proposal-template-comparison.md, phase 2). The
 * template comparison uses them to show a "possible match". Nothing is renamed
 * or merged because of them, and extraction and the review screen never read
 * them.
 */

function GroupForm({
  group,
  onCancel,
  onSaved,
}: {
  group: FieldAliasGroup | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(group?.label ?? '');
  const [names, setNames] = useState<string[]>(group?.names ?? ['', '']);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filled = names.map((n) => n.trim()).filter(Boolean);
  const canSave = filled.length >= 2 && !saving;

  async function save() {
    setSaving(true);
    setError(null);
    const payload = { label: label.trim() ? label.trim() : null, names: filled };
    try {
      if (group) await replaceFieldAliasGroup(group.id, payload);
      else await createFieldAliasGroup(payload);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save this group.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="section">
      <button type="button" className="btn small back-link" onClick={onCancel}>
        ← Back to field aliases
      </button>
      <div className="section-title">{group ? 'Edit alias group' : 'New alias group'}</div>
      {error && <div className="banner banner-crit">{error}</div>}

      <div className="schema-form-row">
        <label className="schema-form-label">
          Label (optional)
          <input
            type="text"
            className="text-input"
            id="alias-label"
            placeholder="e.g. Result of the check after the work"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
      </div>

      <div className="schema-field-extra-label">Field names that mean the same thing</div>
      <div className="alias-names">
        {names.map((n, i) => (
          <div className="item-schema-row alias-name-row" key={i}>
            <input
              type="text"
              className="text-input"
              aria-label="Field name"
              placeholder="e.g. retest_result"
              value={n}
              onChange={(e) => setNames(names.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button
              type="button"
              className="row-remove"
              disabled={names.length <= 2}
              onClick={() => setNames(names.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn small" onClick={() => setNames([...names, ''])}>
        + Add name
      </button>
      <div className="muted alias-hint">
        Case, spaces, underscores and hyphens are ignored, so "Retest result" and "retest_result" are one name. A name can be in
        only one group.
      </div>

      <div className="cta-row">
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={() => void save()} disabled={!canSave}>
          {saving ? 'Saving…' : group ? 'Save changes' : 'Create group'}
        </button>
      </div>
    </div>
  );
}

export function FieldAliasManagerScreen({ onBack }: { onBack: () => void }) {
  // The list is kept with the version it answers, so reloading is a version bump
  // and "loading" is simply "the latest version has not answered yet".
  const [version, setVersion] = useState(0);
  const [answer, setAnswer] = useState<{ version: number; groups: FieldAliasGroup[]; error: string | null } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FieldAliasGroup | 'new' | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const reload = () => setVersion((v) => v + 1);

  useEffect(() => {
    let current = true;
    listFieldAliases()
      .then((groups) => current && setAnswer({ version, groups, error: null }))
      .catch(
        (e: unknown) =>
          current &&
          setAnswer({ version, groups: [], error: e instanceof ApiError ? e.message : 'Could not load the field aliases.' }),
      );
    return () => {
      current = false;
    };
  }, [version]);

  const loading = answer === null || answer.version !== version;
  const groups = answer?.groups ?? [];
  const error = deleteError ?? answer?.error ?? null;

  async function remove(id: string) {
    try {
      await deleteFieldAliasGroup(id);
      setConfirmDeleteId(null);
      setDeleteError(null);
      reload();
    } catch (e) {
      setDeleteError(e instanceof ApiError ? e.message : 'Could not delete this group.');
      setConfirmDeleteId(null);
    }
  }

  if (editing !== null) {
    return (
      <GroupForm
        group={editing === 'new' ? null : editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    );
  }

  return (
    <div className="section">
      <button type="button" className="btn small back-link" onClick={onBack}>
        ← Back to templates
      </button>
      <div className="section-title-row">
        <div className="section-title">Field aliases</div>
        <button type="button" className="btn small primary" id="new-alias-group" onClick={() => setEditing('new')}>
          + New group
        </button>
      </div>
      <div className="muted compare-intro">
        Field names that mean the same thing under different wording. When you compare two templates, fields in the same group are
        shown side by side as a possible match. Nothing is renamed or merged, and the review screen and extraction do not use
        these.
      </div>

      {error && <div className="banner banner-warn">{error}</div>}

      {loading ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading field aliases…</div>
        </div>
      ) : groups.length === 0 ? (
        <div className="empty-hint">No alias groups yet.</div>
      ) : (
        <div className="alias-list">
          {groups.map((g) => (
            <div className="alias-group" key={g.id} data-label={g.label ?? ''}>
              <div className="alias-group-main">
                <div className="alias-group-label">{g.label ?? 'Unlabelled group'}</div>
                <div className="alias-chips">
                  {g.names.map((n) => (
                    <span className="alias-chip" key={n}>
                      {n}
                    </span>
                  ))}
                </div>
              </div>
              <div className="template-row-actions">
                <button type="button" className="btn small" onClick={() => setEditing(g)}>
                  Edit
                </button>
                {confirmDeleteId === g.id ? (
                  <>
                    <button type="button" className="btn small danger solid" onClick={() => void remove(g.id)}>
                      Confirm delete
                    </button>
                    <button type="button" className="btn small" onClick={() => setConfirmDeleteId(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn small danger" onClick={() => setConfirmDeleteId(g.id)}>
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
