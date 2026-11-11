/**
 * Speaking the question, with the browser's own speech recognition (no model call, nothing is sent by this app).
 * Where the browser has none (Firefox, some in-app browsers) `speechSupported()` is false and the app shows no
 * microphone button at all.
 */
interface RecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechSupported(): boolean {
  return ctor() !== null;
}

/** What went wrong, in the three ways the person can act on. */
export type VoiceProblem = 'blocked' | 'nothing' | 'failed';

export function problemOf(error: string): VoiceProblem | null {
  if (error === 'aborted') return null; // stopped on purpose
  if (error === 'not-allowed' || error === 'service-not-allowed') return 'blocked';
  if (error === 'no-speech' || error === 'audio-capture') return 'nothing';
  return 'failed';
}

export const PROBLEM_TEXT: Record<VoiceProblem, string> = {
  blocked: 'The microphone is blocked for this site. Allow it in the browser, or type the question.',
  nothing: 'Did not hear anything. Tap the microphone and try again.',
  failed: 'Could not take that by voice. Type the question instead.',
};

/** The spoken words, from the first alternative of each result, joined and trimmed. */
export function transcriptOf(event: RecognitionResultEvent): string {
  const parts: string[] = [];
  for (let i = 0; i < event.results.length; i++) {
    const first = event.results[i][0];
    if (first && first.transcript) parts.push(first.transcript);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Listens for one sentence. Returns a function that stops it, or null where speech recognition is not available.
 * The language is English because that is what the app reads.
 */
export function listen(handlers: { onText: (text: string) => void; onProblem: (problem: VoiceProblem) => void; onEnd: () => void }): (() => void) | null {
  const Ctor = ctor();
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.lang = 'en-US';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (event) => {
    const text = transcriptOf(event);
    if (text) handlers.onText(text);
    else handlers.onProblem('nothing');
  };
  recognition.onerror = (event) => {
    const problem = problemOf(event.error);
    if (problem) handlers.onProblem(problem);
  };
  recognition.onend = () => handlers.onEnd();
  try {
    recognition.start();
  } catch {
    handlers.onProblem('failed');
    handlers.onEnd();
    return () => undefined;
  }
  return () => {
    try {
      recognition.stop();
    } catch {
      // Already stopped.
    }
  };
}
