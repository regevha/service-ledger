import { createContext, useContext } from 'react';
import type { InstrumentAsk } from './instrumentAsk';

export interface InstrumentAskApi {
  /** The question about instruments in force, or null. */
  ask: InstrumentAsk | null;
  /** Opens the Instruments tab with this question. */
  open: (ask: InstrumentAsk) => void;
  clear: () => void;
}

export const InstrumentAskContext = createContext<InstrumentAskApi | null>(null);

/** Null outside the app shell (a screen rendered on its own), where a question about instruments has nowhere to go. */
export function useInstrumentAsk(): InstrumentAskApi | null {
  return useContext(InstrumentAskContext);
}
