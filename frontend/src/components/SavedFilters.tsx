import { useState } from 'react';
import {
  createSavedFilter,
  deleteSavedFilter,
  listSavedFilters,
  type ReportFilters,
  type SavedFilter,
} from '../api';
import { useAsyncEffect } from '../hooks/useAsyncEffect';

const KEYS = ['instrument_id', 'model_id', 'place_id', 'report_type', 'status', 'date_from', 'date_to', 'technician', 'q'] as const;

/** Only the saved-filter criteria (the filters and the search text), with empty values dropped, so two filter objects compare by content. */
function criteria(f: ReportFilters): ReportFilters {
  const out: ReportFilters = {};
  for (const k of KEYS) {
    const v = f[k];
    if (v) (out as Record<string, string>)[k] = v;
  }
  return out;
}

/** What was actually applied: the saved criteria, minus an instrument, model or place that no longer exists. */
function withoutGone(saved: SavedFilter): ReportFilters {
  const next = { ...saved.filters };
  for (const key of saved.stale_keys ?? []) delete next[key];
  return next;
}

/** "instrument", "model", "place" or a mix: what a stale saved filter points at. */
function goneLabel(saved: SavedFilter): string {
  const keys = saved.stale_keys ?? [];
  return [keys.includes('instrument_id') ? 'instrument' : '', keys.includes('model_id') ? 'model' : '', keys.includes('place_id') ? 'place' : '']
    .filter(Boolean)
    .join(' and ');
}

const GONE_NOTICE: Record<'instrument_id' | 'model_id' | 'place_id', string> = {
  instrument_id: 'The saved instrument no longer exists, so that filter was left out.',
  model_id: 'The saved model no longer exists, so that filter was left out.',
  place_id: 'The saved place no longer exists, so that filter was left out.',
};

function sameCriteria(a: ReportFilters, b: ReportFilters): boolean {
  const ca = criteria(a);
  const cb = criteria(b);
  return KEYS.every((k) => (ca[k] ?? '') === (cb[k] ?? ''));
}

// The "Saved filters" controls on the Reports list: pick one of the shared
// named filter combinations, save the current one, or delete the selected one.
// Applying a saved filter only fills the list's own controls; the list then
// loads through the ordinary GET /reports, so there is one filtering path.
export function SavedFilters({
  filters,
  onApply,
}: {
  filters: ReportFilters;
  /** Replace the list's filters with these. */
  onApply: (filters: ReportFilters) => void;
}) {
  const [items, setItems] = useState<SavedFilter[]>([]);
  const [cap, setCap] = useState(5);
  const [activeId, setActiveId] = useState('');
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Bumped after a save or delete to refetch the shared list.
  const [reloadNonce, setReloadNonce] = useState(0);
  const reload = () => setReloadNonce((n) => n + 1);

  useAsyncEffect(
    async (isCancelled) => {
      const res = await listSavedFilters();
      if (isCancelled()) return;
      setItems(res.items);
      setCap(res.cap);
    },
    [reloadNonce],
    'Could not load saved filters.'
  );

  const active = items.find((i) => i.id === activeId) ?? null;
  const hasCriteria = Object.keys(criteria(filters)).length > 0;
  const full = items.length >= cap;
  // Edited since it was applied. A stale filter is compared without its
  // dropped instrument, model or place, since that is what was actually applied.
  const changed = active ? !sameCriteria(filters, withoutGone(active)) : false;

  function apply(id: string) {
    setError(null);
    setNotice(null);
    setConfirmingDelete(false);
    setNaming(false);
    setActiveId(id);
    const chosen = items.find((i) => i.id === id);
    if (!chosen) return;
    if (chosen.stale) setNotice((chosen.stale_keys ?? []).map((k) => GONE_NOTICE[k]).join(' '));
    onApply(withoutGone(chosen));
  }

  async function save() {
    setError(null);
    try {
      const created = await createSavedFilter(name, criteria(filters));
      setNaming(false);
      setName('');
      reload();
      setActiveId(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the filter.');
    }
  }

  async function remove() {
    if (!active) return;
    setError(null);
    try {
      await deleteSavedFilter(active.id);
      setConfirmingDelete(false);
      setActiveId('');
      setNotice(null);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the filter.');
    }
  }

  return (
    <div className="saved-filters" data-testid="saved-filters">
      <select aria-label="Saved filters" value={activeId} onChange={(e) => apply(e.target.value)}>
        <option value="">
          Saved filters ({items.length} of {cap})
        </option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.stale ? '⚠ ' : ''}
            {i.name}
            {i.stale ? ` (${goneLabel(i)} no longer exists)` : ''}
          </option>
        ))}
      </select>

      {!naming && (
        <button
          className="btn small"
          disabled={!hasCriteria || full}
          title={
            full
              ? `${cap} saved filters already exist. Delete one first.`
              : hasCriteria
                ? 'Save the current filters and search.'
                : 'Set at least one filter, or type a search of two or more characters, first.'
          }
          onClick={() => {
            setNaming(true);
            setError(null);
            setConfirmingDelete(false);
          }}
        >
          Save this filter
        </button>
      )}

      {naming && (
        <span className="saved-filter-name">
          <input
            type="text"
            aria-label="Saved filter name"
            placeholder="Name"
            maxLength={60}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) void save();
              if (e.key === 'Escape') setNaming(false);
            }}
          />
          <button className="btn small primary" disabled={!name.trim()} onClick={() => void save()}>
            Save
          </button>
          <button
            className="btn small"
            onClick={() => {
              setNaming(false);
              setName('');
              setError(null);
            }}
          >
            Cancel
          </button>
        </span>
      )}

      {active && !confirmingDelete && (
        <button className="btn small" onClick={() => setConfirmingDelete(true)}>
          Delete “{active.name}”
        </button>
      )}
      {active && confirmingDelete && (
        <span className="saved-filter-name">
          <span>Delete “{active.name}” for everyone?</span>
          <button className="btn small" onClick={() => void remove()}>
            Yes, delete
          </button>
          <button className="btn small" onClick={() => setConfirmingDelete(false)}>
            Keep
          </button>
        </span>
      )}

      {active && (
        <span className="muted saved-filter-active" data-testid="saved-filter-active">
          Saved filter: {active.name}
          {changed ? ' (changed)' : ''}
        </span>
      )}
      {error && (
        <span className="saved-filter-error" role="alert">
          {error}
        </span>
      )}
      {notice && <span className="muted">{notice}</span>}
    </div>
  );
}
