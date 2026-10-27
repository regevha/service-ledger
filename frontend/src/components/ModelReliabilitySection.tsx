import { useEffect, useState } from 'react';
import { getModelReliability, type ModelReliability } from '../api';

function days(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value)} days`;
}

/**
 * How a model holds up, from its instruments' finalized repair reports: days
 * between repairs, fault categories, parts replaced and labor hours. Says what it
 * could not count (undated repairs, repairs with no fault category) and shows no
 * averages until the model has enough repairs.
 */
export function ModelReliabilitySection({ modelId }: { modelId: string }) {
  const [data, setData] = useState<ModelReliability | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    getModelReliability(modelId)
      .then((d) => live && setData(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [modelId]);

  if (failed) {
    return (
      <>
        <div className="section-title">Reliability</div>
        <div className="banner banner-warn">Could not load the reliability figures.</div>
      </>
    );
  }
  if (!data) return null;

  if (data.repair_count === 0) {
    return (
      <>
        <div className="section-title">Reliability</div>
        <div className="empty-hint" id="model-reliability">No finalized repair reports for this model yet.</div>
      </>
    );
  }

  return (
    <div id="model-reliability">
      <div className="section-title">Reliability</div>
      <p className="muted">
        From {data.repair_count} finalized repair report{data.repair_count === 1 ? '' : 's'}.
        {!data.enough_data && ` Averages appear from ${data.min_repairs} repairs.`}
      </p>

      {data.enough_data && (
        <div className="stat-row">
          <div className="stat-tile">
            <span className="stat-value" id="rel-mean-gap">{days(data.mean_days_between_repairs)}</span>
            <span className="stat-label">Days between repairs</span>
            <small className="muted">
              {data.gap_count === 0 ? 'no instrument has two dated repairs' : `average of ${data.gap_count} gap${data.gap_count === 1 ? '' : 's'}`}
            </small>
          </div>
          <div className="stat-tile">
            <span className="stat-value" id="rel-avg-labor">
              {data.avg_labor_hours === null || data.avg_labor_hours === undefined ? '—' : `${data.avg_labor_hours.toFixed(1)} h`}
            </span>
            <span className="stat-label">Labor per repair</span>
            <small className="muted">{data.repairs_with_labor_hours} of {data.repair_count} repairs have hours</small>
          </div>
        </div>
      )}

      <p className="muted model-rel-notes">
        {data.repairs_without_date > 0 &&
          `${data.repairs_without_date} repair${data.repairs_without_date === 1 ? ' has' : 's have'} no report date and ${data.repairs_without_date === 1 ? 'is' : 'are'} left out of the gaps. `}
        {data.repairs_with_fault_category} of {data.repair_count} repairs have a fault category.
      </p>

      <div className="template-table">
        <div className="instrument-row model-rel-row template-row-head">
          <span>Instrument</span>
          <span>Repairs</span>
          <span>Days between repairs</span>
        </div>
        {data.units.map((u) => (
          <div className="instrument-row model-rel-row template-row-body" key={u.instrument_id}>
            <span data-label="Instrument">{u.name}<small className="muted"> {u.serial_number}</small></span>
            <span data-label="Repairs">{u.repair_count}</span>
            <span data-label="Days between repairs">{days(u.mean_days_between_repairs)}</span>
          </div>
        ))}
      </div>

      {data.fault_categories.length > 0 && (
        <>
          <div className="section-title">Common fault categories</div>
          <div className="template-table">
            <div className="instrument-row model-rel-row template-row-head">
              <span>Category</span>
              <span>Repairs</span>
              <span>Instruments</span>
            </div>
            {data.fault_categories.map((f) => (
              <div className="instrument-row model-rel-row template-row-body" key={f.category}>
                <span data-label="Category">
                  {f.category}
                  {f.repeat && <small className="model-standout"> repeat fault</small>}
                </span>
                <span data-label="Repairs">{f.report_count}</span>
                <span data-label="Instruments">{f.instrument_count}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {data.parts.length > 0 && (
        <>
          <div className="section-title">Parts replaced most</div>
          <div className="template-table">
            <div className="instrument-row model-rel-row template-row-head">
              <span>Part</span>
              <span>Reports</span>
              <span>Quantity</span>
            </div>
            {data.parts.map((p) => (
              <div className="instrument-row model-rel-row template-row-body" key={`${p.part_name}|${p.part_number ?? ''}`}>
                <span data-label="Part">
                  {p.part_name}
                  {p.part_number && <small className="muted"> {p.part_number}</small>}
                </span>
                <span data-label="Reports">{p.times_replaced}</span>
                <span data-label="Quantity">{p.total_qty}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
