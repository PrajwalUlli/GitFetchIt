import { useState, useCallback, useRef } from 'react';
import { zipSync, type Zippable } from 'fflate';

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_FILES      = 10_000;
const CONCURRENCY    = 4;
const INCOMPRESSIBLE = new Set([
  'zip','gz','bz2','xz','7z','rar','zst',
  'png','jpg','jpeg','gif','webp','avif','heic','ico',
  'mp4','webm','mov','mkv','avi','mp3','ogg','flac','aac','wav',
  'pdf','docx','xlsx','pptx','wasm',
]);

// ─── Types ────────────────────────────────────────────────────────────────────
interface TreeNode {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

interface RepoInfo { owner: string; repo: string; branch: string; }
type DownloadState = 'idle' | 'fetching' | 'zipping' | 'done' | 'error';

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function ghFetch(url: string, signal?: AbortSignal) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal,
  });
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get('X-RateLimit-Reset');
    const t = reset ? new Date(parseInt(reset) * 1000).toLocaleTimeString() : 'soon';
    throw new Error(`Rate limit — resets at ${t}`);
  }
  if (res.status === 404) throw new Error('Repo not found or is private');
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

function parseRepoUrl(input: string): { owner: string; repo: string; branch: string } | null {
  const s = input.trim().replace(/\.git$/, '').replace(/^https?:\/\//, '');
  const m = s.match(/(?:github\.com\/)?([^/\s]+)\/([^/\s]+)(?:\/tree\/([^/\s]+))?/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3] || '' };
}

function getName(path: string) { return path.split('/').pop() || path; }

function formatSize(bytes?: number) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// Children of a given folder prefix
function childrenOf(nodes: TreeNode[], prefix: string): TreeNode[] {
  const p = prefix ? prefix + '/' : '';
  return nodes.filter(n => {
    if (!n.path.startsWith(p)) return false;
    const rest = n.path.slice(p.length);
    return !rest.includes('/'); // direct children only
  });
}

// ─── Icons ────────────────────────────────────────────────────────────────────
const FolderIcon = ({ open = false }) => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    {open
      ? <path d="M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1H13.25a1.75 1.75 0 0 1 1.74 1.554l-1.979 9A1.75 1.75 0 0 1 11.27 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75c0-.464.184-.91.513-1.237Z"/>
      : <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/>
    }
  </svg>
);

const FileIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914Z"/>
  </svg>
);

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"
    style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
    <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/>
  </svg>
);

const DownloadIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/>
    <path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06L7.25 7.69Z"/>
  </svg>
);

// ─── Checkbox ─────────────────────────────────────────────────────────────────
function Checkbox({ checked, indeterminate, onChange }: {
  checked: boolean; indeterminate?: boolean; onChange: () => void;
}) {
  return (
    <div onClick={e => { e.stopPropagation(); onChange(); }} style={{
      width: 14, height: 14, borderRadius: 3, flexShrink: 0,
      border: `1.5px solid ${checked || indeterminate ? '#238636' : 'rgba(240,246,252,0.2)'}`,
      background: checked ? '#238636' : indeterminate ? 'rgba(35,134,54,0.4)' : 'transparent',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', transition: 'all 0.1s',
    }}>
      {checked && (
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
          <path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )}
      {!checked && indeterminate && (
        <div style={{ width: 6, height: 1.5, background: '#fff', borderRadius: 1 }} />
      )}
    </div>
  );
}

// ─── Tree Row ─────────────────────────────────────────────────────────────────
function TreeRow({ node, depth, selected, indeterminate, expanded, onToggleSelect, onToggleExpand }: {
  node: TreeNode;
  depth: number;
  selected: boolean;
  indeterminate: boolean;
  expanded: boolean;
  onToggleSelect: (path: string, type: 'blob' | 'tree') => void;
  onToggleExpand: (path: string) => void;
}) {
  const name = getName(node.path);
  const isDir = node.type === 'tree';

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: `4px 12px 4px ${12 + depth * 16}px`,
        cursor: 'pointer',
        background: selected ? 'rgba(35,134,54,0.1)' : 'transparent',
        borderLeft: selected ? '2px solid #238636' : '2px solid transparent',
        userSelect: 'none',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      onClick={() => isDir ? onToggleExpand(node.path) : onToggleSelect(node.path, node.type)}
    >
      {/* Expand chevron for folders */}
      {isDir ? (
        <span style={{ color: '#7d8590', display: 'flex', width: 10, flexShrink: 0 }}>
          <ChevronIcon open={expanded} />
        </span>
      ) : (
        <span style={{ width: 10, flexShrink: 0 }} />
      )}

      <Checkbox
        checked={selected}
        indeterminate={indeterminate}
        onChange={() => onToggleSelect(node.path, node.type)}
      />

      <span style={{ color: isDir ? '#79c0ff' : '#7d8590', flexShrink: 0, display: 'flex' }}>
        {isDir ? <FolderIcon open={expanded} /> : <FileIcon />}
      </span>

      <span style={{
        flex: 1, fontSize: 12,
        color: selected ? '#e6edf3' : '#cdd9e5',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontWeight: isDir ? 500 : 400,
      }}>
        {name}
      </span>

      {!isDir && node.size ? (
        <span style={{ fontSize: 10, color: '#484f58', flexShrink: 0 }}>
          {formatSize(node.size)}
        </span>
      ) : null}
    </div>
  );
}

// ─── Recursive Tree ───────────────────────────────────────────────────────────
function FileTree({ nodes, prefix, depth, selected, expanded, onToggleSelect, onToggleExpand }: {
  nodes: TreeNode[];
  prefix: string;
  depth: number;
  selected: Set<string>;
  expanded: Set<string>;
  onToggleSelect: (path: string, type: 'blob' | 'tree') => void;
  onToggleExpand: (path: string) => void;
}) {
  const children = childrenOf(nodes, prefix);

  // Compute indeterminate state for a folder
  const folderIndeterminate = (folderPath: string): boolean => {
    if (selected.has(folderPath)) return false;
    const descendants = nodes.filter(n => n.path.startsWith(folderPath + '/'));
    return descendants.some(n => selected.has(n.path));
  };

  return (
    <>
      {children.map(node => (
        <div key={node.path}>
          <TreeRow
            node={node}
            depth={depth}
            selected={selected.has(node.path)}
            indeterminate={node.type === 'tree' ? folderIndeterminate(node.path) : false}
            expanded={expanded.has(node.path)}
            onToggleSelect={onToggleSelect}
            onToggleExpand={onToggleExpand}
          />
          {node.type === 'tree' && expanded.has(node.path) && (
            <FileTree
              nodes={nodes}
              prefix={node.path}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              onToggleSelect={onToggleSelect}
              onToggleExpand={onToggleExpand}
            />
          )}
        </div>
      ))}
    </>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [url, setUrl]               = useState('');
  const [repoInfo, setRepoInfo]     = useState<RepoInfo | null>(null);
  const [allNodes, setAllNodes]     = useState<TreeNode[]>([]);
  const [selected, setSelected]     = useState<Set<string>>(new Set());
  const [expanded, setExpanded]     = useState<Set<string>>(new Set());
  const [loading, setLoading]       = useState(false);
  const [loadErr, setLoadErr]       = useState('');
  const [dlState, setDlState]       = useState<DownloadState>('idle');
  const [dlProgress, setDlProgress] = useState(0);
  const [dlLabel, setDlLabel]       = useState('');
  const [dlErr, setDlErr]           = useState('');
  const [filter, setFilter]         = useState('');
  const abortRef                    = useRef<AbortController | null>(null);

  const isDownloading = dlState === 'fetching' || dlState === 'zipping';

  // ── Load repo ────────────────────────────────────────────────────────────────
  const loadRepo = useCallback(async () => {
    const parsed = parseRepoUrl(url);
    if (!parsed) { setLoadErr('Invalid GitHub URL'); return; }
    setLoading(true); setLoadErr(''); setAllNodes([]); setSelected(new Set()); setExpanded(new Set()); setFilter('');
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      let branch = parsed.branch;
      if (!branch) {
        const data = await ghFetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, ctrl.signal);
        branch = data.default_branch || 'main';
      }
      setRepoInfo({ ...parsed, branch });
      const data = await ghFetch(
        `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        ctrl.signal
      );
      if (data.truncated) throw new Error('Repo too large to fully list');
      setAllNodes(data.tree as TreeNode[]);
    } catch (e: any) {
      if (e.name !== 'AbortError') setLoadErr(e.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [url]);

  // ── Toggle expand ─────────────────────────────────────────────────────────────
  const toggleExpand = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }, []);

  // ── Toggle select ─────────────────────────────────────────────────────────────
  const toggleSelect = useCallback((path: string, type: 'blob' | 'tree') => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
        // Deselect all descendants too
        if (type === 'tree') {
          for (const p of next) { if (p.startsWith(path + '/')) next.delete(p); }
        }
      } else {
        next.add(path);
        // Deselect ancestors to avoid double-counting
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
          next.delete(parts.slice(0, i).join('/'));
        }
      }
      return next;
    });
  }, []);

  const clearAll = () => setSelected(new Set());

  // Count selected items label
  const selectedCount = selected.size;

  // ── Filter ───────────────────────────────────────────────────────────────────
  const filteredNodes = filter.trim()
    ? allNodes.filter(n => n.path.toLowerCase().includes(filter.toLowerCase()))
    : null;

  // ── Download ─────────────────────────────────────────────────────────────────
  const download = useCallback(async () => {
    if (!repoInfo || selected.size === 0) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const { signal } = ctrl;
    setDlState('fetching'); setDlProgress(0); setDlErr('');

    try {
      const { owner, repo, branch } = repoInfo;
      const toFetch: Array<{ zipPath: string; url: string }> = [];

      for (const path of selected) {
        signal.throwIfAborted();
        const node = allNodes.find(n => n.path === path);
        if (!node) continue;

        if (node.type === 'blob') {
          toFetch.push({ zipPath: path, url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}` });
        } else {
          setDlLabel(`Listing ${getName(path)}…`);
          // Get folder blobs from already-loaded tree
          const blobs = allNodes.filter(n => n.type === 'blob' && n.path.startsWith(path + '/'));
          for (const b of blobs) {
            toFetch.push({ zipPath: b.path, url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${b.path}` });
          }
        }
      }

      if (!toFetch.length) throw new Error('Nothing to download');
      if (toFetch.length > MAX_FILES) throw new Error(`Too many files (${toFetch.length.toLocaleString()})`);

      const zipEntries: Zippable = {};
      let done = 0;
      const total = toFetch.length;

      for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
        signal.throwIfAborted();
        await Promise.all(
          toFetch.slice(i, i + CONCURRENCY).map(async ({ zipPath, url }) => {
            const res = await fetch(url, { signal });
            if (!res.ok) throw new Error(`${res.status} — ${zipPath}`);
            const buf = await res.arrayBuffer();
            signal.throwIfAborted();
            const ext = zipPath.slice(zipPath.lastIndexOf('.') + 1).toLowerCase();
            zipEntries[zipPath] = INCOMPRESSIBLE.has(ext)
              ? [new Uint8Array(buf), { level: 0 }]
              : [new Uint8Array(buf), { level: 1 }];
            done++;
            setDlLabel(`Fetching ${done} / ${total}`);
            setDlProgress((done / total) * 90);
          })
        );
      }

      setDlState('zipping'); setDlLabel('Zipping…'); setDlProgress(95);
      await new Promise<void>(r => setTimeout(r, 16));
      signal.throwIfAborted();

      const zipped = zipSync(zipEntries);
      signal.throwIfAborted();
      for (const k in zipEntries) delete (zipEntries as any)[k];
      setDlProgress(100);

      const blob  = new Blob([zipped], { type: 'application/zip' });
      const dlUrl = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: dlUrl, download: `${repo}-gitfetchit.zip` });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(dlUrl), 30_000);

      setDlState('done');
      setDlLabel(`✓ Downloaded ${total} file${total !== 1 ? 's' : ''}`);
      setTimeout(() => { setDlState('idle'); setDlLabel(''); setDlProgress(0); }, 3000);

    } catch (e: any) {
      if (e.name === 'AbortError') {
        setDlState('idle'); setDlLabel(''); setDlProgress(0);
      } else {
        setDlState('error'); setDlErr(e.message ?? 'Download failed');
        setTimeout(() => { setDlState('idle'); setDlErr(''); setDlProgress(0); }, 5000);
      }
    }
  }, [repoInfo, selected, allNodes]);

  const cancelDownload = () => {
    abortRef.current?.abort();
    setDlState('idle'); setDlLabel(''); setDlProgress(0);
  };

  return (
    <div style={{
      width: 420, minHeight: 520, maxHeight: 600,
      background: '#000', color: '#e6edf3',
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>

      {/* ── Header ── */}
      <div style={{
        padding: '14px 16px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        background: '#0a0a0a',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div style={{
            width: 26, height: 26, borderRadius: 6,
            background: '#238636',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <DownloadIcon />
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3', letterSpacing: '0.01em' }}>GitFetchIt</div>
            <div style={{ fontSize: 10, color: '#7d8590', letterSpacing: '0.06em' }}>SELECT & ZIP</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center',
            background: '#0d0d0d',
            border: '1px solid rgba(255,255,255,0.09)',
            borderRadius: 7, overflow: 'hidden',
          }}>
            <span style={{ padding: '0 6px 0 10px', color: '#484f58', fontSize: 11, userSelect: 'none', whiteSpace: 'nowrap' }}>
              github.com/
            </span>
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && loadRepo()}
              placeholder="owner/repo"
              style={{
                flex: 1, background: 'none', border: 'none', outline: 'none',
                color: '#58a6ff', fontSize: 12, padding: '7px 8px 7px 0',
                fontFamily: 'inherit', caretColor: '#238636', minWidth: 0,
              }}
            />
          </div>
          <button
            onClick={loadRepo}
            disabled={loading || !url.trim()}
            style={{
              padding: '0 14px', background: '#238636',
              color: '#fff', border: 'none', borderRadius: 7,
              fontSize: 12, fontWeight: 600,
              cursor: loading || !url.trim() ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit', opacity: !url.trim() ? 0.5 : 1,
              whiteSpace: 'nowrap', transition: 'opacity 0.15s',
            }}
          >
            {loading ? '···' : 'Load →'}
          </button>
        </div>

        {loadErr && (
          <div style={{ marginTop: 7, fontSize: 11, color: '#f85149' }}>⚠ {loadErr}</div>
        )}
      </div>

      {/* ── Repo toolbar ── */}
      {allNodes.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          background: '#000', gap: 8,
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' }}>
            <span style={{ fontSize: 11, color: '#7d8590', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {repoInfo?.owner}/{repoInfo?.repo}
            </span>
            <span style={{
              fontSize: 10, color: '#3fb950',
              border: '1px solid rgba(63,185,80,0.3)',
              padding: '1px 6px', borderRadius: 4, flexShrink: 0,
            }}>
              {repoInfo?.branch}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
            {selectedCount > 0 && (
              <span style={{ fontSize: 10, color: '#3fb950' }}>{selectedCount} selected</span>
            )}
            {selectedCount > 0 && (
              <button onClick={clearAll} style={ghostBtn}>Clear</button>
            )}
          </div>
        </div>
      )}

      {/* ── Filter ── */}
      {allNodes.length > 0 && (
        <div style={{ padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter files…"
            style={{
              width: '100%', background: '#0d0d0d',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 5, outline: 'none',
              color: '#e6edf3', fontSize: 11,
              padding: '5px 8px', fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
        </div>
      )}

      {/* ── File tree / filtered results ── */}
      {allNodes.length > 0 && (
        <div style={{ flex: 1, overflowY: 'auto' }} className="file-list">
          {filter.trim() ? (
            // Flat filtered list
            filteredNodes!.length === 0
              ? <div style={{ padding: 20, textAlign: 'center', color: '#484f58', fontSize: 11 }}>No matches</div>
              : filteredNodes!.map(node => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  selected={selected.has(node.path)}
                  indeterminate={false}
                  expanded={false}
                  onToggleSelect={toggleSelect}
                  onToggleExpand={toggleExpand}
                />
              ))
          ) : (
            // Full navigable tree
            <FileTree
              nodes={allNodes}
              prefix=""
              depth={0}
              selected={selected}
              expanded={expanded}
              onToggleSelect={toggleSelect}
              onToggleExpand={toggleExpand}
            />
          )}
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && allNodes.length === 0 && !loadErr && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 10, color: '#484f58', padding: 32,
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.07)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="20" height="20" viewBox="0 0 16 16" fill="#484f58">
              <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8Z"/>
            </svg>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: '#7d8590', marginBottom: 3 }}>Enter a GitHub repo URL</div>
            <div style={{ fontSize: 11 }}>e.g. github.com/facebook/react</div>
          </div>
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: 10, color: '#7d8590', fontSize: 11,
        }}>
          <div style={{
            width: 18, height: 18,
            border: '2px solid rgba(255,255,255,0.07)',
            borderTopColor: '#238636',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
          Fetching file tree…
        </div>
      )}

      {/* ── Download bar ── */}
      {allNodes.length > 0 && (
        <div style={{
          padding: '8px 10px',
          borderTop: '1px solid rgba(255,255,255,0.07)',
          background: '#0a0a0a',
          display: 'flex', gap: 6, alignItems: 'center',
          flexShrink: 0,
        }}>
          {isDownloading ? (
            <>
              <div style={{
                flex: 1, position: 'relative', height: 34,
                background: '#1a7f37', borderRadius: 7,
                overflow: 'hidden', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0,
                  width: `${dlProgress}%`,
                  background: 'rgba(255,255,255,0.1)',
                  transition: 'width 0.2s ease',
                }} />
                <span style={{ position: 'relative', zIndex: 1, fontSize: 11, fontWeight: 600, color: '#fff' }}>
                  {dlLabel}
                </span>
              </div>
              <button onClick={cancelDownload} style={{
                width: 34, height: 34, flexShrink: 0,
                background: 'rgba(248,81,73,0.12)', color: '#f85149',
                border: '1px solid rgba(248,81,73,0.25)', borderRadius: 7,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
                </svg>
              </button>
            </>
          ) : (
            <button
              onClick={download}
              disabled={selectedCount === 0}
              style={{
                flex: 1, height: 34,
                background: dlState === 'done' ? '#1a7f37' : dlState === 'error' ? '#b62324' : '#238636',
                color: '#fff', border: 'none', borderRadius: 7,
                fontSize: 12, fontWeight: 600,
                cursor: selectedCount === 0 ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
                opacity: selectedCount === 0 ? 0.45 : 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                transition: 'background 0.15s, opacity 0.15s',
              }}
            >
              {dlState === 'done'  ? dlLabel :
               dlState === 'error' ? `⚠ ${dlErr.slice(0, 38)}` :
               <><DownloadIcon /> Download{selectedCount > 0 ? ` ${selectedCount} item${selectedCount !== 1 ? 's' : ''}` : ''} as ZIP</>}
            </button>
          )}
        </div>
      )}

      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; padding: 0; }
        input::placeholder { color: #484f58; }
        .file-list::-webkit-scrollbar { width: 4px; }
        .file-list::-webkit-scrollbar-track { background: transparent; }
        .file-list::-webkit-scrollbar-thumb { background: #21262d; border-radius: 4px; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

const ghostBtn: React.CSSProperties = {
  background: 'none',
  border: '1px solid rgba(255,255,255,0.09)',
  color: '#7d8590', cursor: 'pointer',
  fontSize: 10, padding: '2px 7px',
  borderRadius: 4, fontFamily: 'inherit',
};
