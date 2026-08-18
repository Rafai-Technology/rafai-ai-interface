import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * SpeechRecognition is not in TypeScript's DOM lib — it never became a W3C
 * standard, it is a WICG spec Chromium and WebKit shipped anyway. These are
 * the parts we actually touch.
 */
interface SpeechRecognitionAlternative { transcript: string }
interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const FRIENDLY_ERROR: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow it in the address bar to dictate.',
  'service-not-allowed': 'Microphone access was blocked by the browser.',
  'no-speech': 'Nothing was picked up — try again a little closer to the mic.',
  'audio-capture': 'No microphone was found.',
  network: 'Speech recognition could not reach the network.',
};

export interface SpeechInput {
  /** False in Firefox and anywhere else without the API — hide the button. */
  supported: boolean;
  listening: boolean;
  error: string | null;
  start: (base: string) => void;
  stop: () => void;
}

/**
 * Dictation for the composer, done entirely in the browser.
 *
 * Deliberately not a server-side transcription call: it costs nothing per use,
 * needs no audio upload, and adds no latency to a demo that is already waiting
 * on a model. `onTranscript` receives the full text — the caller's text before
 * dictation started, plus what has been heard so far — so speaking is additive
 * to whatever was already typed rather than replacing it.
 */
export function useSpeechInput(onTranscript: (text: string) => void): SpeechInput {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState(() => getCtor() !== null);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const baseRef = useRef('');
  // Kept in a ref so the recogniser's handlers never close over a stale
  // callback between renders.
  const cbRef = useRef(onTranscript);
  useEffect(() => { cbRef.current = onTranscript; }, [onTranscript]);

  const stop = useCallback(() => {
    recRef.current?.stop();
    setListening(false);
  }, []);

  const start = useCallback((base: string) => {
    const Ctor = getCtor();
    if (!Ctor) return;

    recRef.current?.abort();
    setError(null);
    baseRef.current = base.trim();

    const rec = new Ctor();
    // en-IN matters here: it handles Indian English far better than en-US,
    // which is what the operators using this actually speak.
    rec.lang = 'en-IN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      let heard = '';
      for (let i = 0; i < e.results.length; i++) {
        heard += e.results[i][0].transcript;
      }
      const joined = [baseRef.current, heard.trim()].filter(Boolean).join(' ');
      cbRef.current(joined);
    };

    rec.onerror = (e) => {
      // Ending a session by clicking stop reports as 'aborted'; not an error.
      if (e.error !== 'aborted') {
        setError(FRIENDLY_ERROR[e.error] ?? `Dictation failed (${e.error}).`);
      }
      setListening(false);
    };

    rec.onend = () => setListening(false);

    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      // start() throws if called while already running — harmless.
      setListening(true);
    }
  }, []);

  // A recogniser left running after unmount keeps the mic indicator on.
  useEffect(() => () => recRef.current?.abort(), []);

  return { supported, listening, error, start, stop };
}
