import { useEffect, useState } from 'react';

export function WorkingPanel({
  label,
  fileName,
  slow,
  onCancel,
}: {
  label: string;
  fileName?: string;
  /** True when a live model is reading the scan, which takes a while. */
  slow: boolean;
  onCancel?: () => void;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="section working-panel" data-testid="intake-working">
      <div className="spinner" />
      <div className="working-text">
        <div>{label}</div>
        <div className="working-detail">
          {fileName && <span className="working-file" data-testid="intake-working-file">{fileName}</span>}
          <span>{seconds}s</span>
        </div>
        {slow && seconds < 90 && <div className="working-detail">Reading a scan usually takes 10–60 seconds; a translated one takes longer.</div>}
        {slow && seconds >= 90 && <div className="working-detail">Still working — this one is taking longer than usual.</div>}
        <ul className="working-steps" aria-label="Progress">
          <li className="done">Scan uploaded</li>
          <li className="now">{label.replace(/[….]+$/, '')}</li>
          <li>You check the result</li>
        </ul>
        <div className="working-detail">You can leave this tab; the report keeps reading in the background.</div>
      </div>
      {onCancel && (
        <button type="button" className="btn small" data-testid="intake-cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
