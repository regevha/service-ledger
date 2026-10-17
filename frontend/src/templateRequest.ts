import type { ReportType } from './api';

/**
 * A report that is waiting for a template of its own: the intake flow asks the
 * Templates tab to open a new-template form for this model and report type
 * (prefilled, with the closest existing template as the starting point), and
 * reads the report again once that template is saved.
 */
export interface TemplateRequest {
  instrumentType: string;
  reportType: ReportType;
  /** The model exactly as the instrument spells it, so the new template resolves for it. */
  model: string;
}
