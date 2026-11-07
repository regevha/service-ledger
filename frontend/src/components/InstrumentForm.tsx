import { useEffect, useState } from 'react';
import {
  ApiError,
  createInstrument,
  createInstrumentType,
  listInstrumentModels,
  listInstrumentTypes,
  listPlaces,
  updateInstrument,
  type Instrument,
  type InstrumentStatus,
  type InstrumentModel,
  type InstrumentType,
  type Place,
} from '../api';
import { INSTRUMENT_STATUS_LABEL } from '../labels';
import { matchTypedPlaces, typedPlaceHint } from '../placeUtils';
import { useMakerNames } from './MakerSuggestions';
import { SuggestInput } from './SuggestInput';

const STATUS_OPTIONS: InstrumentStatus[] = ['active', 'maintenance', 'retired'];

export function InstrumentFormScreen({
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
  const [typeKey, setTypeKey] = useState(existing?.instrument_type ?? '');
  const [newTypeName, setNewTypeName] = useState<string | null>(null);
  const [knownModels, setKnownModels] = useState<InstrumentModel[]>([]);
  const [knownPlaces, setKnownPlaces] = useState<Place[]>([]);
  const makerNames = useMakerNames();

  useEffect(() => {
    listInstrumentTypes()
      .then((list) => {
        setTypes(list);
        // A new instrument starts with the default type (an existing one keeps its own).
        setTypeKey((current) => current || (list.find((t) => t.is_default)?.key ?? list[0]?.key ?? ''));
      })
      .catch(() => setTypes([]));
    listInstrumentModels()
      .then(setKnownModels)
      .catch(() => setKnownModels([]));
    listPlaces()
      .then(setKnownPlaces)
      .catch(() => setKnownPlaces([]));
  }, []);

  // The model typed is one that already exists (exact name), or a new one.
  const matchedModel = knownModels.find((m) => m.name === model.trim());
  // Places already on record: the institution typed is one of them (ignoring case
  // and spaces) or a new one; rooms offered are those in the institution typed.
  const { roomsHere } = matchTypedPlaces(knownPlaces, institution, location);
  const placeHint = typedPlaceHint(knownPlaces, institution, location);

  // An instrument's manufacturer follows its model: with an existing model that
  // has one, it is shown read-only and changed only on the model.
  const lockedManufacturer = matchedModel?.manufacturer ?? null;

  // Choosing an existing model fills in its type for a new instrument. An
  // effect, so it also applies when the list arrives after typing.
  const matchedId = matchedModel?.id;
  useEffect(() => {
    if (existing || !matchedModel) return;
    setTypeKey(matchedModel.instrument_type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedId]);

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
          manufacturer: (lockedManufacturer ?? manufacturer).trim() || null,
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
          manufacturer: (lockedManufacturer ?? manufacturer).trim(),
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
    existing === undefined && (lockedManufacturer ?? manufacturer).trim().length === 0 ? 'manufacturer' : null,
    serialNumber.trim().length === 0 ? 'serial number' : null,
  ].filter((m): m is string => m !== null);
  const roomWithoutInstitution = location.trim() !== '' && institution.trim() === '';
  const canSave = missing.length === 0 && !roomWithoutInstitution && !saving;

  return (
    <div className="section">
      <button type="button" className="btn small back-link" onClick={onCancel}>
        ← Back to instruments
      </button>

      <div className="section-title">{existing ? 'Edit instrument' : 'New instrument'}</div>

      {error && <div className="banner banner-crit">{error}</div>}

      <div className="schema-form-row type-row">
        <label className="schema-form-label" data-testid="form-label">
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
            <button type="button" className="btn small add-type-link" onClick={() => setNewTypeName('')}>
              + Add a type
            </button>
          ) : (
            <div className="schema-form-label" data-testid="form-label">
              New type name
              <input
                type="text"
                className="text-input"
                placeholder="e.g. Electron microscope"
                value={newTypeName}
                autoFocus
                enterKeyHint="done"
                onChange={(e) => setNewTypeName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleAddType();
                  }
                }}
              />
              <span className="type-adder-actions">
                <button type="button" className="btn small" onClick={() => void handleAddType()}>
                  Add
                </button>
                <button type="button" className="btn small" onClick={() => setNewTypeName(null)}>
                  Cancel
                </button>
              </span>
            </div>
          ))}
      </div>

      {!existing && matchedModel && (
        <small className="muted type-follows-hint">The type follows the model.</small>
      )}

      <div className="schema-form-row">
        <label className="schema-form-label" data-testid="form-label">
          <span>Name <Required /></span>
          <input
            type="text"
            className="text-input"
            placeholder="e.g. Aurora — Core Lab"
            autoCapitalize="words"
            enterKeyHint="next"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="schema-form-label" data-testid="form-label">
          <span>Model <Required /></span>
          <SuggestInput
            className="text-input"
            placeholder="e.g. Aurora"
            value={model}
            onChange={setModel}
            options={knownModels.map((m) => m.name)}
          />
          {model.trim() !== '' && (
            <small className="muted model-hint" id="model-hint">
              {matchedModel
                ? `Existing model · ${matchedModel.unit_count} instrument${matchedModel.unit_count === 1 ? '' : 's'}`
                : 'New model · it will be added to Models'}
            </small>
          )}
        </label>
      </div>

      <div className="schema-form-row">
        <div className="field-with-hint">
          <label className="schema-form-label" data-testid="form-label">
            <span>Manufacturer {!existing && <Required />}</span>
            <SuggestInput
              className="text-input"
              placeholder="e.g. Cytek Biosciences"
              value={lockedManufacturer ?? manufacturer}
              onChange={setManufacturer}
              options={makerNames}
              disabled={lockedManufacturer !== null}
            />
          </label>
          {lockedManufacturer !== null && (
            <small className="muted manufacturer-lock-hint">Set by the model. Change it on the Models screen.</small>
          )}
        </div>
        <label className="schema-form-label" data-testid="form-label">
          <span>Serial number <Required /></span>
          <input type="text" className="text-input" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
        </label>
      </div>

      <div className="schema-form-row">
        <label className="schema-form-label" data-testid="form-label">
          Institute
          <SuggestInput
            className="text-input"
            placeholder="e.g. Bar-Ilan University (optional)"
            value={institution}
            onChange={setInstitution}
            options={knownPlaces.filter((p) => p.kind === 'institution').map((p) => p.name)}
          />
        </label>
        <label className="schema-form-label" data-testid="form-label">
          Room name
          <SuggestInput
            className="text-input"
            placeholder="e.g. Core Lab"
            value={location}
            onChange={setLocation}
            options={roomsHere.map((p) => p.name)}
          />
        </label>
        <label className="schema-form-label" data-testid="form-label">
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

      {placeHint && (
        <small className="muted place-hint" id="place-hint">
          {placeHint}
        </small>
      )}

      {/* A brand-new instrument is always created active (schemas.py's
          InstrumentCreate has no status field) — status only becomes
          something to change once the instrument already exists. */}
      {existing && (
        <div className="schema-form-row">
          <label className="schema-form-label" data-testid="form-label">
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

      {missing.length > 0 && !saving && (
        <p className="form-missing" id="instrument-missing">
          Still needed: {missing.join(', ')}.
        </p>
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

/** The mark next to a field the form cannot be saved without. */
export function Required() {
  return (
    <span className="required-mark" aria-label="required" title="Required">
      *
    </span>
  );
}
