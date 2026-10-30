import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  createInstrumentModel,
  deleteInstrumentModel,
  listInstrumentModels,
  listInstrumentTypes,
  mergeInstrumentModel,
  updateInstrumentModel,
  type InstrumentModel,
  type InstrumentType,
} from '../api';
import { MakerDatalist, MAKER_LIST_ID } from './MakerSuggestions';
import { ModelPage } from './ModelPage';
import { RowMenu } from './RowMenu';
import { showToast } from '../toast';

/**
 * The Models list under the Instruments tab. A model is a record of its own;
 * the record is the source, so renaming it or changing its manufacturer
 * updates its instruments (and a rename the templates written for the name).
 * Merging two models is only ever done here, by a person, after a message that
 * says exactly what moves.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ModelForm({
  existing,
  types,
  onCancel,
  onSaved,
}: {
  existing?: InstrumentModel;
  types: InstrumentType[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [manufacturer, setManufacturer] = useState(existing?.manufacturer ?? '');
  const [typeKey, setTypeKey] = useState(existing?.instrument_type ?? 'facs');
  const [interval, setInterval] = useState(existing?.service_interval_months?.toString() ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const units = existing?.unit_count ?? 0;
  const renamed = existing !== undefined && name.trim() !== existing.name && name.trim() !== '';
  const maker = manufacturer.trim();
  const makerChanged = existing !== undefined && (existing.manufacturer ?? '') !== maker && units > 0;
  const intervalNumber = interval.trim() === '' ? null : Number(interval);
  const intervalBad = intervalNumber !== null && (!Number.isInteger(intervalNumber) || intervalNumber < 1 || intervalNumber > 600);
  const canSave = name.trim() !== '' && !intervalBad && !saving;

  async function save() {
    setSaving(true);
    setError(null);
    const payload = {
      name: name.trim(),
      manufacturer: maker || null,
      service_interval_months: intervalNumber,
      notes: notes.trim() || null,
    };
    try {
      if (existing) {
        await updateInstrumentModel(existing.id, { ...payload, ...(units === 0 ? { instrument_type: typeKey } : {}) });
      } else {
        await createInstrumentModel({ ...payload, instrument_type: typeKey });
      }
      showToast(existing ? 'Model saved' : 'Model added');
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save this model.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="section">
      <button type="button" className="btn small back-link" onClick={onCancel}>
        ← Back to models
      </button>
      <div className="section-title">{existing ? 'Edit model' : 'New model'}</div>
      {error && <div className="banner banner-crit">{error}</div>}

      <div className="schema-form-row">
        <label className="schema-form-label">
          <span>
            Name <span className="required-mark" title="Required">*</span>
          </span>
          <input type="text" className="text-input" value={name} placeholder="e.g. Aurora" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="schema-form-label">
          Manufacturer
          <input type="text" className="text-input" value={manufacturer} placeholder="e.g. Cytek Biosciences" list={MAKER_LIST_ID} onChange={(e) => setManufacturer(e.target.value)} />
          <MakerDatalist />
        </label>
      </div>
      <div className="schema-form-row">
        <label className="schema-form-label">
          Instrument type
          <select value={typeKey} disabled={units > 0} onChange={(e) => setTypeKey(e.target.value)}>
            {types.length === 0 && <option value={typeKey}>{typeKey}</option>}
            {types.map((t) => (
              <option key={t.key} value={t.key}>
                {t.display_name}
              </option>
            ))}
          </select>
          {units > 0 && <small className="muted">Fixed while the model has instruments.</small>}
        </label>
        <label className="schema-form-label">
          Service interval (months)
          <input
            type="number"
            inputMode="numeric"
            className="text-input"
            min={1}
            max={600}
            value={interval}
            placeholder="e.g. 6 (optional)"
            onChange={(e) => setInterval(e.target.value)}
          />
          <small className="muted">How often preventive maintenance is due. Empty: never shown as overdue.</small>
        </label>
      </div>
      <label className="schema-form-label">
        Notes
        <textarea className="text-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      {renamed && units + (existing?.template_count ?? 0) > 0 && (
        <div className="banner banner-warn" id="model-rename-warning">
          Renaming changes the model of {plural(units, 'instrument')}
          {existing && existing.template_count > 0 ? ` and the model of ${plural(existing.template_count, 'template')}` : ''} to “{name.trim()}”.
        </div>
      )}
      {makerChanged && (
        <div className="banner banner-warn" id="model-maker-warning">
          The manufacturer of {plural(units, 'instrument')} will become “{maker || 'empty'}”.
        </div>
      )}
      {intervalBad && <p className="form-missing">The service interval is a whole number of months from 1 to 600.</p>}

      <div className="cta-row">
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={() => void save()} disabled={!canSave}>
          {saving ? 'Saving…' : existing ? 'Save changes' : 'Add model'}
        </button>
      </div>
    </div>
  );
}

type Mode = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; model: InstrumentModel } | { kind: 'page'; model: InstrumentModel };
type Pending = { kind: 'delete'; model: InstrumentModel } | { kind: 'merge'; model: InstrumentModel; intoId: string };

export function ModelsManager({ onChanged }: { onChanged: () => void }) {
  const [models, setModels] = useState<InstrumentModel[]>([]);
  const [types, setTypes] = useState<InstrumentType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([listInstrumentModels(), listInstrumentTypes()])
      .then(([m, t]) => {
        setModels(m);
        setTypes(t);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load the models.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const typeName = (key: string) => types.find((t) => t.key === key)?.display_name ?? key;

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      if (pending.kind === 'delete') {
        await deleteInstrumentModel(pending.model.id);
        showToast('Model deleted');
      } else {
        const r = await mergeInstrumentModel(pending.model.id, pending.intoId);
        showToast(`Merged into ${r.into}`);
      }
      setPending(null);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  function afterSave() {
    setMode({ kind: 'list' });
    void load();
    onChanged();
  }

  if (mode.kind === 'page') {
    return (
      <ModelPage
        modelId={mode.model.id}
        typeName={typeName}
        onBack={() => setMode({ kind: 'list' })}
        onEdit={() => setMode({ kind: 'edit', model: mode.model })}
      />
    );
  }
  if (mode.kind !== 'list') {
    return <ModelForm existing={mode.kind === 'edit' ? mode.model : undefined} types={types} onCancel={() => setMode({ kind: 'list' })} onSaved={afterSave} />;
  }

  const mergeTargets = (m: InstrumentModel) => models.filter((o) => o.id !== m.id && o.instrument_type === m.instrument_type);
  const target = pending?.kind === 'merge' ? models.find((m) => m.id === pending.intoId) : undefined;

  return (
    <div className="section" id="models-section">
      <div className="section-title-row">
        <div className="section-title">Models</div>
        <button type="button" className="btn small primary" onClick={() => setMode({ kind: 'create' })}>
          + New model
        </button>
      </div>
      <p className="hint-text">
        A model is kept once, here. Renaming it or changing its manufacturer updates its instruments. Names that look alike are never merged on
        their own.
      </p>

      {error && <div className="banner banner-warn">{error}</div>}

      {pending?.kind === 'delete' && (
        <div className="banner banner-warn" role="alertdialog" aria-label="Confirm delete model">
          <div>
            Delete the model “{pending.model.name}”? This deletes only the model record; it has no instruments.
            {pending.model.template_count > 0
              ? ` The ${plural(pending.model.template_count, 'template')} written for this model name stay${pending.model.template_count === 1 ? 's' : ''}.`
              : ''}{' '}
            This cannot be undone.
          </div>
          <button type="button" className="btn small danger solid" onClick={() => void confirm()} disabled={busy}>
            Confirm delete
          </button>{' '}
          <button type="button" className="btn small" onClick={() => setPending(null)} disabled={busy}>
            Cancel
          </button>
        </div>
      )}

      {pending?.kind === 'merge' && (
        <div className="banner banner-warn" role="alertdialog" aria-label="Merge model">
          <label className="schema-form-label">
            Merge “{pending.model.name}” into
            <select value={pending.intoId} onChange={(e) => setPending({ ...pending, intoId: e.target.value })}>
              {mergeTargets(pending.model).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          {target && (
            <div>
              {plural(pending.model.unit_count, 'instrument')} and {plural(pending.model.template_count, 'template')} written for “{pending.model.name}” move
              to “{target.name}”
              {target.manufacturer ? `, and those instruments’ manufacturer becomes “${target.manufacturer}”` : ''}. The model “{pending.model.name}” is then
              deleted. This cannot be undone.
            </div>
          )}
          <button type="button" className="btn small danger solid" onClick={() => void confirm()} disabled={busy || !target}>
            Confirm merge
          </button>{' '}
          <button type="button" className="btn small" onClick={() => setPending(null)} disabled={busy}>
            Cancel
          </button>
        </div>
      )}

      {loading ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading models…</div>
        </div>
      ) : models.length === 0 ? (
        <div className="empty-hint">No models yet.</div>
      ) : (
        <div className="template-table">
          <div className="instrument-row model-row template-row-head">
            <span>Model</span>
            <span>Manufacturer</span>
            <span>Type</span>
            <span>Instruments</span>
            <span>Service interval</span>
            <span>Actions</span>
          </div>
          {models.map((m) => {
            const targets = mergeTargets(m);
            return (
              <div className="instrument-row model-row template-row-body" key={m.id}>
                <span data-label="Model">
                  <button type="button" className="link-button model-name" onClick={() => setMode({ kind: 'page', model: m })}>
                    {m.name}
                  </button>
                  {m.similar_to.length > 0 && (
                    <small className="muted model-similar">May be the same as {m.similar_to.map((s) => `“${s}”`).join(', ')}</small>
                  )}
                  {m.notes && <small className="muted model-notes">{m.notes}</small>}
                </span>
                <span data-label="Manufacturer">{m.manufacturer ?? '—'}</span>
                <span data-label="Type">{typeName(m.instrument_type)}</span>
                <span data-label="Instruments">{m.unit_count}</span>
                <span data-label="Service interval">
                  {m.service_interval_months ? `${m.service_interval_months} months` : '—'}
                </span>
                <span className="template-row-actions">
                  <button type="button" className="btn small" onClick={() => setMode({ kind: 'edit', model: m })}>
                    Edit
                  </button>
                  <RowMenu
                    label={`More actions for ${m.name}`}
                    items={[
                      {
                        label: 'Merge into…',
                        disabled: targets.length === 0,
                        title: targets.length === 0 ? 'No other model of this type' : undefined,
                        onSelect: () => setPending({ kind: 'merge', model: m, intoId: targets[0].id }),
                      },
                      {
                        label: 'Delete',
                        danger: true,
                        disabled: m.unit_count > 0,
                        title: m.unit_count > 0 ? `${plural(m.unit_count, 'instrument')} still use this model` : undefined,
                        onSelect: () => setPending({ kind: 'delete', model: m }),
                      },
                    ]}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
