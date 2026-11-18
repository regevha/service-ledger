import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  attachmentPageUrl,
  getAttachmentPageCount,
  getAttachmentPageWords,
  listFieldAliases,
  listSampleScans,
  type FieldAliasGroup,
  type FieldSource,
  type FieldType,
  type TemplateField,
  type TemplateFieldDraft,
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
import { TemplateDraftSuggestions } from './template/TemplateDraftSuggestions';

/** What the picker hands back for the field it was asked to add. The field editor fills in the rest. */
export interface PickedField {
  name: string;
  type: FieldType;
  notes: string | null;
  /** The page and box the text was picked from, so the field can be shown there later. */
  source: FieldSource;
}

interface Draft {
  id: number;
  /** The chosen words (empty for a box drawn on a page that has no text layer). */
  indexes: number[];
  box: Box;
  suggestion?: TemplateFieldDraft;
}

const IMAGE_WIDTH = 1100;
const NO_WORDS: PageWord[] = [];
const NO_ALIASES: FieldAliasGroup[] = [];
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
  attachmentForReport,
  fields,
  relatedFields,
  onAddField,
  onUpdateRegion,
}: {
  reportType: ReportType;
  model: string;
  attachmentForReport?: string;
  /** The template's fields: their names so a new field never repeats one, and the boxes of those picked from a PDF. */
  fields: TemplateField[];
  relatedFields: TemplateField[];
  onAddField: (field: PickedField) => void;
  onUpdateRegion: (index: number, source: FieldSource) => void;
}) {
  const [open, setOpen] = useState(Boolean(attachmentForReport));
  // What the server last said, tagged with the request it answers: while the tag is not the current request
  // the answer is stale and the screen shows "loading", so no effect has to reset state before it fetches.
  const sampleKey = `${reportType}|${model.trim()}`;
  const [sampleAnswer, setSampleAnswer] = useState<{ key: string; list: SampleScan[]; error: string | null } | null>(null);
  const [attachmentId, setAttachmentId] = useState(attachmentForReport ?? '');
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
  const [aliases, setAliases] = useState<FieldAliasGroup[]>(NO_ALIASES);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const nextDraftId = useRef(1);
  // The PDF on show, readable inside the promise callback that picks the first one.
  const attachmentRef = useRef(attachmentForReport ?? '');

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
        if (attachmentRef.current === attachmentForReport) return;
        if (!list.some((s) => s.attachment_id === attachmentRef.current)) chooseAttachment(attachmentForReport ?? list[0]?.attachment_id ?? '');
      })
      .catch((e: unknown) => {
        if (live) setSampleAnswer({ key: sampleKey, list: [], error: e instanceof ApiError ? e.message : 'Could not load the stored PDFs.' });
      });
    return () => {
      live = false;
    };
  }, [open, reportType, model, sampleKey, attachmentForReport]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    listFieldAliases().then((list) => { if (live) setAliases(list); }).catch(() => undefined);
    return () => { live = false; };
  }, [open]);

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

  function startDraft(indexes: number[], box: Box, suggestion?: TemplateFieldDraft) {
    setDraft({ id: nextDraftId.current++, indexes, box, suggestion });
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
    if (box.w > 0 && box.h > 0) startDraft(indexes, box);
  }

  function onDoubleClick(e: React.MouseEvent) {
    const rect = overlay.current!.getBoundingClientRect();
    const hit = wordAt(words, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    if (hit === null) return;
    const line = wordsOnLine(words, hit);
    startDraft(line, boundsOf(words, line)!);
  }

  // The fields picked from this page of a PDF, drawn back over it. Where the template was picked from another
  // sample the boxes still land on the same form, since every report of a template is the same layout.
  const markers = useMemo(() => fields.filter((f) => f.source && f.source.page === page), [fields, page]);
  const chosen = useMemo(() => new Set(draft?.indexes ?? []), [draft]);

  function add(field: PickedField) {
    onAddField(field);
    setAdded((prev) => [...prev, field.name]);
    showToast(`Added ${field.name}`);
    setDraft(null);
  }

  function updateRegion(index: number, source: FieldSource) {
    onUpdateRegion(index, source);
    showToast(`Updated the region for ${fields[index].name || 'the field'}`);
    setDraft(null);
  }

  if (!open) {
    return (
      <div className="pdf-picker-closed" data-testid="pdf-picker-closed">
        <div>
          <strong>Pick fields from a PDF</strong>
          <span>Open a stored report to add or change field regions.</span>
        </div>
        <button type="button" className="btn" data-testid="pdf-picker-open" onClick={() => setOpen(true)}>
          Pick from a PDF
        </button>
      </div>
    );
  }

  const noSamples = !attachmentForReport && samples !== null && samples.length === 0;

  return (
    <section className="pdf-picker" aria-label="Pick fields from a PDF" data-testid="pdf-picker">
      <div className="pdf-picker-bar">
        <label className="pdf-picker-sample">
          <span className="pdf-picker-label">Sample PDF</span>
          <select
            value={attachmentId}
            onChange={(e) => chooseAttachment(e.target.value)}
            disabled={!attachmentForReport && (!samples || samples.length === 0)}
            aria-label="Sample PDF"
            data-testid="pdf-picker-sample"
          >
            {attachmentForReport && <option value={attachmentForReport}>Current report</option>}
            {samples === null && !attachmentForReport && <option value="">Loading…</option>}
            {samples?.filter((s) => s.attachment_id !== attachmentForReport).map((s) => (
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
          This page has no selectable text. Drag a box around the value to place a field.
        </div>
      )}

      {attachmentId && (
        <div className="pdf-picker-stage">
          <TemplateDraftSuggestions
            key={pageKey}
            attachmentId={attachmentId}
            page={page}
            onReview={(field) => startDraft(wordsInBox(words, field.source), field.source, field)}
          />
          <div className="pdf-picker-hint">Click a word, double-click a line, or draw a box. Add a field or use the region for an existing field.</div>
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
              onPointerCancel={() => { dragStart.current = null; setDrag(null); }}
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
              {markers.map((f) => (
                <span
                  key={f.name}
                  className="pdf-marker"
                  data-testid="pdf-marker"
                  style={{ left: `${f.source!.x * 100}%`, top: `${f.source!.y * 100}%`, width: `${f.source!.w * 100}%`, height: `${f.source!.h * 100}%` }}
                >
                  <span className="pdf-marker-name">{f.name}</span>
                </span>
              ))}
              {draft && (
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
                fields={fields}
                relatedFields={relatedFields}
                aliases={aliases}
                onUpdateRegion={updateRegion}
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
  fields,
  relatedFields,
  aliases,
  onUpdateRegion,
  onAdd,
  onCancel,
}: {
  words: PageWord[];
  draft: Draft;
  page: number;
  fields: TemplateField[];
  relatedFields: TemplateField[];
  aliases: FieldAliasGroup[];
  onUpdateRegion: (index: number, source: FieldSource) => void;
  onAdd: (field: PickedField) => void;
  onCancel: () => void;
}) {
  const taken = fields.map((field) => field.name);
  const sample = draft.indexes.length > 0 ? selectedText(words, draft.indexes) : '';
  const label = labelBefore(words, draft.indexes);
  const [name, setName] = useState(() => draft.suggestion?.name ?? (draft.indexes.length > 0 ? suggestFieldName(words, draft.indexes, taken) : 'field'));
  const [type, setType] = useState<FieldType>(() => draft.suggestion?.type ?? (sample ? guessType(sample) : 'text'));
  const [notes, setNotes] = useState(() => draft.suggestion?.notes ?? suggestNotes(label, page));
  const [target, setTarget] = useState<TemplateField | null>(null);
  const targetIndex = target ? fields.indexOf(target) : -1;
  function nameKey(value: string) {
    return toFieldName(value).replaceAll('_', '');
  }
  const matchingNames = new Set([nameKey(label), nameKey(sample)].filter(Boolean));
  for (const alias of aliases) {
    const names = [alias.label ?? '', ...alias.names].map(nameKey).filter(Boolean);
    if (names.some((key) => matchingNames.has(key))) names.forEach((key) => matchingNames.add(key));
  }
  const related = [...new Map(relatedFields
    .filter((field) => matchingNames.has(nameKey(field.name)) && PICKER_TYPES.some(({ value }) => value === field.type))
    .map((field) => [field.name, field])).values()];

  const cleaned = toFieldName(name);
  const duplicate = taken.some((n) => n.toLowerCase() === cleaned);
  let problem = null;
  if (target && targetIndex < 0) problem = 'The field changed. Choose where to apply this region again.';
  if (!target && !cleaned) problem = 'Give the field a name.';
  if (!target && duplicate) problem = 'The template already has a field with this name.';

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
      aria-label="Use this region"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem) return;
        const source = { page, ...draft.box };
        if (target) onUpdateRegion(targetIndex, source);
        else onAdd({ name: cleaned, type, notes: notes.trim() || null, source });
      }}
    >
      <div className="pdf-card-title">Use this region</div>
      {sample ? <div className="pdf-card-sample" data-testid="pdf-add-sample">{sample}</div> : <div className="pdf-card-sample muted">{draft.suggestion ? 'Suggested region' : 'The area you drew'}</div>}
      {(taken.length > 0 || target) && (
        <label className="pdf-card-field">
          <span className="pdf-picker-label">Apply to</span>
          <select value={target ? targetIndex : ''} onChange={(e) => setTarget(e.target.value === '' ? null : fields[Number(e.target.value)])}>
            <option value="">New field</option>
            {target && targetIndex < 0 && <option value={-1} disabled>Choose a field again</option>}
            {taken.map((field, index) => <option key={index} value={index}>{field || `Unnamed field ${index + 1}`}</option>)}
          </select>
        </label>
      )}
      {!target && (
        <>
          {related.length > 0 && (
            <label className="pdf-card-field">
              <span className="pdf-picker-label">Related template fields</span>
              <select value={related.some((field) => field.name === name) ? name : ''} onChange={(e) => {
                const suggestion = related.find((field) => field.name === e.target.value);
                if (suggestion) {
                  setName(suggestion.name);
                  setType(suggestion.type);
                }
              }}>
                <option value="" disabled>Choose a suggestion</option>
                {related.map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}
              </select>
            </label>
          )}
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
        </>
      )}
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
          {target ? 'Set region' : 'Add field'}
        </button>
      </div>
    </form>
  );
}
