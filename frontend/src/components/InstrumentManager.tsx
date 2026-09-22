import { useState } from 'react';
import { ApiError, createInstrument, updateInstrument, type Instrument, type InstrumentStatus } from '../api';
import { INSTRUMENT_STATUS_LABEL } from '../labels';

/**
 * The Instruments tab: create/edit for the fleet, replacing "POST
 * /instruments from a script or curl, then edit the row in the DB by hand
 * for anything else" as the only way to add an instrument or fix a typo'd
 * serial number, rename, relocate, or retire one (backend/app/routers/
 * instruments.py's new PATCH /instruments/{id}).
 *
 * Unlike TemplateManagerScreen (its own fetch/list state, since nothing
 * else in the app needs the template list), the instrument list is already
 * loaded once at the top of App.tsx and threaded down to the Reports
 * filter and the instrument detail page — so this screen takes that same
 * `instruments` array and a `refresh` callback as props instead of
 * fetching its own copy, and a create/edit here is reflected everywhere
 * else immediately rather than only after a full reload.
 *
 * `instrument_type` is deliberately not exposed in either form: it's fixed
 * to "facs" for MVP (models.py's own doc comment) and nothing else in the
 * UI offers another value to pick.
 */

const STATUS_OPTIONS: InstrumentStatus[] = ['active', 'maintenance', 'retired'];

function InstrumentFormScreen({
  existing,
  onCancel,
  onSaved,
}: {
  existing?: Instrument;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [model, setModel] = useState(existing?.model ?? '');
  const [serialNumber, setSerialNumber] = useState(existing?.serial_number ?? '');
  const [location, setLocation] = useState(existing?.location ?? '');
  const [status, setStatus] = useState<InstrumentStatus>(existing?.status ?? 'active');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const trimmedLocation = location.trim() ? location.trim() : null;
      if (existing) {
        await updateInstrument(existing.id, {
          name: name.trim(),
          model: model.trim(),
          serial_number: serialNumber.trim(),
          location: trimmedLocation,
          status,
        });
      } else {
        await createInstrument({
          name: name.trim(),
          model: model.trim(),
          serial_number: serialNumber.trim(),
          location: trimmedLocation,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save this instrument.');
    } finally {
      setSaving(false);
    }
  }

  const canSave = name.trim().length > 0 && model.trim().length > 0 && serialNumber.trim().length > 0 && !saving;

  return (
    <div className="section">
      <button type="button" className="btn small back-link" onClick={onCancel}>
        ← Back to instruments
      </button>

      <div className="section-title">{existing ? 'Edit instrument' : 'New instrument'}</div>

      {error && <div className="banner banner-crit">{error}</div>}

      <div className="schema-form-row">
        <label className="schema-form-label">
          Name
          <input
            type="text"
            className="text-input"
            placeholder="e.g. FACSAria III — Core Lab"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="schema-form-label">
          Model
          <input
            type="text"
            className="text-input"
            placeholder="e.g. FACSAria III"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
      </div>

      <div className="schema-form-row">
        <label className="schema-form-label">
          Serial number
          <input type="text" className="text-input" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
        </label>
        <label className="schema-form-label">
          Location
          <input
            type="text"
            className="text-input"
            placeholder="e.g. Core Lab, Bench 3"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </label>
      </div>

      {/* A brand-new instrument is always created active (schemas.py's
          InstrumentCreate has no status field) — status only becomes
          something to change once the instrument already exists. */}
      {existing && (
        <div className="schema-form-row">
          <label className="schema-form-label">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value as InstrumentStatus)}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {INSTRUMENT_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="cta-row">
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={() => void handleSave()} disabled={!canSave}>
          {saving ? 'Saving…' : existing ? 'Save changes' : 'Create instrument'}
        </button>
      </div>
    </div>
  );
}

type ManagerMode = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; instrument: Instrument };

export function InstrumentManagerScreen({
  instruments,
  loading,
  error,
  onRefresh,
}: {
  instruments: Instrument[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const [mode, setMode] = useState<ManagerMode>({ kind: 'list' });

  function handleSaved() {
    setMode({ kind: 'list' });
    onRefresh();
  }

  if (mode.kind === 'create') {
    return <InstrumentFormScreen onCancel={() => setMode({ kind: 'list' })} onSaved={handleSaved} />;
  }
  if (mode.kind === 'edit') {
    return (
      <InstrumentFormScreen existing={mode.instrument} onCancel={() => setMode({ kind: 'list' })} onSaved={handleSaved} />
    );
  }

  return (
    <div className="section">
      <div className="section-title-row">
        <div className="section-title">Instruments</div>
        <button type="button" className="btn small primary" onClick={() => setMode({ kind: 'create' })}>
          + New instrument
        </button>
      </div>

      {error && <div className="banner banner-warn">{error}</div>}

      {loading ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading instruments…</div>
        </div>
      ) : instruments.length === 0 ? (
        <div className="empty-hint">No instruments yet.</div>
      ) : (
        <div className="template-table">
          <div className="instrument-row template-row-head">
            <span>Name</span>
            <span>Model</span>
            <span>Serial number</span>
            <span>Location</span>
            <span>Status</span>
            <span>Actions</span>
          </div>
          {instruments.map((inst) => (
            <div className="instrument-row template-row-body" key={inst.id}>
              <span>{inst.name}</span>
              <span>{inst.model}</span>
              <span>{inst.serial_number}</span>
              <span>{inst.location ?? '—'}</span>
              <span>
                <span className={`status-pill instrument-status-${inst.status}`}>
                  {INSTRUMENT_STATUS_LABEL[inst.status]}
                </span>
              </span>
              <span className="template-row-actions">
                <button type="button" className="btn small" onClick={() => setMode({ kind: 'edit', instrument: inst })}>
                  Edit
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
