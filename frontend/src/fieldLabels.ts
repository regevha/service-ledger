// Template fields are stored under machine names (`cst_beads_lot`, `baseline_cv_percent`).
// This turns one into what a person would write: "CST beads lot", "Baseline CV".

// Words that are abbreviations and stay in capitals.
const ACRONYMS = new Set(['cst', 'pmt', 'cv', 'qc', 'id', 'led', 'uv', 'cpu', 'pc', 'ui', 'pdf', 'ph', 'sn', 'po', 'wo']);

/**
 * `unit`: when the name already ends in its own unit (`fluidics_pressure_psi` with unit "psi",
 * `baseline_cv_percent` with unit "%"), that last word is dropped, because the unit is shown
 * next to the label anyway ("Fluidics pressure (psi)", not "Fluidics Pressure Psi (psi)").
 */
export function fieldLabel(name: string, unit?: string | null): string {
  let words = name.split(/[_\s]+/).filter(Boolean);
  const last = words[words.length - 1]?.toLowerCase();
  const u = unit?.trim().toLowerCase();
  if (words.length > 1 && u && (last === u || (u === '%' && last === 'percent'))) words = words.slice(0, -1);
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}
