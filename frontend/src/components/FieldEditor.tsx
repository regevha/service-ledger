import type { TemplateField } from '../api';

/**
 * Renders one editable control per template field type (SL-ARCH-001 §5's
 * field_schema types) and reports value changes back up as plain JS values
 * matching what PATCH /reports/{id}/fields expects in extracted_fields.
 *
 * This is deliberately generic rather than one component per template
 * (repair vs. preventive_maintenance vs. calibration): the whole point of
 * JSONB templates (§5) is that the field set varies by report type, so the
 * review screen has to render from field_schema rather than hardcode a
 * layout per type.
 */

type LeafType = 'text' | 'number' | 'boolean' | 'date';

function leafInput(value: unknown, type: string, onChange: (v: unknown) => void) {
  if (type === 'boolean') {
    return (
      <select value={value ? 'true' : 'false'} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  if (type === 'number') {
    return (
      <input
        type="number"
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  }
  if (type === 'date') {
    return <input type="date" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
  }
  return <input type="text" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
}

// Exported for reuse by TemplateManager.tsx's structured field-schema editor
// (an enum/enum[] field's `options` list is built with the exact same
// type-a-value-press-Enter tag UI as an enum[] field's own runtime value).
export function EnumArrayInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const items = Array.isArray(value) ? value : [];
  return (
    <div className="tag-input">
      <div className="tag-list">
        {items.map((tag, i) => (
          <span className="tag-chip" key={i}>
            {tag}
            <button type="button" aria-label={`Remove ${tag}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        type="text"
        placeholder="Type a value, press Enter"
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const v = e.currentTarget.value.trim();
          if (v && !items.includes(v)) onChange([...items, v]);
          e.currentTarget.value = '';
        }}
      />
    </div>
  );
}

function ObjectArrayInput({
  value,
  itemSchema,
  onChange,
}: {
  value: Record<string, unknown>[];
  itemSchema: Record<string, string>;
  onChange: (v: Record<string, unknown>[]) => void;
}) {
  const rows = Array.isArray(value) ? value : [];
  const columns = Object.entries(itemSchema);

  function updateRow(i: number, key: string, v: unknown) {
    const next = rows.map((row, j) => (i === j ? { ...row, [key]: v } : row));
    onChange(next);
  }
  function removeRow(i: number) {
    onChange(rows.filter((_, j) => j !== i));
  }
  function addRow() {
    const blank = Object.fromEntries(columns.map(([key]) => [key, '']));
    onChange([...rows, blank]);
  }

  // Explicit column count + minmax(0, 1fr) rather than the CSS's own
  // repeat(auto-fit, minmax(90px, 1fr)): auto-fit sizes tracks from the
  // container width alone, and a track's automatic minimum still defaults
  // to its content's width unless overridden — so a long extracted value
  // (a real part description, or here the stub's placeholder file path)
  // was forcing each column onto its own line instead of lining up beside
  // its header. minmax(0, ...) lets the track shrink below its content's
  // natural width, and the input/textarea inside truncates or wraps in its
  // own column instead of blowing out the whole row.
  const rowGridStyle = { gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr)) auto` };

  return (
    <div className="object-array">
      {rows.length > 0 && (
        <div className="object-array-table">
          <div className="object-array-row object-array-head" style={rowGridStyle}>
            {columns.map(([key]) => (
              <span key={key}>{key.replace(/_/g, ' ')}</span>
            ))}
            <span />
          </div>
          {rows.map((row, i) => (
            <div className="object-array-row" key={i} style={rowGridStyle}>
              {columns.map(([key, type]) => (
                <span key={key}>{leafInput(row[key], type as LeafType, (v) => updateRow(i, key, v))}</span>
              ))}
              <button type="button" className="row-remove" onClick={() => removeRow(i)} aria-label="Remove row">
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="btn small" onClick={addRow}>
        + Add row
      </button>
    </div>
  );
}

function NumberMapInput({ value, onChange }: { value: Record<string, number>; onChange: (v: Record<string, number>) => void }) {
  const entries = Object.entries(value && typeof value === 'object' ? value : {});
  function updateKey(key: string, v: string) {
    onChange({ ...value, [key]: v === '' ? 0 : Number(v) });
  }
  function removeKey(key: string) {
    const next = { ...value };
    delete next[key];
    onChange(next);
  }
  function addKey() {
    let n = 1;
    while (`item_${n}` in value) n += 1;
    onChange({ ...value, [`item_${n}`]: 0 });
  }
  return (
    <div className="number-map">
      {entries.length === 0 && <div className="empty-hint">No per-detector/laser values yet.</div>}
      {entries.map(([key, v]) => (
        <div className="number-map-row" key={key}>
          <span className="number-map-key">{key}</span>
          <input type="number" value={v} onChange={(e) => updateKey(key, e.target.value)} />
          <button type="button" className="row-remove" onClick={() => removeKey(key)}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="btn small" onClick={addKey}>
        + Add
      </button>
    </div>
  );
}

export function FieldControl({
  field,
  value,
  onChange,
}: {
  field: TemplateField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  switch (field.type) {
    case 'boolean':
    case 'number':
    case 'date':
      return leafInput(value, field.type, onChange);
    case 'text':
      return <textarea value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
    case 'enum':
      return (
        <select value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>
            Choose…
          </option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    case 'enum[]':
      return <EnumArrayInput value={(value as string[]) ?? []} onChange={onChange} />;
    case 'object[]':
      return (
        <ObjectArrayInput
          value={(value as Record<string, unknown>[]) ?? []}
          itemSchema={field.item_schema ?? {}}
          onChange={onChange}
        />
      );
    case 'number[detector]':
    case 'number[laser]':
      return <NumberMapInput value={(value as Record<string, number>) ?? {}} onChange={onChange} />;
    default:
      return <input type="text" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
  }
}
