import { useEffect, useRef, useState } from 'react';
import { API_BASE, apiFetch } from '../api/http';
import { GROUPABLE_TYPES, isGroupableFile, isPdfFile } from '../uploadFiles';
import { prepareUpload } from '../imageUpload';

type Source = { file: File; pageCount: number };
type Page = { source: Source; number: number };
type Group = Page[];

const MAX_GROUPS = 30;
const MAX_PAGES = 80;

async function describe(file: File): Promise<Source> {
  if (!isPdfFile(file)) return { file, pageCount: 1 };
  const body = new FormData();
  body.append('file', file);
  const data = await apiFetch<{ page_count: number }>('/uploads/inspect', { method: 'POST', body });
  return { file, pageCount: data.page_count };
}

function pages(source: Source): Page[] {
  return Array.from({ length: source.pageCount }, (_, index) => ({ source, number: index + 1 }));
}

function suggest(sources: Source[]): Group[] {
  const groups: Group[] = [];
  for (const source of sources) {
    const previous = groups.at(-1);
    if (!isPdfFile(source.file) && previous && previous.every((page) => !isPdfFile(page.source.file))) {
      previous.push(...pages(source));
    } else {
      groups.push(pages(source));
    }
  }
  return groups;
}

async function compose(group: Group, signal: AbortSignal): Promise<File> {
  const sources = [...new Set(group.map((page) => page.source))];
  if (sources.length === 1 && group.length === sources[0].pageCount && group.every((page, i) => page.number === i + 1)) {
    return sources[0].file;
  }
  if (sources.every((source) => !isPdfFile(source.file))) return prepareUpload(group.map((page) => page.source.file));

  const body = new FormData();
  for (const source of sources) body.append('files', source.file);
  body.append('selection', JSON.stringify({
    pages: group.map((page) => ({ source: sources.indexOf(page.source), page: page.number })),
  }));
  const response = await fetch(`${API_BASE}/uploads/compose`, { method: 'POST', body, signal });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(typeof detail?.detail === 'string' ? detail.detail : 'Could not assemble these pages.');
  }
  const name = group[0].source.file.name.replace(/\.[^.]+$/, '');
  return new File([await response.blob()], `${name}-grouped.pdf`, { type: 'application/pdf' });
}

function SourcePreview({ page }: { page: Page }) {
  const [url, setUrl] = useState('');
  const file = page.source.file;
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  return (
    <span className="grouping-page-name">
      {url && !isPdfFile(file) && <img src={url} alt="" />}
      <span>{file.name}{isPdfFile(file) && ` · Page ${page.number}`}</span>
      {url && isPdfFile(file) && <a href={`${url}#page=${page.number}`} target="_blank" rel="noopener noreferrer">View page</a>}
    </span>
  );
}

export function UploadGrouping({ files, queueCapacity, onConfirm, onCancel }: {
  files: File[];
  queueCapacity: number;
  onConfirm: (files: File[]) => void;
  onCancel: () => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    Promise.all(files.map(describe))
      .then((sources) => { if (mounted) setGroups(suggest(sources)); })
      .catch((cause: unknown) => { if (mounted) setError(cause instanceof Error ? cause.message : 'Could not open the selected files.'); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [files]);

  function move(groupIndex: number, pageIndex: number, destination: number) {
    setGroups((current) => {
      const updated = current.map((group) => [...group]);
      const [page] = updated[groupIndex].splice(pageIndex, 1);
      if (destination === updated.length) updated.push([page]);
      else updated[destination].push(page);
      return updated.filter((group) => group.length > 0);
    });
  }

  function reorder(groupIndex: number, pageIndex: number, offset: number) {
    setGroups((current) => current.map((group, index) => {
      if (index !== groupIndex) return group;
      const updated = [...group];
      const [page] = updated.splice(pageIndex, 1);
      updated.splice(pageIndex + offset, 0, page);
      return updated;
    }));
  }

  async function addToGroup(groupIndex: number, selected: File[]) {
    if (!selected.length) return;
    if (!selected.every(isGroupableFile)) {
      setError('Choose PDF or image pages to add to this report.');
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const extra = await Promise.all(selected.map(describe));
      setGroups((current) => current.map((group, index) => index === groupIndex ? [...group, ...extra.flatMap(pages)] : group));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add those pages.');
    } finally {
      setAdding(false);
    }
  }

  async function confirm() {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setPreparing(true);
    setError(null);
    try {
      const result: File[] = [];
      for (const group of groups) {
        if (request.signal.aborted) return;
        result.push(await compose(group, request.signal));
      }
      if (!request.signal.aborted) onConfirm(result);
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not assemble the reports.');
    } finally {
      controller.current = null;
      if (!request.signal.aborted) setPreparing(false);
    }
  }

  const busy = loading || adding || preparing;
  const tooMany = groups.length > queueCapacity || groups.some((group) => group.length > MAX_PAGES || new Set(group.map(({ source }) => source)).size > MAX_GROUPS);

  return (
    <section className="upload-grouping" aria-labelledby="upload-grouping-title">
      <h2 id="upload-grouping-title">Group pages into reports</h2>
      <p>Each group becomes one report. Check which pages belong together and put them in reading order.</p>
      {loading && <p role="status">Opening selected files…</p>}
      {error && <p className="banner banner-warn" role="alert">{error}</p>}
      {tooMany && <p className="banner banner-warn" role="alert">The queue has room for {queueCapacity} more reports. Each report can have up to 80 pages and 30 source files.</p>}
      {groups.map((group, groupIndex) => (
        <fieldset key={groupIndex} disabled={busy}>
          <legend>Report {groupIndex + 1} · {group.length} {group.length === 1 ? 'page' : 'pages'}</legend>
          <ol>
            {group.map((page, pageIndex) => (
              <li key={pageIndex}>
                <SourcePreview page={page} />
                <div className="grouping-actions">
                  <button className="btn small" type="button" disabled={pageIndex === 0} onClick={() => reorder(groupIndex, pageIndex, -1)}>Move up</button>
                  <button className="btn small" type="button" disabled={pageIndex === group.length - 1} onClick={() => reorder(groupIndex, pageIndex, 1)}>Move down</button>
                  <select aria-label={`Move page ${pageIndex + 1} of report ${groupIndex + 1}`} value="" onChange={(event) => { if (event.target.value) move(groupIndex, pageIndex, Number(event.target.value)); }}>
                    <option value="">Move to…</option>
                    {groups.map((_, index) => index === groupIndex ? null : <option key={index} value={index}>Report {index + 1}</option>)}
                    <option value={groups.length}>New report</option>
                  </select>
                </div>
              </li>
            ))}
          </ol>
          <label className="grouping-append">
            Add pages to report {groupIndex + 1}
            <input type="file" multiple accept={GROUPABLE_TYPES.join(',')} onChange={(event) => {
              void addToGroup(groupIndex, Array.from(event.target.files ?? []));
              event.target.value = '';
            }} />
          </label>
        </fieldset>
      ))}
      <div className="grouping-actions">
        <button className="btn" type="button" onClick={() => { controller.current?.abort(); onCancel(); }}>Cancel grouping</button>
        <button className="btn primary" type="button" disabled={busy || groups.length === 0 || tooMany} onClick={() => void confirm()}>
          {preparing ? 'Preparing reports…' : `Queue ${groups.length} ${groups.length === 1 ? 'report' : 'reports'}`}
        </button>
      </div>
    </section>
  );
}
