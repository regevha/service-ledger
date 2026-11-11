import type { Page } from '@playwright/test';

type FakeRecognition = {
  onresult: ((e: { results: { transcript: string }[][] }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type Win = { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown; __rec?: FakeRecognition };

/** Gives the page a speech recognition it can drive, so voice can be tested without a microphone. */
export async function installFakeSpeech(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Win;
    class Fake {
      lang = '';
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onresult: FakeRecognition['onresult'] = null;
      onerror: FakeRecognition['onerror'] = null;
      onend: FakeRecognition['onend'] = null;
      start() {
        w.__rec = this;
      }
      stop() {
        this.onend?.();
      }
    }
    w.SpeechRecognition = Fake;
    w.webkitSpeechRecognition = Fake;
  });
}

/** Takes speech recognition away, like a browser that has none. */
export async function removeSpeech(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Win;
    w.SpeechRecognition = undefined;
    w.webkitSpeechRecognition = undefined;
  });
}

/** The person says something (what the fake recognition hears), and the recognition ends. */
export async function say(page: Page, text: string): Promise<void> {
  await page.evaluate((spoken) => {
    const rec = (window as unknown as Win).__rec!;
    rec.onresult?.({ results: [[{ transcript: spoken }]] });
    rec.onend?.();
  }, text);
}

/** The recognition fails (for example 'not-allowed' when the microphone is blocked) and ends. */
export async function failToHear(page: Page, error: string): Promise<void> {
  await page.evaluate((code) => {
    const rec = (window as unknown as Win).__rec!;
    rec.onerror?.({ error: code });
    rec.onend?.();
  }, error);
}
