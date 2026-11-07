import { type ClassificationResult, type Instrument, type ReportType, type SerialMatch } from '../../api';
import { SERIAL_MATCH_NOTE } from './serialNotices';
import { REPORT_TYPE_LABEL } from '../../labels';
import { ConfidenceBadge, classificationLabel } from '../ConfidenceBadge';
import { AddInstrumentPanel } from '../AddInstrumentPanel';
import { PhoneScanSwitch, ScanSplit, ScanToggleButton, useScanPreview } from '../ScanPreview';

export function ConfirmClassificationScreen({
  classification,
  instruments,
  pickInstrumentId,
  setPickInstrumentId,
  pickReportType,
  setPickReportType,
  classificationConfidenceThreshold,
  onConfirm,
  onInstrumentAdded,
  busy,
  originalScanUrl,
  scanInlineUrl,
  scanAttachmentId,
}: {
  classification: ClassificationResult;
  instruments: Instrument[];
  pickInstrumentId: string;
  setPickInstrumentId: (v: string) => void;
  pickReportType: ReportType | '';
  setPickReportType: (v: ReportType) => void;
  classificationConfidenceThreshold: number;
  onConfirm: () => void;
  onInstrumentAdded: (instrument: Instrument) => void;
  busy: boolean;
  // The uploaded document, shown the same way as on the review screen.
  originalScanUrl?: string;
  scanInlineUrl?: string;
  scanAttachmentId?: string;
}) {
  const preview = useScanPreview(scanInlineUrl, scanAttachmentId);
  const serial = classification.instrument_serial ?? null;
  const match: SerialMatch = classification.serial_match ?? 'not_read';
  const noteType = classification.report_type_note as ReportType | null | undefined;
  // Say which reads were uncertain, and outline those rows, instead of a general "check it".
  const threshold = classificationConfidenceThreshold;
  const modelUnsure = classification.instrument.confidence < threshold;
  const unitUnsure = !pickInstrumentId || match === 'model_conflict';
  const typeUnsure = classification.report_type.confidence < threshold;
  const reasons = [
    typeUnsure ? 'The report type was not clear on the document.' : '',
    modelUnsure ? 'The instrument model was not clear on the document.' : '',
    match === 'model_conflict' ? 'The serial number belongs to a different model than the one read.' : '',
    !pickInstrumentId && !modelUnsure && match !== 'model_conflict' ? 'The instrument could not be told from the document.' : '',
  ].filter(Boolean);
  return (
    <>
    {(classification.maker_in_fleet === false || (match === 'not_found' && !!serial)) && (
      <AddInstrumentPanel classification={classification} busy={busy} onAdded={onInstrumentAdded} />
    )}
    <div className="section">
      <div className="section-title-row">
        <div>
          <div className="section-title">Detected from the document</div>
          <p className="hint-text" data-testid="classify-reason">
            {reasons.length > 0 ? `${reasons.join(' ')} Check the outlined rows, then continue.` : 'Check the instrument and the report type, then continue.'}
          </p>
        </div>
        <div className="section-title-actions">
          <ScanToggleButton preview={preview} />
          {originalScanUrl && !(preview.phone && preview.phoneScan) && (
            <a className="btn small" href={originalScanUrl} target="_blank" rel="noreferrer">
              View original scan
            </a>
          )}
        </div>
      </div>

      <PhoneScanSwitch preview={preview} />

      <ScanSplit preview={preview}>

      <div className="read-row" id="read-model">
        <div className="crow-top">
          <span className="clabel">Instrument model</span>
          <ConfidenceBadge
            confidence={classification.instrument.confidence}
            threshold={classificationConfidenceThreshold}
            label={classificationLabel(classification.reader, classification.instrument.confidence)}
          />
        </div>
        <div className="read-value">
          {classification.maker_in_fleet === false
            ? `${[classification.detected_manufacturer, classification.detected_model].filter(Boolean).join(' ') || 'Unknown'} (not in your fleet)`
            : classification.instrument.value || '—'}
        </div>
      </div>

      {classification.issuer && (
        <div className="read-row" id="read-issuer">
          <div className="crow-top">
            <span className="clabel">Form issued by</span>
          </div>
          <div className="read-value">{classification.issuer}</div>
        </div>
      )}

      <div className="read-row" id="read-serial">
        <div className="crow-top">
          <span className="clabel">Serial number</span>
          <ConfidenceBadge
            confidence={serial ? serial.confidence : 0}
            threshold={classificationConfidenceThreshold}
            label={serial ? classificationLabel(classification.reader, serial.confidence) : 'not found'}
          />
        </div>
        <div className="read-value">{serial ? serial.value : '—'}</div>
        <div className="field-note">{SERIAL_MATCH_NOTE[match]}</div>
      </div>

      <div className={`class-row${unitUnsure || modelUnsure ? ' uncertain' : ''}`} data-testid="class-row">
        <div className="crow-top">
          <span className="clabel">Instrument</span>
          <ConfidenceBadge
            confidence={pickInstrumentId && match !== 'model_conflict' ? 1 : 0}
            threshold={classificationConfidenceThreshold}
            label={
              !pickInstrumentId
                ? 'choose one'
                : match === 'model_conflict'
                  ? 'check this'
                  : match === 'matched'
                    ? 'matched by serial'
                    : 'suggested'
            }
          />
        </div>
        <select value={pickInstrumentId} onChange={(e) => setPickInstrumentId(e.target.value)}>
          {/* Keyed and valued by instrument id, not model: model isn't unique
              across the fleet (InstrumentManager.tsx doesn't enforce it, and
              only serial_number has a backend uniqueness check), so a
              model-valued <option> would give two different instruments the
              same <select> value — picking either one would then resolve to
              whichever instrument the id lookup happened to return, silently
              attributing the report to the wrong physical unit.
              The disabled placeholder is what shows when nothing is
              pre-selected (no guessed-model match, or several): without it,
              a value of '' matched no option, the browser displayed the
              first instrument as if selected, and choosing that same option
              fired no onChange — so Confirm stayed disabled. */}
          <option value="" disabled>
            Select instrument…
          </option>
          {instruments.map((inst) => (
            <option key={inst.id} value={inst.id}>
              {inst.model} ({inst.serial_number})
            </option>
          ))}
        </select>
      </div>

      <div className={`class-row${typeUnsure || !pickReportType ? ' uncertain' : ''}`} data-testid="class-row">
        <div className="crow-top">
          <span className="clabel">Report type</span>
          <ConfidenceBadge
            confidence={classification.report_type.confidence}
            threshold={classificationConfidenceThreshold}
            label={classificationLabel(
              classification.reader,
              classification.report_type.confidence,
              classification.report_type_source === 'task_code',
            )}
          />
        </div>
        <select value={pickReportType} onChange={(e) => setPickReportType(e.target.value as ReportType)}>
          {/* Below the confidence threshold nothing is pre-selected, so one click cannot accept a guess. */}
          <option value="" disabled>
            Select report type…
          </option>
          {(Object.keys(REPORT_TYPE_LABEL) as ReportType[]).map((rt) => (
            <option key={rt} value={rt}>
              {REPORT_TYPE_LABEL[rt]}
            </option>
          ))}
        </select>
        {classification.report_type_note && (
          <div className="field-note" id="report-type-note">
            This visit also looks like: {noteType && REPORT_TYPE_LABEL[noteType] ? REPORT_TYPE_LABEL[noteType] : classification.report_type_note}.
          </div>
        )}
      </div>

      <div className="cta-row">
        <button className="btn primary" disabled={!pickInstrumentId || !pickReportType} onClick={onConfirm}>
          Confirm &amp; continue to extraction →
        </button>
      </div>
      </ScanSplit>
    </div>
    </>
  );
}
