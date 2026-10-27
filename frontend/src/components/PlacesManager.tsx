import { useCallback, useEffect, useState } from 'react';
import { ApiError, createPlace, deletePlace, listPlaces, mergePlace, updatePlace, type Place, type PlaceKind } from '../api';
import { RowMenu } from './RowMenu';
import { showToast } from '../toast';

/**
 * The Places list under the Instruments tab: institutions, the faculties inside
 * them (optional) and the rooms inside institutions or faculties. A place is a
 * record of its own and the record is the source: renaming or moving it updates
 * the institution and room text on its instruments. Merging two places is only
 * ever done here, by a person, after a message that says exactly what moves.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const KIND_LABEL: Record<PlaceKind, string> = { institution: 'Institution', faculty: 'Faculty', room: 'Room' };
const KIND_PLURAL: Record<PlaceKind, string> = { institution: 'institutions', faculty: 'faculties', room: 'rooms' };

function whereText(p: Place): string {
  if (p.kind === 'institution') return '—';
  return p.faculty_name ? `${p.faculty_name}, ${p.institution_name}` : p.institution_name;
}

function PlaceForm({
  existing,
  places,
  onCancel,
  onSaved,
}: {
  existing?: Place;
  places: Place[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<PlaceKind>(existing?.kind ?? 'room');
  const [name, setName] = useState(existing?.name ?? '');
  const parents = places.filter((p) => (kind === 'faculty' ? p.kind === 'institution' : kind === 'room' ? p.kind !== 'room' : false));
  const [parentId, setParentId] = useState<string>(existing?.parent_id ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The chosen parent must suit the kind; fall back to the first one that does.
  const parentOk = parents.some((p) => p.id === parentId);
  const effectiveParent = kind === 'institution' ? '' : parentOk ? parentId : (parents[0]?.id ?? '');

  const parentLabel = (p: Place) => (p.kind === 'institution' ? p.name : `${p.name} (${p.institution_name}, faculty)`);
  const units = existing?.total_unit_count ?? 0;
  const renamed = existing !== undefined && name.trim() !== existing.name && name.trim() !== '';
  const moved = existing !== undefined && existing.kind !== 'institution' && effectiveParent !== (existing.parent_id ?? '');
  const newParent = places.find((p) => p.id === effectiveParent);
  const institutionChanges = moved && newParent !== undefined && (newParent.kind === 'institution' ? newParent.id : newParent.institution_id) !== existing?.institution_id;
  const canSave = name.trim() !== '' && (kind === 'institution' || effectiveParent !== '') && !saving;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (existing) {
        await updatePlace(existing.id, { name: name.trim(), ...(existing.kind !== 'institution' ? { parent_id: effectiveParent } : {}) });
      } else {
        await createPlace({ kind, name: name.trim(), parent_id: kind === 'institution' ? null : effectiveParent });
      }
      showToast(existing ? 'Place saved' : 'Place added');
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save this place.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="section">
      <button type="button" className="btn small back-link" onClick={onCancel}>
        ← Back to places
      </button>
      <div className="section-title">{existing ? `Edit ${existing.kind}` : 'New place'}</div>
      {error && <div className="banner banner-crit">{error}</div>}

      <div className="schema-form-row">
        {!existing && (
          <label className="schema-form-label">
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value as PlaceKind)}>
              <option value="room">Room</option>
              <option value="faculty">Faculty</option>
              <option value="institution">Institution</option>
            </select>
          </label>
        )}
        <label className="schema-form-label">
          <span>
            Name <span className="required-mark" title="Required">*</span>
          </span>
          <input
            type="text"
            className="text-input"
            value={name}
            placeholder={kind === 'institution' ? 'e.g. Bar-Ilan University' : kind === 'faculty' ? 'e.g. Faculty of Life Sciences' : 'e.g. Room 205'}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {kind !== 'institution' && (
          <label className="schema-form-label">
            <span>{kind === 'faculty' ? 'In institution' : 'In institution or faculty'}</span>
            <select value={effectiveParent} onChange={(e) => setParentId(e.target.value)} aria-label="Parent place">
              {parents.length === 0 && <option value="">No {kind === 'faculty' ? 'institution' : 'institution or faculty'} yet</option>}
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {parentLabel(p)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {renamed && existing && existing.kind !== 'faculty' && units > 0 && (
        <div className="banner banner-warn" id="place-rename-warning">
          Renaming changes the {existing.kind === 'room' ? 'room name' : 'institution'} of {plural(units, 'instrument')} to “{name.trim()}”.
        </div>
      )}
      {institutionChanges && existing && newParent && units > 0 && (
        <div className="banner banner-warn" id="place-move-warning">
          The institution of {plural(units, 'instrument')} will become “{newParent.kind === 'institution' ? newParent.name : newParent.institution_name}”.
        </div>
      )}

      <div className="cta-row">
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={() => void save()} disabled={!canSave}>
          {saving ? 'Saving…' : existing ? 'Save changes' : 'Add place'}
        </button>
      </div>
    </div>
  );
}

type Mode = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; place: Place };
type Pending = { kind: 'delete'; place: Place } | { kind: 'merge'; place: Place; intoId: string };

export function PlacesManager({ onChanged }: { onChanged: () => void }) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return listPlaces()
      .then((p) => {
        setPlaces(p);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load the places.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      if (pending.kind === 'delete') {
        await deletePlace(pending.place.id);
        showToast('Place deleted');
      } else {
        const r = await mergePlace(pending.place.id, pending.intoId);
        showToast(`Merged into ${r.into}`);
      }
      setPending(null);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  function afterSave() {
    setMode({ kind: 'list' });
    void load();
    onChanged();
  }

  if (mode.kind !== 'list') {
    return <PlaceForm existing={mode.kind === 'edit' ? mode.place : undefined} places={places} onCancel={() => setMode({ kind: 'list' })} onSaved={afterSave} />;
  }

  const mergeTargets = (p: Place) => places.filter((o) => o.id !== p.id && o.kind === p.kind);
  const mergeLabel = (o: Place) => (o.kind === 'institution' ? o.name : `${o.name} (${whereText(o)})`);
  const target = pending?.kind === 'merge' ? places.find((p) => p.id === pending.intoId) : undefined;
  const depth = (p: Place) => (p.kind === 'institution' ? 0 : p.kind === 'faculty' ? 1 : p.faculty_id ? 2 : 1);

  return (
    <div className="section" id="places-section">
      <div className="section-title-row">
        <div className="section-title">Places</div>
        <button type="button" className="btn small primary" onClick={() => setMode({ kind: 'create' })}>
          + New place
        </button>
      </div>
      <p className="hint-text">
        An institution, the faculties inside it (optional) and the rooms. A place is kept once, here: renaming or moving it updates the institution
        and room of its instruments. Names that look alike are never merged on their own.
      </p>

      {error && <div className="banner banner-warn">{error}</div>}

      {pending?.kind === 'delete' && (
        <div className="banner banner-warn" role="alertdialog" aria-label="Confirm delete place">
          <div>
            Delete the {pending.place.kind} “{pending.place.name}”? This deletes only the place record; nothing is inside it and no instrument is in it. This
            cannot be undone.
          </div>
          <button type="button" className="btn small danger solid" onClick={() => void confirm()} disabled={busy}>
            Confirm delete
          </button>{' '}
          <button type="button" className="btn small" onClick={() => setPending(null)} disabled={busy}>
            Cancel
          </button>
        </div>
      )}

      {pending?.kind === 'merge' && (
        <div className="banner banner-warn" role="alertdialog" aria-label="Merge place">
          <label className="schema-form-label">
            Merge “{pending.place.name}” into
            <select value={pending.intoId} onChange={(e) => setPending({ ...pending, intoId: e.target.value })}>
              {mergeTargets(pending.place).map((o) => (
                <option key={o.id} value={o.id}>
                  {mergeLabel(o)}
                </option>
              ))}
            </select>
          </label>
          {target && (
            <div>
              {plural(pending.place.unit_count, 'instrument')} pointing at “{pending.place.name}”
              {pending.place.child_count > 0 ? ` and the ${plural(pending.place.child_count, 'place')} inside it` : ''} move to “{target.name}”
              {pending.place.kind === 'room' ? ', and those instruments’ room name' : pending.place.kind === 'institution' ? ', and the institution of every instrument there' : ''}
              {pending.place.kind !== 'faculty' ? ` becomes “${target.name}”` : ''}. The {pending.place.kind} “{pending.place.name}” is then deleted. This cannot be undone.
            </div>
          )}
          <button type="button" className="btn small danger solid" onClick={() => void confirm()} disabled={busy || !target}>
            Confirm merge
          </button>{' '}
          <button type="button" className="btn small" onClick={() => setPending(null)} disabled={busy}>
            Cancel
          </button>
        </div>
      )}

      {loading ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading places…</div>
        </div>
      ) : places.length === 0 ? (
        <div className="empty-hint">No places yet. They appear when an instrument is given an institution or a room, or add one here.</div>
      ) : (
        <div className="template-table">
          <div className="instrument-row place-row template-row-head">
            <span>Place</span>
            <span>Kind</span>
            <span>In</span>
            <span>Instruments</span>
            <span>Actions</span>
          </div>
          {places.map((p) => {
            const targets = mergeTargets(p);
            const blockedBy =
              p.child_count > 0
                ? `${plural(p.child_count, 'place')} inside it`
                : p.unit_count > 0
                  ? `${plural(p.unit_count, 'instrument')} in it`
                  : null;
            return (
              <div className="instrument-row place-row template-row-body" key={p.id}>
                <span data-label="Place" className={`place-name place-depth-${depth(p)}`}>
                  <span className="place-name-text">{p.name}</span>
                  {p.similar_to.length > 0 && (
                    <small className="muted model-similar">May be the same as {p.similar_to.map((s) => `“${s}”`).join(', ')}</small>
                  )}
                </span>
                <span data-label="Kind">{KIND_LABEL[p.kind]}</span>
                <span data-label="In">{whereText(p)}</span>
                <span data-label="Instruments">
                  {p.total_unit_count}
                  {p.kind !== 'room' && p.total_unit_count !== p.unit_count && <small className="muted"> ({p.unit_count} directly)</small>}
                </span>
                <span className="template-row-actions">
                  <button type="button" className="btn small" onClick={() => setMode({ kind: 'edit', place: p })}>
                    Edit
                  </button>
                  <RowMenu
                    label={`More actions for ${p.name}`}
                    items={[
                      {
                        label: 'Merge into…',
                        disabled: targets.length === 0,
                        title: targets.length === 0 ? `No other ${p.kind}` : undefined,
                        onSelect: () => setPending({ kind: 'merge', place: p, intoId: targets[0].id }),
                      },
                      {
                        label: 'Delete',
                        danger: true,
                        disabled: blockedBy !== null,
                        title: blockedBy ? `${blockedBy}; move or merge first` : undefined,
                        onSelect: () => setPending({ kind: 'delete', place: p }),
                      },
                    ]}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="muted places-legend">
        {Object.entries(KIND_PLURAL)
          .map(([k, label]) => `${places.filter((p) => p.kind === k).length} ${label}`)
          .join(' · ')}
      </p>
    </div>
  );
}
