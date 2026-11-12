import { describe, expect, it } from 'vitest';
import { NUMBER_OPS, numberConditionText } from './numberCondition';

describe('numberConditionText', () => {
  it('describes every operator in words', () => {
    const words = ['above', 'at least', 'below', 'at most', 'equal to'];
    NUMBER_OPS.forEach((op, i) => {
      expect(numberConditionText({ number_field: 'beam_width', number_op: op, number_value: '5' })).toBe(`Beam width ${words[i]} 5`);
    });
  });

  it('replaces every underscore and capitalises the first letter', () => {
    expect(numberConditionText({ number_field: 'pump_flow_rate', number_op: 'gt', number_value: '12.5' })).toBe(
      'Pump flow rate above 12.5',
    );
  });

  it('returns an empty string when any part is missing or empty', () => {
    expect(numberConditionText({})).toBe('');
    expect(numberConditionText({ number_op: 'gt', number_value: '1' })).toBe('');
    expect(numberConditionText({ number_field: 'x', number_value: '1' })).toBe('');
    expect(numberConditionText({ number_field: 'x', number_op: 'gt' })).toBe('');
    expect(numberConditionText({ number_field: '', number_op: 'gt', number_value: '1' })).toBe('');
    expect(numberConditionText({ number_field: 'x', number_op: 'gt', number_value: '' })).toBe('');
  });

  it('returns an empty string for an unknown operator', () => {
    expect(numberConditionText({ number_field: 'x', number_op: 'ne', number_value: '1' })).toBe('');
    expect(numberConditionText({ number_field: 'x', number_op: 'GT', number_value: '1' })).toBe('');
  });

  it('keeps a value of "0" (a non-empty string)', () => {
    expect(numberConditionText({ number_field: 'offset', number_op: 'eq', number_value: '0' })).toBe('Offset equal to 0');
  });
});
