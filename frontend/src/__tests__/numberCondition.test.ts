import { describe, expect, it } from 'vitest';
import { numberConditionText } from '../numberCondition';

describe('numberConditionText', () => {
  it('words a complete condition', () => {
    expect(numberConditionText({ number_field: 'laser_delay', number_op: 'gt', number_value: '29' })).toBe('Laser delay above 29');
    expect(numberConditionText({ number_field: 'x', number_op: 'gte', number_value: '1' })).toBe('X at least 1');
    expect(numberConditionText({ number_field: 'x', number_op: 'lte', number_value: '1' })).toBe('X at most 1');
    expect(numberConditionText({ number_field: 'x', number_op: 'lt', number_value: '1' })).toBe('X below 1');
    expect(numberConditionText({ number_field: 'x', number_op: 'eq', number_value: '1' })).toBe('X equal to 1');
  });

  it('returns an empty string unless all three parts are there and the operator is known', () => {
    expect(numberConditionText({})).toBe('');
    expect(numberConditionText({ number_field: 'x', number_op: 'gt' })).toBe('');
    expect(numberConditionText({ number_op: 'gt', number_value: '1' })).toBe('');
    expect(numberConditionText({ number_field: 'x', number_op: 'between', number_value: '1' })).toBe('');
  });
});
