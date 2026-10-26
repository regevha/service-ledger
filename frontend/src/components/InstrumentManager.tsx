import { useEffect, useState } from 'react';
import {
  ApiError,
  createInstrument,
  createInstrumentType,
  deleteInstrument,
  listInstrumentTypes,
  listReports,
  updateInstrument,
  type Instrument,
  type InstrumentStatus,
  type InstrumentType,
} from '../api';
import { INSTRUMENT_STATUS_LABEL } from '../labels';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { RowMenu } from './RowMenu';

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
 * The instrument type is picked when an instrument is created (and a new
 * type can be added right there); it cannot be changed afterwards because the
 * instrument's templates and reports are tied to it.
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
  const [manufacturer, setManufacturer] = useState(existing?.manufacturer ?? '');
  const [distributor, setDistributor] = useState(existing?.distributor ?? '');
  const [institution, setInstitution] = useState(existing?.institution ?? '');
  const [serialNumber, setSerialNumber] = useState(existing?.serial_number ?? '');
  const [location, setLocation] = useState(existing?.location ?? '');
  const [status, setStatus] = useState<InstrumentStatus>(existing?.status ?? 'active');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [types, setTypes] = useState<InstrumentType[]>([]);
  const [typeKey, setTypeKey] = useState(existing?.instrument_type ?? 'facs');
  const [newTypeName, setNewTypeName] = useState<string | null>(null);

  useEffect(() => {
    listInstrumentTypes()
      .then(setTypes)
      .catch(() => setTypes([]));
  }, []);

  async function handleAddType() {
    if (!newTypeName || !newTypeName.trim()) return;
    setError(null);
    try {
      const created = await createInstrumentType(newTypeName.trim());
      setTypes((prev) => [...prev, created].sort((a, b) => a.display_name.localeCompare(b.display_name)));
      setTypeKey(created.key);
      setNewTypeName(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add this type.');
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const trimmedLocation = location.trim() ? location.trim() : null;
      if (existing) {
        await updateInstrument(existing.id, {
          name: name.trim(),
          model: model.trim(),
          manufacturer: manufacturer.trim() || null,
          distributor: distributor.trim() || null,
          institution: institution.trim() || null,
          serial_number: serialNumber.trim(),
          location: trimmedLocation,
          status,
        });
      } else {
        await createInstrument({
          name: name.trim(),
          model: model.trim(),
          instrument_type: typeKey,
          manufacturer: manufacturer.trim(),
          distributor: distributor.trim() || null,
          institution: institution.trim() || null,
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

  const missing = [
    name.trim().length === 0 ? 'name' : null,
    model.trim().length === 0 ? 'model' : null,
    existing === undefined && manufacturer.trim().length === 0 ? 'manufacturer' : null,
    serialNumber.trim().length === 0 ? 'serial number' : null,
  ].filter((m): m is string => m !== null);
  const canSave = missing.length === 0 && !saving;

  return (
    <div className="section">
      <button type="button" className="btn small back-link" onClick={onCancel}>
        ← Back to instruments
      </button>

      <div className="section-title">{existing ? 'Edit instrument' : 'New instrument'}</div>

      {error && <div className="banner banner-crit">{error}</div>}

      <div className="schema-form-row">
        <label className="schema-form-label">
          Instrument type
          <select
            id="instrument-type"
            value={typeKey}
            disabled={existing !== undefined}
            onChange={(e) => setTypeKey(e.target.value)}
          >
            {types.length === 0 && <option value={typeKey}>{typeKey}</option>}
            {types.map((t) => (
              <option key={t.key} value={t.key}>
                {t.display_name}
              </option>
            ))}
          </select>
        </label>
        {!existing &&
          (newTypeName === null ? (
            <button type="button" className="btn small" onClick={() => setNewTypeName('')}>
              + Add a type
            </button>
          ) : (
            <div className="schema-form-label">
              New type name
              <input
                type="text"
                className="text-input"
                placeholder="e.g. Electron microscope"
                value={newTypeName}
                onChange={(e) => setNewTypeName(e.target.value)}
              />
              <button type="button" className="btn small" onClick={() => void handleAddType()}>
                Add
              </button>
              <button type="button" className="btn small" onClick={() => setNewTypeName(null)}>
                Cancel
              </button>
            </div>
          ))}
      </div>

      <div className="schema-form-row">
        <label className="schema-form-label">
          <span>Name <Required /></span>
          <input
            type="text"
            className="text-input"
            placeholder="e.g. FACSAria III — Core Lab"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="schema-form-label">
          <span>Model <Required /></span>
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
          <span>Manufacturer {!existing && <Required />}</span>
          <input
            type="text"
            className="text-input"
            placeholder="e.g. BD"
            value={manufacturer}
            onChange={(e) => setManufacturer(e.target.value)}
          />
        </label>
        <label className="schema-form-label">
          <span>Serial number <Required /></span>
          <input type="text" className="text-input" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
        </label>
      </div>

      <div className="schema-form-row">
        <label className="schema-form-label">
          Room name
          <input
            type="text"
            className="text-input"
            placeholder="e.g. Core Lab"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </label>
        <label className="schema-form-label">
          Institution
          <input
            type="text"
            className="text-input"
            placeholder="e.g. Bar-Ilan University (optional)"
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
          />
        </label>
        <label className="schema-form-label">
          Distributor
          <input
            type="text"
            className="text-input"
            placeholder="e.g. Rhenium (optional)"
            value={distributor}
            onChange={(e) => setDistributor(e.target.value)}
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
      {missing.length > 0 && !saving && (
        <p className="form-missing" id="instrument-missing">
          Still needed: {missing.join(', ')}.
        </p>
      )}
    </div>
  );
}

type ManagerMode = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; instrument: Instrument };

/** The mark next to a field the form cannot be saved without. */
function Required() {
  return (
    <span className="required-mark" aria-label="required" title="Required">
      *
    </span>
  );
}

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
  // The instrument awaiting a delete confirmation, with how many reports go
  // with it (looked up when Delete is clicked, so the warning is specific).
  const phone = useMediaQuery('(max-width: 620px)');
  const [pendingDelete, setPendingDelete] = useState<{ instrument: Instrument; total: number; finalized: number } | null>(
    null
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [typeNames, setTypeNames] = useState<Record<string, string>>({});

  useEffect(() => {
    listInstrumentTypes()
      .then((rows) => setTypeNames(Object.fromEntries(rows.map((t) => [t.key, t.display_name]))))
      .catch(() => setTypeNames({}));
    // Re-read when coming back from the form: a type may have been added there.
  }, [mode.kind]);

  // Deleting an instrument deletes every report on it too (drafts and
  // finalized, whatever the instrument's status), so count them first.
  async function askToDelete(instrument: Instrument) {
    setDeleteError(null);
    try {
      const reports = await listReports({ instrument_id: instrument.id });
      setPendingDelete({
        instrument,
        total: reports.length,
        finalized: reports.filter((r) => r.status === 'finalized').length,
      });
    } catch (e) {
      setDeleteError(e instanceof ApiError ? e.message : 'Could not check this instrument’s reports.');
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteInstrument(pendingDelete.instrument.id);
      setPendingDelete(null);
      onRefresh();
    } catch (e) {
      // e.g. 409 while one of its reports has a scan still being read.
      setDeleteError(e instanceof ApiError ? e.message : 'Could not delete this instrument.');
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

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
      {deleteError && <div className="banner banner-warn">{deleteError}</div>}
      {pendingDelete && (
        <div className="banner banner-warn" role="alertdialog" aria-label="Confirm delete instrument">
          <div>
            Delete {pendingDelete.instrument.name} ({pendingDelete.instrument.serial_number})?{' '}
            {pendingDelete.total === 0
              ? 'It has no reports.'
              : `This also permanently deletes its ${pendingDelete.total} report${pendingDelete.total === 1 ? '' : 's'}${
                  pendingDelete.finalized > 0 ? ` (${pendingDelete.finalized} finalized)` : ''
                } and their scans.`}{' '}
            This cannot be undone.
          </div>
          <button type="button" className="btn small danger solid" onClick={() => void handleDelete()} disabled={deleting}>
            Confirm delete
          </button>{' '}
          <button type="button" className="btn small" onClick={() => setPendingDelete(null)} disabled={deleting}>
            Cancel
          </button>
        </div>
      )}

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
            <span>Manufacturer</span>
            <span>Distributor</span>
            <span>Model</span>
            <span>Serial number</span>
            <span>Room name</span>
            <span>Status</span>
            <span>Actions</span>
          </div>
          {instruments.map((inst) => (
            <div className="instrument-row template-row-body" key={inst.id}>
              <span data-label="Name">
                {inst.name}
                {inst.institution && <small className="muted instrument-institution">{inst.institution}</small>}
              </span>
              <span data-label="Manufacturer">{inst.manufacturer ?? '—'}</span>
              <span data-label="Distributor">{inst.distributor ?? '—'}</span>
              <span data-label="Model">
                {inst.model}
                <small className="muted"> · {typeNames[inst.instrument_type] ?? inst.instrument_type}</small>
              </span>
              <span data-label="Serial number">{inst.serial_number}</span>
              <span data-label="Room name">{inst.location ?? '—'}</span>
              <span data-label="Status">
                <span className={`status-pill instrument-status-${inst.status}`}>
                  {INSTRUMENT_STATUS_LABEL[inst.status]}
                </span>
              </span>
              <span className="template-row-actions">
                <button type="button" className="btn small" onClick={() => setMode({ kind: 'edit', instrument: inst })}>
                  Edit
                </button>
                {phone ? (
                  <RowMenu
                    label={`More actions for ${inst.name}`}
                    items={[{ label: 'Delete', danger: true, onSelect: () => void askToDelete(inst) }]}
                  />
                ) : (
                  <button type="button" className="btn small danger" onClick={() => void askToDelete(inst)}>
                    Delete
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
