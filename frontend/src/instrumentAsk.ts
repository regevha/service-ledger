import type { ReportSearchResult } from './api';
import { NUMBER_OPS, type NumberOp } from './numberCondition';

/**
 * A question about instruments ("instruments with more than 2 repairs this year"). It cannot be answered by the
 * Reports list, so the Ask box opens the Instruments tab with it. It is not kept like a report search: it lasts
 * until the person clears it or asks something else.
 */
export interface InstrumentAsk {
  op: NumberOp;
  count: number;
  date_from?: string;
  date_to?: string;
  model_id?: string;
  place_id?: string;
  /** What was understood, one entry per condition, for the banner. */
  labels: string[];
  /** Parts that were left out or not supported, shown under the banner. */
  notes: string[];
}

export function instrumentAskOf(result: ReportSearchResult): InstrumentAsk | null {
  const { repairs_op: op, repairs_count: count, ...rest } = result.filters;
  const n = Number(count);
  if (result.target !== 'instruments' || !NUMBER_OPS.includes(op as NumberOp) || !Number.isInteger(n) || n < 0) return null;
  return {
    op: op as NumberOp,
    count: n,
    date_from: rest.date_from,
    date_to: rest.date_to,
    model_id: rest.model_id,
    place_id: rest.place_id,
    labels: result.understood.map((part) => part.label),
    notes: result.notes ?? [],
  };
}

/** True when an instrument with `repairs` repairs is one the question asks for. */
export function passesRepairCount(ask: Pick<InstrumentAsk, 'op' | 'count'>, repairs: number): boolean {
  switch (ask.op) {
    case 'gt':
      return repairs > ask.count;
    case 'gte':
      return repairs >= ask.count;
    case 'lt':
      return repairs < ask.count;
    case 'lte':
      return repairs <= ask.count;
    default:
      return repairs === ask.count;
  }
}
