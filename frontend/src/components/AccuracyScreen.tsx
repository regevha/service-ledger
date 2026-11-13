import { useEffect, useState } from 'react';
import { getReadAccuracy, listGlossaryTerms, type ReadAccuracy } from '../api';
import { fieldLabel } from '../fieldLabels';
import { showToast } from '../toast';
import { TermForm } from './GlossaryManager';

const PERIODS: { days: number | null; label: string }[] = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'Year' },
  { days: null, label: 'All' },
];

function pct(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** 0.9873 → "98.7%"; whole numbers stay whole ("100%"). */
function formatPct(share: number | null): string {
  if (share === null) return '–';
  const value = Math.floor(share * 1000) / 10;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

function tone(share: number | null, goal: number): string {
  if (share === null) return '';
  if (share >= goal) return 'acc-good';
  if (share >= goal - 0.09) return 'acc-near';
  return 'acc-far';
}

function Bar({ share, goal }: { share: number | null; goal: number }) {
  return (
    <span className="acc-bar" aria-hidden="true">
      <span className={`acc-bar-fill ${tone(share, goal)}`} style={{ width: `${(share ?? 0) * 100}%` }} />
      <span className="acc-bar-goal" style={{ left: `${goal * 100}%` }} />
    </span>
  );
}

function dayText(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Reading accuracy: how close the reading is to "approve without editing". Measured on what people approved: a
 * field the reading filled in is "kept as read" when the approved value is the first reading. The goal is 99% of
 * fields. Below the figures, where the misses are (which fields, which forms, translated or not) and the newest
 * corrections themselves; those corrections are also given to the next reading of the same form.
 */
export function AccuracyScreen({ onGlossary }: { onGlossary: () => void }) {
  const [days, setDays] = useState<number | null>(90);
  const [data, setData] = useState<ReadAccuracy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);
  // Wrong wordings the glossary already corrects, lower case, so a change it covers is not offered again.
  const [known, setKnown] = useState<Set<string>>(new Set());
  useEffect(() => {
    listGlossaryTerms()
      .then((terms) => setKnown(new Set(terms.flatMap((t) => (t.wrong_term ? [t.wrong_term.toLowerCase()] : [])))))
      .catch(() => undefined);
  }, [added]);

  useEffect(() => {
    let cancelled = false;
    getReadAccuracy(days)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the figures.');
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  function choosePeriod(next: number | null) {
    setError(null);
    setDays(next);
  }

  const goal = data?.goal ?? 0.99;
  const fieldShare = data ? pct(data.unchanged, data.fields) : null;
  const reportShare = data ? pct(data.reports_untouched, data.reports) : null;
  const trShare = data ? pct(data.translations.unchanged, data.translations.accepted) : null;
  const misses = data ? data.fields - data.unchanged : 0;

  return (
    <div className="accuracy" data-testid="accuracy-screen">
      <div className="acc-head">
        <div>
          <h2 className="admin-title">Reading accuracy</h2>
          <p className="admin-lead">
            How much of each new report was approved exactly as it was read. The goal is {formatPct(goal)} of fields, so that a report only needs a check
            and an Approve.
          </p>
        </div>
        <div className="theme-choice" role="radiogroup" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p.label} type="button" role="radio" aria-checked={days === p.days} className={`btn small${days === p.days ? ' primary' : ''}`} onClick={() => choosePeriod(p.days)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="banner banner-crit" role="alert">
          {error}
        </div>
      )}
      {!data && !error && <p className="hint-text">Loading…</p>}

      {data && data.fields === 0 && (
        <p className="hint-text" data-testid="accuracy-empty">
          Nothing to measure yet: no report read since this was tracked has been finalized in this period.
        </p>
      )}

      {data && data.fields > 0 && (
        <>
          <div className="stat-row acc-tiles">
            <div className={`stat-tile ${tone(fieldShare, goal)}`} data-testid="acc-fields">
              <span className="stat-value">{formatPct(fieldShare)}</span>
              <span className="stat-label">Fields kept as read</span>
              <span className="home-tile-note">
                {data.unchanged} of {data.fields}; goal {formatPct(goal)}
                {fieldShare !== null && fieldShare < goal ? `, ${Math.ceil(goal * data.fields - data.unchanged)} fewer edits to reach it` : ''}
              </span>
            </div>
            <div className="stat-tile" data-testid="acc-reports">
              <span className="stat-value">{formatPct(reportShare)}</span>
              <span className="stat-label">Reports approved with no edit</span>
              <span className="home-tile-note">
                {data.reports_untouched} of {data.reports} reports
              </span>
            </div>
            <div className="stat-tile" data-testid="acc-translations">
              <span className="stat-value">{formatPct(trShare)}</span>
              <span className="stat-label">Translations accepted with no edit</span>
              <span className="home-tile-note">{data.translations.accepted ? `${data.translations.unchanged} of ${data.translations.accepted} Hebrew reports` : 'No translated reports in this period'}</span>
            </div>
          </div>

          <section className="acc-section" aria-labelledby="acc-weeks-title">
            <h3 id="acc-weeks-title">By week</h3>
            <div className="trend-table-wrap" tabIndex={0} role="region" aria-label="Accuracy by week, as a table">
              <table className="trend-table acc-table" data-testid="acc-weeks">
                <thead>
                  <tr>
                    <th scope="col">Week of</th>
                    <th scope="col" className="num">Fields kept</th>
                    <th scope="col" className="acc-bar-col">
                      <span className="sr-only">Bar, with the goal marked</span>
                    </th>
                    <th scope="col" className="num">Reports with no edit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.weeks.map((w) => {
                    const share = pct(w.unchanged, w.fields);
                    return (
                      <tr key={w.week_start}>
                        <td>{new Date(`${w.week_start}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                        <td className="num">
                          {formatPct(share)} <span className="acc-muted">({w.fields})</span>
                        </td>
                        <td className="acc-bar-col">
                          <Bar share={share} goal={goal} />
                        </td>
                        <td className="num">
                          {w.untouched} of {w.reports}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <div className="acc-cols">
            <section className="acc-section" aria-labelledby="acc-fields-title">
              <h3 id="acc-fields-title">Where the misses are: fields</h3>
              {misses === 0 ? (
                <p className="hint-text">Every field was kept as read.</p>
              ) : (
                <table className="trend-table acc-table" data-testid="acc-by-field">
                  <thead>
                    <tr>
                      <th scope="col">Field</th>
                      <th scope="col" className="num">Edited</th>
                      <th scope="col" className="num">Kept</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_field
                      .filter((f) => f.unchanged < f.fields)
                      .slice(0, 12)
                      .map((f) => (
                        <tr key={f.field}>
                          <td>{fieldLabel(f.field)}</td>
                          <td className="num">
                            {f.fields - f.unchanged} of {f.fields}
                          </td>
                          <td className="num">{formatPct(pct(f.unchanged, f.fields))}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="acc-section" aria-labelledby="acc-forms-title">
              <h3 id="acc-forms-title">By form</h3>
              <table className="trend-table acc-table" data-testid="acc-by-form">
                <thead>
                  <tr>
                    <th scope="col">Form</th>
                    <th scope="col" className="num">Fields kept</th>
                    <th scope="col" className="num">Reports</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_form.map((f) => (
                    <tr key={f.template_id ?? 'none'}>
                      <td>{f.form}</td>
                      <td className="num">{formatPct(pct(f.unchanged, f.fields))}</td>
                      <td className="num">{f.reports}</td>
                    </tr>
                  ))}
                  {data.by_source.length > 1 &&
                    data.by_source.map((s) => (
                      <tr key={s.source} className="acc-source-row">
                        <td>{s.source === 'translated' ? 'All read from a Hebrew translation' : 'All read from the document itself'}</td>
                        <td className="num">{formatPct(pct(s.unchanged, s.fields))}</td>
                        <td className="num">{s.reports}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </section>
          </div>

          <section className="acc-section" aria-labelledby="acc-corrections-title">
            <h3 id="acc-corrections-title">Newest corrections</h3>
            <p className="hint-text">
              What was read and what was approved instead. The newest corrections on a form are given to the next reading of that form, so the same mistake is
              not made again.
            </p>
            {data.corrections.length === 0 ? (
              <p className="hint-text">None in this period.</p>
            ) : (
              <div className="trend-table-wrap" tabIndex={0} role="region" aria-label="Newest corrections, as a table">
                <table className="trend-table acc-table acc-corrections" data-testid="acc-corrections">
                  <thead>
                    <tr>
                      <th scope="col">Report</th>
                      <th scope="col">Field</th>
                      <th scope="col">Read</th>
                      <th scope="col">Approved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.corrections.map((c, i) => (
                      <tr key={`${c.report_id}-${c.field}-${i}`}>
                        <td>
                          <a href={`#/reports/${c.report_id}`}>{c.instrument ?? 'Report'}</a>
                          <span className="acc-muted">
                            {' '}
                            {dayText(c.finalized_at)}
                            {c.translated ? ' · translated' : ''}
                          </span>
                        </td>
                        <td>{fieldLabel(c.field)}</td>
                        <td>
                          <del className="acc-read">{c.read || '(empty)'}</del>
                        </td>
                        <td>
                          <ins className="acc-kept">{c.kept || '(empty)'}</ins>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="acc-section" aria-labelledby="acc-tr-title">
            <div className="acc-section-head">
              <h3 id="acc-tr-title">Translation fixes</h3>
              <button type="button" className="btn small" onClick={onGlossary}>
                Open the glossary
              </button>
            </div>
            <p className="hint-text">
              Words the reviewer changed in a Hebrew translation. A wrong technical term (&quot;laser direction&quot; for laser alignment) can go into the
              glossary: the next translations are told the right term, and the wrong one is replaced if it still appears.
            </p>
            {data.translations.edits.length === 0 ? (
              <p className="hint-text">No translation was edited in this period.</p>
            ) : (
              <ul className="acc-tr-list" data-testid="acc-translation-edits">
                {data.translations.edits.map((e) => (
                  <li key={e.report_id}>
                    <a href={`#/reports/${e.report_id}`}>{e.instrument ?? 'Report'}</a> <span className="acc-muted">{dayText(e.finalized_at)}</span>
                    <ul>
                      {e.changes.map((c, i) => {
                        const key = `${e.report_id}:${i}`;
                        const canAdd = c.before.trim() !== '' && c.after.trim() !== '';
                        return (
                          <li key={i} className="acc-change">
                            <del className="acc-read">{c.before || '(nothing)'}</del> <span aria-hidden="true">→</span> <ins className="acc-kept">{c.after || '(removed)'}</ins>
                            {canAdd &&
                              (added.has(key) || known.has(c.before.toLowerCase()) ? (
                                <span className="acc-muted"> In the glossary</span>
                              ) : adding !== key ? (
                                <button type="button" className="btn small" onClick={() => setAdding(key)}>
                                  Add to glossary
                                </button>
                              ) : null)}
                            {adding === key && (
                              <div className="acc-add-term">
                                <TermForm
                                  term={null}
                                  initial={{ source_term: '', wrong_term: c.before, english_term: c.after, note: '' }}
                                  onCancel={() => setAdding(null)}
                                  onSaved={() => {
                                    setAdding(null);
                                    setAdded((s) => new Set(s).add(key));
                                    showToast(`Added to the glossary: "${c.after}".`);
                                  }}
                                />
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
