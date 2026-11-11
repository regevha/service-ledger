import { apiFetch } from './http';
import type { TrendField, TrendPoint } from './instruments';
import type { FleetAnalytics, InstrumentStatus, ReportType } from './types';

// ---------- Analytics ----------

export interface UnitComparison {
  instrument_id: string;
  name: string;
  serial_number: string;
  status: InstrumentStatus;
  finalized_report_count: number;
  last_report_date: string | null;
  labor_report_count: number;
  total_labor_hours: number;
  parts_replaced_qty: number;
}

export interface ModelComparison {
  model: string;
  units: UnitComparison[];
  trend_fields: TrendField[];
}

export interface ModelTrendSeries {
  instrument_id: string;
  name: string;
  serial_number: string;
  points: TrendPoint[];
}

export interface ModelTrend {
  model: string;
  field: string;
  series: ModelTrendSeries[];
}

/**
 * What the analytics are computed from; every field is optional and they
 * combine. The same meaning as on the Reports list: the type is the report's
 * template type, the dates are the report date (a report with no date drops out
 * once a date is set), and the instrument is one unit and the manufacturer is
 * every unit from that maker (both also limit the units listed).
 */
export interface AnalyticsFilters {
  instrument_id?: string;
  /** Every unit of one model record (also limits the units listed). */
  model_id?: string;
  /** An institution, faculty or room, with everything inside it. */
  place_id?: string;
  manufacturer?: string;
  report_type?: ReportType;
  date_from?: string;
  date_to?: string;
  /** Omitted: finalized reports only. 'all': every status. Otherwise that one status. */
  status?: string;
  /** Lab manager contains this text. */
  technician?: string;
  /** Free-text search over finalized reports (two or more characters). */
  q?: string;
  /** A condition on a number in the report, as on the Reports list: all three or none. */
  number_field?: string;
  number_op?: string;
  number_value?: string;
}

function analyticsParams(filters: AnalyticsFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// Units of the same model side by side (finalized reports only).
export function getModelComparison(filters: AnalyticsFilters = {}): Promise<ModelComparison[]> {
  return apiFetch(`/analytics/models${analyticsParams(filters)}`);
}

export function getModelTrend(model: string, field: string, filters: AnalyticsFilters = {}): Promise<ModelTrend> {
  return apiFetch(`/analytics/models/trend${analyticsParams(filters, { model, field })}`);
}

export function getFleetAnalytics(filters: AnalyticsFilters = {}): Promise<FleetAnalytics> {
  return apiFetch(`/analytics/fleet${analyticsParams(filters)}`);
}
