// Messages from the server and the browser are written for the people who run it: API codes, setting
// names, section numbers. The intake and save screens show these plain sentences instead. The raw text
// stays available under "Details for support" and in the server log.

const RULES: Array<[RegExp, string]> = [
  // The no-key stub mode refuses these on purpose. They must come before the general key rule below,
  // which would call them "not set up correctly" and hide why the document was refused.
  [
    /in Hebrew and cannot be translated without/i,
    'This document is in Hebrew, and reading it needs a Claude API key, which is not switched on. Tell your administrator.',
  ],
  [
    /without an API key/i,
    'This document can only be read with a Claude API key, which is not switched on. Tell your administrator.',
  ],
  [/authentication failed|ANTHROPIC_API_KEY/i, 'The reading service is not set up correctly. Tell your administrator.'],
  [/Claude API request failed.*(529|overloaded|rate.?limit|429)/is, 'The reading service is busy. Try again in a minute.'],
  [/Claude API request failed.*(timed? ?out|timeout|connection)/is, 'The reading service did not answer. Try again in a minute.'],
  [/Claude API request failed/i, 'The reading service could not read this document just now. Try again in a minute.'],
  [/did not finish within/i, 'Still reading. This one is taking longer than usual. Try again to keep waiting.'],
  [/Worker restarted while this job was in progress/i, 'The reading was interrupted. Try again.'],
  [/Worker crashed processing/i, 'Something went wrong while reading this document. Try again.'],
  [/no resolved instrument\/template/i, 'This report has no instrument and form yet. Go back and choose them.'],
  [/Could not reach the backend/i, 'Cannot reach the server. Check the connection and try again.'],
];

/** The plain sentence for a known failure, or the message unchanged when there is no better wording. */
export function plainMessage(raw: string): string {
  for (const [pattern, plain] of RULES) if (pattern.test(raw)) return plain;
  return raw;
}
