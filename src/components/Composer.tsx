import { forwardRef, useCallback, useEffect, useRef } from 'react';
import { useSpeechInput } from '../hooks/useSpeechInput';
import type { Attachment } from '../types';
import { IconAttach, IconFile, IconMic, IconSend, IconStop } from './icons';

interface Props {
  value: string;
  busy: boolean;
  placeholder?: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** Files already attached to the current conversation. */
  attachments?: Attachment[];
  attachBusy?: boolean;
  attachError?: string | null;
  onAttach?: (files: FileList) => void;
}

const ACCEPTED = '.csv,.txt,.xlsx';

function formatBytes(n: number): string {
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * One composer, two placements. In an empty chat it sits centred as the hero
 * of the page; once a conversation exists it docks to the bottom. Rendering
 * the same component in both spots keeps the two from drifting apart.
 */
export const Composer = forwardRef<HTMLTextAreaElement, Props>(function Composer(
  {
    value, busy, placeholder, onChange, onSubmit,
    attachments = [], attachBusy = false, attachError = null, onAttach,
  },
  ref,
) {
  const speech = useSpeechInput(onChange);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleMic = useCallback(() => {
    if (speech.listening) speech.stop();
    else speech.start(value);
  }, [speech, value]);

  // Sending disables the mic button, so a session left running here would
  // hold the microphone open with no way to switch it off.
  const { listening, stop } = speech;
  useEffect(() => {
    if (busy && listening) stop();
  }, [busy, listening, stop]);

  return (
    <form
      className="composer"
      aria-label="Ask a question"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {(attachments.length > 0 || attachBusy) && (
        <div className="attachments-row">
          {attachments.map((a) => (
            <span
              key={a.id}
              className="attachment-chip"
              title={`${a.filename} · ${formatBytes(a.bytes)}${a.truncated ? ' · shown up to the size cap' : ''}`}
            >
              <IconFile />
              {a.filename}
              {a.truncated && <span className="attachment-chip-flag">truncated</span>}
            </span>
          ))}
          {attachBusy && (
            <span className="attachment-chip uploading">
              <span className="attachment-spin" aria-hidden />
              Attaching…
            </span>
          )}
        </div>
      )}
      {attachError && <p className="attach-error" role="alert">{attachError}</p>}

      <textarea
        ref={ref}
        value={value}
        rows={1}
        aria-label="Your question"
        placeholder={placeholder ?? 'Ask me anything…'}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />

      <div className="composer-foot">
        <span className="composer-hint">
          {speech.listening
            ? 'Listening — speak your question'
            : 'Read-only · every query shown'}
        </span>

        <div className="composer-actions">
          {onAttach && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED}
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) onAttach(e.target.files);
                  e.target.value = ''; // lets the same file be re-picked after an error
                }}
              />
              <button
                type="button"
                className="attach"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || attachBusy}
                aria-label="Attach a file"
                title="Attach a CSV, XLSX or TXT file (up to 5MB)"
              >
                <IconAttach />
              </button>
            </>
          )}
          {/* Hidden rather than shown-and-broken where the API is absent
              (Firefox has never shipped it). */}
          {speech.supported && (
            <button
              type="button"
              className={`mic${speech.listening ? ' live' : ''}`}
              onClick={toggleMic}
              disabled={busy}
              aria-pressed={speech.listening}
              aria-label={speech.listening ? 'Stop dictating' : 'Dictate your question'}
              title={speech.listening ? 'Stop dictating' : 'Dictate your question'}
            >
              {speech.listening ? <IconStop /> : <IconMic />}
            </button>
          )}
          <button
            type="submit"
            className="send"
            disabled={busy || !value.trim()}
            aria-label={busy ? 'Working' : 'Send question'}
          >
            {busy ? <span className="send-spin" aria-hidden /> : <IconSend />}
          </button>
        </div>
      </div>

      {speech.error && (
        <p className="mic-error" role="status">{speech.error}</p>
      )}
    </form>
  );
});
