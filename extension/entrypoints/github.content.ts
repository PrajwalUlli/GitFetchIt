import { zipSync, type Zippable } from 'fflate';

export default defineContentScript({
  matches: ['*://github.com/*'],
  main() {
    const CHECKBOX_ATTR  = 'data-gfi-injected';
    const PANEL_ID       = 'gfi-panel';
    const DEBOUNCE_MS    = 350;
    const MAX_SELECTIONS = 10;
    const MAX_FILES      = 10_000;
    const CONCURRENCY    = 4; // low concurrency = low memory pressure

    // ─── State ────────────────────────────────────────────────────────────────
    const selectedFiles = new Map<string, string>(); // href → name
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let activeAbortController: AbortController | null = null;

    const INCOMPRESSIBLE = new Set([
      'zip','gz','bz2','xz','7z','rar','zst',
      'png','jpg','jpeg','gif','webp','avif','heic','heif','ico',
      'mp4','webm','mov','mkv','avi','mp3','ogg','flac','aac','wav',
      'pdf','docx','xlsx','pptx','wasm',
    ]);

    // ─── GitHub URL helpers ───────────────────────────────────────────────────

    interface GHRef { owner:string; repo:string; branch:string; path:string; kind:'blob'|'tree' }

    function parseGHHref(href: string): GHRef | null {
      const clean = href.replace(/^\//, '').split('?')[0].split('#')[0];
      const m = clean.match(/^([^/]+)\/([^/]+)\/(blob|tree)\/([^/]+)(?:\/(.*))?$/);
      if (!m) return null;
      return { owner:m[1], repo:m[2], kind:m[3] as 'blob'|'tree', branch:m[4], path:m[5]??'' };
    }

    function rawUrl(r: GHRef) {
      return `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.branch}/${r.path}`;
    }

    // Shared API fetch helper with proper error messages
    async function ghFetch(url: string, signal: AbortSignal) {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal,
      });
      if (res.status === 403 || res.status === 429) {
        const reset = res.headers.get('X-RateLimit-Reset');
        const resetTime = reset ? new Date(parseInt(reset) * 1000).toLocaleTimeString() : 'soon';
        throw new Error(`GitHub rate limit hit. Resets at ${resetTime}. Sign in to GitHub to get 5000 req/hr.`);
      }
      if (res.status === 404) throw new Error(`Not found — is this a private repo?`);
      if (!res.ok) throw new Error(`GitHub API error ${res.status}`);
      return res.json();
    }

    async function listFolderFiles(ref: GHRef, signal: AbortSignal): Promise<string[]> {
      // Use Contents API to get the folder's SHA in one call — avoids walking
      // path segments one-by-one (which burns N API calls per depth level).
      const contentsUrl = `https://api.github.com/repos/${ref.owner}/${ref.repo}/contents/${ref.path}?ref=${encodeURIComponent(ref.branch)}`;
      const contents = await ghFetch(contentsUrl, signal);

      // Contents API returns an array of entries for a directory.
      // We need the SHA of the directory itself — get it from the parent tree.
      // Shortcut: use git/trees with the branch and filter, but to avoid the
      // truncation problem we use the SHA from a single non-recursive root fetch.
      signal.throwIfAborted();

      // Get root tree non-recursively to find our folder's SHA in one call
      const segments = ref.path.split('/').filter(Boolean);
      const rootTree = await ghFetch(
        `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(ref.branch)}`,
        signal
      );

      // Walk segments through already-fetched tree levels — no extra API calls
      // needed for shallow paths since we only fetch the next level when required
      let currentEntries: Array<{path:string;type:string;sha:string}> = rootTree.tree;
      let folderSha = '';

      for (let i = 0; i < segments.length; i++) {
        signal.throwIfAborted();
        const seg = segments[i];
        const entry = currentEntries.find(n => n.path === seg && n.type === 'tree');
        if (!entry) throw new Error(`Folder "${seg}" not found in tree`);
        folderSha = entry.sha;

        // Only fetch next level if there are more segments to traverse
        if (i < segments.length - 1) {
          const nextTree = await ghFetch(
            `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${entry.sha}`,
            signal
          );
          currentEntries = nextTree.tree;
        }
      }

      if (!folderSha) throw new Error(`Could not resolve folder SHA for "${ref.path}"`);

      // Fetch the target folder's subtree recursively using its own SHA.
      // Scoped to just this folder — far less likely to truncate.
      signal.throwIfAborted();
      const sub = await ghFetch(
        `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${folderSha}?recursive=1`,
        signal
      );

      if (sub.truncated)
        throw new Error(`Folder is too large. Try selecting individual subfolders instead.`);

      const prefix = ref.path + '/';
      const blobs = (sub.tree as Array<{path:string;type:string}>)
        .filter(n => n.type === 'blob')
        .map(n => `${prefix}${n.path}`);

      if (blobs.length > MAX_FILES)
        throw new Error(`Folder has ${blobs.length.toLocaleString()} files — exceeds ${MAX_FILES.toLocaleString()} limit`);

      return blobs;
    }

    // ─── Styles ───────────────────────────────────────────────────────────────

    function ensureStyle() {
      if (document.getElementById('gfi-style')) return;
      const s = document.createElement('style');
      s.id = 'gfi-style';
      s.textContent = `
        @keyframes gh-spin { to { transform: rotate(360deg) } }
        #gfi-panel * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        #gfi-file-list::-webkit-scrollbar { width: 4px }
        #gfi-file-list::-webkit-scrollbar-track { background: transparent }
        #gfi-file-list::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px }
      `;
      document.head.appendChild(s);
    }

    const SPINNER  = `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0;animation:gh-spin 0.75s linear infinite"><path opacity=".2" d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z"/><path d="M8 2a6 6 0 0 1 6 6h-2A4 4 0 0 0 8 4V2z"/></svg>`;
    const ICON_DL  = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/><path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06L7.25 7.69Z"/></svg>`;
    const ICON_DIR = `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>`;
    const ICON_FILE= `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914Z"/></svg>`;

    // ─── Cancel ───────────────────────────────────────────────────────────────

    function handleCancel() {
      activeAbortController?.abort();
      activeAbortController = null;
    }

    // ─── Download ─────────────────────────────────────────────────────────────
    //
    // Strategy A — single root-level folder:
    //   Redirect to GitHub's native archive URL. GitHub zips server-side and
    //   streams it directly to disk. Zero memory usage in the browser.
    //   URL: https://github.com/{owner}/{repo}/archive/refs/heads/{branch}.zip
    //
    // Strategy B — everything else (files, sub-folders, mixed):
    //   1. Resolve to a flat list of raw file URLs (capped at MAX_FILES)
    //   2. Fetch CONCURRENCY=4 files at a time (prevents OOM from parallel fetches)
    //   3. zipSync with level:0 for binaries, level:1 for text (fast, low CPU)
    //   4. Free zipEntries before creating the Blob to minimise peak RSS
    //   5. Trigger save dialog, revoke URL after 30s

    async function handleDownload() {
      const btn       = document.getElementById('gfi-dl-btn') as HTMLButtonElement | null;
      const cancelBtn = document.getElementById('gfi-cancel-btn') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;

      ensureStyle();
      const controller = new AbortController();
      activeAbortController = controller;
      const { signal } = controller;

      btn.disabled = true;
      if (cancelBtn) cancelBtn.style.display = 'flex';

      // Progress bar helpers — renders inside the button itself
      const setLabel = (msg: string) => {
        const lbl = document.getElementById('gfi-prog-label');
        if (lbl) lbl.textContent = msg;
      };
      const setProgress = (pct: number) => { // 0–100
        const fill = document.getElementById('gfi-prog-fill');
        if (fill) fill.style.width = `${Math.min(100, pct)}%`;
      };
      const showProgress = (msg: string, pct = 0) => {
        if (!btn) return;
        btn.style.background = '#1a7f37';
        btn.style.padding = '0';
        btn.style.overflow = 'hidden';
        btn.innerHTML = `
          <div style="position:relative;width:100%;padding:10px 16px;display:flex;align-items:center;justify-content:center;gap:7px;z-index:1">
            <span id="gfi-prog-label" style="position:relative;z-index:1;font-size:13px;font-weight:600;color:#fff">${msg}</span>
          </div>
          <div id="gfi-prog-track" style="position:absolute;bottom:0;left:0;right:0;height:3px;background:rgba(0,0,0,0.25)">
            <div id="gfi-prog-fill" style="height:100%;background:rgba(255,255,255,0.5);width:${pct}%;transition:width 0.15s ease;border-radius:0 2px 2px 0"></div>
          </div>`;
        btn.style.position = 'relative';
      };

      const setStatus = (msg: string, spin = true) => {
        if (!btn) return;
        btn.style.background = '#1a7f37';
        btn.style.padding = '10px 16px';
        btn.style.overflow = '';
        btn.innerHTML = `<span style="display:flex;align-items:center;gap:7px;justify-content:center">${spin ? SPINNER : ''}${msg}</span>`;
      };

      try {
        const items = [...selectedFiles.entries()];

        // ── Strategy A: single root-level folder ─────────────────────────────
        if (items.length === 1) {
          const [href, _name] = items[0];
          const ref = parseGHHref(href);
          if (ref?.kind === 'tree' && !ref.path) {
            // Root folder — GitHub archive covers the whole tree, zero memory
            setStatus('Starting download…');
            signal.throwIfAborted();
            const archiveUrl = `https://github.com/${ref.owner}/${ref.repo}/archive/refs/heads/${encodeURIComponent(ref.branch)}.zip`;
            const a = Object.assign(document.createElement('a'), {
              href: archiveUrl,
              download: `${ref.repo}-${ref.branch}.zip`,
            });
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            activeAbortController = null;
            btn.innerHTML = `<span style="display:flex;align-items:center;gap:6px;justify-content:center">✓ Download started</span>`;
            setTimeout(resetBtn, 2000);
            return;
          }
        }

        // ── Strategy B: resolve items to a flat file list ────────────────────
        const toFetch: Array<{ zipPath: string; url: string }> = [];

        for (const [href, name] of items) {
          signal.throwIfAborted();
          const ref = parseGHHref(href);
          if (!ref) continue;
          if (ref.kind === 'blob') {
            toFetch.push({ zipPath: name, url: rawUrl(ref) });
          } else {
            setStatus(`Listing ${name}…`);
            const paths = await listFolderFiles(ref, signal);
            const prefix = ref.path ? ref.path + '/' : '';
            for (const p of paths) {
              const rel = p.startsWith(prefix) ? p.slice(prefix.length) : p;
              toFetch.push({
                zipPath: `${name}/${rel}`,
                url: `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.branch}/${p}`,
              });
            }
          }
        }

        if (!toFetch.length) throw new Error('Nothing to download');
        if (toFetch.length > MAX_FILES)
          throw new Error(`${toFetch.length.toLocaleString()} files exceeds ${MAX_FILES.toLocaleString()} limit`);

        // ── Controlled-concurrency fetch with progress bar ────────────────────
        const zipEntries: Zippable = {};
        let done = 0;
        const total = toFetch.length;

        showProgress(`Fetching 0 / ${total}…`, 0);

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
              setLabel(`Fetching ${done} / ${total}…`);
              setProgress((done / total) * 90); // reserve last 10% for zip step
            })
          );
        }

        // ── Zip ───────────────────────────────────────────────────────────────
        setLabel(`Zipping…`);
        setProgress(95);
        await new Promise<void>(r => setTimeout(r, 16)); // let UI repaint
        signal.throwIfAborted();

        const zipped = zipSync(zipEntries);
        signal.throwIfAborted();
        setProgress(100);

        // Free the raw buffers before allocating the Blob (halves peak memory)
        for (const k in zipEntries) delete zipEntries[k];

        // ── Save dialog ───────────────────────────────────────────────────────
        const blob  = new Blob([zipped], { type: 'application/zip' });
        const dlUrl = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), { href: dlUrl, download: buildZipName() });
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(dlUrl), 30_000);

        activeAbortController = null;
        btn.innerHTML = `<span style="display:flex;align-items:center;gap:6px;justify-content:center">✓ Downloaded ${total} file${total !== 1 ? 's' : ''}</span>`;
        setTimeout(resetBtn, 2200);

      } catch (err: unknown) {
        activeAbortController = null;
        const isAbort = err instanceof DOMException && err.name === 'AbortError';
        if (btn) {
          if (isAbort) {
            btn.style.background = '#30363d';
            btn.innerHTML = `<span style="display:flex;align-items:center;gap:6px;justify-content:center">Cancelled</span>`;
          } else {
            const msg = (err instanceof Error ? err.message : String(err)).slice(0, 60);
            btn.style.background = '#b62324';
            btn.innerHTML = `<span style="display:flex;align-items:center;gap:6px;justify-content:center">⚠ ${msg}</span>`;
          }
          setTimeout(() => { resetBtn(); }, isAbort ? 1800 : 5000);
        }
      } finally {
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (btn) {
          btn.disabled = false;
          // Always restore these — showProgress() sets them and they must be
          // cleared immediately regardless of success/cancel/error
          btn.style.padding = '10px 16px';
          btn.style.overflow = '';
          btn.style.position = '';
        }
      }
    }

    function buildZipName() {
      const m = location.pathname.match(/^\/[^/]+\/([^/]+)/);
      return `${m ? m[1] : 'download'}-gitfetchit.zip`;
    }

    function resetBtn() {
      const btn = document.getElementById('gfi-dl-btn') as HTMLButtonElement | null;
      if (!btn) return;
      btn.disabled = false;
      // Explicitly restore every property that download/progress state may have mutated
      btn.style.background  = '#238636';
      btn.style.color       = '#fff';
      btn.style.padding     = '10px 16px';
      btn.style.overflow    = '';
      btn.style.position    = '';
      btn.style.boxShadow   = '0 4px 12px rgba(35,134,54,0.3)';
      btn.style.opacity     = '1';
      btn.style.cursor      = 'pointer';
      renderPanel();
    }

    // ─── File info from DOM ───────────────────────────────────────────────────

    function getFileInfo(col: HTMLElement): { name: string; href: string } | null {
      const a = col.querySelector<HTMLAnchorElement>('a[href][title],a[href][aria-label]');
      if (!a) return null;
      const name = a.title || a.innerText.trim();
      const href = a.getAttribute('href') || '';
      return name && href ? { name, href } : null;
    }

    // ─── Panel UI ─────────────────────────────────────────────────────────────

    function ensurePanel() {
      if (document.getElementById(PANEL_ID)) return;
      ensureStyle();

      const panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.style.cssText = [
        'all:initial',
        'position:fixed', 'bottom:20px', 'right:20px', 'z-index:2147483647',
        'display:flex', 'flex-direction:column', 'align-items:flex-end', 'gap:8px',
        'pointer-events:none',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      ].join(';');

      // ── Card ──
      const card = document.createElement('div');
      card.id = 'gfi-card';
      card.style.cssText = [
        'display:none', 'flex-direction:column',
        'background:#0d1117', 'border:1px solid rgba(240,246,252,0.1)', 'border-radius:12px',
        'min-width:280px', 'max-width:340px', 'overflow:hidden', 'pointer-events:all',
        'box-shadow:0 16px 40px rgba(0,0,0,0.6),0 0 0 1px rgba(255,255,255,0.04)',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', 'box-sizing:border-box',
      ].join(';');

      const cardHeader = document.createElement('div');
      cardHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px 9px;border-bottom:1px solid rgba(240,246,252,0.08)';

      const headerLabel = document.createElement('span');
      headerLabel.id = 'gfi-header-label';
      headerLabel.style.cssText = 'color:#7d8590;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase';

      const clearAll = document.createElement('button');
      clearAll.style.cssText = 'background:none;border:none;color:#7d8590;cursor:pointer;font-size:11px;padding:0;transition:color 0.1s';
      clearAll.textContent = 'Clear all';
      clearAll.addEventListener('mouseenter', () => clearAll.style.color = '#f85149');
      clearAll.addEventListener('mouseleave', () => clearAll.style.color = '#7d8590');
      clearAll.addEventListener('click', () => {
        document.querySelectorAll<HTMLInputElement>('input.gfi-checkbox').forEach(cb => cb.checked = false);
        selectedFiles.clear();
        renderPanel();
      });

      cardHeader.appendChild(headerLabel);
      cardHeader.appendChild(clearAll);
      card.appendChild(cardHeader);

      const list = document.createElement('div');
      list.id = 'gfi-file-list';
      list.style.cssText = 'max-height:260px;overflow-y:auto';
      card.appendChild(list);
      panel.appendChild(card);

      // ── Buttons ──
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;flex-direction:row;gap:6px;pointer-events:all;width:280px;box-sizing:border-box';

      const dlBtn = document.createElement('button');
      dlBtn.id = 'gfi-dl-btn';
      dlBtn.style.cssText = [
        'display:none', 'align-items:center', 'justify-content:center', 'flex:1', 'min-width:0', 'box-sizing:border-box',
        'background:#238636', 'color:#fff', 'border:1px solid rgba(240,246,252,0.1)', 'border-radius:10px',
        'padding:10px 16px', 'font-size:13px', 'font-weight:600',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'cursor:pointer', 'pointer-events:all', 'box-shadow:0 4px 12px rgba(35,134,54,0.3)',
        'transition:background 0.15s,box-shadow 0.15s,transform 0.1s',
        'gap:7px', 'line-height:1.4', 'text-align:center',
      ].join(';');
      dlBtn.addEventListener('mouseenter', () => {
        if (!dlBtn.disabled) { dlBtn.style.background='#2ea043'; dlBtn.style.boxShadow='0 6px 16px rgba(35,134,54,0.4)'; dlBtn.style.transform='translateY(-1px)'; }
      });
      dlBtn.addEventListener('mouseleave', () => {
        if (!dlBtn.disabled) { dlBtn.style.background='#238636'; dlBtn.style.boxShadow='0 4px 12px rgba(35,134,54,0.3)'; }
        dlBtn.style.transform='';
      });
      dlBtn.addEventListener('click', handleDownload);
      btnRow.appendChild(dlBtn);

      const cancelBtn = document.createElement('button');
      cancelBtn.id = 'gfi-cancel-btn';
      cancelBtn.style.cssText = [
        'display:none', 'align-items:center', 'justify-content:center', 'flex-shrink:0',
        'width:40px', 'height:40px', 'box-sizing:border-box',
        'background:rgba(248,81,73,0.15)', 'color:#f85149',
        'border:1px solid rgba(248,81,73,0.3)',
        'border-radius:10px',
        'cursor:pointer', 'pointer-events:all',
        'transition:background 0.15s,border-color 0.15s,transform 0.1s',
        'padding:0',
      ].join(';');
      cancelBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>`;
      cancelBtn.title = 'Cancel download';
      cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.background='rgba(248,81,73,0.28)'; cancelBtn.style.borderColor='rgba(248,81,73,0.6)'; cancelBtn.style.transform='translateY(-1px)'; });
      cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.background='rgba(248,81,73,0.15)'; cancelBtn.style.borderColor='rgba(248,81,73,0.3)'; cancelBtn.style.transform=''; });
      cancelBtn.addEventListener('click', handleCancel);
      btnRow.appendChild(cancelBtn);

      panel.appendChild(btnRow);
      document.body.appendChild(panel);
    }

    function renderPanel() {
      ensurePanel();
      const card  = document.getElementById('gfi-card')!;
      const list  = document.getElementById('gfi-file-list')!;
      const label = document.getElementById('gfi-header-label')!;
      const dlBtn = document.getElementById('gfi-dl-btn') as HTMLButtonElement;
      const count = selectedFiles.size;

      if (count === 0) { card.style.display='none'; dlBtn.style.display='none'; return; }

      card.style.display = 'flex';
      label.textContent  = `${count} / ${MAX_SELECTIONS} selected`;
      dlBtn.style.display = 'flex';
      dlBtn.innerHTML    = `${ICON_DL}<span>Download as ZIP</span>`;

      list.innerHTML = '';
      selectedFiles.forEach((name, href) => {
        const isDir = parseGHHref(href)?.kind === 'tree';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 14px;border-bottom:1px solid rgba(240,246,252,0.06);transition:background 0.1s';
        row.addEventListener('mouseenter', () => row.style.background = 'rgba(255,255,255,0.03)');
        row.addEventListener('mouseleave', () => row.style.background = '');

        const icon = document.createElement('span');
        icon.style.cssText = 'flex-shrink:0;color:#7d8590;display:flex;align-items:center';
        icon.innerHTML = isDir ? ICON_DIR : ICON_FILE;

        const nameEl = document.createElement('span');
        nameEl.style.cssText = 'flex:1;min-width:0;color:#cdd9e5;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        nameEl.textContent = name;
        nameEl.title = name;

        const xBtn = document.createElement('button');
        xBtn.style.cssText = 'flex-shrink:0;background:none;border:none;color:#7d8590;cursor:pointer;padding:2px;border-radius:4px;display:flex;align-items:center;transition:color 0.1s,background 0.1s;opacity:0;pointer-events:none';
        xBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>`;
        xBtn.addEventListener('mouseenter', () => { xBtn.style.color='#f85149'; xBtn.style.background='rgba(248,81,73,0.1)'; });
        xBtn.addEventListener('mouseleave', () => { xBtn.style.color='#7d8590'; xBtn.style.background='transparent'; });
        xBtn.addEventListener('click', () => {
          document.querySelectorAll<HTMLInputElement>('input.gfi-checkbox[data-href]').forEach(cb => {
            if (cb.dataset.href === href) cb.checked = false;
          });
          selectedFiles.delete(href);
          renderPanel();
        });
        row.addEventListener('mouseenter', () => { xBtn.style.opacity='1'; xBtn.style.pointerEvents='all'; });
        row.addEventListener('mouseleave', () => { xBtn.style.opacity='0'; xBtn.style.pointerEvents='none'; xBtn.style.color='#7d8590'; xBtn.style.background='transparent'; });

        row.appendChild(icon);
        row.appendChild(nameEl);
        row.appendChild(xBtn);
        list.appendChild(row);
      });
    }

    // ─── Checkbox injection ───────────────────────────────────────────────────

    function injectCheckboxes() {
      document.querySelectorAll<HTMLElement>(
        `.react-directory-filename-column:not([${CHECKBOX_ATTR}])`
      ).forEach(col => {
        col.setAttribute(CHECKBOX_ATTR, 'true');
        const info = getFileInfo(col);

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'gfi-checkbox';
        if (info) cb.dataset.href = info.href;
        if (info && selectedFiles.has(info.href)) cb.checked = true;
        // Disable if already at max and this file isn't selected
        if (info && selectedFiles.size >= MAX_SELECTIONS && !selectedFiles.has(info.href)) {
          cb.disabled = true;
          cb.title = `Max ${MAX_SELECTIONS} items`;
        }
        cb.style.cssText = 'margin-right:6px;cursor:pointer;accent-color:#2da44e;width:14px;height:14px;flex-shrink:0;vertical-align:middle;position:relative;z-index:1';

        cb.addEventListener('click', e => {
          e.stopPropagation();
          if (!info) return;
          if (cb.checked) {
            if (selectedFiles.size >= MAX_SELECTIONS) {
              cb.checked = false;
              return; // silently block over-selection
            }
            selectedFiles.set(info.href, info.name);
          } else {
            selectedFiles.delete(info.href);
          }
          // Re-enable/disable all unselected checkboxes based on new count
          document.querySelectorAll<HTMLInputElement>('input.gfi-checkbox').forEach(other => {
            if (other === cb || other.checked) return;
            other.disabled = selectedFiles.size >= MAX_SELECTIONS;
            other.title    = other.disabled ? `Max ${MAX_SELECTIONS} items` : '';
          });
          renderPanel();
        });

        col.style.display    = 'flex';
        col.style.alignItems = 'center';
        col.insertBefore(cb, col.firstChild);
      });
    }

    // ─── Debounce / Observer ──────────────────────────────────────────────────

    function scheduleInject() {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { debounceTimer = null; injectCheckboxes(); }, DEBOUNCE_MS);
    }

    function isRelevantMutation(ms: MutationRecord[]) {
      return ms.some(m => {
        if (m.type === 'attributes' && m.attributeName === CHECKBOX_ATTR) return false;
        return Array.from(m.addedNodes).some(
          (n): n is HTMLElement => n instanceof HTMLElement &&
            (n.classList.contains('react-directory-filename-column') ||
              !!n.querySelector('.react-directory-filename-column'))
        );
      });
    }

    // ─── Bootstrap ────────────────────────────────────────────────────────────

    ensurePanel();
    scheduleInject();

    new MutationObserver(ms => { if (isRelevantMutation(ms)) scheduleInject(); }).observe(
      document.body,
      { childList:true, subtree:true, attributes:true, attributeFilter:['class','data-component'] }
    );

    document.addEventListener('turbo:load',   () => { selectedFiles.clear(); renderPanel(); scheduleInject(); });
    document.addEventListener('turbo:render', () => scheduleInject());
  },
});
