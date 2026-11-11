/**
 * A condition on a number in a report ("laser delay above 29"): the name of the field, how to compare and the number.
 * The three always go together. Only finalized reports are searched, and for a field with one number per laser or
 * detector a report passes when any of them does.
 */
export const NUMBER_OPS = ['gt', 'gte', 'lt', 'lte', 'eq'] as const;
export type NumberOp = (typeof NUMBER_OPS)[number];

const OP_WORD: Record<NumberOp, string> = { gt: 'above', gte: 'at least', lt: 'below', lte: 'at most', eq: 'equal to' };

export interface NumberCondition {
  number_field?: string;
  number_op?: string;
  number_value?: string;
}

/** "Laser delay above 29", or '' when the three parts are not all there. */
export function numberConditionText(f: NumberCondition): string {
  if (!f.number_field || !f.number_value || !NUMBER_OPS.includes(f.number_op as NumberOp)) return '';
  const name = f.number_field.replace(/_/g, ' ');
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${OP_WORD[f.number_op as NumberOp]} ${f.number_value}`;
}
