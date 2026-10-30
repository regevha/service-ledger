import { type APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

// The seeded templates carry no per-detector or pressure fields (the calibration templates that did
// are gone), so specs that chart numbers or edit per-detector maps make their own model and a
// template for it. The model is new, so nothing else in the shared database is affected.

export const NUMERIC_FIELDS = [
  { name: 'cst_beads_lot', type: 'text', unit: null, notes: 'lot number, for traceability' },
  { name: 'baseline_cv_percent', type: 'number[detector]', unit: '%', notes: 'per-detector, flag if > 5%' },
  { name: 'pmt_voltages', type: 'number[detector]', unit: 'V', notes: 'volts' },
  { name: 'fluidics_pressure_psi', type: 'number', unit: 'psi', notes: null },
];

/** Gives `model` an installation/upgrade template with the numeric fields above. */
export async function createNumericTemplate(request: APIRequestContext, model: string): Promise<void> {
  const res = await request.post(`${API_BASE}/report-templates`, {
    data: { instrument_type: 'flow_cytometer', report_type: 'installation_upgrade', model, fields: NUMERIC_FIELDS },
  });
  expect(res.status(), await res.text()).toBe(201);
}

/** A new instrument whose model has the numeric template; returns the model name. */
export async function createNumericModel(request: APIRequestContext, prefix: string): Promise<string> {
  const model = `${prefix}-${Date.now()}`;
  const res = await request.post(`${API_BASE}/instruments`, {
    data: { name: model, model, manufacturer: 'E2E Maker', serial_number: `SN-${model}` },
  });
  expect(res.status()).toBe(201);
  await createNumericTemplate(request, model);
  return model;
}
