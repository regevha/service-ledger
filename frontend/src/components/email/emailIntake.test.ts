import { describe, expect, it } from 'vitest';
import { PUBLIC_DOMAINS, senderLabelError, senderValueError } from './allowedSenderRules';
import { emailFiles, emailOutcome, replyStatus } from './emailLog';
describe('allowed sender validation', () => {
  it.each(['team@example.org', 'team+reports@lab.example.org'])('accepts %s', (value) => expect(senderValueError('address', value)).toBeNull());
  it.each(['', 'team', 'team@@example.org', 'team@localhost', 'team @example.org', 'team@-example.org'])('rejects %s', (value) => expect(senderValueError('address', value)).toBeTruthy());
  it.each(['example.org', '@example.org', 'lab.example.org'])('accepts domain %s', (value) => expect(senderValueError('domain', value)).toBeNull());
  it.each(['', 'team@example.org', 'localhost', '-example.org', 'example..org', 'example.org/path'])('rejects domain %s', (value) => expect(senderValueError('domain', value)).toBeTruthy());
  it('limits addresses and domains', () => { expect(senderValueError('address', `${'x'.repeat(65)}@example.org`)).toBeTruthy(); expect(senderValueError('domain', 'a'.repeat(254))).toBeTruthy(); });
  it.each(['', 'team@example.org', 'a'.repeat(61), 'team\nname'])('rejects invalid label %s', (value) => expect(senderLabelError(value)).toBeTruthy());
  it('allows a team label', () => expect(senderLabelError(' Flow core team ')).toBeNull());
  it('warns on common public domains', () => { expect(PUBLIC_DOMAINS.has('gmail.com')).toBe(true); expect(PUBLIC_DOMAINS.has('example.org')).toBe(false); });
});
describe('email log wording', () => {
  it.each([['processed', 'Handled'], ['unknown_sender', 'Dropped: sender not on the list'], ['sender_not_verified', 'Dropped: sender could not be confirmed'], ['rate_limited', 'Dropped: too many emails in an hour'], ['no_pdf', 'No PDF attached'], ['too_large', 'Email too large to open'], ['auto_reply_ignored', 'Ignored: automatic reply'], ['error', 'Could not be handled'], ['future_value', 'future_value']])('labels %s', (value, label) => expect(emailOutcome(value)).toBe(label));
  it.each([['none', 'None'], ['pending', 'Waiting to send'], ['sent', 'Sent'], ['failed', 'Not sent']])('labels reply %s', (value, label) => expect(replyStatus(value)).toBe(label));
  it('describes mixed outcomes and omits zeros', () => expect(emailFiles({ file_count: 3, files_loaded: 1, files_held: 1, files_refused: 1, files_skipped: 0 })).toBe('3 PDFs: 1 loaded, 1 held, 1 refused'));
  it('describes single PDF', () => expect(emailFiles({ file_count: 1, files_loaded: 1, files_held: 0, files_refused: 0, files_skipped: 0 })).toBe('1 PDF: loaded'));
  it('describes empty email', () => expect(emailFiles({ file_count: 0, files_loaded: 0, files_held: 0, files_refused: 0, files_skipped: 0 })).toBe('No PDFs'));
});
