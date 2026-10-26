// A one-line message that fades after a moment ("Saved"). Any screen can call showToast; the ToastHost
// mounted in App shows it. Nothing here keeps state beyond the one message on screen.

export interface ToastMessage {
  id: number;
  text: string;
}

let listener: ((message: ToastMessage) => void) | undefined;
let counter = 0;

export function showToast(text: string): void {
  counter += 1;
  listener?.({ id: counter, text });
}

export function subscribeToast(fn: (message: ToastMessage) => void): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = undefined;
  };
}
