import { useEffect, useState } from 'react';
import {
  ApiError,
  createInstrument,
  listInstrumentModels,
  listInstrumentTypes,
  type ClassificationResult,
  type Instrument,
  type InstrumentModel,
  type InstrumentType,
} from '../api';

/**
 * Shown on the classification screen when the document's instrument is not in
 * the fleet (ClassificationResult.maker_in_fleet === false). The technician
 * adds it right here, with what the document says already filled in, and the
 * document is classified again against the new fleet.
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
  const [model, setModel] = useState(classification.detected_model ?? '');
  const [name, setName] = useState(classification.detected_model ?? '');
  const [manufacturer, setManufacturer] = useState(classification.detected_manufacturer ?? '');
  // The form's issuer is usually the company that sold or services the
  // instrument, not its maker, so it goes in the distributor field.
  const [distributor, setDistributor] = useState(classification.issuer ?? '');
  const [serial, setSerial] = useState(classification.instrument_serial?.value ?? '');
  const [room, setRoom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [knownModels, setKnownModels] = useState<InstrumentModel[]>([]);

  useEffect(() => {
    listInstrumentModels()
      .then(setKnownModels)
      .catch(() => setKnownModels([]));
  }, []);

  // A model that already exists has one instrument type; the new instrument has to match it.
  useEffect(() => {
    const match = knownModels.find((m) => m.name === model.trim());
    if (match) setTypeKey(match.instrument_type);
  }, [knownModels, model]);

  useEffect(() => {
    listInstrumentTypes()
      .then((list) => {
        setTypes(list);
        setTypeKey((current) => current || list[0]?.key || '');
      })
      .catch(() => setError('Could not load the instrument types.'));
  }, []);

  const ready = [name, model, manufacturer, serial].every((v) => v.trim() !== '') && typeKey !== '';

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
        The document looks like {classification.detected_manufacturer ? `a ${classification.detected_manufacturer} ` : 'an '}
        {classification.detected_model ?? 'instrument'} that has not been added yet
        {classification.issuer ? `, on a form from ${classification.issuer}` : ''}. Add it here, check the details, and the document is classified
        again.
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
          <input className="text-input" value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} aria-label="Instrument manufacturer" />
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
          <span className="clabel">Room name (optional)</span>
          <input className="text-input" value={room} onChange={(e) => setRoom(e.target.value)} aria-label="Instrument room name" />
        </label>
      </div>
      {error && <div className="banner banner-crit">{error}</div>}
      <div className="cta-row">
        <button className="btn primary" disabled={disabled || !ready} onClick={() => void submit()}>
          Add instrument &amp; classify again →
        </button>
      </div>
    </div>
  );
}
