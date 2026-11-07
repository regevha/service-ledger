import { useState } from 'react';
import { type FieldType, type ItemSchemaColumn } from '../../api';
import { LEAF_TYPE_OPTIONS } from './fieldSchema';

// A list of {name, type} columns, not a {name: type} dict — see
// ItemSchemaColumn (api.ts) for why: a dict's key order doesn't survive
// Postgres's JSONB storage, only a JSON array's element order does, and this
// editor is exactly what determines that order in the first place. Columns
// are still addressed by name (not index) for rename/type-change/remove, the
// same identity the old dict-keyed version used — the backend now also
// rejects duplicate column names outright (schemas.py), which the old dict
// shape could silently merge into data loss on a rename collision.
export function ItemSchemaEditor({
  itemSchema,
  onChange,
}: {
  itemSchema: ItemSchemaColumn[];
  onChange: (v: ItemSchemaColumn[]) => void;
}) {
  const columns = itemSchema;
  // Bumped per-column when a rename is rejected below, to force that
  // column's (uncontrolled) name input to remount and re-read its
  // defaultValue instead of keeping the rejected text on screen.
  const [revertNonce, setRevertNonce] = useState<Record<string, number>>({});

  function renameColumn(name: string, newName: string) {
    const trimmed = newName.trim();
    if (trimmed === name) return;
    // A blank name is rejected the same way as a collision below: the
    // input must be reset too, or it keeps showing empty while the old name
    // is what actually gets saved.
    if (!trimmed || columns.some((c) => c.name === trimmed)) {
      // Reject a rename that collides with another existing column name.
      // The backend rejects duplicate column names outright (schemas.py),
      // and setColumnType/removeColumn below both match "the" column by
      // c.name — silently allowing two columns to share a name here would
      // make a later type change or remove on either one act on both at
      // once instead of just the one the user touched.
      setRevertNonce((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }));
      return;
    }
    onChange(columns.map((c) => (c.name === name ? { ...c, name: trimmed } : c)));
  }
  function setColumnType(name: string, type: FieldType) {
    onChange(columns.map((c) => (c.name === name ? { ...c, type } : c)));
  }
  function removeColumn(name: string) {
    onChange(columns.filter((c) => c.name !== name));
  }
  function addColumn() {
    const existingNames = new Set(columns.map((c) => c.name));
    let n = 1;
    while (existingNames.has(`column_${n}`)) n += 1;
    onChange([...columns, { name: `column_${n}`, type: 'text' }]);
  }

  return (
    <div className="schema-field-extra">
      <span className="schema-field-extra-label">Table columns</span>
      {columns.length === 0 && <div className="empty-hint">No columns yet.</div>}
      {columns.map((c) => (
        <div className="item-schema-row" key={c.name}>
          <input
            type="text"
            className="text-input"
            key={`name-${revertNonce[c.name] ?? 0}`}
            defaultValue={c.name}
            aria-label="Column name"
            onBlur={(e) => renameColumn(c.name, e.target.value)}
          />
          <select value={c.type} onChange={(e) => setColumnType(c.name, e.target.value as FieldType)} aria-label="Column type">
            {LEAF_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button type="button" className="row-remove" onClick={() => removeColumn(c.name)}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="btn small" onClick={addColumn}>
        + Add column
      </button>
    </div>
  );
}
