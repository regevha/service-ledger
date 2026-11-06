/**
 * Typed client for the ServiceLedger backend (see SL-TDD-001 §6 for the
 * full endpoint table). Shapes here mirror backend/app/schemas.py field for
 * field rather than approximating them, so a backend schema change is a
 * compile error here, not a silent runtime mismatch.
 */

export * from './types';
export { ApiError } from './http';
export * from './config';
export * from './instruments';
export * from './analytics';
export * from './templates';
export * from './fieldAliases';
export * from './reports';
export * from './attachments';
export * from './translations';
export * from './savedFilters';
export * from './instrumentModels';
export * from './manufacturers';
