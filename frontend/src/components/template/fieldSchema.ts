import { type FieldType, type ReportTemplate, type TemplateField, type TemplateFieldPayload } from '../../api';

export const FIELD_TYPE_OPTIONS: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Text (long)' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'date', label: 'Date' },
  { value: 'enum', label: 'Choice (one of…)' },
  { value: 'enum[]', label: 'Choices (any of…)' },
  { value: 'object[]', label: 'Table of rows' },
  { value: 'number[detector]', label: 'Per-detector numbers' },
  { value: 'number[laser]', label: 'Per-laser numbers' },
];

// object[]'s item_schema columns are always a leaf control — the backend
// (schemas.py's TemplateFieldIn) rejects anything else, since
// ObjectArrayInput's own table cells can only render a leaf input.
export const LEAF_TYPE_OPTIONS: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'date', label: 'Date' },
];

export function defaultFieldFor(type: FieldType): TemplateField {
  const base: TemplateField = { name: '', type, unit: null, notes: null };
  if (type === 'enum' || type === 'enum[]') return { ...base, options: [] };
  if (type === 'object[]') return { ...base, item_schema: [] };
  return base;
}

export function fieldToPayload(field: TemplateField): TemplateFieldPayload {
  return {
    name: field.name.trim(),
    type: field.type,
    unit: field.unit || null,
    notes: field.notes || null,
    ...(field.options ? { options: field.options } : {}),
    ...(field.item_schema ? { item_schema: field.item_schema } : {}),
    ...(field.filled_by_person ? { filled_by_person: true } : {}),
    ...(field.optional ? { optional: true } : {}),
    ...(field.source ? { source: field.source } : {}),
  };
}

/**
 * What stops a template from being saved, in words. Checked as the user
 * types so the reason is on screen, instead of a Save button that is just
 * greyed out (or a round trip to the backend's 422).
 */
export function templateProblems(fields: TemplateField[]): string[] {
  const problems: string[] = [];
  if (fields.length === 0) problems.push('Add at least one field.');
  if (fields.some((f) => !f.name.trim())) problems.push('Every field needs a name.');
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const f of fields) {
    const key = f.name.trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) repeated.add(f.name.trim());
    seen.add(key);
  }
  if (repeated.size > 0) problems.push(`Field names must be unique: ${[...repeated].join(', ')} appears more than once.`);
  for (const f of fields) {
    const label = f.name.trim() || 'A choice field';
    if ((f.type === 'enum' || f.type === 'enum[]') && (f.options ?? []).length === 0) {
      problems.push(`${label} needs at least one option.`);
    }
    if (f.type === 'object[]' && (f.item_schema ?? []).length === 0) {
      problems.push(`${f.name.trim() || 'A table field'} needs at least one column.`);
    }
  }
  return problems;
}

/** Names that exist on the saved template but not in the edited one (removed or renamed). */
export function droppedFieldNames(existing: ReportTemplate | undefined, fields: TemplateField[]): string[] {
  if (!existing) return [];
  const kept = new Set(fields.map((f) => f.name.trim()));
  return existing.field_schema.fields.map((f) => f.name).filter((name) => !kept.has(name));
}
