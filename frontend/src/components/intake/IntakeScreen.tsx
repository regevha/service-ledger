import { useRef, useState } from 'react';
import { ACCEPTED_TYPES, dropProblem } from '../../uploadFiles';
import { useMediaQuery } from '../../hooks/useMediaQuery';

export function IntakeScreen({
  technicianName,
  setTechnicianName,
  files,
  setFiles,
  onStart,
}: {
  technicianName: string;
  setTechnicianName: (v: string) => void;
  files: File[];
  setFiles: (f: File[]) => void;
  onStart: () => void;
}) {
  const file = files[0] ?? null;
  const chosenLabel = files.length > 1 ? `${files.length} photos — one report` : file?.name;
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  const phone = useMediaQuery('(max-width: 620px)');
  const browseRef = useRef<HTMLInputElement>(null);
  const cameraMode = useRef(false);
  // Photos taken one after another are the pages of one report: each new one joins the ones already chosen.
  const addPhotos = (picked: File[]) => {
    const kept = files.length > 0 && files.every((f) => f.type.startsWith('image/')) ? files : [];
    const next = [...kept, ...picked];
    const problem = next.length > 1 ? dropProblem(next) : null;
    setDropError(problem);
    if (!problem) setFiles(next);
  };
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  return (
    <div className="section">
      <div className="intake-head">
        <h2 className="intake-heading">Add a service report</h2>
        {/* The button sits at the top on every screen size, so it is in view without scrolling.
            It stays disabled until a file is chosen. */}
        <button className="btn primary intake-head-cta" disabled={!file} onClick={onStart}>
          Upload &amp; classify
        </button>
      </div>

      <label
        data-testid="intake-dropzone"
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragEnter={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault(); // without this the browser refuses the drop
          e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        }}
        onDragLeave={(e) => {
          // Moving over the icon or text inside the box also fires this; only a real exit counts.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(false);
          const files = Array.from(e.dataTransfer.files);
          const problem = dropProblem(files);
          // A refused drop leaves the file already chosen in place; say so, so it is not a surprise.
          setDropError(problem && file ? `${problem} Keeping ${chosenLabel}.` : problem);
          if (!problem) setFiles(files);
        }}
      >
        <div className="icon">📄</div>
        <div className="primary">
          {dragging ? 'Drop the file here' : file ? chosenLabel : phone ? 'Take a photo or choose a file' : 'Click to choose a scan or PDF, or drop it here'}
        </div>
        <input
          type="file"
          multiple
          data-testid="intake-file-input"
          accept={ACCEPTED_TYPES.join(',')}
          // Visually hidden, not display:none, so the keyboard can reach it (Enter or Space opens the picker).
          className="sr-only"
          aria-label="Choose a scan or PDF"
          ref={browseRef}
          onChange={(e) => {
            setDropError(null);
            const picked = Array.from(e.target.files ?? []);
            if (cameraMode.current) {
              cameraMode.current = false;
              addPhotos(picked);
              e.target.value = '';
              return;
            }
            const problem = picked.length > 1 ? dropProblem(picked) : null;
            if (problem) {
              setDropError(problem);
              return;
            }
            setFiles(picked);
          }}
        />
      </label>
      {phone && (
        <div className="phone-pick" data-testid="intake-phone-pick">
          <button
            type="button"
            className="btn primary"
            data-testid="intake-take-photo"
            onClick={() => {
              // The one file input is reused: with `capture` set the phone opens the camera instead of the picker.
              const input = browseRef.current;
              if (!input) return;
              cameraMode.current = true;
              input.setAttribute('capture', 'environment');
              input.click();
              input.removeAttribute('capture');
            }}
          >
            Take photo
          </button>
          <button type="button" className="btn" onClick={() => {
              cameraMode.current = false;
              browseRef.current?.click();
            }}>
            Browse files
          </button>
        </div>
      )}
      {dropError && (
        <div className="drop-error" role="alert" data-testid="intake-drop-error">
          {dropError}
        </div>
      )}

      <div className="intake-name">
        <label htmlFor="intake-name">
          Your name <span className="intake-name-optional">(optional)</span>
        </label>
        <input
          id="intake-name"
          type="text"
          className="text-input"
          placeholder="Your name (optional)"
          value={technicianName}
          onChange={(e) => setTechnicianName(e.target.value)}
        />
      </div>

      <div className="intake-info">
        <p className="intake-subheading">Upload the scan or photos. We read the instrument and visit type, then you check the details.</p>
        <p className="hint-text">Scanned or printed service forms, as a PDF or a PNG, JPEG, GIF or WebP image — one PDF, or several photos of the pages, per report; any instrument, any report type</p>
        <aside className="next-card" data-testid="intake-next-card" aria-label="What happens next">
          <div className="next-card-title">What happens next</div>
          <ol>
            <li>
              <strong>We read the form.</strong> Usually 10–60 seconds.
            </li>
            <li>
              <strong>You confirm the instrument and report type.</strong> Only what we are unsure about is outlined.
            </li>
            <li>
              <strong>You check the fields</strong> against the scan, then finalize.
            </li>
          </ol>
        </aside>
      </div>
    </div>
  );
}
