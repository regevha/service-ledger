import { test, expect } from '@playwright/test';
import { plainMessage } from '../../src/plainMessages';

// Pure logic, no browser: the plain sentences shown instead of raw server messages.

test('a Hebrew document with no Claude key says why, and what to do', () => {
  const hebrew = plainMessage('This document is in Hebrew and cannot be translated without ANTHROPIC_API_KEY');
  expect(hebrew).toContain('in Hebrew');
  expect(hebrew).toContain('Claude API key');
  expect(hebrew).toContain('Tell your administrator');
});

test('a scan or unreadable maker with no key says a key is needed', () => {
  const scan = plainMessage('Reading a scan is not possible without an API key (ANTHROPIC_API_KEY).');
  expect(scan).toContain('only be read with a Claude API key');
});

test('other key and service failures keep their own sentences, and unknown messages pass through', () => {
  expect(plainMessage('authentication failed')).toBe('The reading service is not set up correctly. Tell your administrator.');
  expect(plainMessage('Claude API request failed: 529 overloaded')).toBe('The reading service is busy. Try again in a minute.');
  expect(plainMessage('Something we have no rule for')).toBe('Something we have no rule for');
});
