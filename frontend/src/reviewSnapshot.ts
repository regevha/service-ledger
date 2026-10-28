// A comparable picture of what the review form holds: the extracted fields and the service date.
// Two snapshots are equal exactly when nothing the user could save differs, whatever order the
// keys were added in. The review screens compare the current form against the snapshot taken when
// the values were last extracted or saved, to know whether there are unsaved edits.

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, stable(source[key])])
    );
  }
  return value;
}

export function reviewSnapshot(fields: Record<string, unknown>, reportDate: string | null): string {
  // JSON.stringify leaves out keys whose value is undefined, so {a: undefined} equals {}.
  return JSON.stringify([stable(fields), reportDate ?? null]);
}
