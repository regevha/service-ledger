// How long the specs wait for the app, named so a slow screen stands out in a diff
// instead of hiding behind a bare number.
export const TIMEOUT = {
  /** The screen reacting to one action: a click, a navigation, a list refreshing. */
  ui: 15_000,
  /** A flow that goes through the backend worker: upload, classify, extract, finalize. */
  flow: 30_000,
};
