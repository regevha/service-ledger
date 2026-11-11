import { useEffect, useMemo, useState } from 'react';
import { LoadError } from './LoadError';
import {
  ApiError,
  deleteInstrument,
  listInstrumentRepairCounts,
  listInstrumentTypes,
  listPlaces,
  listReports,
  type Instrument,
  type Place,
} from '../api';
import { useInstrumentFilters } from '../hooks/useInstrumentFilters';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { passesRepairCount } from '../instrumentAsk';
import { useInstrumentAsk } from '../instrumentAskContext';
import { DeleteInstrumentBanner, type PendingInstrumentDelete } from './DeleteInstrumentBanner';
import { InstrumentFilters } from './InstrumentFilters';
import { InstrumentFormScreen } from './InstrumentForm';
import { InstrumentTable } from './InstrumentTable';
import { MakersManager } from './MakersManager';
import { ModelsManager } from './ModelsManager';
import { PlacesManager } from './PlacesManager';

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

type ManagerMode = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; instrument: Instrument };

type Section = 'instruments' | 'models' | 'makers' | 'places';
const SECTIONS: [Section, string][] = [
  ['instruments', 'Instruments'],
  ['models', 'Models'],
  ['makers', 'Makers'],
  ['places', 'Places'],
];

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
  const [pendingDelete, setPendingDelete] = useState<PendingInstrumentDelete | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [typeNames, setTypeNames] = useState<Record<string, string>>({});
  const [section, setSection] = useState<Section>('instruments');
  const [allPlaces, setAllPlaces] = useState<Place[]>([]);
  const filters = useInstrumentFilters(instruments, allPlaces);
  // A question about instruments from the Ask box: how many repairs, in which dates, for which model or place.
  const asked = useInstrumentAsk();
  const ask = asked?.ask ?? null;
  const [repairCounts, setRepairCounts] = useState<Map<string, number> | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const { setModelFilter, setPlaceFilter } = filters;
  useEffect(() => {
    if (!ask) {
      setRepairCounts(null);
      setCountError(null);
      return;
    }
    // The question's own model and place replace the pickers' choice for as long as it lasts.
    setModelFilter(ask.model_id ?? 'all');
    setPlaceFilter(ask.place_id ?? '');
    let cancelled = false;
    setRepairCounts(null);
    setCountError(null);
    listInstrumentRepairCounts({ date_from: ask.date_from, date_to: ask.date_to })
      .then((rows) => {
        if (!cancelled) setRepairCounts(new Map(rows.map((r) => [r.instrument_id, r.repairs])));
      })
      .catch((e: unknown) => {
        if (!cancelled) setCountError(e instanceof ApiError ? e.message : 'Could not count the repairs.');
      });
    return () => {
      cancelled = true;
    };
  }, [ask, setModelFilter, setPlaceFilter]);
  const shownInstruments = useMemo(
    () => (!ask ? filters.shownInstruments : repairCounts ? filters.shownInstruments.filter((i) => passesRepairCount(ask, repairCounts.get(i.id) ?? 0)) : []),
    [ask, repairCounts, filters.shownInstruments]
  );
  useEffect(() => {
    listPlaces()
      .then(setAllPlaces)
      .catch(() => setAllPlaces([]));
  }, [instruments]);

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

  const switcher = (
    <div className="sub-switch" role="tablist" aria-label="Instruments, models, makers or places">
      {SECTIONS.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={section === key}
          className={section === key ? 'active' : ''}
          onClick={() => setSection(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (section === 'places') {
    return (
      <>
        {switcher}
        <PlacesManager onChanged={onRefresh} />
      </>
    );
  }

  if (section === 'makers') {
    return (
      <>
        {switcher}
        <MakersManager onChanged={onRefresh} />
      </>
    );
  }

  if (section === 'models') {
    return (
      <>
        {switcher}
        <ModelsManager onChanged={onRefresh} />
      </>
    );
  }

  return (
    <>
    {switcher}
    <div className="section">
      <div className="section-title-row">
        <div className="section-title">Instruments</div>
        <button type="button" className="btn small primary" onClick={() => setMode({ kind: 'create' })}>
          + New instrument
        </button>
      </div>

      {error && <LoadError message={error} onRetry={onRefresh} />}
      {deleteError && <div className="banner banner-crit">{deleteError}</div>}
      {pendingDelete && (
        <DeleteInstrumentBanner
          pending={pendingDelete}
          deleting={deleting}
          onConfirm={() => void handleDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {ask && (
        <div className="banner banner-info instrument-ask" role="status" data-testid="instrument-ask">
          <strong>Showing instruments:</strong> {ask.labels.join(' · ')}{' '}
          <button type="button" className="link-button" data-testid="instrument-ask-clear" onClick={() => asked?.clear()}>
            Clear
          </button>
          {ask.notes.map((note) => (
            <div key={note} className="ask-notes" data-testid="instrument-ask-note">
              {note}.
            </div>
          ))}
          {countError && <div className="banner banner-warn">{countError}</div>}
        </div>
      )}

      {!loading && instruments.length > 0 && (
        <InstrumentFilters
          showPlace={allPlaces.length > 0}
          placeOptions={filters.placeOptions}
          activePlace={filters.activePlace}
          onPlaceChange={filters.setPlaceFilter}
          modelOptions={filters.modelOptions}
          activeModel={filters.activeModel}
          onModelChange={filters.setModelFilter}
          stateFilter={filters.stateFilter}
          onStateChange={filters.setStateFilter}
        />
      )}

      {loading ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading instruments…</div>
        </div>
      ) : instruments.length === 0 ? (
        // A failed load says so above; it is not an empty fleet.
        error ? null : <div className="empty-hint">No instruments yet.</div>
      ) : shownInstruments.length === 0 ? (
        <div className="empty-hint" data-testid="instruments-empty">
          {ask && !repairCounts && !countError ? 'Counting repairs…' : 'No instruments match these filters.'}{' '}
          {filters.filtersActive && (
            <button type="button" className="btn small" onClick={filters.clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <InstrumentTable
          instruments={shownInstruments}
          repairCounts={ask && repairCounts ? repairCounts : undefined}
          typeNames={typeNames}
          phone={phone}
          onEdit={(instrument) => setMode({ kind: 'edit', instrument })}
          onDelete={(instrument) => void askToDelete(instrument)}
        />
      )}
    </div>
    </>
  );
}
