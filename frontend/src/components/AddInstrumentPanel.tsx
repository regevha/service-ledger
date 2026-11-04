import { useEffect, useState } from 'react';
import {
  ApiError,
  createInstrument,
  listInstrumentModels,
  listInstrumentTypes,
  listPlaces,
  type ClassificationResult,
  type Instrument,
  type InstrumentModel,
  type InstrumentType,
  type Place,
} from '../api';
import { matchTypedPlaces, typedPlaceHint } from '../placeUtils';
import { useMakerNames } from './MakerSuggestions';
import { SuggestInput } from './SuggestInput';

/**
 * Shown on the classification screen when the document's instrument is not in
 * the fleet: another maker's instrument (maker_in_fleet === false), or one of
 * the fleet's own models whose serial is not registered (serial_match ===
 * 'not_found'). The technician adds it right here, with what the document says
 * already filled in, and the document is classified again against the new fleet.
 */
export function AddInstrumentPanel({
  classification,
  busy,
  onAdded,
}: {
  classification: ClassificationResult;
  busy: boolean;
  /** Called with the new instrument; the caller classifies the document again. */
  onAdded: (instrument: Instrument) => void;
}) {
  const [types, setTypes] = useState<InstrumentType[]>([]);
  const [typeKey, setTypeKey] = useState('');
  // Another maker's form names its model; a fleet model's form is read as that model.
  const otherMaker = classification.maker_in_fleet === false;
  const startModel = classification.detected_model ?? (otherMaker ? '' : classification.instrument.value);
  const [model, setModel] = useState(startModel);
  const [name, setName] = useState(startModel);
  const [manufacturer, setManufacturer] = useState(classification.detected_manufacturer ?? '');
  // The form's issuer is usually the company that sold or services the
  // instrument, not its maker, so it goes in the distributor field.
  const [distributor, setDistributor] = useState(classification.issuer ?? '');
  const [serial, setSerial] = useState(classification.instrument_serial?.value ?? '');
  const [institute, setInstitute] = useState('');
  const makerNames = useMakerNames();
  const [room, setRoom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [knownModels, setKnownModels] = useState<InstrumentModel[]>([]);
  const [knownPlaces, setKnownPlaces] = useState<Place[]>([]);

  useEffect(() => {
    listInstrumentModels()
      .then(setKnownModels)
      .catch(() => setKnownModels([]));
    listPlaces()
      .then(setKnownPlaces)
      .catch(() => setKnownPlaces([]));
  }, []);

  // A model that already exists has one instrument type; the new instrument has to match it.
  useEffect(() => {
    const match = knownModels.find((m) => m.name === model.trim());
    if (match) {
      setTypeKey(match.instrument_type);
      // A model already in the fleet knows its maker.
      if (match.manufacturer) setManufacturer((current) => current || match.manufacturer || '');
    }
  }, [knownModels, model]);

  useEffect(() => {
    listInstrumentTypes()
      .then((list) => {
        setTypes(list);
        setTypeKey((current) => current || (list.find((t) => t.is_default)?.key ?? list[0]?.key ?? ''));
      })
      .catch(() => setError('Could not load the instrument types.'));
  }, []);

  // The institute typed is one that exists (ignoring case and spaces) or a new one, created when the instrument is saved,
  // exactly as on the Instruments tab. A room is only meaningful inside an institute.
  const { roomsHere } = matchTypedPlaces(knownPlaces, institute, room);
  const placeHint = typedPlaceHint(knownPlaces, institute, room);
  const roomWithoutInstitute = room.trim() !== '' && institute.trim() === '';
  const ready = [name, model, manufacturer, serial].every((v) => v.trim() !== '') && typeKey !== '' && !roomWithoutInstitute;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const created = await createInstrument({
        name: name.trim(),
        instrument_type: typeKey,
        model: model.trim(),
        manufacturer: manufacturer.trim(),
        distributor: distributor.trim() || null,
        serial_number: serial.trim(),
        institution: institute.trim() || null,
        location: room.trim() || null,
      });
      onAdded(created);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add the instrument.');
    } finally {
      setSaving(false);
    }
  }

  const disabled = busy || saving;
  return (
    <div className="section add-instrument-panel" id="add-instrument-panel">
      <div className="section-title">This instrument is not in your fleet</div>
      <p className="hint-text">
        {otherMaker ? (
          <>
            The document looks like {classification.detected_manufacturer ? `a ${classification.detected_manufacturer} ` : 'an '}
            {classification.detected_model ?? 'instrument'} that has not been added yet
            {classification.issuer ? `, on a form from ${classification.issuer}` : ''}.
          </>
        ) : (
          <>The serial number on the document, {classification.instrument_serial?.value}, is not registered under {classification.instrument.value}.</>
        )}{' '}
        Add it here, check the details, and the document is classified again.
      </p>
      <div className="add-instrument-grid">
        <label>
          <span className="clabel">Name</span>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Instrument name" />
        </label>
        <label>
          <span className="clabel">Kind of instrument</span>
          <select value={typeKey} onChange={(e) => setTypeKey(e.target.value)} aria-label="Instrument type">
            {types.map((t) => (
              <option key={t.key} value={t.key}>
                {t.display_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="clabel">Model</span>
          <input className="text-input" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Instrument model" />
        </label>
        <label>
          <span className="clabel">Manufacturer</span>
          <SuggestInput className="text-input" value={manufacturer} onChange={setManufacturer} aria-label="Instrument manufacturer" options={makerNames} />
        </label>
        <label>
          <span className="clabel">Distributor (optional)</span>
          <input className="text-input" value={distributor} onChange={(e) => setDistributor(e.target.value)} aria-label="Instrument distributor" />
        </label>
        <label>
          <span className="clabel">Serial number</span>
          <input className="text-input" value={serial} onChange={(e) => setSerial(e.target.value)} aria-label="Instrument serial number" autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
        </label>
        <label>
          <span className="clabel">Institute (optional)</span>
          <SuggestInput
            className="text-input"
            value={institute}
            placeholder="e.g. Bar-Ilan University"
            onChange={setInstitute}
            aria-label="Instrument institute"
            options={knownPlaces.filter((p) => p.kind === 'institution').map((p) => p.name)}
          />
        </label>
        <label>
          <span className="clabel">Room name (optional)</span>
          <SuggestInput
            className="text-input"
            value={room}
            onChange={setRoom}
            aria-label="Instrument room name"
            options={roomsHere.map((p) => p.name)}
          />
        </label>
      </div>
      {placeHint && (
        <small className="muted place-hint" id="add-instrument-place-hint">
          {placeHint}
        </small>
      )}
      {error && <div className="banner banner-crit">{error}</div>}
      <div className="cta-row">
        <button className="btn primary" disabled={disabled || !ready} onClick={() => void submit()}>
          Add instrument &amp; classify again →
        </button>
      </div>
    </div>
  );
}
