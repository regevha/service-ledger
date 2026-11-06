import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  attachmentPageUrl,
  getAttachmentPageCount,
  getAttachmentPageWords,
  listSampleScans,
  type FieldType,
  type PageWord,
  type ReportType,
  type SampleScan,
} from '../api';
import {
  PICKER_TYPES,
  boundsOf,
  guessType,
  labelBefore,
  selectedText,
  suggestFieldName,
  suggestNotes,
  toFieldName,
  wordAt,
  wordsInBox,
  wordsOnLine,
  type Box,
} from '../pdfPicker';
import { REPORT_TYPE_LABEL } from '../labels';
import { showToast } from '../toast';
import { plainMessage } from '../plainMessages';

/** What the picker hands back for the field it was asked to add. The field editor fills in the rest. */
export interface PickedField {
  name: string;
  type: FieldType;
  notes: string | null;
}

interface Draft {
  id: number;
  /** The chosen words (empty for a box drawn on a page that has no text layer). */
  indexes: number[];
  box: Box;
}

const IMAGE_WIDTH = 1100;
const NO_WORDS: PageWord[] = [];
// A drag shorter than this many pixels is a click.
const CLICK_SLOP_PX = 5;

function sampleLabel(s: SampleScan): string {
  const what = [s.instrument_model, s.instrument_serial_number].filter(Boolean).join(' · ');
  const type = s.report_type ? REPORT_TYPE_LABEL[s.report_type] : null;
  const date = s.report_date ? new Date(`${s.report_date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  return [s.file_name, what || null, type, date].filter(Boolean).join(' · ');
}

/**
 * The template editor's "pick from a PDF": a stored report's page with its words laid over it. A click
 * picks a word, a double click a whole line, a dragged box every word it touches. A small card then asks
 * for the field's name and type, with both already guessed from the text, and hands the field back to be
 * added to the template. Nothing is saved here; the template's own Save does that.
 */
export function TemplatePdfPicker({
  reportType,
  model,
  fieldNames,
  onAddField,
}: {
  reportType: ReportType;
  model: string;
  /** The names the template already has, so a new field never repeats one. */
  fieldNames: string[];
  onAddField: (field: PickedField) => void;
}) {
  const [open, setOpen] = useState(false);
  // What the server last said, tagged with the request it answers: while the tag is not the current request
  // the answer is stale and the screen shows "loading", so no effect has to reset state before it fetches.
  const sampleKey = `${reportType}|${model.trim()}`;
  const [sampleAnswer, setSampleAnswer] = useState<{ key: string; list: SampleScan[]; error: string | null } | null>(null);
  const [attachmentId, setAttachmentId] = useState('');
  const [pageCount, setPageCount] = useState(1);
  const [page, setPage] = useState(1);
  const pageKey = `${attachmentId}|${page}`;
  const [pageAnswer, setPageAnswer] = useState<{ key: string; words: PageWord[]; hasText: boolean; error: string | null } | null>(null);
  const samples = sampleAnswer && sampleAnswer.key === sampleKey && !sampleAnswer.error ? sampleAnswer.list : null;
  const samplesError = sampleAnswer && sampleAnswer.key === sampleKey ? sampleAnswer.error : null;
  const pageCurrent = pageAnswer && pageAnswer.key === pageKey ? pageAnswer : null;
  const words = pageCurrent?.words ?? NO_WORDS;
  const hasText = pageCurrent?.hasText ?? true;
  const pageError = pageCurrent?.error ?? null;
  const pageLoading = Boolean(attachmentId) && pageCurrent === null;
  const [showAll, setShowAll] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drag, setDrag] = useState<Box | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const nextDraftId = useRef(1);
  // The PDF on show, readable inside the promise callback that picks the first one.
  const attachmentRef = useRef('');

  function chooseAttachment(id: string) {
    attachmentRef.current = id;
    setAttachmentId(id);
    setPage(1);
    setPageCount(1);
    setDraft(null);
  }

  // The stored PDFs to choose from; the same report type and model come first.
  useEffect(() => {
    if (!open) return;
    let live = true;
    listSampleScans({ report_type: reportType, model: model.trim() || undefined })
      .then((list) => {
        if (!live) return;
        setSampleAnswer({ key: sampleKey, list, error: null });
        // Keep the PDF on show when it is still offered; otherwise start on the first one, at its first page.
        if (!list.some((s) => s.attachment_id === attachmentRef.current)) chooseAttachment(list[0]?.attachment_id ?? '');
      })
      .catch((e: unknown) => {
        if (live) setSampleAnswer({ key: sampleKey, list: [], error: e instanceof ApiError ? e.message : 'Could not load the stored PDFs.' });
      });
    return () => {
      live = false;
    };
  }, [open, reportType, model, sampleKey]);

  // A different PDF starts on its first page.
  useEffect(() => {
    if (!attachmentId) return;
    let live = true;
    getAttachmentPageCount(attachmentId)
      .then((r) => live && setPageCount(Math.max(1, r.page_count)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [attachmentId]);

  // The words of the page on show.
  useEffect(() => {
    if (!attachmentId) return;
    let live = true;
    getAttachmentPageWords(attachmentId, page)
      .then((r) => live && setPageAnswer({ key: pageKey, words: r.words, hasText: r.has_text, error: null }))
      .catch((e: unknown) => {
        if (live) setPageAnswer({ key: pageKey, words: [], hasText: true, error: e instanceof ApiError ? e.message : 'Could not read this page.' });
      });
    return () => {
      live = false;
    };
  }, [attachmentId, page, pageKey]);

  function goToPage(next: number) {
    setPage(next);
    setDraft(null);
  }

  function point(e: React.PointerEvent): { x: number; y: number; rect: DOMRect } {
    const rect = overlay.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
      rect,
    };
  }

  function startDraft(indexes: number[], box: Box) {
    setDraft({ id: nextDraftId.current++, indexes, box });
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const p = point(e);
    dragStart.current = { x: p.x, y: p.y };
    setDraft(null);
    setDrag({ x: p.x, y: p.y, w: 0, h: 0 });
    overlay.current?.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const start = dragStart.current;
    if (!start) return;
    const p = point(e);
    setDrag({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
  }

  function onPointerUp(e: React.PointerEvent) {
    const start = dragStart.current;
    dragStart.current = null;
    setDrag(null);
    if (!start) return;
    const p = point(e);
    const moved = Math.max(Math.abs(p.x - start.x) * p.rect.width, Math.abs(p.y - start.y) * p.rect.height);
    if (moved < CLICK_SLOP_PX) {
      const hit = wordAt(words, p.x, p.y);
      if (hit !== null) startDraft([hit], boundsOf(words, [hit])!);
      return;
    }
    const box: Box = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    const indexes = wordsInBox(words, box);
    if (indexes.length > 0) startDraft(indexes, boundsOf(words, indexes)!);
    // A page with no text layer has nothing to snap to: the drawn box itself is the pick.
    else if (!hasText) startDraft([], box);
  }

  function onDoubleClick(e: React.MouseEvent) {
    const rect = overlay.current!.getBoundingClientRect();
    const hit = wordAt(words, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    if (hit === null) return;
    const line = wordsOnLine(words, hit);
    startDraft(line, boundsOf(words, line)!);
  }

  const chosen = useMemo(() => new Set(draft?.indexes ?? []), [draft]);

  function add(field: PickedField) {
    onAddField(field);
    setAdded((prev) => [...prev, field.name]);
    showToast(`Added ${field.name}`);
    setDraft(null);
  }

  if (!open) {
    return (
      <div className="pdf-picker-closed" data-testid="pdf-picker-closed">
        <div>
          <strong>Pick fields from a PDF</strong>
          <span>Open a stored report and click or drag over its text to add it as a field.</span>
        </div>
        <button type="button" className="btn" data-testid="pdf-picker-open" onClick={() => setOpen(true)}>
          Pick from a PDF
        </button>
      </div>
    );
  }

  const noSamples = samples !== null && samples.length === 0;

  return (
    <section className="pdf-picker" aria-label="Pick fields from a PDF" data-testid="pdf-picker">
      <div className="pdf-picker-bar">
        <label className="pdf-picker-sample">
          <span className="pdf-picker-label">Sample PDF</span>
          <select
            value={attachmentId}
            onChange={(e) => chooseAttachment(e.target.value)}
            disabled={!samples || samples.length === 0}
            aria-label="Sample PDF"
            data-testid="pdf-picker-sample"
          >
            {samples === null && <option value="">Loading…</option>}
            {samples?.map((s) => (
              <option key={s.attachment_id} value={s.attachment_id}>
                {sampleLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <div className="pdf-picker-pages" role="group" aria-label="Page">
          <button type="button" className="btn small" aria-label="Previous page" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
            ‹
          </button>
          <span data-testid="pdf-picker-page">
            Page {page} of {pageCount}
          </span>
          <button type="button" className="btn small" aria-label="Next page" disabled={page >= pageCount} onClick={() => goToPage(page + 1)}>
            ›
          </button>
        </div>
        <label className="pdf-picker-toggle">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all selectable text
        </label>
        <button type="button" className="btn small" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      {samplesError && (
        <div className="banner banner-warn" role="alert">
          {plainMessage(samplesError)}
        </div>
      )}
      {noSamples && (
        <div className="empty-hint" data-testid="pdf-picker-empty">
          There is no stored PDF to pick from yet. Upload a service report on the New report tab first, then come back.
        </div>
      )}
      {pageError && (
        <div className="banner banner-warn" role="alert">
          {plainMessage(pageError)}
        </div>
      )}
      {attachmentId && !pageError && !hasText && !pageLoading && (
        <div className="banner banner-info" data-testid="pdf-picker-no-text">
          This page has no text layer, so words cannot be picked. Drag a box around the value and name the field yourself.
        </div>
      )}

      {attachmentId && (
        <div className="pdf-picker-stage">
          <div className="pdf-picker-hint">Click a word, double-click a line, or drag a box around the text. A card then asks what to call the field.</div>
          <div className="pdf-picker-page">
            <img
              className="pdf-picker-image"
              src={attachmentPageUrl(attachmentId, page, IMAGE_WIDTH)}
              alt={`Sample PDF page ${page} of ${pageCount}`}
              draggable={false}
            />
            <div
              ref={overlay}
              className={`pdf-picker-overlay${showAll ? ' show-all' : ''}`}
              role="group"
              aria-label="Page text: click a word or drag a box to add a field"
              data-testid="pdf-picker-overlay"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onDoubleClick={onDoubleClick}
            >
              {words.map((w, i) => (
                <span
                  key={i}
                  className={`pdf-word${chosen.has(i) ? ' chosen' : ''}`}
                  data-testid="pdf-word"
                  style={{ left: `${w.x * 100}%`, top: `${w.y * 100}%`, width: `${w.w * 100}%`, height: `${w.h * 100}%` }}
                >
                  <span className="pdf-word-text">{w.text}</span>
                </span>
              ))}
              {draft && draft.indexes.length === 0 && (
                <span
                  className="pdf-box chosen"
                  style={{ left: `${draft.box.x * 100}%`, top: `${draft.box.y * 100}%`, width: `${draft.box.w * 100}%`, height: `${draft.box.h * 100}%` }}
                />
              )}
              {drag && drag.w + drag.h > 0 && (
                <span
                  className="pdf-box rubber"
                  style={{ left: `${drag.x * 100}%`, top: `${drag.y * 100}%`, width: `${drag.w * 100}%`, height: `${drag.h * 100}%` }}
                />
              )}
            </div>
            {draft && (
              <AddFieldCard
                key={draft.id}
                words={words}
                draft={draft}
                page={page}
                taken={[...fieldNames, ...added]}
                onAdd={add}
                onCancel={() => setDraft(null)}
              />
            )}
          </div>
        </div>
      )}

      {added.length > 0 && (
        <div className="pdf-picker-added" data-testid="pdf-picker-added">
          <span className="pdf-picker-label">Added from this PDF</span>
          {added.map((name, i) => (
            <span key={`${name}-${i}`} className="pdf-picker-chip">
              {name}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function AddFieldCard({
  words,
  draft,
  page,
  taken,
  onAdd,
  onCancel,
}: {
  words: PageWord[];
  draft: Draft;
  page: number;
  taken: string[];
  onAdd: (field: PickedField) => void;
  onCancel: () => void;
}) {
  const sample = draft.indexes.length > 0 ? selectedText(words, draft.indexes) : '';
  const label = labelBefore(words, draft.indexes);
  const [name, setName] = useState(() => (draft.indexes.length > 0 ? suggestFieldName(words, draft.indexes, taken) : 'field'));
  const [type, setType] = useState<FieldType>(() => (sample ? guessType(sample) : 'text'));
  const [notes, setNotes] = useState(() => suggestNotes(label, page));

  const cleaned = toFieldName(name);
  const duplicate = taken.some((n) => n.toLowerCase() === cleaned);
  const problem = !cleaned ? 'Give the field a name.' : duplicate ? 'The template already has a field with this name.' : null;

  // Under the picked text, flipped to the left edge when the text is on the right half so the card stays on the page.
  const onRight = draft.box.x > 0.5;
  const style: React.CSSProperties = {
    top: `calc(${(draft.box.y + draft.box.h) * 100}% + 8px)`,
    ...(onRight ? { right: `${(1 - (draft.box.x + draft.box.w)) * 100}%` } : { left: `${draft.box.x * 100}%` }),
  };

  return (
    <form
      className="pdf-card"
      style={style}
      data-testid="pdf-add-card"
      aria-label="Add as a new field"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) onAdd({ name: cleaned, type, notes: notes.trim() || null });
      }}
    >
      <div className="pdf-card-title">Add as a new field</div>
      {sample ? <div className="pdf-card-sample" data-testid="pdf-add-sample">{sample}</div> : <div className="pdf-card-sample muted">The area you drew</div>}
      <label className="pdf-card-field">
        <span className="pdf-picker-label">Field name</span>
        <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Field name" autoFocus />
      </label>
      <label className="pdf-card-field">
        <span className="pdf-picker-label">Type</span>
        <select value={type} onChange={(e) => setType(e.target.value as FieldType)} aria-label="Field type">
          {PICKER_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="pdf-card-field">
        <span className="pdf-picker-label">Where to find it (helps the reader)</span>
        <input className="text-input" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Where to find it" />
      </label>
      {problem && (
        <div className="pdf-card-problem" role="alert">
          {problem}
        </div>
      )}
      <div className="pdf-card-actions">
        <button type="button" className="btn small" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn small primary" disabled={problem !== null}>
          Add field
        </button>
      </div>
    </form>
  );
}
