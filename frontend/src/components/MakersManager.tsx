import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  createManufacturer,
  deleteManufacturer,
  listManufacturers,
  updateManufacturer,
  type Manufacturer,
} from '../api';
import { showToast } from '../toast';

/**
 * The Makers list under the Instruments tab. A maker is a record of its own: "BD" and
 * "Becton Dickinson" are one maker when the second is listed as an alias of the first. Typing
 * either on an instrument or a model stores the maker's name. Renaming a maker updates the
 * text on its instruments and models. Two makers are never merged on their own.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Aliases are typed as one line, separated by semicolons (a maker's name can contain a comma:
// "Becton, Dickinson and Company").
const parseAliases = (text: string) => text.split(';').map((a) => a.trim()).filter(Boolean);

function MakerForm({
  existing,
  onCancel,
  onSaved,
}: {
  existing?: Manufacturer;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [aliases, setAliases] = useState((existing?.aliases ?? []).join('; '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const payload = { name: name.trim(), aliases: parseAliases(aliases) };
    try {
      if (existing) await updateManufacturer(existing.id, payload);
      else await createManufacturer(payload);
      showToast(existing ? 'Maker saved' : 'Maker added');
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save this maker.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="section">
      <button type="button" className="btn small back-link" onClick={onCancel}>
        ← Back to makers
      </button>
      <div className="section-title">{existing ? `Edit ${existing.name}` : 'New maker'}</div>
      {error && <div className="banner banner-crit">{error}</div>}
      {existing && existing.name !== name.trim() && (existing.instrument_count > 0 || existing.model_count > 0) && (
        <div className="banner banner-warn">
          The maker of {plural(existing.instrument_count, 'instrument')} and {plural(existing.model_count, 'model')} will become “
          {name.trim() || 'empty'}”.
        </div>
      )}
      <div className="schema-form-row">
        <label className="schema-form-label">
          Name
          <input type="text" className="text-input" value={name} placeholder="e.g. Beckman Coulter" onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <div className="schema-form-row">
        <label className="schema-form-label">
          Other names (optional, separated by semicolons)
          <input
            type="text"
            className="text-input"
            value={aliases}
            placeholder="e.g. Beckman; Beckman Coulter Life Sciences"
            onChange={(e) => setAliases(e.target.value)}
          />
        </label>
      </div>
      <div className="muted alias-hint">
        Case, spaces and punctuation are ignored. A name or other name can belong to only one maker.
      </div>
      <div className="cta-row">
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={() => void save()} disabled={saving || name.trim() === ''}>
          {saving ? 'Saving…' : existing ? 'Save changes' : 'Add maker'}
        </button>
      </div>
    </div>
  );
}

export function MakersManager({ onChanged }: { onChanged: () => void }) {
  const [makers, setMakers] = useState<Manufacturer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<{ kind: 'list' } | { kind: 'create' } | { kind: 'edit'; maker: Manufacturer }>({ kind: 'list' });
  const [pendingDelete, setPendingDelete] = useState<Manufacturer | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setMakers(await listManufacturers());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the makers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await deleteManufacturer(pendingDelete.id);
      showToast('Maker deleted');
      setPendingDelete(null);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
      setPendingDelete(null);
    } finally {
      setBusy(false);
    }
  }

  function afterSave() {
    setMode({ kind: 'list' });
    void load();
    onChanged();
  }

  if (mode.kind !== 'list') {
    return <MakerForm existing={mode.kind === 'edit' ? mode.maker : undefined} onCancel={() => setMode({ kind: 'list' })} onSaved={afterSave} />;
  }

  return (
    <div className="section" id="makers-section">
      <div className="section-title-row">
        <div className="section-title">Makers</div>
        <button type="button" className="btn small primary" onClick={() => setMode({ kind: 'create' })}>
          + New maker
        </button>
      </div>
      <p className="hint-text">
        A maker is kept once, here. Typing one of its other names on an instrument or model stores the maker’s name. Makers are never merged on
        their own.
      </p>

      {error && <div className="banner banner-warn">{error}</div>}

      {pendingDelete && (
        <div className="banner banner-warn" role="alertdialog" aria-label="Confirm delete maker">
          <div>Delete the maker “{pendingDelete.name}”? It has no instruments or models. This cannot be undone.</div>
          <button type="button" className="btn small danger solid" onClick={() => void confirmDelete()} disabled={busy}>
            Confirm delete
          </button>{' '}
          <button type="button" className="btn small" onClick={() => setPendingDelete(null)} disabled={busy}>
            Cancel
          </button>
        </div>
      )}

      {loading ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading makers…</div>
        </div>
      ) : makers.length === 0 ? (
        <div className="empty-hint">No makers yet.</div>
      ) : (
        <div className="template-table">
          <div className="instrument-row maker-row template-row-head">
            <span>Maker</span>
            <span>Other names</span>
            <span>Instruments</span>
            <span>Models</span>
            <span>Actions</span>
          </div>
          {makers.map((m) => {
            const used = m.instrument_count > 0 || m.model_count > 0;
            return (
              <div className="instrument-row maker-row template-row-body" key={m.id}>
                <span data-label="Maker">{m.name}</span>
                <span data-label="Other names">{m.aliases.length ? m.aliases.join('; ') : '—'}</span>
                <span data-label="Instruments">{m.instrument_count}</span>
                <span data-label="Models">{m.model_count}</span>
                <span className="template-row-actions">
                  <button type="button" className="btn small" onClick={() => setMode({ kind: 'edit', maker: m })}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn small danger"
                    disabled={used}
                    title={used ? 'Still used by instruments or models' : undefined}
                    onClick={() => setPendingDelete(m)}
                  >
                    Delete
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
