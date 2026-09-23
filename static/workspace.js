async function api(path,opts={}){
  // Strip leading slash so URL resolves relative to location.href (supports subpath mounts)
  const rel = path.startsWith('/') ? path.slice(1) : path;
  const url=new URL(rel,document.baseURI||location.href);
  const timeoutMs=Object.prototype.hasOwnProperty.call(opts,'timeoutMs')?opts.timeoutMs:30000;
  const timeoutToast=opts.timeoutToast!==false;
  const redirect401=opts.redirect401!==false;
  const maxAttempts=Object.prototype.hasOwnProperty.call(opts,'retries')?Math.max(0,Number(opts.retries)||0)+1:3;
  const retryTimeouts=opts.retryTimeouts===true;
  const retryStatuses=Array.isArray(opts.retryStatuses)?opts.retryStatuses.map(Number).filter(Number.isFinite):[];
  const retryDelayMs=Object.prototype.hasOwnProperty.call(opts,'retryDelayMs')?Math.max(0,Number(opts.retryDelayMs)||0):350;
  // Retry up to 2 times on network errors (e.g. stale keep-alive after long idle).
  // Callers may opt into retrying timeouts / transient server statuses for idempotent GETs.
  let lastErr;
  for(let attempt=0;attempt<maxAttempts;attempt++){
    let controller=null;
    let timeoutId=null;
    let didTimeout=false;
    let upstreamSignal=null;
    let upstreamAbort=null;
    try{
      const fetchOpts={...opts};
      delete fetchOpts.timeoutMs;
      delete fetchOpts.timeoutToast;
      delete fetchOpts.redirect401;
      delete fetchOpts.retries;
      delete fetchOpts.retryTimeouts;
      delete fetchOpts.retryStatuses;
      delete fetchOpts.retryDelayMs;

      const useTimeout=Number.isFinite(Number(timeoutMs))&&Number(timeoutMs)>0;
      if(useTimeout&&typeof AbortController!=='undefined'){
        controller=new AbortController();
        upstreamSignal=fetchOpts.signal||null;
        if(upstreamSignal){
          upstreamAbort=()=>controller.abort(upstreamSignal.reason);
          if(upstreamSignal.aborted) upstreamAbort();
          else upstreamSignal.addEventListener('abort',upstreamAbort,{once:true});
        }
        fetchOpts.signal=controller.signal;
      }
      const requestPromise=(async()=>{
        const res=await fetch(url.href,{credentials:'include',headers:{'Content-Type':'application/json'},...fetchOpts});
        if(!res.ok){
          // 401 means the auth session expired. Redirect to login so the user can
          // re-authenticate. This is especially important for iOS PWA (standalone mode)
          // and for subpath mounts like /hermes/, where /login escapes to the site root.
          if(res.status===401){
            // #5578: if we're ALREADY on the login page, appending
            // window.location.pathname+search (which contains ?next=…) into a
            // fresh next= wraps the login URL into itself and re-encodes it —
            // exponential URL growth on each expired-auth bounce until the tab
            // breaks. On the login page, just reload login WITHOUT a next (the
            // page preserves its own inner next); elsewhere, capture the path.
            if(redirect401){
              // Already on the login page? Reload login WITHOUT a next.
              const _p=(window.location.pathname||'').replace(/\/+$/,'');
              if(/(?:^|\/)login$/.test(_p)){
                window.location.href='login';
              }else{
                window.location.href='login?next='+encodeURIComponent(window.location.pathname+window.location.search);
              }
            }
            // Callers can opt out of navigation and handle the unauthenticated state themselves.
            return;
          }
          const text=await res.text();
          // Parse JSON error body and surface the human-readable message,
          // rather than showing raw JSON like {"error":"Profile 'x' does not exist."}
          let message=text;
          try{const j=JSON.parse(text);message=j.error||j.message||text;}catch(e){}
          // Attach the raw HTTP context so callers can branch on status (404 stale-session
          // cleanup, 401 redirect, 503 retry, etc.) without re-parsing the message string.
          const err=new Error(message);
          err.status=res.status;
          err.statusText=res.statusText;
          err.body=text;
          throw err;
        }
        const ct=res.headers.get('content-type')||'';
        return ct.includes('application/json')?await res.json():await res.text();
      })();
      return useTimeout?await Promise.race([
        requestPromise,
        new Promise((_,reject)=>{
          timeoutId=setTimeout(()=>{
            didTimeout=true;
            if(controller) controller.abort();
            const err=new Error('Request timed out. Please try again.');
            err.name='TimeoutError';
            err.timeout=true;
            reject(err);
          },Number(timeoutMs));
        })
      ]):await requestPromise;
    }catch(e){
      lastErr=e;
      const isTimeout=didTimeout||(e&&(e.timeout===true||e.name==='TimeoutError'));
      if(isTimeout){
        if(retryTimeouts&&attempt<2&&attempt<maxAttempts-1){
          if(retryDelayMs) await new Promise(resolve=>setTimeout(resolve,retryDelayMs*Math.pow(2,attempt)));
          continue;
        }
        const err=(e&&e.name==='TimeoutError')?e:new Error('Request timed out. Please try again.');
        err.name='TimeoutError';
        err.timeout=true;
        if(timeoutToast&&typeof showToast==='function') showToast('Request timed out. Please try again.',5000,'error');
        throw err;
      }
      // Only retry on network errors (TypeError from fetch), not on HTTP errors
      // that were already thrown above. Re-throw 401 redirects immediately.
      if(e.message&&/401/.test(e.message)) throw e;
      if(attempt<2&&attempt<maxAttempts-1 && (e instanceof TypeError || retryStatuses.includes(Number(e.status)))){
        if(retryDelayMs) await new Promise(resolve=>setTimeout(resolve,retryDelayMs*Math.pow(2,attempt)));
        continue;
      }
      throw e;
    }finally{
      if(timeoutId) clearTimeout(timeoutId);
      if(upstreamSignal&&upstreamAbort) upstreamSignal.removeEventListener('abort',upstreamAbort);
    }
  }
  throw lastErr;
}

function recordClientSSEError(source, details={}){
  try{
    const payload={
      event:'sse_error',
      source:String(source||'unknown'),
      ready_state:details.ready_state,
      session_id:details.session_id||null,
      stream_id:details.stream_id||null,
      visibility_state:(typeof document!=='undefined'&&document.visibilityState)||'unknown',
      online:(typeof navigator!=='undefined'&&typeof navigator.onLine==='boolean')?navigator.onLine:null,
      url_path:(typeof location!=='undefined'&&location.pathname)||'/',
      reason:details.reason||'EventSource.onerror',
    };
    void api('/api/client-events/log',{method:'POST',body:JSON.stringify(payload),timeoutMs:3000,timeoutToast:false}).catch(()=>{});
  }catch(_){}
}

// Persist/restore expanded directory state per workspace in localStorage
function _wsExpandKey(){
  const ws=S.session&&S.session.workspace;
  return ws?'hermes-webui-expanded:'+ws:null;
}
function _saveExpandedDirs(){
  const key=_wsExpandKey();if(!key)return;
  try{localStorage.setItem(key,JSON.stringify([...(S._expandedDirs||new Set())]));}catch(e){}
}
function _restoreExpandedDirs(){
  const key=_wsExpandKey();
  if(!key){S._expandedDirs=new Set();return;}
  try{
    const raw=localStorage.getItem(key);
    S._expandedDirs=raw?new Set(JSON.parse(raw)):new Set();
  }catch(e){S._expandedDirs=new Set();}
}

function _escapeGrantStore(){
  if(!S._escapeGrants) S._escapeGrants = Object.create(null);
  return S._escapeGrants;
}

function _normalizeWorkspaceRelPath(path){
  let raw = String(path || '').trim().replace(/\\/g, '/');
  if(!raw || raw === '.') return '.';
  if(raw.startsWith('/')) return '';
  const parts = [];
  for(const part of raw.split('/')){
    if(!part || part === '.') continue;
    if(part === '..'){
      if(parts.length) parts.pop();
      else return '';
      continue;
    }
    parts.push(part);
  }
  return parts.length ? parts.join('/') : '.';
}

function _isSameOrChildPath(base, path){
  const normalizedBase = _normalizeWorkspaceRelPath(base);
  const normalizedPath = _normalizeWorkspaceRelPath(path);
  if(!normalizedBase || !normalizedPath) return false;
  if(normalizedBase === '.') return true;
  return normalizedPath === normalizedBase || normalizedPath.startsWith(`${normalizedBase}/`);
}

function _workspaceEscapeGrantForPath(path){
  const grants = _escapeGrantStore();
  const normalizedPath = _normalizeWorkspaceRelPath(path);
  if(!normalizedPath || !S.session || !S.session.session_id) return null;
  const sessionId = S.session.session_id;
  let best = null;
  for(const root of Object.keys(grants)){
    const grant = grants[root];
    if(!grant || grant.sessionId !== sessionId) continue;
    if(grant.expiresAt && Date.now() >= grant.expiresAt){
      delete grants[root];
      continue;
    }
    if(!_isSameOrChildPath(root, normalizedPath)) continue;
    if(!best || root.length > best.root.length) best = {root, grant};
  }
  return best ? best.grant : null;
}

function _workspaceEscapeExactGrant(path){
  const normalizedPath = _normalizeWorkspaceRelPath(path);
  const grant = _workspaceEscapeGrantForPath(normalizedPath);
  if(!grant) return null;
  return grant.path === normalizedPath ? grant : null;
}

function _storeWorkspaceEscapeGrant(data){
  if(!S.session || !data || !data.token) return null;
  const grants = _escapeGrantStore();
  const root = _normalizeWorkspaceRelPath(data.path || '');
  if(!root) return null;
  const grant = {
    sessionId: S.session.session_id,
    path: root,
    token: String(data.token),
    expiresAt: Number(data.expires_at || 0) * 1000,
    isDir: !!data.is_dir,
  };
  grants[root] = grant;
  return grant;
}

function _clearWorkspaceEscapeGrant(path){
  const grants = S._escapeGrants;
  if(!grants) return;
  const root = _normalizeWorkspaceRelPath(path);
  if(root && grants[root]) delete grants[root];
}

function _workspacePathIsReadOnly(path){
  return !!_workspaceEscapeGrantForPath(path || S.currentDir || '.');
}

function _workspaceRouteForPath(path, kind, opts={}){
  // Resolve the app-relative "/api/…" route against document.baseURI so the
  // URLs that are consumed OUTSIDE api() — previewImg.src, the media/pdf/html
  // frame src, the download anchor, window.open — keep working under a subpath
  // mount like /hermes/. A bare "/api/…" string resolves to the server root
  // there and 404s. (api() strips the leading slash and re-resolves against
  // baseURI itself, so routes passed through it are unaffected by already
  // being absolute.)
  const route=_workspaceRouteForPathRel(path, kind, opts);
  if(!route) return route;
  // Non-browser test harnesses have no document/location: keep the app-relative form.
  const base=(typeof document!=='undefined'&&document.baseURI)||(typeof location!=='undefined'&&location.href)||'';
  if(!base||!/^https?:\/\//i.test(base)) return route;
  const rel=route.startsWith('/') ? route.slice(1) : route;
  return new URL(rel, base).href;
}

function _workspaceRouteForPathRel(path, kind, opts={}){
  if(!S.session) return '';
  const normalizedPath = _normalizeWorkspaceRelPath(path);
  const grant = _workspaceEscapeGrantForPath(normalizedPath);
  const sessionId = encodeURIComponent(S.session.session_id);
  const params = new URLSearchParams({session_id:S.session.session_id, path:normalizedPath || '.'});
  if(grant){
    params.set('token', grant.token);
    if(kind === 'raw' && opts.download) params.set('download', '1');
    if(kind === 'raw' && opts.inline) params.set('inline', '1');
    if(kind === 'list') return `/api/escape/list?${params.toString()}`;
    if(kind === 'read') return `/api/escape/file/read?${params.toString()}`;
    if(kind === 'raw') return `/api/escape/file/raw?${params.toString()}`;
  }
  if(kind === 'list') return `/api/list?session_id=${sessionId}&path=${encodeURIComponent(normalizedPath || '.')}`;
  if(kind === 'read') return `/api/file?session_id=${sessionId}&path=${encodeURIComponent(normalizedPath || '.')}`;
  if(kind === 'raw'){
    const extra = [];
    if(opts.download) extra.push('download=1');
    // Inline previews intentionally preserve a literal &inline=1 marker in this file.
    if(opts.inline) extra.push('inline=1');
    const suffix = extra.length ? `&${extra.join('&')}` : '';
    return `/api/file/raw?session_id=${sessionId}&path=${encodeURIComponent(normalizedPath || '.')}${suffix}`;
  }
  return '';
}

async function authorizeWorkspaceEscapeNavigation(item){
  if(!S.session || !item || !item.path) return null;
  const normalizedPath = _normalizeWorkspaceRelPath(item.path);
  const exactGrant = _workspaceEscapeExactGrant(normalizedPath);
  if(!exactGrant){
    const ok = await showConfirmDialog({
      title: item.name || normalizedPath,
      message: t('external_link_open_confirm'),
      confirmLabel: t('dialog_confirm_btn'),
      danger: false,
      hideCancel: true,
      focusCancel: false,
    });
    if(!ok) return null;
  }
  try{
    const data = await api('/api/escape/authorize', {
      method: 'POST',
      body: JSON.stringify({
        session_id: S.session.session_id,
        path: normalizedPath,
      }),
    });
    const grant = _storeWorkspaceEscapeGrant(data);
    if(!grant) throw new Error('Missing escape authorization token');
    showToast(t('external_link_read_only'), 2000);
    return grant;
  }catch(e){
    showToast(t('external_link_grant_expired') || (e && e.message ? e.message : String(e)), 5000, 'error');
    return null;
  }
}

let _workspacePanelActiveTab = 'files';
let _renderSessionArtifactsTimer = null;
let _workspaceTodosLastRenderedHash = null;

function _setWorkspacePanelTabDataset(){
  const panel = document.querySelector('.rightpanel');
  if(panel) panel.dataset.activeTab = _workspacePanelActiveTab;
}

function scheduleRenderSessionArtifacts(){
  if(_renderSessionArtifactsTimer) clearTimeout(_renderSessionArtifactsTimer);
  _renderSessionArtifactsTimer = setTimeout(()=>{
    _renderSessionArtifactsTimer = null;
    renderSessionArtifacts();
  }, 100);
}

function _workspaceTodosHash(items){
  if(!Array.isArray(items)) return '';
  let h=items.length+'|';
  for(let i=0;i<items.length;i++){
    const t=items[i]||{};
    h+=String(t.id==null?'':t.id)+'\x1f'+String(t.content==null?(t.text==null?'':t.text):t.content)+'\x1f'+String(t.status==null?'':t.status)+'\x1e';
  }
  return h;
}

function _workspaceTodosTabIsActive(){
  if(typeof window==='undefined'||window._workspaceTodosTab!==true) return false;
  if(typeof document==='undefined') return false;
  const rightPanel=document.querySelector('.rightpanel');
  if(!rightPanel||!rightPanel.dataset||rightPanel.dataset.activeTab!=='todos') return false;
  const tab=document.getElementById('workspaceTodosTab');
  const panel=document.getElementById('workspaceTodosPanel');
  return !!(tab&&panel&&!tab.hidden&&!panel.hidden);
}

function _resetWorkspaceTodosRenderCache(){
  _workspaceTodosLastRenderedHash=null;
}

function _refreshWorkspacePanelTodos(){
  if(!_workspaceTodosTabIsActive()) return;
  _loadWorkspacePanelTodos();
}

if(typeof document !== 'undefined'){
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _setWorkspacePanelTabDataset, {once:true});
  else _setWorkspacePanelTabDataset();
}

function switchWorkspacePanelTab(tab){
  _workspacePanelActiveTab = tab === 'artifacts' ? 'artifacts' : tab === 'todos' ? 'todos' : 'files';
  _setWorkspacePanelTabDataset();
  const filesTab = $('workspaceFilesTab');
  const artifactsTab = $('workspaceArtifactsTab');
  const todosTab = $('workspaceTodosTab');
  if(filesTab){
    filesTab.classList.toggle('active', _workspacePanelActiveTab === 'files');
    filesTab.setAttribute('aria-selected', _workspacePanelActiveTab === 'files' ? 'true' : 'false');
  }
  if(artifactsTab){
    artifactsTab.classList.toggle('active', _workspacePanelActiveTab === 'artifacts');
    artifactsTab.setAttribute('aria-selected', _workspacePanelActiveTab === 'artifacts' ? 'true' : 'false');
  }
  if(todosTab){
    todosTab.classList.toggle('active', _workspacePanelActiveTab === 'todos');
    todosTab.setAttribute('aria-selected', _workspacePanelActiveTab === 'todos' ? 'true' : 'false');
  }
  const artifacts = $('workspaceArtifacts');
  if(artifacts) artifacts.hidden = _workspacePanelActiveTab !== 'artifacts';
  const todosPanel = $('workspaceTodosPanel');
  if(todosPanel) todosPanel.hidden = _workspacePanelActiveTab !== 'todos';
  if(_workspacePanelActiveTab === 'artifacts') renderSessionArtifacts();
  if(_workspacePanelActiveTab === 'todos') _loadWorkspacePanelTodos();
}

function _loadWorkspacePanelTodos(){
  const panel = $('workspaceTodosPanel');
  if(!panel) return;
  let todos = [];
  try{
    if(S && Array.isArray(S.todos)){
      todos = S.todos;
    } else if(S && S.session && S.session.todo_state && Array.isArray(S.session.todo_state.todos)){
      todos = S.session.todo_state.todos;
    } else if(typeof _legacyTodosFromMessages === 'function'){
      todos = _legacyTodosFromMessages() || [];
    }
  }catch(e){ todos = []; }
  if(!todos.length){
    panel.innerHTML = renderTodoEmptyState({centered:true});
    return;
  }
  panel.innerHTML = renderTodoRows(todos, {metadata:true});
}

function _escHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const ARTIFACT_IGNORE_RE = /(^|\/)(?:\.git|\.hg|\.svn|node_modules|\.venv|venv|__pycache__|dist|build|\.next|\.cache)(?:\/|$)/;
// Canonical Hermes mutators plus MCP filesystem aliases that can create/edit files.
const ARTIFACT_MUTATION_TOOLS = new Set(['write_file','patch','edit_file','create_file','mcp_filesystem_write_file','mcp_filesystem_edit_file']);

function _normalizeArtifactPath(path){
  if(!path) return '';
  path = String(path).trim().replace(/[\`"'<>),.;:]+$/g,'').replace(/^[\`"'(<]+/g,'');
  if(!path || path.length > 240 || path.includes('://')) return '';
  // Canonicalize workspace-relative prefixes so a file-tree open ("foo.md") and a
  // tool arg recorded as "./foo.md" or "~/foo.md" compare equal for mutation
  // tracking; otherwise an agent edit via a ./-prefixed path leaves the open
  // preview stale (#3262 / pre-release regression-gate finding).
  path = path.replace(/^~\//,'').replace(/^(?:\.\/)+/,'');
  if(!path) return '';
  if(ARTIFACT_IGNORE_RE.test(path)) return '';
  if(!/[./]/.test(path)) return '';
  return path;
}

function _artifactCandidatesFromText(text){
  if(!text || typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  const add = (path) => {
    path = _normalizeArtifactPath(path);
    if(!path || seen.has(path)) return;
    seen.add(path); out.push({path, kind:'diff'});
  };
  // Fallback text mining is intentionally narrow: only diff/patch fences imply
  // the session changed a file. Prose mentions such as "edited package.json" are
  // too noisy for an Artifacts list that should track write/edit outputs.
  const fenced = /```(?:diff|patch)\s*\n[\s\S]*?```/gi;
  let m;
  while((m = fenced.exec(text))){
    const block = m[0];
    const fm = block.match(/(?:^|\n)(?:\+\+\+|---)\s+(?:[ab]\/)?([^\n\t]+)/);
    if(fm) add(fm[1].trim());
  }
  return out;
}

function _artifactCandidatesFromToolCall(tc){
  if(!tc) return [];
  const name = String(tc.name || '').replace(/^functions\./,'');
  const args = tc.arguments || tc.args || tc.input || {};
  const result = tc.result || tc.output || tc.snippet || '';
  const out = [];
  const add = (path, source=name || 'tool') => {
    path = _normalizeArtifactPath(path);
    if(path) out.push({path, kind:source});
  };
  if(ARTIFACT_MUTATION_TOOLS.has(name) && args && typeof args === 'object'){
    for(const key of ['path','file_path','source','destination']) add(args[key]);
    if(Array.isArray(args.paths)) args.paths.forEach(p=>add(p));
    if(Array.isArray(args.edits)) args.edits.forEach(e=>add(e&&e.path));
  }
  const resultText = typeof result === 'string' ? result : (result ? JSON.stringify(result) : '');
  // Tool results may include unified diffs from patch-style tools; scan those
  // narrowly after structured args so diff headers can still contribute paths.
  for(const a of _artifactCandidatesFromText(resultText)) out.push(a);
  if(!out.length && ARTIFACT_MUTATION_TOOLS.has(name)){
    const argsText = typeof args === 'string' ? args : JSON.stringify(args || {});
    for(const a of _artifactCandidatesFromText(argsText)) out.push(a);
  }
  return out;
}

const _turnMutatedPreviewPaths = new Set();

function resetTurnWorkspaceMutations(){
  _turnMutatedPreviewPaths.clear();
}

function noteWorkspaceMutationsFromToolCall(tc){
  for(const a of _artifactCandidatesFromToolCall(tc)){
    const path=_normalizeArtifactPath(a.path);
    if(path) _turnMutatedPreviewPaths.add(path);
  }
}

function noteWorkspaceMutationsFromToolCalls(toolCalls){
  if(!Array.isArray(toolCalls)) return;
  for(const tc of toolCalls) noteWorkspaceMutationsFromToolCall(tc);
}

function _isOpenPreviewPathMutated(){
  if(!_previewCurrentPath) return false;
  const current=_normalizeArtifactPath(_previewCurrentPath);
  return !!(current&&_turnMutatedPreviewPaths.has(current));
}

async function refreshOpenPreviewIfMutated(){
  if(typeof _previewDirty!=='undefined'&&_previewDirty) return;
  if(!_isOpenPreviewPathMutated()) return;
  if(!_previewCurrentPath||!S.session) return;
  await openFile(_previewCurrentPath, { bustCache: true });
}

function collectSessionArtifacts(){
  const items = [];
  const seen = new Set();
  const push = (path, source) => {
    path = _normalizeArtifactPath(path);
    if(!path || seen.has(path)) return;
    seen.add(path); items.push({path, source});
  };
  // Source 1: session-level tool call summaries (may be empty when messages
  // carry their own tool metadata — see _syncToolCallsForLoadedMessages).
  for(const tc of (S.toolCalls || [])){
    for(const a of _artifactCandidatesFromToolCall(tc)) push(a.path, a.kind || tc.name || 'tool');
  }
  // Source 2 & 3: message-level data — both text-mined diffs and structured
  // tool_calls / tool_use content blocks that survive the S.toolCalls clear.
  for(const msg of (S.messages || [])){
    if(!msg) continue;
    const text = msg.content || msg.text || msg.message || '';
    // Text-mined diff/patch fences (existing path).
    if(typeof text === 'string'){
      for(const a of _artifactCandidatesFromText(text)) push(a.path, a.kind);
    }
    // Structured tool_calls array (OpenAI format: {function:{name,arguments}}).
    if(Array.isArray(msg.tool_calls)){
      for(const tc of msg.tool_calls){
        if(!tc || typeof tc !== 'object') continue;
        const fn = (tc.function && typeof tc.function === 'object') ? tc.function : tc;
        const name = fn.name || tc.name || '';
        let args = fn.arguments || tc.arguments || tc.args || tc.input || {};
        if(typeof args === 'string'){ try{ args = JSON.parse(args); }catch(_){} }
        const fakeTc = {name, args, result: tc.result || tc.output || ''};
        for(const a of _artifactCandidatesFromToolCall(fakeTc)) push(a.path, a.kind || name || 'tool');
      }
    }
    // Structured content array with tool_use blocks (Anthropic format).
    if(Array.isArray(msg.content)){
      for(const block of msg.content){
        if(!block || block.type !== 'tool_use') continue;
        let inp = block.input || {};
        if(typeof inp === 'string'){ try{ inp = JSON.parse(inp); }catch(_){} }
        const fakeTc = {name: block.name || '', args: inp, result: block.result || ''};
        for(const a of _artifactCandidatesFromToolCall(fakeTc)) push(a.path, a.kind || block.name || 'tool');
      }
    }
  }
  return items.slice(0, 50);
}

function renderSessionArtifacts(){
  const root = $('workspaceArtifacts');
  const count = $('workspaceArtifactsCount');
  if(!root) return;
  const items = collectSessionArtifacts();
  if(count) count.textContent = String(items.length);
  if(!S.session){
    root.innerHTML = '<div class="workspace-artifact-empty">Open a conversation to see files changed in this session.</div>';
    return;
  }
  if(!items.length){
    root.innerHTML = '<div class="workspace-artifact-empty">No artifacts detected yet. Files created or edited during this session will appear here.</div>';
    return;
  }
  // Strip workspace prefix for display so long absolute paths don't clutter the list.
  const ws = S.session && S.session.workspace;
  const normWs = ws ? ws.replace(/\/+$/,'') + '/' : '';
  const displayPath = (p) => {
    if(normWs && p.startsWith(normWs)) return p.slice(normWs.length);
    return p;
  };
  const splitArtifactDisplayPath = (path) => {
    const slash = path.lastIndexOf('/');
    if(slash < 0) return {name: path, head: '', tail: ''};
    const directory = path.slice(0, slash + 1);
    const parentSlash = directory.lastIndexOf('/', directory.length - 2);
    return {
      name: path.slice(slash + 1),
      head: directory.slice(0, parentSlash + 1),
      tail: directory.slice(parentSlash + 1),
    };
  };
  root.innerHTML = items.map(item => {
    const path = displayPath(item.path);
    const parts = splitArtifactDisplayPath(path);
    const directory = (parts.head || parts.tail)
      ? `<div class="workspace-artifact-directory"><span class="workspace-artifact-directory-head">${esc(parts.head)}</span><span class="workspace-artifact-directory-tail">${esc(parts.tail)}</span></div>`
      : '';
    const source = item.source ? esc(item.source) : esc(t('workspace_artifact_source_session') || 'session');
    const sourceAttrs = item.source ? '' : ' data-i18n="workspace_artifact_source_session"';
    return `<button type="button" class="workspace-artifact-item" title="${esc(path)}" data-artifact-path="${esc(item.path)}" onclick="openArtifactPath(this.dataset.artifactPath)"><div class="workspace-artifact-filename">${esc(parts.name)}</div>${directory}<div class="workspace-artifact-meta"${sourceAttrs}>${source}</div></button>`;
  }).join('');
}

function projectSessionArtifactsForOwner(sessionId){
  if(!sessionId||!S.session||S.session.session_id!==sessionId) return false;
  if(typeof _isSessionCurrentPane!=='function'||!_isSessionCurrentPane(sessionId)) return false;
  renderSessionArtifacts();
  return true;
}

async function _workspacePathExists(path){
  if(!S.session||!path) return false;
  const parts=String(path).replace(/\\/g,'/').split('/').filter(Boolean);
  const name=parts.pop();
  if(!name) return false;
  const dir=parts.length?parts.join('/'):'.';
  const data=await api(`/api/list?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(dir)}`);
  return (data.entries||[]).some(entry=>entry&&((entry.path===path)||entry.name===name));
}

async function openArtifactPath(path){
  if(!path) return;
  switchWorkspacePanelTab('files');
  // Normalize backslash separators to '/' first — Windows absolute paths
  // (e.g. "D:\workspace\dir\file") otherwise break prefix-strip and the
  // /api/list existence check (which splits on '/').
  let rel = String(path).replace(/\\/g,'/').replace(/^~\//,'').replace(/^(?:\.\/)+/,'');
  // Strip workspace prefix so /api/list receives a workspace-relative path.
  const ws = (S.session && S.session.workspace || '').replace(/\\/g,'/');
  if(ws){
    const normWs = ws.replace(/\/+$/,'') + '/';
    if(rel.startsWith(normWs)) rel = rel.slice(normWs.length);
    else if(rel === ws.replace(/\/+$/,'')) rel = '.';
  }
  if(!rel) rel = '.';
  try{
    if(!(await _workspacePathExists(rel))){
      setStatus(t('file_open_failed'));
      return;
    }
  }catch(_){
    setStatus(t('file_open_failed'));
    return;
  }
  openFile(rel);
}

// ── Workspace file-tree loading skeleton (#4662 Phase 1) ────────────────────
// During a profile switch the right-hand workspace panel would otherwise keep
// showing the previous profile's file tree until /api/list resolves. Show a
// clean tree-shaped skeleton in its place (panel stays open — hiding it is
// jarring). Varied bar widths + a small indent pattern so it reads as a real
// directory listing rather than a mechanical repeat.
const _WS_SKELETON_ROWS = [
  {w: 38, indent: 0, dir: true},
  {w: 72, indent: 0},
  {w: 44, indent: 1},
  {w: 63, indent: 1},
  {w: 80, indent: 0},
  {w: 51, indent: 1},
  {w: 67, indent: 0},
  {w: 39, indent: 1},
];

// Workspace-tree render generation. loadDir() captures this at call time and
// discards its render/cache writes if a newer generation started meanwhile.
// #4671 CORE: an empty-session profile switch REUSES the same session_id, so
// loadDir()'s session_id guard alone can't reject a pre-switch /api/list response
// that resolves after the new profile's loadDir('.') — it would paint the previous
// workspace's files over the switched-to profile. switchToProfile() bumps this
// UNCONDITIONALLY at switch start (even when the workspace panel is closed, since
// loadDir('.') still runs then), so the stale response is rejected.
let _wsTreeGen = 0;
function bumpWorkspaceTreeGen(){
  _wsTreeGen = (typeof _wsTreeGen === 'number' ? _wsTreeGen : 0) + 1;
  return _wsTreeGen;
}
if(typeof window!=='undefined') window.bumpWorkspaceTreeGen = bumpWorkspaceTreeGen;

function showWorkspaceTreeSkeleton(){
  const tree = $('fileTree');
  if(!tree) return;
  const wrap = document.createElement('div');
  wrap.className = 'skeleton-tree';
  wrap.setAttribute('aria-hidden', 'true');
  for(const spec of _WS_SKELETON_ROWS){
    const row = document.createElement('div');
    row.className = 'skeleton-tree-row';
    if(spec.indent) row.style.paddingLeft = (2 + spec.indent * 16) + 'px';
    const glyph = document.createElement('div');
    glyph.className = 'skeleton-glyph';
    const name = document.createElement('div');
    name.className = 'skeleton-bar skeleton-name';
    name.style.width = spec.w + '%';
    row.appendChild(glyph);
    row.appendChild(name);
    // Files (not dirs) show a size on the right; mirror that on leaf rows.
    if(!spec.dir){
      const size = document.createElement('div');
      size.className = 'skeleton-bar skeleton-size';
      row.appendChild(size);
    }
    wrap.appendChild(row);
  }
  tree.innerHTML = '';
  tree.appendChild(wrap);
  tree.style.display = '';
}

// Clear a stranded workspace-tree skeleton (#4662 Opus gate). showWorkspaceTreeSkeleton()
// is shown up front on a profile switch, but the real loadDir('.') that would
// replace it is skipped when the new profile has no bound workspace — leaving a
// shimmering skeleton forever. Call this on the no-workspace path so the tree
// empties instead. Only touches #fileTree when it still holds a skeleton, so
// it can't clobber a real render.
function clearWorkspaceTreeSkeleton(){
  const tree = $('fileTree');
  if(!tree) return;
  if(tree.querySelector('.skeleton-tree')) tree.innerHTML = '';
}

async function loadDir(path, opts={}){
  const preservePreview=!!(opts&&opts.preservePreview);
  const refreshExpanded=!!(opts&&opts.refreshExpanded);
  if(!S.session)return;
  const sessionId=S.session.session_id;
  const treeGen=_wsTreeGen;  // #4671: capture the workspace-tree generation. A profile
                             // switch bumps it (bumpWorkspaceTreeGen), so a stale response
                             // from the previous workspace — which would pass the session_id
                             // guard because an empty-session switch reuses the same id — is
                             // rejected here instead of painting the wrong profile's files.
  try{
    if(!path||path==='.'||refreshExpanded){
      if(typeof _syncWorkspaceBirthtimeSupportScope==='function') _syncWorkspaceBirthtimeSupportScope((S.session&&S.session.workspace)||'');
      S._dirCache={};
      _restoreExpandedDirs();  // restore per-workspace expanded state after root and refresh resets
    }
    S.currentDir=path||'.';
    const data=await api(
      _workspaceRouteForPath(path, 'list') ||
      `/api/list?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path||'.')}`
    );
    if(!S.session||S.session.session_id!==sessionId||treeGen!==_wsTreeGen)return;
    if(data.workspace_recovered&&data.workspace){
      S.session.workspace=String(data.workspace);
      S._dirCache={};
      _restoreExpandedDirs();
      if(typeof syncWorkspaceDisplays==='function')syncWorkspaceDisplays();
      if(typeof syncTerminalButton==='function')syncTerminalButton();
      showToast(t('workspace_recovered_notice',S.session.workspace),5000,'warning');
    }
    S.entries=data.entries||[];renderBreadcrumb();renderFileTree();
    // #2673 — refresh Artifacts tab when its source data (the file tree) updates.
    if(typeof renderSessionArtifacts==='function') renderSessionArtifacts();
    // Pre-fetch contents of restored expanded dirs so they render without a second click
    // (parallelized — avoids serial waterfall when multiple dirs are expanded)
    if(!path||path==='.'||refreshExpanded){
      const expanded=S._expandedDirs||new Set();
      const pending=[...expanded].filter(dirPath=>!S._dirCache[dirPath]);
      if(pending.length){
        const results=await Promise.all(pending.map(dirPath=>
          api(_workspaceRouteForPath(dirPath, 'list'))
            .then(dc=>({dirPath,entries:dc.entries||[]}))
            .catch(()=>({dirPath,entries:[]}))
        ));
        if(!S.session||S.session.session_id!==sessionId||treeGen!==_wsTreeGen)return;
        for(const {dirPath,entries} of results) S._dirCache[dirPath]=entries;
      }
      if(expanded.size>0)renderFileTree();
    }
    if(!preservePreview&&typeof clearPreview==='function'){
      if(typeof _previewDirty!=='undefined'&&_previewDirty){
        showConfirmDialog({title:t('unsaved_confirm'),message:'',confirmLabel:'Discard',danger:true,focusCancel:true}).then(ok=>{if(ok)clearPreview({keepPanelOpen:true});});
      }else{
        clearPreview({keepPanelOpen:true});
      }
    }else if(preservePreview){
      await refreshOpenPreviewIfMutated();
    }
    // Fetch git info for workspace root (non-blocking)
    if(!path||path==='.') _refreshGitBadge();
  }catch(e){
    const grant = _workspaceEscapeGrantForPath(path);
    if(grant && e && e.status===403){
      _clearWorkspaceEscapeGrant(grant.path);
      showToast(t('external_link_grant_expired') || t('file_open_failed'), 5000, 'error');
      return;
    }
    console.warn('loadDir',e);
  }
}

function refreshWorkspacePanel(){
  if(!S.session)return;
  const targetDir = S.currentDir || '.';
  loadDir(targetDir,{refreshExpanded:true});
}

async function _refreshGitBadge(){
  const badge=$('gitBadge');
  if(!badge||!S.session)return;
  const sessionId=S.session.session_id;
  try{
    const data=await api(`/api/git-info?session_id=${encodeURIComponent(sessionId)}`);
    if(!S.session||S.session.session_id!==sessionId)return;
    if(data.git&&data.git.is_git){
      const g=data.git;
      let text=g.branch||'git';
      if(g.dirty>0) text+=` \u00b7 ${g.dirty}\u2206`; // middot + delta
      if(g.behind>0) text+=` \u2193${g.behind}`;
      if(g.ahead>0) text+=` \u2191${g.ahead}`;
      badge.textContent=text;
      badge.className='git-badge'+(g.dirty>0?' dirty':'');
      badge.style.display='';
    } else {
      badge.style.display='none';
      badge.textContent='';
    }
  }catch(e){
    if(!S.session||S.session.session_id!==sessionId)return;
    badge.style.display='none';
  }
}

function navigateUp(){
  if(!S.session||S.currentDir==='.')return;
  const parts=S.currentDir.split('/');
  parts.pop();
  loadDir(parts.length?parts.join('/'):'.');
}

// File extension sets for preview routing (must match server-side sets)
const IMAGE_EXTS  = new Set(['.png','.jpg','.jpeg','.gif','.svg','.webp','.ico','.bmp']);
const MD_EXTS     = new Set(['.md','.markdown','.mdown']);
const HTML_EXTS   = new Set(['.html','.htm']);
const PDF_EXTS    = new Set(['.pdf']);
const AUDIO_EXTS  = new Set(['.mp3','.wav','.m4a','.aac','.ogg','.oga','.opus','.flac']);
const VIDEO_EXTS  = new Set(['.mp4','.mov','.m4v','.webm','.ogv','.avi','.mkv']);
const BPMN_EXTS   = new Set(['.bpmn']);
const MD_PREVIEW_RICH_RENDER_MAX_BYTES = 256 * 1024;
const MD_PREVIEW_RICH_RENDER_MAX_LINES = 5000;
// Binary formats that should download rather than preview
const DOWNLOAD_EXTS = new Set([
  '.doc','.xls','.ppt','.odt','.ods','.odp',
  '.zip','.tar','.gz','.bz2','.7z','.rar',
  '.exe','.dmg','.pkg','.deb','.rpm',
  '.woff','.woff2','.ttf','.otf','.eot',
  '.bin','.dat','.db','.sqlite','.pyc','.class','.so','.dylib','.dll',
]);

function fileExt(p){ const i=p.lastIndexOf('.'); return i>=0?p.slice(i).toLowerCase():''; }

function markdownPreviewByteLength(content){
  const text=String(content||'');
  if(typeof Blob==='function') return new Blob([text]).size;
  if(typeof TextEncoder==='function') return new TextEncoder().encode(text).length;
  return unescape(encodeURIComponent(text)).length;
}

function markdownPreviewLineCount(content){
  const text=String(content||'');
  if(!text) return 1;
  return text.split('\n').length;
}

function shouldRenderMarkdownPreviewAsPlainText(content){
  return markdownPreviewByteLength(content)>MD_PREVIEW_RICH_RENDER_MAX_BYTES
    || markdownPreviewLineCount(content)>MD_PREVIEW_RICH_RENDER_MAX_LINES;
}

function largeMarkdownPlainTextStatus(content){
  const bytes=markdownPreviewByteLength(content);
  const lines=markdownPreviewLineCount(content);
  const sizeLabel=bytes>=1024?`${Math.round(bytes/1024)} KB`:`${bytes} B`;
  return `Large markdown file (${sizeLabel}, ${lines} lines) shown as plain text. Click "Render as markdown anyway" to force rich rendering, or Edit to view raw.`;
}

function setLargeMarkdownForceRenderVisible(visible){
  const btn=$('btnRenderMarkdownAnyway');
  if(btn) btn.style.display=visible?'inline-flex':'none';
}

function renderMarkdownPreviewContent(data){
  const target=data&&data.el?data.el:$('previewMd');
  if(!data||!data.el) showPreview('md');
  target.innerHTML=renderMd(data.content);
  requestAnimationFrame(()=>{
    if(typeof renderKatexBlocks==='function')renderKatexBlocks();
    _buildMarkdownToc(target);
  });
}

function renderCodePreviewContent(path, content){
  showPreview('code');
  const codeEl=document.createElement('code');
  codeEl.textContent=content;
  const lang=_prismLanguageForPath(path);
  if(lang) codeEl.className='language-'+lang;
  const pre=$('previewCode');
  pre.textContent='';
  // Prism.highlightElement() propagates the language-* class onto the
  // parent <pre>, so a previously-previewed code file leaves e.g.
  // "language-css" on #previewCode. A subsequent plain-text file builds a
  // class-less <code>, and Prism walks up to that stale ancestor class and
  // mis-highlights prose. Strip any inherited language-* token from the
  // <pre> before each render so highlighting never leaks across files.
  pre.className=pre.className.replace(/\blanguage-\S+/g,'').replace(/\s+/g,' ').trim();
  pre.appendChild(codeEl);
  // Only invoke Prism when we actually assigned a language; otherwise the
  // class-less <code> would inherit any ancestor language-* class.
  if(lang&&typeof Prism!=='undefined'&&typeof Prism.highlightElement==='function'){
    Prism.highlightElement(codeEl);
  }
}

function renderCsvPreviewContent(path, content){
  if(typeof buildCsvTablePreview!=='function') return false;
  const preview=buildCsvTablePreview(path, content);
  if(!preview) return false;
  showPreview('csv');
  // Preserve the raw CSV text so the Edit flow can repopulate the textarea and
  // a save can re-render the table from the edited source (#4025 review, Codex).
  if(typeof content==='string'){
    _previewRawContent = content;
    _previewRawContentPath = path;
  }
  if(preview.html){
    $('previewMd').innerHTML=preview.html;
    return true;
  }
  if(preview.errorKey&&typeof _csvPreviewErrorHtml==='function'){
    $('previewMd').innerHTML=_csvPreviewErrorHtml(path, preview.errorKey);
    return true;
  }
  return false;
}

function forceRenderMarkdownPreview(){
  // #3378 review (Codex): don't force-render from a dirty/open editor — the
  // cached raw content would not reflect the unsaved edit. Require a saved,
  // non-dirty state and cached content that belongs to the current file.
  if(_previewDirty || $('previewEditArea').style.display!=='none') return;
  if(!_previewRawContent || _previewRawContentPath!==_previewCurrentPath) return;
  openFile(_previewCurrentPath,{forceRichMarkdown:true});
  setStatus('Markdown rendered for this file.');
}

let _previewCurrentPath = '';  // relative path of currently previewed file
let _previewCurrentMode = '';  // 'code' | 'csv' | 'md' | 'image' | 'html' | 'pdf' | 'audio' | 'video'
let _previewDirty = false;     // true when edits are unsaved
let _previewServerEditable = null;  // backend editability metadata when available
let _previewSaveRoute = '/api/file/save';  // current save adapter for the open preview
let _previewOfficeFormat = '';  // current claimed Office format, if any
let _previewPreviewKind = '';  // preview family returned by the backend

function showPreview(mode){
  // mode: 'code' | 'csv' | 'image' | 'md' | 'html' | 'pdf' | 'audio' | 'video' | 'bpmn' | 'workbench'
  $('previewCode').style.display     = mode==='code'  ? '' : 'none';
  $('previewImgWrap').style.display  = mode==='image' ? '' : 'none';
  const mediaWrap=$('previewMediaWrap'); if(mediaWrap) mediaWrap.style.display = (mode==='audio'||mode==='video') ? '' : 'none';
  const pdfWrap=$('previewPdfWrap'); if(pdfWrap) pdfWrap.style.display = mode==='pdf' ? '' : 'none';
  $('previewMd').style.display       = (mode==='md'||mode==='csv') ? '' : 'none';
  $('previewHtmlWrap').style.display = mode==='html'  ? '' : 'none';
  const bpmnWrap=$('previewBpmnWrap'); if(bpmnWrap) bpmnWrap.style.display = mode==='bpmn' ? 'flex' : 'none';
  const wbWrap=$('workbenchSplitWrap'); if(wbWrap) wbWrap.style.display = mode==='workbench' ? 'flex' : 'none';
  const mdToc = document.getElementById('previewMdFloatingToc');
  if(mdToc) mdToc.style.display = (mode==='md') ? 'flex' : 'none';
  const rpanel=document.querySelector('.rightpanel');
  if(rpanel) rpanel.classList.toggle('workbench-mode-active', mode==='workbench');
  $('previewEditArea').style.display = 'none';  // start in read-only
  const badge=$('previewBadge');
  badge.className='preview-badge '+mode;
  badge.textContent = mode==='workbench'?'workbench':mode==='image'?'image':mode==='audio'?'audio':mode==='video'?'video':mode==='pdf'?'pdf':mode==='csv'?'csv':mode==='md'?'md':mode==='html'?'html':mode==='bpmn'?'bpmn':fileExt($('previewPathText').textContent)||'text';
  _previewCurrentMode = mode;
  _previewDirty = false;
  updateEditBtn();
  // Show "Open in browser" button for iframe-backed document previews
  const openBtn=$('btnOpenInBrowser');
  if(openBtn) openBtn.style.display = (mode==='html'||mode==='pdf')?'inline-flex':'none';
  setLargeMarkdownForceRenderVisible(false);
}

function updateEditBtn(){
  const btn=$('btnEditFile');
  if(!btn)return;
  const editable = !_workspacePathIsReadOnly(_previewCurrentPath)
    && (_previewServerEditable===null
      ? (_previewCurrentMode==='code'||_previewCurrentMode==='md'||_previewCurrentMode==='csv'||_previewCurrentMode==='bpmn')
      : !!_previewServerEditable);
  btn.style.display = editable?'':'none';
  const editing = $('previewEditArea').style.display!=='none';
  btn.innerHTML = editing ? `&#128190; ${t('save')}` : `&#9998; ${t('edit')}`;
  btn.title = editing ? t('save_title') : t('edit_title');
  btn.style.color = editing ? 'var(--blue)' : '';
  if(_previewDirty) btn.innerHTML = '&#128190; Save*';
}

async function toggleEditMode(){
  const editing = $('previewEditArea').style.display!=='none';
  if(_workspacePathIsReadOnly(_previewCurrentPath)){
    showToast(t('external_link_read_only'), 2000);
    return;
  }
  if(!editing && _previewServerEditable===false){
    showToast('This Office document is preview-only.', 3000, 'error');
    return;
  }
  if(editing){
    // Save
    if(!S.session||!_previewCurrentPath)return;
    const content=$('previewEditArea').value;
    try{
      const saved=await api(_previewSaveRoute||'/api/file/save',{method:'POST',body:JSON.stringify({
        session_id:S.session.session_id, path:_previewCurrentPath, content
      })});
      const savedContent=saved&&typeof saved.content==='string'?saved.content:content;
      if(saved && typeof saved.editable==='boolean') _previewServerEditable = saved.editable;
      if(saved && saved.preview_kind) _previewPreviewKind = saved.preview_kind;
      if(saved && saved.office_format) _previewOfficeFormat = saved.office_format;
      if(saved && saved.preview_kind==='office' && saved.office_format==='docx'){
        _previewSaveRoute = '/api/file/office-save';
      }
      _previewDirty=false;
      // Update read-only views AND the cached raw content so a later
      // "Render as markdown anyway" force-render reflects the just-saved text
      // (not the stale pre-edit fetch). #3378 review (Codex).
      _previewRawContent = savedContent;
      _previewRawContentPath = _previewCurrentPath;
      if(_previewCurrentMode==='code') $('previewCode').textContent=savedContent;
      else if(_previewCurrentMode==='csv') renderCsvPreviewContent(_previewCurrentPath, savedContent);
      else if(_previewCurrentMode==='bpmn') renderBpmnPreviewContent(_previewCurrentPath, savedContent);
      else renderMarkdownPreviewContent({content:savedContent});
      $('previewEditArea').style.display='none';
      if(_previewCurrentMode==='code') $('previewCode').style.display='';
      else if(_previewCurrentMode==='bpmn') $('previewBpmnWrap').style.display='flex';
      else $('previewMd').style.display='';
      showToast(t('saved'));
    }catch(e){setStatus(t('save_failed')+e.message);}
  }else{
    // Enter edit mode: populate textarea with current content
    const currentText = _previewCurrentMode==='code'
      ? $('previewCode').textContent
      : _previewRawContent||'';
    $('previewEditArea').value=currentText;
    $('previewEditArea').style.display='';
    if(_previewCurrentMode==='code') $('previewCode').style.display='none';
    else if(_previewCurrentMode==='bpmn') $('previewBpmnWrap').style.display='none';
    else $('previewMd').style.display='none';
    // Escape cancels the edit without saving
    $('previewEditArea').onkeydown=e=>{
      if(e.key==='Escape'){e.preventDefault();cancelEditMode();}
    };
  }
  updateEditBtn();
}

let _previewRawContent = '';  // raw text for md files (to populate editor)
let _previewRawContentPath = '';  // path that _previewRawContent belongs to (#3378 force-render cache guard)

function cancelEditMode(){
  // Discard changes and return to read-only view
  $('previewEditArea').style.display='none';
  $('previewEditArea').onkeydown=null;
  if(_previewCurrentMode==='code') $('previewCode').style.display='';
  else if(_previewCurrentMode==='bpmn') $('previewBpmnWrap').style.display='flex';
  else $('previewMd').style.display='';
  _previewDirty=false;
  updateEditBtn();
}

// Map file extensions to Prism.js language identifiers.
// Prism autoloader fetches missing language components from CDN on demand.
const _PRISM_LANG_MAP={
  js:'javascript',mjs:'javascript',jsx:'jsx',ts:'typescript',tsx:'tsx',
  py:'python',pyw:'python',pyi:'python',
  rb:'ruby',go:'go',rs:'rust',java:'java',kt:'kotlin',kts:'kotlin',
  c:'c',h:'c',cpp:'cpp',cxx:'cpp',hpp:'cpp',cc:'cpp',
  cs:'csharp',swift:'swift',scala:'scala',
  php:'php',pl:'perl',pm:'perl',r:'r',lua:'lua',
  sh:'bash',bash:'bash',zsh:'bash',fish:'bash',
  ps1:'powershell',psm1:'powershell',
  sql:'sql',graphql:'graphql',
  json:'json',yaml:'yaml',yml:'yaml',toml:'toml',xml:'xml',
  html:'markup',htm:'markup',svg:'markup',vue:'markup',
  css:'css',scss:'scss',sass:'sass',less:'less',
  md:'markdown',markdown:'markdown',
  dockerfile:'docker',makefile:'makefile',cmake:'cmake',
  ini:'ini',cfg:'ini',conf:'ini',properties:'properties',
  diff:'diff',patch:'diff',
  txt:'',log:'',csv:'',tsv:'',
};
const _PRISM_BASENAME_LANG_MAP={
  'dockerfile':'docker','makefile':'makefile','gnumakefile':'makefile',
  'cmakelists.txt':'cmake',
  '.gitignore':'ignore','.dockerignore':'ignore',
};
function _prismLanguageForPath(path){
  const base=String(path||'').split(/[\\/]/).pop().toLowerCase();
  if(base.startsWith('dockerfile.')) return 'docker';
  if(_PRISM_BASENAME_LANG_MAP[base]!==undefined) return _PRISM_BASENAME_LANG_MAP[base];
  const ext=fileExt(path).replace(/^\./,'');
  return _PRISM_LANG_MAP[ext]!==undefined?_PRISM_LANG_MAP[ext]:'plaintext';
}

let _bpmnViewerInstance = null;
let _bpmnLoadingPromise = null;
let _bpmnShowingXml = false;

// Workbench State & Maps
const WORKSPACE_GDRIVE_MAP = {
  'PRD/PRD_EMS_00_Master_Data_Architecture.md': 'https://drive.google.com/open?id=11760ltGFHwrBSPeLmCanDBUms4dBSr5E',
  'PRD/PRD_EMS_01_Admission_Trial.md': 'https://drive.google.com/open?id=1lNwSIoQ_tIdcYIi8h1g1KT7MokXK7eAC',
  'PRD/PRD_EMS_02_Fees_Billing.md': 'https://drive.google.com/open?id=1v_9MU9cy3qI5F6a_fpwRFQ6x2E2Z5NxR',
  'PRD/PRD_EMS_03_Timetable_Attendance.md': 'https://drive.google.com/open?id=1pJzDjgxvG-NGXie58dj6aLnhptCZd0mq',
  'PRD/PRD_EMS_04_Assessment_Gradebook_Parent.md': 'https://drive.google.com/open?id=1LJe5IpClCJKtGkfpVV9bmrxaQcJXIP8B',
  'PRD/PRD_EMS_Master_Bimbel.md': 'https://drive.google.com/open?id=1DH4DWkexjrDjj5gXPdy_QclnRhMFWOMY',
  'PRD/PRD_Hermes_WebUI_Product_Analyst_Suite.md': 'https://drive.google.com/open?id=1ODKru-jupUWjkj01jaSYy-2uV6VYsBqT',
  'Flows/flow_master_data_setup.bpmn': 'https://drive.google.com/open?id=1s3bA-kaG2_l2RrvW_KGun8qz0gR_QHi5',
  'Flows/flow_admission_trial.bpmn': 'https://drive.google.com/open?id=1AJu8zNp99CRXpGRU05lqBcG7cNXmGdIP',
  'Flows/flow_fees_invoicing.bpmn': 'https://drive.google.com/open?id=1WqeOKAFbORGrMeywBQ7COZoOS_D_-D9i',
  'Flows/flow_attendance_session.bpmn': 'https://drive.google.com/open?id=1Bgk6oTiltCK-9r3xhdidxqlhCCnwXqFP',
  'Flows/flow_gradebook_eval.bpmn': 'https://drive.google.com/open?id=1EHWhViRw4HigNtpCDbeWwRWrt0NUubhQ',
  'Flows/ems_master_workflow.bpmn': 'https://drive.google.com/open?id=1Qhv4ZoPvtMCpuIoPqRikmzNJYeeNf1SN',
  'Flows/sample_order_process.bpmn': 'https://drive.google.com/open?id=1eTxVSGkKHMzF9hTaVlKWDPTlRNfLtBE_',
  'Flows/LeaveApproval.bpmn': 'https://drive.google.com/open?id=1tMUc-fJd5PEWpEYtSDu3ZfvWhMT1k-Uy',
  'Docs/Javan/Analisis_dan_Desain_Alurkerja.pdf': 'https://drive.google.com/open?id=1z1haiMyyrn14EjNUF72vsQ6B8_CCplnE',
  'Docs/Javan/Fundamental_Operational_-_Tribe_Javan.pdf': 'https://drive.google.com/open?id=1tOYo9grrKPtz2uVmC9WYCc02QqPi-lF1',
  'Docs/Javan/Panduan_Kerja_Product_Analyst__1_.pdf': 'https://drive.google.com/open?id=1gKUl7jQcpE9IebwLzsZoCjhk468w7FVh',
  'Docs/Javan/SOP_Active_Collab.pdf': 'https://drive.google.com/open?id=1-XQXp22XnkdijPGE2ggVlmPHpWFxcc3b',
  'Docs/Javan/Fundamental_Operational_-_Tribe_Javan.md': 'https://drive.google.com/open?id=11a60p3ZTCgxt-W7wrfSHpBNgGoOOl6cK'
};

const WORKBENCH_PAIR_MAP = {
  'PRD/PRD_EMS_00_Master_Data_Architecture.md': 'Flows/flow_master_data_setup.bpmn',
  'PRD/PRD_EMS_01_Admission_Trial.md': 'Flows/flow_admission_trial.bpmn',
  'PRD/PRD_EMS_02_Fees_Billing.md': 'Flows/flow_fees_invoicing.bpmn',
  'PRD/PRD_EMS_03_Timetable_Attendance.md': 'Flows/flow_attendance_session.bpmn',
  'PRD/PRD_EMS_04_Assessment_Gradebook_Parent.md': 'Flows/flow_gradebook_eval.bpmn',
  'PRD/PRD_EMS_Master_Bimbel.md': 'Flows/ems_master_workflow.bpmn',
  'Flows/flow_master_data_setup.bpmn': 'PRD/PRD_EMS_00_Master_Data_Architecture.md',
  'Flows/flow_admission_trial.bpmn': 'PRD/PRD_EMS_01_Admission_Trial.md',
  'Flows/flow_fees_invoicing.bpmn': 'PRD/PRD_EMS_02_Fees_Billing.md',
  'Flows/flow_attendance_session.bpmn': 'PRD/PRD_EMS_03_Timetable_Attendance.md',
  'Flows/flow_gradebook_eval.bpmn': 'PRD/PRD_EMS_04_Assessment_Gradebook_Parent.md',
  'Flows/ems_master_workflow.bpmn': 'PRD/PRD_EMS_Master_Bimbel.md'
};

const ALL_WORKBENCH_FLOWS = [
  { path: 'Flows/flow_master_data_setup.bpmn', name: '0. Master Data Setup' },
  { path: 'Flows/flow_admission_trial.bpmn', name: '1. Admission & Trial Class' },
  { path: 'Flows/flow_fees_invoicing.bpmn', name: '2. Fees & Invoicing' },
  { path: 'Flows/flow_attendance_session.bpmn', name: '3. Session & Attendance' },
  { path: 'Flows/flow_gradebook_eval.bpmn', name: '4. Tryout & Gradebook' },
  { path: 'Flows/ems_master_workflow.bpmn', name: 'Master End-to-End Workflow' },
  { path: 'Flows/sample_order_process.bpmn', name: 'Sample Order Flow' }
];

let _workbenchBpmnViewerInstance = null;
let _workbenchActivePrdPath = '';
let _workbenchActiveBpmnPath = '';
let _workbenchActivePrdContent = '';
let _workbenchActiveBpmnXml = '';

function _destroyBpmnViewer(){
  if(_bpmnViewerInstance){
    try { _bpmnViewerInstance.destroy(); } catch(e){}
    _bpmnViewerInstance = null;
  }
  if(_workbenchBpmnViewerInstance){
    try { _workbenchBpmnViewerInstance.destroy(); } catch(e){}
    _workbenchBpmnViewerInstance = null;
  }
  const rpanel = document.querySelector('.rightpanel');
  if(rpanel) rpanel.classList.remove('workbench-mode-active');
  const btnWb = $('btnToggleWorkbench');
  if(btnWb) btnWb.style.display = 'none';
  const btnDrive = $('btnOpenInDrive');
  if(btnDrive) btnDrive.style.display = 'none';
  const btnCopyDrive = $('btnCopyDriveLink');
  if(btnCopyDrive) btnCopyDrive.style.display = 'none';
  const mdToc = document.getElementById('previewMdFloatingToc');
  if(mdToc) mdToc.style.display = 'none';
}

function loadBpmnViewerLibrary(){
  if(window.BpmnJS) return Promise.resolve();
  if(_bpmnLoadingPromise) return _bpmnLoadingPromise;

  _bpmnLoadingPromise = new Promise((resolve, reject) => {
    const linkDiagram = document.createElement('link');
    linkDiagram.rel = 'stylesheet';
    linkDiagram.href = 'https://cdn.jsdelivr.net/npm/bpmn-js@17/dist/assets/diagram-js.css';
    document.head.appendChild(linkDiagram);

    const linkBpmn = document.createElement('link');
    linkBpmn.rel = 'stylesheet';
    linkBpmn.href = 'https://cdn.jsdelivr.net/npm/bpmn-js@17/dist/assets/bpmn-js.css';
    document.head.appendChild(linkBpmn);

    const linkFont = document.createElement('link');
    linkFont.rel = 'stylesheet';
    linkFont.href = 'https://cdn.jsdelivr.net/npm/bpmn-js@17/dist/assets/bpmn-font/css/bpmn.css';
    document.head.appendChild(linkFont);

    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/bpmn-js@17/dist/bpmn-modeler.production.min.js';
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve();
    script.onerror = (err) => {
      _bpmnLoadingPromise = null;
      reject(err);
    };
    document.head.appendChild(script);
  });
  return _bpmnLoadingPromise;
}

async function renderBpmnPreviewContent(path, xml){
  showPreview('bpmn');
  _bpmnShowingXml = false;
  const toggleBtn = $('btnBpmnToggleView');
  if(toggleBtn) toggleBtn.innerHTML = '&lt;/&gt; Raw XML';

  try {
    await loadBpmnViewerLibrary();
    const canvasEl = $('previewBpmnCanvas');
    if(!canvasEl) return;
    canvasEl.innerHTML = '';
    _destroyBpmnViewer();

    _bpmnViewerInstance = new window.BpmnJS({
      container: canvasEl,
      keyboard: {
        bindTo: document
      }
    });
    await _bpmnViewerInstance.importXML(xml);
    const canvas = _bpmnViewerInstance.get('canvas');
    canvas.zoom('fit-viewport');
  } catch(err) {
    console.error('BPMN render error:', err);
    showPreview('code');
    $('previewCode').textContent = xml;
    if(typeof showToast==='function'){
      showToast('Visual BPMN preview failed. Displaying raw XML.', 3000, 'warning');
    }
  }
}

async function bpmnSaveDiagram(){
  if(!_bpmnViewerInstance || !_previewCurrentPath) return;
  const saveBtn = $('btnBpmnSave');
  const oldText = saveBtn ? saveBtn.innerHTML : '';
  try {
    if(saveBtn) saveBtn.innerHTML = '⏳ Saving...';
    const { xml } = await _bpmnViewerInstance.saveXML({ format: true });
    await api('/api/file/save', {
      method: 'POST',
      body: JSON.stringify({
        session_id: S.session ? S.session.session_id : '',
        path: _previewCurrentPath,
        content: xml
      })
    });
    _previewRawContent = xml;
    if(typeof showToast === 'function'){
      showToast('BPMN Diagram berhasil disimpan ke server! 💾', 3000);
    }
  } catch(e) {
    console.error('Save BPMN failed:', e);
    if(typeof showToast === 'function'){
      showToast('Gagal menyimpan BPMN: ' + e.message, 4000, 'error');
    }
  } finally {
    if(saveBtn) saveBtn.innerHTML = oldText || '💾 Save BPMN';
  }
}

function bpmnFitViewport(){
  if(_bpmnViewerInstance){
    try {
      const canvas = _bpmnViewerInstance.get('canvas');
      canvas.zoom('fit-viewport');
    } catch(e){}
  }
}

function bpmnToggleRawXml(){
  if(_bpmnShowingXml){
    _bpmnShowingXml = false;
    showPreview('bpmn');
    const toggleBtn = $('btnBpmnToggleView');
    if(toggleBtn) toggleBtn.innerHTML = '&lt;/&gt; Raw XML';
    if(_previewRawContent){
      renderBpmnPreviewContent(_previewCurrentPath, _previewRawContent);
    }
  } else {
    _bpmnShowingXml = true;
    showPreview('code');
    const toggleBtn = $('btnBpmnToggleView');
    if(toggleBtn) toggleBtn.innerHTML = '📊 Diagram';
    if(_previewRawContent){
      $('previewCode').textContent = _previewRawContent;
    }
  }
}

function getGoogleDriveLinkForPath(path){
  if(!path) return '';
  if(WORKSPACE_GDRIVE_MAP[path]) return WORKSPACE_GDRIVE_MAP[path];
  if(path.startsWith('Docs/Javan/') || path.includes('Javan/')) {
    return 'https://drive.google.com/open?id=1T6hm2VkzaWG8YbRB4A0jMg7wbMaxgKp0';
  }
  return 'https://drive.google.com/drive/u/0/folders/Hermes_Artifacts';
}

function openPreviewInGoogleDrive(){
  if(!_previewCurrentPath) return;
  const link = getGoogleDriveLinkForPath(_previewCurrentPath);
  window.open(link, '_blank', 'noopener,noreferrer');
}

async function copyDriveLink(){
  if(!_previewCurrentPath) return;
  const link = getGoogleDriveLinkForPath(_previewCurrentPath);
  try {
    await navigator.clipboard.writeText(link);
    if(typeof showToast==='function') showToast('Google Drive link copied to clipboard! 📋');
  } catch(e) {
    if(typeof showToast==='function') showToast(link, 5000);
  }
}

async function exportBpmnSvg(){
  if(!_bpmnViewerInstance) return;
  try{
    const { svg } = await _bpmnViewerInstance.saveSVG({ format: true });
    _downloadSvgBlob(svg, _previewCurrentPath);
  }catch(e){
    console.error('Export SVG failed', e);
  }
}

async function workbenchExportSvg(){
  if(!_workbenchBpmnViewerInstance) return;
  try{
    const { svg } = await _workbenchBpmnViewerInstance.saveSVG({ format: true });
    _downloadSvgBlob(svg, _workbenchActiveBpmnPath || 'workbench_flow');
  }catch(e){
    console.error('Workbench export SVG failed', e);
  }
}

function _downloadSvgBlob(svgString, baseName){
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const cleanName = ((baseName||'diagram').split('/').pop()||'diagram').replace(/\.bpmn$/, '');
  a.download = cleanName + '.svg';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  if(typeof showToast==='function') showToast('Diagram SVG exported successfully!');
}

async function toggleSplitWorkbench(){
  const wbLabel = $('btnToggleWorkbenchLabel');
  if(_previewCurrentMode === 'workbench'){
    const isBpmn = fileExt(_previewCurrentPath) === '.bpmn';
    showPreview(isBpmn ? 'bpmn' : 'md');
    if(wbLabel) wbLabel.textContent = 'Split Workbench';
    return;
  }

  if(wbLabel) wbLabel.textContent = 'Close Split';

  let targetPrd = '';
  let targetBpmn = '';

  if(fileExt(_previewCurrentPath) === '.bpmn'){
    targetBpmn = _previewCurrentPath;
    targetPrd = WORKBENCH_PAIR_MAP[_previewCurrentPath] || 'PRD/PRD_EMS_Master_Bimbel.md';
  } else {
    targetPrd = _previewCurrentPath;
    targetBpmn = WORKBENCH_PAIR_MAP[_previewCurrentPath] || 'Flows/flow_admission_trial.bpmn';
  }

  await launchSplitWorkbench(targetPrd, targetBpmn);
}

async function launchSplitWorkbench(prdPath, bpmnPath){
  showPreview('workbench');
  _workbenchActivePrdPath = prdPath;
  _workbenchActiveBpmnPath = bpmnPath;

  // 1. Populate flow selector
  const selectEl = $('workbenchFlowSelect');
  if(selectEl){
    selectEl.innerHTML = '';
    ALL_WORKBENCH_FLOWS.forEach(flow => {
      const opt = document.createElement('option');
      opt.value = flow.path;
      opt.textContent = flow.name;
      if(flow.path === bpmnPath) opt.selected = true;
      selectEl.appendChild(opt);
    });
  }

  // 2. Load PRD content
  const prdBody = $('workbenchPrdBody');
  const prdTitle = $('workbenchPrdTitle');
  if(prdTitle) prdTitle.textContent = '📄 ' + (prdPath.split('/').pop() || 'PRD Specification');
  if(prdBody){
    prdBody.innerHTML = '<div style="padding:20px;color:var(--muted)">Loading specification...</div>';
    try{
      const data = await api(_workspaceRouteForPath(prdPath, 'read'));
      _workbenchActivePrdContent = data.content || '';
      prdBody.innerHTML = renderMd(_workbenchActivePrdContent);
      _attachPrdClickListeners(prdBody);
    }catch(e){
      prdBody.innerHTML = '<div style="color:var(--red);padding:20px">Failed to load PRD: ' + e.message + '</div>';
    }
  }

  // 3. Load BPMN content
  await loadWorkbenchBpmn(bpmnPath);
}

async function loadWorkbenchBpmn(bpmnPath){
  _workbenchActiveBpmnPath = bpmnPath;
  const canvasEl = $('workbenchBpmnCanvas');
  if(!canvasEl) return;
  canvasEl.innerHTML = '';
  if(_workbenchBpmnViewerInstance){
    try{ _workbenchBpmnViewerInstance.destroy(); }catch(_){}
    _workbenchBpmnViewerInstance = null;
  }

  try{
    await loadBpmnViewerLibrary();
    const data = await api(_workspaceRouteForPath(bpmnPath, 'read'));
    _workbenchActiveBpmnXml = data.content || '';

    _workbenchBpmnViewerInstance = new window.BpmnJS({
      container: canvasEl
    });
    await _workbenchBpmnViewerInstance.importXML(_workbenchActiveBpmnXml);
    const canvas = _workbenchBpmnViewerInstance.get('canvas');
    canvas.zoom('fit-viewport');

    // Wire up BPMN -> PRD click event!
    const eventBus = _workbenchBpmnViewerInstance.get('eventBus');
    eventBus.on('element.click', function(e){
      const el = e.element;
      if(el && el.businessObject && el.businessObject.name){
        syncBpmnClickToPrd(el.businessObject.name, el.id);
      }
    });
  }catch(err){
    console.error('Failed to load workbench BPMN:', err);
    canvasEl.innerHTML = '<div style="padding:20px;color:var(--red)">Failed to render BPMN: ' + err.message + '</div>';
  }
}

function syncBpmnClickToPrd(nodeName, nodeId){
  const prdBody = $('workbenchPrdBody');
  if(!prdBody) return;

  // Clean prior pulse highlights
  prdBody.querySelectorAll('.workbench-highlight-pulse').forEach(el => {
    el.classList.remove('workbench-highlight-pulse');
  });

  // Extract clean keywords
  const words = nodeName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !['dan','atau','dari','yang','untuk','the','and','for','sesi','alur','step','task','klik'].includes(w));

  let matchedEl = null;
  const candidates = prdBody.querySelectorAll('h1, h2, h3, h4, li, p, pre');

  for(let i = 0; i < candidates.length; i++){
    const text = candidates[i].textContent.toLowerCase();
    const hitCount = words.filter(w => text.includes(w)).length;
    if(hitCount >= Math.min(2, words.length) && hitCount > 0){
      matchedEl = candidates[i];
      break;
    }
  }

  if(!matchedEl && words.length > 0){
    for(let i = 0; i < candidates.length; i++){
      if(candidates[i].textContent.toLowerCase().includes(words[0])){
        matchedEl = candidates[i];
        break;
      }
    }
  }

  if(matchedEl){
    matchedEl.classList.add('workbench-highlight-pulse');
    matchedEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const banner = $('workbenchSyncText');
    if(banner){
      banner.textContent = '🎯 BPMN ➔ PRD: Found & highlighted "' + nodeName + '"';
    }
  } else {
    const banner = $('workbenchSyncText');
    if(banner){
      banner.textContent = '📍 BPMN: Selected "' + nodeName + '"';
    }
  }
}

function _attachPrdClickListeners(container){
  const items = container.querySelectorAll('h2, h3, h4, li, pre, p');
  items.forEach(item => {
    item.classList.add('workbench-prd-clickable');
    item.title = 'Click to trace in linked BPMN flow';
    item.addEventListener('click', function(e){
      e.stopPropagation();
      syncPrdClickToBpmn(item.textContent);
    });
  });
}

function syncPrdClickToBpmn(text){
  if(!_workbenchBpmnViewerInstance) return;
  const canvas = _workbenchBpmnViewerInstance.get('canvas');
  const elementRegistry = _workbenchBpmnViewerInstance.get('elementRegistry');
  if(!canvas || !elementRegistry) return;

  const allElements = elementRegistry.getAll();
  const cleanSearch = text.toLowerCase();

  let matchedNode = null;
  for(let i = 0; i < allElements.length; i++){
    const name = (allElements[i].businessObject && allElements[i].businessObject.name) || '';
    if(name && cleanSearch.includes(name.toLowerCase())){
      matchedNode = allElements[i];
      break;
    }
  }

  if(matchedNode){
    allElements.forEach(el => canvas.removeMarker(el.id, 'highlight-bpmn-node'));
    canvas.addMarker(matchedNode.id, 'highlight-bpmn-node');
    canvas.scrollToElement(matchedNode.id);
    const banner = $('workbenchSyncText');
    if(banner){
      banner.textContent = '🎯 PRD ➔ BPMN: Traced to [' + (matchedNode.businessObject.name || matchedNode.id) + ']';
    }
  }
}

function changeWorkbenchFlow(newFlowPath){
  if(newFlowPath){
    loadWorkbenchBpmn(newFlowPath);
  }
}

function workbenchFitBpmn(){
  if(_workbenchBpmnViewerInstance){
    try{
      const canvas = _workbenchBpmnViewerInstance.get('canvas');
      canvas.zoom('fit-viewport');
    }catch(_){}
  }
}

window.bpmnFitViewport = bpmnFitViewport;
window.bpmnToggleRawXml = bpmnToggleRawXml;
window._destroyBpmnViewer = _destroyBpmnViewer;
window.openPreviewInGoogleDrive = openPreviewInGoogleDrive;
window.exportBpmnSvg = exportBpmnSvg;
window.workbenchExportSvg = workbenchExportSvg;
window.toggleSplitWorkbench = toggleSplitWorkbench;
window.changeWorkbenchFlow = changeWorkbenchFlow;
window.workbenchFitBpmn = workbenchFitBpmn;

async function openFile(path, opts={}){
  if(!S.session)return;
  const ext=fileExt(path);
  const bustCache=!!(opts&&opts.bustCache);
  const forceRichMarkdown=!!(opts&&opts.forceRichMarkdown);
  const cacheBust=bustCache?`&_=${Date.now()}`:'';

  // Binary/download-only formats: trigger browser download, don't preview
  if(DOWNLOAD_EXTS.has(ext)){
    downloadFile(path);
    return;
  }

  _previewServerEditable = null;
  _previewSaveRoute = '/api/file/save';
  _previewOfficeFormat = '';
  _previewPreviewKind = '';

  $('previewPathText').textContent=path;
  $('previewArea').classList.add('visible');
  $('fileTree').style.display='none';
  if(typeof ensureWorkspacePreviewVisible==='function'){
    ensureWorkspacePreviewVisible();
  } else if(typeof openWorkspacePanel==='function'){
    openWorkspacePanel('preview');
  } else if(typeof toggleWorkspacePanel==='function'){
    toggleWorkspacePanel(true);
  }

  _previewCurrentPath = path;
  renderFileBreadcrumb(path);

  // Update visibility of Split Workbench and Drive buttons
  const isPrdOrFlow = path.startsWith('PRD/') || path.startsWith('Flows/') || ext === '.md' || ext === '.bpmn';
  const btnWb = $('btnToggleWorkbench');
  if(btnWb){
    btnWb.style.display = isPrdOrFlow ? 'inline-flex' : 'none';
    const wbLabel = $('btnToggleWorkbenchLabel');
    if(wbLabel) wbLabel.textContent = 'Split Workbench';
  }
  const btnDrive = $('btnOpenInDrive');
  const btnCopyDrive = $('btnCopyDriveLink');
  const showDriveBtn = (WORKSPACE_GDRIVE_MAP[path] || isPrdOrFlow || path.startsWith('Docs/Javan/'));
  if(btnDrive){
    btnDrive.style.display = showDriveBtn ? 'inline-flex' : 'none';
  }
  if(btnCopyDrive){
    btnCopyDrive.style.display = showDriveBtn ? 'inline-flex' : 'none';
  }

  if(IMAGE_EXTS.has(ext)){
    // Image: load via raw endpoint, show as <img>
    showPreview('image');
    const url=_workspaceRouteForPath(path, 'raw') + cacheBust;
    $('previewImg').alt=path;
    $('previewImg').src=url;
    $('previewImg').onerror=()=>setStatus(t('image_load_failed'));
  } else if(AUDIO_EXTS.has(ext)||VIDEO_EXTS.has(ext)){
    const mode=VIDEO_EXTS.has(ext)?'video':'audio';
    showPreview(mode);
    const url=_workspaceRouteForPath(path, 'raw', {inline:true}) + cacheBust;
    const wrap=$('previewMediaWrap');
    if(wrap){
      wrap.innerHTML=(typeof _mediaPlayerHtml==='function')
        ? _mediaPlayerHtml(mode,url,path.split('/').pop()||path)
        : `<${mode} src="${url.replace(/"/g,'%22')}" controls preload="metadata"></${mode}>`;
      if(typeof _applyMediaPlaybackPreferences==='function') _applyMediaPlaybackPreferences(wrap);
    }
  } else if(PDF_EXTS.has(ext)){
    showPreview('pdf');
    const url=_workspaceRouteForPath(path, 'raw', {inline:true}) + cacheBust;
    const frame=$('previewPdfFrame');
    if(frame){
      frame.src=''; // clear first to avoid stale content
      frame.src=url;
      frame.title=`PDF preview: ${path.split('/').pop()||path}`;
    }
  } else if(MD_EXTS.has(ext)){
    // Markdown: fetch text, render with renderMd, display as formatted HTML
    try{
      // #3378 review (Codex): only reuse cached raw content when it actually
      // belongs to the requested path. `path===_previewCurrentPath` is tautological
      // here (_previewCurrentPath was just assigned above), so guard on the
      // dedicated _previewRawContentPath instead — otherwise a force-render after a
      // file switch could re-render the previous file's cached content.
      const data=forceRichMarkdown&&path===_previewRawContentPath&&_previewRawContent
        ? {content:_previewRawContent}
        : await api(_workspaceRouteForPath(path, 'read'));
      _previewRawContent = data.content;
      _previewRawContentPath = path;
      if(!forceRichMarkdown && shouldRenderMarkdownPreviewAsPlainText(data.content)){
        showPreview('code');
        $('previewCode').textContent=data.content;
        setLargeMarkdownForceRenderVisible(true);
        setStatus(largeMarkdownPlainTextStatus(data.content));
        return;
      }
      renderMarkdownPreviewContent(data);
    }catch(e){setStatus(t('file_open_failed'));}
  } else if(HTML_EXTS.has(ext)){
    // HTML: render in sandboxed iframe via raw endpoint.
    // SECURITY TRADEOFF: We use sandbox="allow-scripts" which lets inline JS run
    // but prevents access to the parent frame (origin isolation). This is a
    // deliberate choice — the user is previewing their own workspace files, so
    // blocking scripts entirely would break most HTML documents. The sandbox
    // still prevents the preview from navigating the parent, accessing cookies,
    // or reading other origin data. If a stricter mode is needed, remove
    // allow-scripts (or add sandbox="") to disable all JS execution.
    showPreview('html');
    const url=_workspaceRouteForPath(path, 'raw', {inline:true}) + cacheBust;
    const iframe=$('previewHtmlIframe');
    if(iframe){
      iframe.src=''; // clear first to avoid stale content
      iframe.src=url;
    }
  } else if(BPMN_EXTS.has(ext)){
    try{
      const data=await api(_workspaceRouteForPath(path, 'read'));
      if(data.binary){
        downloadFile(path);
        return;
      }
      _previewRawContent = data.content;
      _previewRawContentPath = path;
      await renderBpmnPreviewContent(path, data.content);
    }catch(e){
      downloadFile(path);
    }
  } else if(ext==='.csv'){
    try{
      const data=await api(_workspaceRouteForPath(path, 'read'));
      if(data.binary){
        downloadFile(path);
        return;
      }
      if(renderCsvPreviewContent(path, data.content)) return;
      renderCodePreviewContent(path, data.content);
    }catch(e){
      downloadFile(path);
    }
  } else {
    // Plain code / text -- but fall back to download if server signals binary
    try{
      const data=await api(_workspaceRouteForPath(path, 'read'));
      if(data.binary){
        // Server flagged this as binary content
        downloadFile(path);
        return;
      }
      if(data.preview_kind==='office'){
        _previewRawContent = data.content || '';
        _previewRawContentPath = path;
        _previewServerEditable = typeof data.editable === 'boolean' ? data.editable : null;
        _previewPreviewKind = data.preview_kind || '';
        _previewOfficeFormat = data.office_format || '';
        _previewSaveRoute = data.preview_kind==='office' ? '/api/file/office-save' : '/api/file/save';
      }
      renderCodePreviewContent(path, data.content);
  }catch(e){
      const grant = _workspaceEscapeGrantForPath(path);
      if(grant && e && e.status===403){
        _clearWorkspaceEscapeGrant(grant.path);
        showToast(t('external_link_grant_expired') || t('file_open_failed'), 5000, 'error');
        return;
      }
      // If it's a 400/too-large error, offer download instead
      downloadFile(path);
    }
  }
}

function downloadFile(path){
  if(!S.session)return;
  // Trigger browser download via the raw file endpoint with content-disposition attachment
  const url=_workspaceRouteForPath(path, 'raw', {download:true});
  const filename=path.split('/').pop();
  const a=document.createElement('a');
  a.href=url;a.download=filename;
  document.body.appendChild(a);a.click();
  setTimeout(()=>document.body.removeChild(a),100);
  showToast(t('downloading',filename),2000);
}


// ── Render breadcrumb for file preview mode ──────────────────────────────────
function renderFileBreadcrumb(filePath) {
  const bar = $('breadcrumbBar');
  if (!bar) return;
  bar.style.display = 'flex';
  const upBtn = $('btnUpDir');
  if (upBtn) upBtn.style.display = '';

  bar.innerHTML = '';
  // Root
  const root = document.createElement('span');
  root.className = 'breadcrumb-seg breadcrumb-link';
  root.textContent = '~';
  root.onclick = () => { loadDir('.'); };
  bar.appendChild(root);

  const parts = filePath.split('/');
  let accumulated = '';
  for (let i = 0; i < parts.length; i++) {
    const sep = document.createElement('span');
    sep.className = 'breadcrumb-sep';
    sep.textContent = '/';
    bar.appendChild(sep);

    accumulated += (accumulated ? '/' : '') + parts[i];
    const seg = document.createElement('span');
    seg.textContent = parts[i];
    if (i < parts.length - 1) {
      seg.className = 'breadcrumb-seg breadcrumb-link';
      const target = accumulated;
      seg.onclick = () => { loadDir(target); };
    } else {
      seg.className = 'breadcrumb-seg breadcrumb-current';
    }
    bar.appendChild(seg);
  }
}

function openInBrowser(){
  if(!_previewCurrentPath||!S.session) return;
  const url=_workspaceRouteForPath(_previewCurrentPath, 'raw', {inline:true});
  window.open(url,'_blank','noopener');
}
// openInBrowser keeps the helper-based raw path, which expands to an explicit &inline=1 URL.

async function copyPreviewRelativePath(){
  if(!_previewCurrentPath) return;
  const btn=$('btnCopyPreviewRelPath');
  if(btn&&btn.disabled) return;
  if(btn) btn.disabled=true;
  try{
    const rel=_normalizeWorkspaceRelPath(_previewCurrentPath)||_previewCurrentPath;
    if(typeof _copyTextWithFallback==='function'){
      await _copyTextWithFallback(rel,t('path_copied'),t('path_copy_failed'));
      return;
    }
    try{
      await navigator.clipboard.writeText(rel);
      showToast(t('path_copied'));
    }catch(clipErr){
      const ta=document.createElement('textarea');
      ta.value=rel;
      ta.style.cssText='position:fixed;left:-9999px;top:-9999px;';
      document.body.appendChild(ta);
      ta.select();
      let copied=false;
      try{copied=document.execCommand('copy');}catch(_){}
      ta.remove();
      if(copied) showToast(t('path_copied'));
      else showToast(t('path_copy_failed')+(clipErr&&clipErr.message?clipErr.message:String(clipErr)));
    }
  }catch(err){
    showToast(t('path_copy_failed')+(err.message||err));
  }finally{
    if(btn) btn.disabled=false;
  }
}

// ── Workspace upload ──────────────────────────────────────────────────
function triggerWorkspaceUpload() {
  if(_workspacePathIsReadOnly(S.currentDir || '.')){
    showToast(t('external_link_read_only'), 2000);
    return;
  }
  const input = $('workspaceFileInput');
  if (!input) return;
  input.value = '';
  input.onchange = async () => {
    const files = input.files;
    if (!files || !files.length) return;
    for (const file of files) {
      await uploadToWorkspace(file, S.currentDir || '.');
    }
    if (S.session) loadDir(S.currentDir);
  };
  input.click();
}

async function uploadToWorkspace(file, dir) {
  if (!S.session) return;
  if(_workspacePathIsReadOnly(dir || '.')){
    showToast(t('external_link_read_only'), 2000);
    return;
  }
  const formData = new FormData();
  formData.append('session_id', S.session.session_id);
  formData.append('path', dir || '.');
  formData.append('file', file, file.name);
  try {
    showToast(t('uploading') || 'Uploading\u2026', 2000);
    const data = await api('/api/workspace/upload', {
      method: 'POST',
      body: formData,
      headers: {},
      timeoutMs: 120000,
    });
    if (data && data.error) {
      showToast(data.error, 5000, 'error');
    } else if (data && (data.extract_error || (Array.isArray(data.files) && data.files.some(function(f){return f && f.extract_error;})))) {
      // Archive was rejected (zip-slip / zip-bomb / corrupt / too-many-members):
      // the file uploaded but extraction failed. Surface it as an error instead
      // of a misleading "Uploaded" success toast.
      var msg = data.extract_error
        || (data.files.find(function(f){return f && f.extract_error;}) || {}).extract_error
        || 'Archive extraction failed';
      showToast(msg, 5000, 'error');
    } else {
      showToast(t('uploaded') || ('Uploaded ' + (data.filename || file.name)), 2000);
    }
  } catch (e) {
    showToast(t('upload_failed') || ('Upload failed: ' + e.message), 5000, 'error');
  }
}

function _isOsFilesDrag(e) {
  return !!(e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files'));
}

function _joinWorkspacePath(base, rel) {
  const b = base || '.';
  const r = (rel || '').replace(/^\/+|\/+$/g, '');
  if (!r) return b;
  return b === '.' ? r : `${b}/${r}`;
}

function _targetDirForRelDir(destDir, relDir) {
  const dirPart = (relDir || '').replace(/\/+$/, '');
  if (!dirPart) return destDir || '.';
  return _joinWorkspacePath(destDir, dirPart);
}

async function _readAllDirectoryEntries(reader) {
  const entries = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch.length) break;
    entries.push(...batch);
  }
  return entries;
}

async function _collectFilesFromEntry(entry, relPrefix) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => {
      entry.file(resolve, reject);
    });
    return [{ file, relDir: relPrefix || '' }];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const children = await _readAllDirectoryEntries(reader);
  const dirPrefix = `${relPrefix || ''}${entry.name}/`;
  let out = [];
  for (const child of children) {
    out = out.concat(await _collectFilesFromEntry(child, dirPrefix));
  }
  return out;
}

async function _collectOsDropUploads(dataTransfer) {
  const out = [];
  const items = dataTransfer.items ? [...dataTransfer.items] : [];
  const files = dataTransfer.files ? [...dataTransfer.files] : [];
  if (items.length) {
    const entries = [];
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const getAsEntry = item.getAsEntry || item.webkitGetAsEntry;
      const entry = typeof getAsEntry === 'function' ? getAsEntry.call(item) : null;
      if (!entry) continue;
      entries.push(entry);
    }
    for (const entry of entries) {
      out.push(...await _collectFilesFromEntry(entry, ''));
    }
    if (out.length) return out;
  }
  for (const file of files) {
    out.push({ file, relDir: '' });
  }
  return out;
}

async function uploadOsDropToWorkspace(dataTransfer, destDir) {
  if (!S.session || !dataTransfer) return;
  if(_workspacePathIsReadOnly(destDir || '.')){
    showToast(t('external_link_read_only'), 2000);
    return;
  }
  const uploads = await _collectOsDropUploads(dataTransfer);
  for (const { file, relDir } of uploads) {
    await uploadToWorkspace(file, _targetDirForRelDir(destDir, relDir));
  }
  if (S.session) await loadDir(S.currentDir);
}

function _clearWorkspaceOsUploadDragOver() {
  document.querySelectorAll('.file-item.drag-over-upload,.breadcrumb-seg.drag-over-upload').forEach((el) => {
    el.classList.remove('drag-over-upload');
  });
}

function _bindWorkspaceOsUploadDropTarget(el, destDir) {
  // Use addEventListener (not on-property assignment) so these OS-upload
  // handlers COMPOSE with the workspace tree-MOVE handlers bound by
  // _bindWorkspaceMoveDropTarget() on the same element. A property assignment
  // for the drop handler here would overwrite the move handler, and a
  // workspace-file drag would fall through to the document drop (inserting
  // @path into the composer) instead of moving the file. Each handler gates on
  // its own drag type (_isOsFilesDrag vs _isWorkspaceTreeMoveDrag), so only the
  // matching one acts.
  el.addEventListener('dragenter', (e) => {
    if (!_isOsFilesDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add('drag-over-upload');
  });
  el.addEventListener('dragover', (e) => {
    if (!_isOsFilesDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drag-over-upload');
  });
  el.addEventListener('dragleave', (e) => {
    if (el.contains(e.relatedTarget)) return;
    el.classList.remove('drag-over-upload');
  });
  el.addEventListener('drop', async (e) => {
    if (!_isOsFilesDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drag-over-upload');
    if(_workspacePathIsReadOnly(destDir || '.')){
      showToast(t('external_link_read_only'), 2000);
      return;
    }
    await uploadOsDropToWorkspace(e.dataTransfer, destDir);
  });
}

// Drag-and-drop files onto workspace file tree
if (typeof document !== 'undefined') {
  const _wsUploadInit = () => {
    const tree = $('fileTree');
    if (!tree) return;
    tree.addEventListener('dragenter', (e) => {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    tree.addEventListener('dragover', (e) => {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        e.stopPropagation();
        if (e.target.closest('.file-item[data-ws-type="dir"],.file-item[data-ws-is-dir="true"],.breadcrumb-seg')) return;
        e.dataTransfer.dropEffect = 'copy';
        tree.classList.add('drag-over-upload');
      }
    });
    tree.addEventListener('dragleave', (e) => {
      if (tree.contains(e.relatedTarget)) return;
      tree.classList.remove('drag-over-upload');
    });
    tree.addEventListener('drop', async (e) => {
      tree.classList.remove('drag-over-upload');
      if (!e.dataTransfer || !e.dataTransfer.types || !e.dataTransfer.types.includes('Files')) return;
      if (e.target.closest('.file-item[data-ws-type="dir"],.file-item[data-ws-is-dir="true"],.breadcrumb-seg')) return;
      e.preventDefault();
      e.stopPropagation();
      if(_workspacePathIsReadOnly(S.currentDir || '.')){
        showToast(t('external_link_read_only'), 2000);
        return;
      }
      await uploadOsDropToWorkspace(e.dataTransfer, S.currentDir || '.');
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wsUploadInit, {once: true});
  } else {
    _wsUploadInit();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// DEDICATED PRODUCT ENGINEERING STUDIO CONTROLLER
// ═══════════════════════════════════════════════════════════════════════

let _studioBpmnViewerInstance = null;
let _studioCurrentPrdPath = 'PRD/PRD_EMS_Master_Bimbel.md';
let _studioCurrentBpmnPath = 'Flows/ems_master_workflow.bpmn';
let _studioPrdRawText = '';

const STUDIO_ARTIFACTS_DATA = {
  prds: [
    { path: 'PRD/PRD_EMS_Master_Bimbel.md', title: 'EMS Master Blueprint', desc: 'Arsitektur Global Bimbel As-Is' },
    { path: 'PRD/PRD_EMS_00_Master_Data_Architecture.md', title: '0. Master Data Architecture', desc: 'Piramida Hirarki & Tata Kelola' },
    { path: 'PRD/PRD_EMS_01_Admission_Trial.md', title: '1. Admission & Trial Class', desc: 'Pendaftaran & Fast-Track Trial' },
    { path: 'PRD/PRD_EMS_02_Fees_Billing.md', title: '2. Fees & Invoicing', desc: 'Tagihan SPP & Integrasi Akuntansi' },
    { path: 'PRD/PRD_EMS_03_Timetable_Attendance.md', title: '3. Timetable & Attendance', desc: 'Jadwal Bebas Bentrok & Presensi 1-Klik' },
    { path: 'PRD/PRD_EMS_04_Assessment_Gradebook_Parent.md', title: '4. Evaluation & Gradebook', desc: 'Tryout CBT & Rapor Ortu' },
    { path: 'PRD/PRD_Hermes_WebUI_Product_Analyst_Suite.md', title: 'Hermes WebUI Suite PRD', desc: 'Spesifikasi Fitur Analis' }
  ],
  flows: [
    { path: 'Flows/ems_master_workflow.bpmn', name: 'Master End-to-End Workflow' },
    { path: 'Flows/flow_master_data_setup.bpmn', name: '0. Master Data Setup' },
    { path: 'Flows/flow_admission_trial.bpmn', name: '1. Admission & Trial Class' },
    { path: 'Flows/flow_fees_invoicing.bpmn', name: '2. Fees & Invoicing' },
    { path: 'Flows/flow_attendance_session.bpmn', name: '3. Session & Attendance' },
    { path: 'Flows/flow_gradebook_eval.bpmn', name: '4. Tryout & Gradebook' }
  ]
};

function switchAppMode(mode){
  const target = (mode === 'studio') ? 'studio' : 'chat';
  if(typeof switchPanel === 'function'){
    switchPanel(target);
  }
}

async function initProductStudio(){
  renderStudioArtifactTree();

  const flowSelect = $('studioActiveFlowSelect');
  if(flowSelect){
    flowSelect.innerHTML = '';
    STUDIO_ARTIFACTS_DATA.flows.forEach(flow => {
      const opt = document.createElement('option');
      opt.value = flow.path;
      opt.textContent = flow.name;
      if(flow.path === _studioCurrentBpmnPath) opt.selected = true;
      flowSelect.appendChild(opt);
    });
  }

  await loadStudioPrd(_studioCurrentPrdPath);
  if(!_studioBpmnViewerInstance){
    await loadStudioBpmn(_studioCurrentBpmnPath);
  }

  const savedLayout = localStorage.getItem('hermes-studio-layout') || 'prd';
  setStudioLayout(savedLayout);
}

function renderStudioArtifactTree(){
  const treeContainer = $('studioArtifactTree');
  if(!treeContainer) return;

  let html = '';

  // PRD Group
  html += '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin:8px 6px 4px 6px;">PRD Specifications (' + STUDIO_ARTIFACTS_DATA.prds.length + ')</div>';
  STUDIO_ARTIFACTS_DATA.prds.forEach(prd => {
    const isActive = (prd.path === _studioCurrentPrdPath);
    html += '<div class="studio-tree-item ' + (isActive ? 'active' : '') + '" onclick="loadStudioPrd(\'' + prd.path + '\')">';
    html += '  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--blue);flex-shrink:0;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    html += '  <div style="flex:1;min-width:0;">';
    html += '    <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + prd.title + '</div>';
    html += '    <div style="font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + prd.desc + '</div>';
    html += '  </div>';
    html += '</div>';
  });

  // Flows Group
  html += '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin:16px 6px 4px 6px;">BPMN 2.0 Flows (' + STUDIO_ARTIFACTS_DATA.flows.length + ')</div>';
  STUDIO_ARTIFACTS_DATA.flows.forEach(flow => {
    const isActive = (flow.path === _studioCurrentBpmnPath);
    html += '<div class="studio-tree-item ' + (isActive ? 'active' : '') + '" onclick="selectStudioFlowFromTree(\'' + flow.path + '\')">';
    html += '  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#8b5cf6;flex-shrink:0;"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>';
    html += '  <div style="flex:1;min-width:0;">';
    html += '    <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + flow.name + '</div>';
    html += '    <div style="font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + flow.path + '</div>';
    html += '  </div>';
    html += '</div>';
  });

  treeContainer.innerHTML = html;
}

async function loadStudioPrd(prdPath){
  _studioCurrentPrdPath = prdPath;
  const titleEl = $('studioActivePrdTitle');
  const viewerEl = $('studioPrdViewer');
  if(!viewerEl) return;

  if(titleEl){
    titleEl.textContent = prdPath.split('/').pop() || 'PRD Specification';
    titleEl.title = prdPath;
  }

  viewerEl.innerHTML = '<div style="padding:20px;color:var(--muted)">Loading specification...</div>';
  renderStudioArtifactTree();

  try{
    const data = await api(_workspaceRouteForPath(prdPath, 'read'));
    _studioPrdRawText = data.content || '';
    viewerEl.innerHTML = renderMd(_studioPrdRawText);
    _enhancePrdView(viewerEl);
    _attachStudioPrdListeners(viewerEl);
    _buildPrdTableOfContents(viewerEl);
  }catch(err){
    viewerEl.innerHTML = '<div style="color:var(--red);padding:20px">Failed to load PRD: ' + err.message + '</div>';
  }

  const matchingFlow = WORKBENCH_PAIR_MAP[prdPath];
  if(matchingFlow && (matchingFlow !== _studioCurrentBpmnPath || !_studioBpmnViewerInstance)){
    await loadStudioBpmn(matchingFlow);
    const flowSelect = $('studioActiveFlowSelect');
    if(flowSelect) flowSelect.value = matchingFlow;
  }
}

async function loadStudioBpmn(bpmnPath){
  _studioCurrentBpmnPath = bpmnPath;
  const canvasEl = $('studioBpmnContainer');
  if(!canvasEl) return;
  canvasEl.innerHTML = '';

  if(_studioBpmnViewerInstance){
    try{ _studioBpmnViewerInstance.destroy(); }catch(_){}
    _studioBpmnViewerInstance = null;
  }

  renderStudioArtifactTree();

  try{
    await loadBpmnViewerLibrary();
    const data = await api(_workspaceRouteForPath(bpmnPath, 'read'));
    const xml = data.content || '';

    _studioBpmnViewerInstance = new window.BpmnJS({
      container: canvasEl,
      keyboard: {
        bindTo: document
      }
    });
    await _studioBpmnViewerInstance.importXML(xml);
    requestAnimationFrame(() => {
      setTimeout(() => {
        try {
          const canvas = _studioBpmnViewerInstance.get('canvas');
          canvas.zoom('fit-viewport');
        } catch(_) {}
      }, 100);
    });

    const eventBus = _studioBpmnViewerInstance.get('eventBus');
    eventBus.on('element.click', function(e){
      const el = e.element;
      if(el && el.businessObject && el.businessObject.name){
        syncStudioBpmnClickToPrd(el.businessObject.name, el.id);
      }
    });
  }catch(err){
    console.error('Failed to load Studio BPMN:', err);
    canvasEl.innerHTML = '<div style="padding:20px;color:var(--red)">Failed to render BPMN: ' + err.message + '</div>';
  }
}

function syncStudioBpmnClickToPrd(nodeName, nodeId){
  const viewer = $('studioPrdViewer');
  if(!viewer) return;

  viewer.querySelectorAll('.workbench-highlight-pulse').forEach(el => {
    el.classList.remove('workbench-highlight-pulse');
  });

  const words = nodeName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !['dan','atau','dari','yang','untuk','the','and','for','sesi','alur','step','task','klik'].includes(w));

  let matchedEl = null;
  const candidates = viewer.querySelectorAll('h1, h2, h3, h4, li, p, pre');

  for(let i = 0; i < candidates.length; i++){
    const text = candidates[i].textContent.toLowerCase();
    const hitCount = words.filter(w => text.includes(w)).length;
    if(hitCount >= Math.min(2, words.length) && hitCount > 0){
      matchedEl = candidates[i];
      break;
    }
  }

  if(!matchedEl && words.length > 0){
    for(let i = 0; i < candidates.length; i++){
      if(candidates[i].textContent.toLowerCase().includes(words[0])){
        matchedEl = candidates[i];
        break;
      }
    }
  }

  const syncBanner = $('studioSyncStatusText');
  if(matchedEl){
    matchedEl.classList.add('workbench-highlight-pulse');
    matchedEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if(syncBanner) syncBanner.textContent = '🎯 Flow ➔ PRD: Found & highlighted "' + nodeName + '"';
  } else {
    if(syncBanner) syncBanner.textContent = '📍 Flow: Selected "' + nodeName + '"';
  }
}

function _attachStudioPrdListeners(container){
  const items = container.querySelectorAll('h2, h3, h4, li, pre, p');
  items.forEach(item => {
    item.classList.add('workbench-prd-clickable');
    item.title = 'Click to trace in linked BPMN flow';
    item.addEventListener('click', function(e){
      e.stopPropagation();
      syncStudioPrdClickToBpmn(item.textContent);
    });
  });

  container.addEventListener('mouseup', _handlePrdTextSelection);
  container.addEventListener('keyup', _handlePrdTextSelection);
}

let _currentSelectedPrdText = '';
function _handlePrdTextSelection(){
  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : '';
  const badge = $('prdHighlightDiscussBadge');
  if(!badge) return;

  if(text && text.length >= 4){
    _currentSelectedPrdText = text;
    try {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const studioView = $('productStudioView');
      const studioRect = studioView.getBoundingClientRect();

      const top = Math.max(10, rect.top - studioRect.top - 36);
      const left = Math.max(10, rect.left - studioRect.left + (rect.width / 2) - 75);

      badge.style.top = top + 'px';
      badge.style.left = left + 'px';
      badge.style.display = 'inline-flex';
    } catch(_) {
      badge.style.display = 'none';
    }
  } else {
    setTimeout(() => {
      const activeSel = window.getSelection();
      if(!activeSel || !activeSel.toString().trim()){
        badge.style.display = 'none';
      }
    }, 250);
  }
}

function setStudioLayout(layout){
  const valid = ['prd', 'split', 'flow'].includes(layout) ? layout : 'prd';
  const studioView = $('mainStudio') || $('productStudioView');
  if(!studioView) return;
  studioView.setAttribute('data-studio-layout', valid);
  localStorage.setItem('hermes-studio-layout', valid);

  const bPrd = $('btnLayoutPrd');
  const bSplit = $('btnLayoutSplit');
  const bFlow = $('btnLayoutFlow');
  if(bPrd) bPrd.classList.toggle('active', valid === 'prd');
  if(bSplit) bSplit.classList.toggle('active', valid === 'split');
  if(bFlow) bFlow.classList.toggle('active', valid === 'flow');

  if(valid === 'flow' || valid === 'split'){
    setTimeout(() => {
      studioFitBpmn();
    }, 150);
  }
}

function toggleStudioPrdDiscussion(){
  const drawer = $('studioPrdDiscussDrawer');
  if(!drawer) return;
  const isHidden = (drawer.style.display === 'none');
  drawer.style.display = isHidden ? 'flex' : 'none';
  if(isHidden){
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if(text) _currentSelectedPrdText = text;
    const contextBox = $('discussSelectedContextBox');
    const textEl = $('discussSelectedText');
    if(_currentSelectedPrdText){
      if(contextBox) contextBox.style.display = 'block';
      if(textEl) textEl.textContent = `"${_currentSelectedPrdText.slice(0, 300)}${_currentSelectedPrdText.length > 300 ? '...' : ''}"`;
    } else {
      if(contextBox) contextBox.style.display = 'none';
    }
    setTimeout(() => $('discussInputPrompt')?.focus(), 50);
  }
}

function closeStudioPrdDiscussion(){
  const drawer = $('studioPrdDiscussDrawer');
  if(drawer) drawer.style.display = 'none';
}

function openStudioPrdDiscussionFromHighlight(){
  const drawer = $('studioPrdDiscussDrawer');
  const contextBox = $('discussSelectedContextBox');
  const textEl = $('discussSelectedText');
  const badge = $('prdHighlightDiscussBadge');
  if(badge) badge.style.display = 'none';
  if(!drawer) return;

  drawer.style.display = 'flex';
  if(_currentSelectedPrdText){
    if(contextBox) contextBox.style.display = 'block';
    if(textEl) textEl.textContent = `"${_currentSelectedPrdText.slice(0, 300)}${_currentSelectedPrdText.length > 300 ? '...' : ''}"`;
  }
  const input = $('discussInputPrompt');
  if(input){
    input.focus();
  }
}

function jumpToCouncilChatWithContext(){
  const promptInput = $('discussInputPrompt');
  const userPrompt = promptInput ? promptInput.value.trim() : '';
  const selectedText = _currentSelectedPrdText || '';
  const prdFile = (_studioCurrentPrdPath || '').split('/').pop() || 'PRD Document';

  const fullPrompt = `[DISKUSI IN-LINE PRD: ${prdFile}]\n` +
    (selectedText ? `[Klausul yang disorot]: "${selectedText}"\n` : '') +
    (userPrompt ? `[Catatan]: ${userPrompt}\n` : '') +
    `Mohon review klausul ini bersama Gemstone Council.`;

  const chatMsgInput = $('msg');
  if(chatMsgInput) {
    chatMsgInput.value = fullPrompt;
  }
  switchAppMode('chat');
  setTimeout(() => {
    chatMsgInput?.focus();
  }, 100);
}

let _lastRevisionProposal = '';
async function submitPrdDiscussion(){
  const promptInput = $('discussInputPrompt');
  const prompt = promptInput ? promptInput.value.trim() : '';
  if(!prompt) return;

  const role = $('discussRoleSelect')?.value || 'council';
  const roleNameMap = {
    council: 'Gemstone Council (Diamond, Sapphire, Ruby, Amber)',
    diamond: '💎 Diamond (Lead Decider)',
    sapphire: '🔷 Sapphire (Operasional & DMS Specialist)',
    ruby: '🔴 Ruby (Arsitektur ERP & Technical Lead)',
    amber: '🔶 Amber (QA & Edge Case Specialist)'
  };

  const selectedText = _currentSelectedPrdText || '';
  const prdFile = (_studioCurrentPrdPath || '').split('/').pop() || 'PRD Document';

  const fullPrompt = `[DISKUSI IN-LINE PRD: ${prdFile}]\n` +
    (selectedText ? `[Klausul yang disorot]: "${selectedText}"\n` : '') +
    `[Fokus Review]: ${roleNameMap[role] || role}\n` +
    `[Masukan/Catatan User]: ${prompt}\n\n` +
    `Mohon tanggapi langsung poin di atas, berikan analisis singkat dan rekomendasi perbaikan klausul dokumen. Sertakan blok "USULAN REVISI KLAUSUL:" yang siap diterapkan langsung ke PRD.`;

  const resultBox = $('discussResultBox');
  const resultContent = $('discussResultContent');
  const labelSubmit = $('labelSubmitDiscuss');
  if(resultBox) resultBox.style.display = 'block';
  if(resultContent) resultContent.innerHTML = '<div style="color:var(--muted);font-style:italic;">⏳ Mengirim konteks ke Hermes...</div>';
  if(labelSubmit) labelSubmit.textContent = '...';

  try {
    const chatMsgInput = $('msg');
    if(chatMsgInput && typeof send === 'function'){
      chatMsgInput.value = fullPrompt;
      await send();
      if(resultContent){
        resultContent.innerHTML = `<div style="color:var(--text);line-height:1.6;">
          <strong>✅ Diskusi klausul telah dikirim ke Hermes.</strong><br><br>
          Hermes sedang memproses jawaban & usulan revisi. Anda dapat membuka obrolan langsung di 
          <a href="javascript:void(0)" onclick="switchAppMode('chat')" style="color:var(--blue);font-weight:600;text-decoration:underline;">Council Chat</a> 
          atau tetap di PRD ini.
        </div>`;
      }
      if(typeof showToast === 'function'){
        showToast('Klausul terkirim ke Hermes! 💬', 2500);
      }
    } else {
      if(resultContent){
        resultContent.innerHTML = '<div style="color:var(--muted);">Sesi belum aktif. Silakan buka chat terlebih dahulu.</div>';
      }
    }
  } catch(err) {
    console.error('Submit PRD discussion failed:', err);
    if(resultContent) resultContent.innerHTML = '<div style="color:var(--red);">Gagal mengirim diskusi: ' + err.message + '</div>';
  } finally {
    if(labelSubmit) labelSubmit.textContent = 'Kirim';
  }
}

async function applyPrdRevision(){
  if(!_lastRevisionProposal || !_studioCurrentPrdPath || !_currentSelectedPrdText){
    showToast('Pilih klausul dan tunggu usulan revisi dari Hermes.', 2500, 'warning');
    return;
  }
  if(!_studioPrdRawText.includes(_currentSelectedPrdText)){
    showToast('Teks asli tidak ditemukan persis di dokumen.', 3000, 'warning');
    return;
  }
  const updatedText = _studioPrdRawText.replace(_currentSelectedPrdText, _lastRevisionProposal);
  try {
    await api('/api/file/save', {
      method: 'POST',
      body: JSON.stringify({
        session_id: S.session ? S.session.session_id : '',
        path: _studioCurrentPrdPath,
        content: updatedText
      })
    });
    _studioPrdRawText = updatedText;
    const viewer = $('studioPrdViewer');
    if(viewer){
      viewer.innerHTML = renderMd(_studioPrdRawText);
      _attachStudioPrdListeners(viewer);
    }
    showToast('Revisi berhasil diterapkan ke PRD! 💾', 3000);
    closeStudioPrdDiscussion();
  } catch(e) {
    showToast('Gagal menerapkan revisi: ' + e.message, 3500, 'error');
  }
}

function syncStudioPrdClickToBpmn(text){
  if(!_studioBpmnViewerInstance) return;
  const canvas = _studioBpmnViewerInstance.get('canvas');
  const elementRegistry = _studioBpmnViewerInstance.get('elementRegistry');
  if(!canvas || !elementRegistry) return;

  const allElements = elementRegistry.getAll();
  const cleanSearch = text.toLowerCase();

  let matchedNode = null;
  for(let i = 0; i < allElements.length; i++){
    const name = (allElements[i].businessObject && allElements[i].businessObject.name) || '';
    if(name && cleanSearch.includes(name.toLowerCase())){
      matchedNode = allElements[i];
      break;
    }
  }

  const syncBanner = $('studioSyncStatusText');
  if(matchedNode){
    allElements.forEach(el => canvas.removeMarker(el.id, 'highlight-bpmn-node'));
    canvas.addMarker(matchedNode.id, 'highlight-bpmn-node');
    canvas.scrollToElement(matchedNode.id);
    if(syncBanner) syncBanner.textContent = '🎯 PRD ➔ Flow: Traced to [' + (matchedNode.businessObject.name || matchedNode.id) + ']';
  }
}

function selectStudioFlowFromTree(flowPath){
  const select = $('studioActiveFlowSelect');
  if(select) select.value = flowPath;
  loadStudioBpmn(flowPath);
}

function changeStudioFlow(flowPath){
  if(flowPath) loadStudioBpmn(flowPath);
}

function studioFitBpmn(){
  if(_studioBpmnViewerInstance){
    try{
      const canvas = _studioBpmnViewerInstance.get('canvas');
      canvas.zoom('fit-viewport');
    }catch(_){}
  }
}

async function studioExportSvg(){
  if(!_studioBpmnViewerInstance) return;
  try{
    const { svg } = await _studioBpmnViewerInstance.saveSVG({ format: true });
    _downloadSvgBlob(svg, _studioCurrentBpmnPath || 'studio_diagram');
  }catch(e){
    console.error('Studio export SVG failed', e);
  }
}

function openStudioDriveFolder(){
  window.open('https://drive.google.com/drive/u/0/folders/Hermes_Artifacts', '_blank', 'noopener,noreferrer');
}

function openStudioPrdDrive(){
  const link = WORKSPACE_GDRIVE_MAP[_studioCurrentPrdPath];
  if(link){
    window.open(link, '_blank', 'noopener,noreferrer');
  } else {
    openStudioDriveFolder();
  }
}

async function copyStudioPrdMarkdown(){
  if(!_studioPrdRawText) return;
  try{
    await navigator.clipboard.writeText(_studioPrdRawText);
    if(typeof showToast==='function') showToast('PRD Markdown copied to clipboard!');
  }catch(e){
    console.error('Copy PRD failed', e);
  }
}

function refreshStudioArtifacts(){
  renderStudioArtifactTree();
  if(typeof showToast==='function') showToast('Artifact list refreshed');
}

function toggleStudioNav(){
  const studioView = $('productStudioView');
  if(!studioView) return;
  studioView.classList.toggle('studio-nav-collapsed');
  const isCollapsed = studioView.classList.contains('studio-nav-collapsed');
  const label = $('labelStudioNav');
  if(label) label.textContent = isCollapsed ? 'Show' : 'Sidebar';
  setTimeout(() => {
    studioFitBpmn();
  }, 220);
}

// Global hotkeys:
// 1. Alt+S: Toggles between Chat and Product Studio!
// 2. Escape: Returns from Studio to Chat!
// 3. '[': Toggles Artifact Explorer sidebar inside Studio!
document.addEventListener('keydown', function(e){
  // Check if user is typing in an input or textarea
  const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;

  if((e.altKey && (e.key === 's' || e.key === 'S')) || (e.ctrlKey && e.shiftKey && (e.key === 'p' || e.key === 'P'))){
    e.preventDefault();
    if(typeof switchPanel === 'function'){
      const activeTab = document.querySelector('.rail-btn.active')?.dataset?.panel;
      switchPanel(activeTab === 'studio' ? 'chat' : 'studio');
    }
    return;
  }
});

async function studioSaveBpmn(){
  if(!_studioBpmnViewerInstance || !_studioCurrentBpmnPath) return;
  const saveBtn = $('btnStudioSaveBpmn');
  const oldHtml = saveBtn ? saveBtn.innerHTML : '';
  try {
    if(saveBtn) saveBtn.innerHTML = '<span>Saving...</span>';
    const { xml } = await _studioBpmnViewerInstance.saveXML({ format: true });
    await api('/api/file/save', {
      method: 'POST',
      body: JSON.stringify({
        session_id: S.session ? S.session.session_id : '',
        path: _studioCurrentBpmnPath,
        content: xml,
        sync_gdrive: true
      })
    });
    if(typeof showToast === 'function'){
      showToast('BPMN Flow disimpan & disinkronkan ke Google Drive! 💾☁️', 3500);
    }
  } catch(e) {
    console.error('Save studio BPMN failed:', e);
    if(typeof showToast === 'function'){
      showToast('Gagal menyimpan flow: ' + e.message, 4000, 'error');
    }
  } finally {
    if(saveBtn) saveBtn.innerHTML = oldHtml || '<span>Save</span>';
  }
}

let _studioPrdEditing = false;
function toggleStudioPrdEdit(){
  const viewer = $('studioPrdViewer');
  const editorWrap = $('studioPrdEditorWrap');
  const editArea = $('studioPrdEditArea');
  const editLabel = $('studioEditBtnLabel');
  const saveBtn = $('btnStudioSavePrd');
  if(!viewer || !editorWrap || !editArea) return;

  _studioPrdEditing = !_studioPrdEditing;
  if(_studioPrdEditing){
    editArea.value = _studioPrdRawText || '';
    viewer.style.display = 'none';
    editorWrap.style.display = 'flex';
    if(editLabel) editLabel.textContent = 'Preview';
    if(saveBtn) saveBtn.style.display = 'inline-flex';
    editArea.focus();
  } else {
    _studioPrdRawText = editArea.value;
    viewer.innerHTML = renderMd(_studioPrdRawText);
    _enhancePrdView(viewer);
    _attachStudioPrdListeners(viewer);
    _buildPrdTableOfContents(viewer);
    editorWrap.style.display = 'none';
    viewer.style.display = 'block';
    if(editLabel) editLabel.textContent = 'Edit';
    if(saveBtn) saveBtn.style.display = 'none';
  }
}

async function saveStudioPrdEdit(){
  const editArea = $('studioPrdEditArea');
  const saveBtn = $('btnStudioSavePrd');
  if(!_studioCurrentPrdPath || !editArea) return;
  const oldHtml = saveBtn ? saveBtn.innerHTML : '';
  try {
    if(saveBtn) saveBtn.innerHTML = '<span>Saving...</span>';
    const content = editArea.value;
    await api('/api/file/save', {
      method: 'POST',
      body: JSON.stringify({
        session_id: S.session ? S.session.session_id : '',
        path: _studioCurrentPrdPath,
        content: content,
        sync_gdrive: true
      })
    });
    _studioPrdRawText = content;
    const viewer = $('studioPrdViewer');
    if(viewer) {
      viewer.innerHTML = renderMd(_studioPrdRawText);
      _enhancePrdView(viewer);
      _attachStudioPrdListeners(viewer);
      _buildPrdTableOfContents(viewer);
    }
    if(typeof showToast === 'function'){
      showToast('PRD Specification disimpan & disinkronkan ke Google Drive! 💾☁️', 3500);
    }
  } catch(e) {
    console.error('Failed to save PRD:', e);
    if(typeof showToast === 'function'){
      showToast('Gagal menyimpan PRD: ' + e.message, 4000, 'error');
    }
  } finally {
    if(saveBtn) saveBtn.innerHTML = oldHtml || '<span>Save</span>';
  }
}

function exportPrdToPdf(){
  window.print();
}

function toggleStudioPrdOutline(){
  const outline = $('studioPrdOutline');
  const btn = $('btnTogglePrdOutline');
  if(!outline) return;
  const isCollapsed = outline.classList.toggle('collapsed');
  localStorage.setItem('hermes-studio-outline-collapsed', isCollapsed ? '1' : '0');
  if(btn) btn.classList.toggle('active', !isCollapsed);
}

function scrollToPrdHeading(secId){
  const heading = document.getElementById(secId);
  if(!heading) return;
  heading.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const outlineList = $('studioPrdOutlineList');
  if(outlineList){
    outlineList.querySelectorAll('.prd-toc-item').forEach(item => {
      item.classList.toggle('active', item.getAttribute('data-sec-id') === secId);
    });
  }
}

function _buildPrdTableOfContents(viewerEl){
  const outlineList = $('studioPrdOutlineList');
  const outlineCount = $('prdOutlineCount');
  const outline = $('studioPrdOutline');
  const btn = $('btnTogglePrdOutline');
  if(!outlineList || !viewerEl) return;

  const isCollapsed = localStorage.getItem('hermes-studio-outline-collapsed') === '1';
  if(outline) outline.classList.toggle('collapsed', isCollapsed);
  if(btn) btn.classList.toggle('active', !isCollapsed);

  const headings = viewerEl.querySelectorAll('h1, h2, h3, h4');
  if(!headings || headings.length === 0){
    outlineList.innerHTML = '<div style="color:var(--muted);font-size:11.5px;padding:12px 8px;text-align:center;">Tidak ada heading</div>';
    if(outlineCount) outlineCount.textContent = '0';
    return;
  }

  if(outlineCount) outlineCount.textContent = headings.length + ' sections';

  let html = '';
  headings.forEach((h, idx) => {
    const secId = 'prd-sec-' + idx;
    h.id = secId;
    const tagName = h.tagName.toLowerCase();
    const level = tagName === 'h1' ? 1 : (tagName === 'h2' ? 2 : (tagName === 'h3' ? 3 : 4));
    const titleText = (h.textContent || '').trim();
    html += '<a class="prd-toc-item toc-level-' + level + '" data-sec-id="' + secId + '" href="javascript:void(0)" onclick="scrollToPrdHeading(\'' + secId + '\')" title="' + titleText.replace(/"/g, '&quot;') + '">' + titleText + '</a>';
  });
  outlineList.innerHTML = html;

  if(viewerEl._tocScrollHandler){
    viewerEl.removeEventListener('scroll', viewerEl._tocScrollHandler);
  }

  viewerEl._tocScrollHandler = () => {
    const viewerRect = viewerEl.getBoundingClientRect();
    let currentActiveId = null;
    headings.forEach(h => {
      const r = h.getBoundingClientRect();
      if(r.top - viewerRect.top <= 120){
        currentActiveId = h.id;
      }
    });
    if(!currentActiveId && headings.length > 0){
      currentActiveId = headings[0].id;
    }
    if(currentActiveId){
      outlineList.querySelectorAll('.prd-toc-item').forEach(item => {
        item.classList.toggle('active', item.getAttribute('data-sec-id') === currentActiveId);
      });
    }
  };
  viewerEl.addEventListener('scroll', viewerEl._tocScrollHandler, { passive: true });
}

function _enhancePrdView(viewerEl){
  if(!viewerEl) return;

  // 1. Wrap tables in responsive card wrappers
  const tables = viewerEl.querySelectorAll('table');
  tables.forEach(tbl => {
    if(!tbl.parentElement.classList.contains('prd-table-wrapper')){
      const wrap = document.createElement('div');
      wrap.className = 'prd-table-wrapper';
      tbl.parentNode.insertBefore(wrap, tbl);
      wrap.appendChild(tbl);
    }
  });

  // 2. Identify column headers and enhance data matrix cells
  tables.forEach(tbl => {
    const ths = Array.from(tbl.querySelectorAll('thead th, tr:first-child th'));
    const fieldColIdx = ths.findIndex(th => /field|nama field|nama kolom|atribut/i.test(th.textContent.trim()));
    const typeColIdx = ths.findIndex(th => /data type|tipe data|tipe/i.test(th.textContent.trim()));

    const rows = tbl.querySelectorAll('tbody tr, tr:not(:first-child)');
    rows.forEach(tr => {
      const tds = tr.querySelectorAll('td');
      tds.forEach((td, colIdx) => {
        const text = (td.textContent || '').trim();
        const lower = text.toLowerCase();

        // Constraint / Requirement badges
        if(lower === 'mandatory' || lower === 'wajib' || lower === 'required'){
          td.innerHTML = '<span class="prd-badge prd-badge-mandatory">Mandatory</span>';
          return;
        }
        if(lower === 'optional' || lower === 'opsional'){
          td.innerHTML = '<span class="prd-badge prd-badge-optional">Optional</span>';
          return;
        }
        if(lower === 'system generated' || lower === 'system' || lower === 'auto'){
          td.innerHTML = '<span class="prd-badge prd-badge-system">System Generated</span>';
          return;
        }
        if(lower === 'pk' || lower === 'primary key'){
          td.innerHTML = '<span class="prd-badge prd-badge-pk">PK</span>';
          return;
        }
        if(lower === 'fk' || lower === 'foreign key'){
          td.innerHTML = '<span class="prd-badge prd-badge-fk">FK</span>';
          return;
        }

        // SQL / Data Types
        if(colIdx === typeColIdx || /^(varchar(\(\d+\))?|char(\(\d+\))?|text|int|integer|bigint|smallint|decimal(\(\d+,\s*\d+\))?|numeric|boolean|date|datetime|timestamp|time|uuid|json|jsonb|serial|float|double)$/i.test(text)){
          td.innerHTML = '<code class="prd-datatype">' + text + '</code>';
          return;
        }

        // Field Names in Field column
        if(colIdx === fieldColIdx && fieldColIdx !== -1 && text && !td.querySelector('code') && !td.querySelector('span.prd-badge')){
          td.innerHTML = '<code class="prd-fieldname">' + text + '</code>';
        }
      });
    });
  });
}

window.switchAppMode = switchAppMode;
window.initProductStudio = initProductStudio;
window.loadStudioPrd = loadStudioPrd;
window.loadStudioBpmn = loadStudioBpmn;
window.selectStudioFlowFromTree = selectStudioFlowFromTree;
window.changeStudioFlow = changeStudioFlow;
window.studioFitBpmn = studioFitBpmn;
window.studioExportSvg = studioExportSvg;
window.studioSaveBpmn = studioSaveBpmn;
window.toggleStudioPrdEdit = toggleStudioPrdEdit;
window.saveStudioPrdEdit = saveStudioPrdEdit;
window.exportPrdToPdf = exportPrdToPdf;
window.toggleStudioPrdOutline = toggleStudioPrdOutline;
window.scrollToPrdHeading = scrollToPrdHeading;
window._buildPrdTableOfContents = _buildPrdTableOfContents;
window._enhancePrdView = _enhancePrdView;
window.bpmnSaveDiagram = bpmnSaveDiagram;
window.openStudioDriveFolder = openStudioDriveFolder;
window.openStudioPrdDrive = openStudioPrdDrive;
window.copyStudioPrdMarkdown = copyStudioPrdMarkdown;
window.refreshStudioArtifacts = refreshStudioArtifacts;
window.toggleStudioNav = toggleStudioNav;
window.setStudioLayout = setStudioLayout;
window.toggleStudioPrdDiscussion = toggleStudioPrdDiscussion;
window.closeStudioPrdDiscussion = closeStudioPrdDiscussion;
window.openStudioPrdDiscussionFromHighlight = openStudioPrdDiscussionFromHighlight;
window.submitPrdDiscussion = submitPrdDiscussion;
window.applyPrdRevision = applyPrdRevision;
window.jumpToCouncilChatWithContext = jumpToCouncilChatWithContext;

function insertCouncilRole(tag){
  const textarea = document.getElementById('msg');
  if(!textarea) return;
  const current = textarea.value || '';
  if(current.startsWith(tag + ' ')){
    textarea.focus();
    return;
  }
  const roleRe = /^@(?:lead|diamond|scope|kontrak|tech|backend|ops|bisnis|qa|test|ux|design|klien|client|polaris|vega|arcturus|sirius|rigel|fitgap|standard|orm|clean)\s*/i;
  if(roleRe.test(current)){
    textarea.value = current.replace(roleRe, tag + ' ');
  } else {
    textarea.value = tag + ' ' + current;
  }
  textarea.focus();
  if(typeof autoResizeComposer === 'function') autoResizeComposer();
}
window.insertCouncilRole = insertCouncilRole;

/* ==========================================================================
   Markdown Floating Table of Contents (TOC) Engine
   ========================================================================== */
let _tocCollapsed = false;

function _buildMarkdownToc(targetEl){
  const existingToc = document.getElementById('previewMdFloatingToc');
  if(existingToc) existingToc.remove();

  if(!targetEl) return;
  const headings = targetEl.querySelectorAll('h1, h2, h3, h4');
  if(headings.length < 2) return;

  const tocWrap = document.createElement('div');
  tocWrap.id = 'previewMdFloatingToc';
  tocWrap.className = 'preview-toc-floating' + (_tocCollapsed ? ' collapsed' : '');

  // Header
  const header = document.createElement('div');
  header.className = 'preview-toc-header';
  header.title = 'Click to toggle Table of Contents';
  header.innerHTML = `
    <span class="preview-toc-title"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg> Outline (${headings.length})</span>
    <span class="preview-toc-toggle" style="font-size:10px;opacity:0.7">${_tocCollapsed ? '▶' : '▼'}</span>
  `;

  // Body
  const body = document.createElement('div');
  body.className = 'preview-toc-body';

  const headingElements = [];

  headings.forEach((h, idx) => {
    if(!h.id){
      const slug = h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      h.id = slug || ('toc-h-' + idx);
    }
    headingElements.push(h);

    const a = document.createElement('a');
    a.className = 'preview-toc-item level-' + h.tagName.toLowerCase();
    a.href = '#' + h.id;
    a.textContent = h.textContent.trim();
    a.title = h.textContent.trim();
    a.addEventListener('click', (e) => {
      e.preventDefault();
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      body.querySelectorAll('.preview-toc-item').forEach(item => item.classList.remove('active'));
      a.classList.add('active');
    });
    body.appendChild(a);
  });

  header.addEventListener('click', () => {
    _tocCollapsed = !_tocCollapsed;
    tocWrap.classList.toggle('collapsed', _tocCollapsed);
    const toggleIcon = header.querySelector('.preview-toc-toggle');
    if(toggleIcon) toggleIcon.textContent = _tocCollapsed ? '▶' : '▼';
  });

  tocWrap.appendChild(header);
  tocWrap.appendChild(body);

  const previewArea = $('previewArea');
  if(previewArea && targetEl === $('previewMd')){
    previewArea.appendChild(tocWrap);
  } else if(targetEl.parentNode){
    targetEl.parentNode.insertBefore(tocWrap, targetEl);
  }

  // Active heading spy on scroll
  const scrollContainer = targetEl;
  if(scrollContainer && headingElements.length > 0){
    const onScroll = () => {
      let activeIndex = 0;
      const topOffset = scrollContainer.scrollTop + 40;
      for(let i = 0; i < headingElements.length; i++){
        if(headingElements[i].offsetTop <= topOffset){
          activeIndex = i;
        } else {
          break;
        }
      }
      const links = body.querySelectorAll('.preview-toc-item');
      links.forEach((l, i) => {
        if(i === activeIndex) l.classList.add('active');
        else l.classList.remove('active');
      });
    };
    if(targetEl._tocScrollHandler){
      scrollContainer.removeEventListener('scroll', targetEl._tocScrollHandler);
    }
    targetEl._tocScrollHandler = onScroll;
    scrollContainer.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
}
window._buildMarkdownToc = _buildMarkdownToc;

/* ==========================================================================
   AlurKerja BPMN Compliance Audit & PostgreSQL DDL Generator
   ========================================================================== */
let _currentAlurkerjaDdl = '';

function _toSnakeCase(str){
  return (str || '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/(^_|_$)/g, '');
}

async function bpmnAuditAlurkerja(){
  let xml = _previewRawContent || '';
  if(!xml && _bpmnViewerInstance){
    try {
      const res = await _bpmnViewerInstance.saveXML({ format: true });
      xml = res.xml;
    } catch(e){}
  }
  if(!xml){
    if(typeof showToast==='function') showToast('No BPMN XML content found to audit.', 3000, 'warning');
    return;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');
  if(doc.querySelector('parsererror')){
    if(typeof showToast==='function') showToast('Invalid BPMN XML syntax.', 3000, 'error');
    return;
  }

  const checks = [];
  let passCount = 0;

  // 1. Participant / Pool Check
  const participants = Array.from(doc.querySelectorAll('participant, bpmn\\:participant'));
  if(participants.length === 0){
    checks.push({
      rule: '1. Participant / Pool',
      status: 'warn',
      title: 'Pool Participant Tidak Ditemukan',
      detail: 'Diagram tidak memiliki Pool terdefinisi. Standar Javan AlurKerja mewajibkan Pool Participant mewakili organisasi (misal: "PT Javan Cipta Solusi").'
    });
  } else {
    let poolPassed = true;
    let poolMessages = [];
    participants.forEach(p => {
      const name = (p.getAttribute('name') || '').trim();
      if(!name){
        poolPassed = false;
        poolMessages.push(`Pool ID "${p.getAttribute('id')}" tidak memiliki nama.`);
      } else if(/\b(alur|proses|flow|workflow)\b/i.test(name)){
        poolPassed = false;
        poolMessages.push(`Nama Pool "${name}" mengandung kata alur/proses. Standar Javan: Pool wajib nama Organisasi/Peserta (contoh: "PT Javan Cipta Solusi"), bukan nama proses.`);
      }
    });
    if(poolPassed){
      passCount++;
      checks.push({
        rule: '1. Participant / Pool',
        status: 'pass',
        title: 'Pool Participant Valid',
        detail: `Nama Pool: "${participants[0].getAttribute('name')}" (Representasi Organisasi/Peserta).`
      });
    } else {
      checks.push({
        rule: '1. Participant / Pool',
        status: 'fail',
        title: 'Pelanggaran Penamaan Pool',
        detail: poolMessages.join(' ')
      });
    }
  }

  // 2. Process Definition Key & File Match Check
  const processes = Array.from(doc.querySelectorAll('process, bpmn\\:process'));
  const processEl = processes[0];
  const processId = processEl ? processEl.getAttribute('id') : '';
  const currentFileName = (_previewCurrentPath || '').split('/').pop() || '';
  const expectedFileName = (processId || '') + '.bpmn';

  if(!processId){
    checks.push({
      rule: '2. Process Definition Key',
      status: 'fail',
      title: 'Process Definition Key Kosong',
      detail: 'Elemen <bpmn:process> tidak memiliki atribut ID.'
    });
  } else {
    const isTitleCase = /^[A-Z][a-zA-Z0-9]*$/.test(processId);
    const fileMatches = currentFileName === expectedFileName || currentFileName.toLowerCase() === expectedFileName.toLowerCase();
    if(isTitleCase && fileMatches){
      passCount++;
      checks.push({
        rule: '2. Process Definition Key',
        status: 'pass',
        title: `Process ID "${processId}" Valid (TitleCase)`,
        detail: `Format ID TitleCase dan nama file "${currentFileName}" sesuai Process Definition Key.`
      });
    } else {
      let issues = [];
      if(!isTitleCase) issues.push(`Process ID "${processId}" harus TitleCase (contoh: "LeaveApproval").`);
      if(!fileMatches) issues.push(`Nama file "${currentFileName}" sebaiknya sama dengan Process ID "${expectedFileName}".`);
      checks.push({
        rule: '2. Process Definition Key',
        status: isTitleCase ? 'warn' : 'fail',
        title: 'Process Key / File Naming Perlu Disesuaikan',
        detail: issues.join(' ')
      });
    }
  }

  // 3. Lane IDs Check (UPPERCASE)
  const lanes = Array.from(doc.querySelectorAll('lane, bpmn\\:lane'));
  if(lanes.length === 0){
    checks.push({
      rule: '3. Lane Role & ID',
      status: 'warn',
      title: 'Lane Tidak Didefinisikan',
      detail: 'Diagram tidak memiliki Lane pemisah role. Gunakan Lane untuk mengelompokkan role aktor (ID wajib UPPERCASE).'
    });
  } else {
    let lanePassed = true;
    let badLanes = [];
    lanes.forEach(l => {
      const id = l.getAttribute('id') || '';
      if(!/^[A-Z0-9_]+$/.test(id)){
        lanePassed = false;
        badLanes.push(`ID "${id}" (Nama: "${l.getAttribute('name')||''}")`);
      }
    });
    if(lanePassed){
      passCount++;
      checks.push({
        rule: '3. Lane Role & ID',
        status: 'pass',
        title: `Seluruh Lane ID Valid (${lanes.length} Lanes)`,
        detail: lanes.map(l => l.getAttribute('id')).join(', ') + ' (Format UPPERCASE).'
      });
    } else {
      checks.push({
        rule: '3. Lane Role & ID',
        status: 'fail',
        title: 'Format ID Lane Tidak UPPERCASE',
        detail: `Standar Javan mewajibkan ID Lane berformat UPPERCASE (contoh: DIVISI_HR, SATGAS_PENYELIDIKAN). Pelanggaran: ${badLanes.join(', ')}.`
      });
    }
  }

  // 4. User Tasks & Form Field Metadata Check
  const userTasks = Array.from(doc.querySelectorAll('userTask, bpmn\\:userTask'));
  if(userTasks.length === 0){
    checks.push({
      rule: '4. User Task & Form Fields',
      status: 'warn',
      title: 'Tidak Ada User Task',
      detail: 'Diagram tidak memuat User Task.'
    });
  } else {
    let tasksPassed = true;
    let formMetadataFound = 0;
    let nonCamelTasks = [];
    userTasks.forEach(ut => {
      const id = ut.getAttribute('id') || '';
      if(!/^[a-z][a-zA-Z0-9]*$/.test(id)){
        tasksPassed = false;
        nonCamelTasks.push(id);
      }
      const formFields = ut.querySelectorAll('formField, camunda\\:formField');
      if(formFields.length > 0) formMetadataFound++;
    });

    if(tasksPassed && formMetadataFound > 0){
      passCount++;
      checks.push({
        rule: '4. User Task & Form Fields',
        status: 'pass',
        title: `User Task (${userTasks.length}) & Form Fields Lengkap`,
        detail: `Seluruh task ID camelCase dan memiliki metadata form fields (<camunda:formField>) untuk generate form AlurKerja.`
      });
    } else if(tasksPassed && formMetadataFound === 0){
      checks.push({
        rule: '4. User Task & Form Fields',
        status: 'warn',
        title: `Task ID camelCase, Namun Form Fields Kosong (${userTasks.length} Task)`,
        detail: 'Task definition key sudah camelCase, namun belum memiliki <camunda:formData> dan <camunda:formField>. Tambahkan field agar dapat digenerate form dan disimulasikan di Camunda.'
      });
    } else {
      checks.push({
        rule: '4. User Task & Form Fields',
        status: 'fail',
        title: 'Task ID Bukan camelCase',
        detail: `Standar AlurKerja mewajibkan taskDefinitionKey berformat camelCase (contoh: reviewCuti, headApproval). Pelanggaran: ${nonCamelTasks.join(', ')}.`
      });
    }
  }

  // 5. Gateways & Decision Condition Expression Check
  const gateways = Array.from(doc.querySelectorAll('exclusiveGateway, bpmn\\:exclusiveGateway, inclusiveGateway, bpmn\\:inclusiveGateway'));
  const sequenceFlows = Array.from(doc.querySelectorAll('sequenceFlow, bpmn\\:sequenceFlow'));
  let gwPassed = true;
  let gwIssues = [];

  gateways.forEach(gw => {
    const outgoing = Array.from(gw.querySelectorAll('outgoing, bpmn\\:outgoing'));
    const name = (gw.getAttribute('name') || '').trim();
    if(outgoing.length > 1){
      if(!name.endsWith('?')){
        gwPassed = false;
        gwIssues.push(`Gateway "${gw.getAttribute('id')}" keluar cabang tapi namanya tidak berakhir tanda tanya ("?").`);
      }
    }
  });

  let validDecisions = 0;
  let booleanExpressions = 0;
  sequenceFlows.forEach(sf => {
    const expr = (sf.textContent || '').trim();
    if(expr.includes('${') && expr.includes('}')){
      if(/\b(true|false)\b/i.test(expr)){
        booleanExpressions++;
      } else if(/\$\{[a-zA-Z0-9_\-]+\s*==\s*"[^"]+"\}/.test(expr)){
        validDecisions++;
      }
    }
  });

  if(booleanExpressions > 0){
    gwPassed = false;
    gwIssues.push(`Ditemukan ${booleanExpressions} condition expression menggunakan boolean. Standar Javan: Wajib menggunakan string kebab-case, contoh: \${approval-admin=="terima"}.`);
  }

  if(gwPassed && (gateways.length === 0 || validDecisions > 0)){
    passCount++;
    checks.push({
      rule: '5. Gateway & Decision Expressions',
      status: 'pass',
      title: 'Gateway & Decision Condition Sesuai Standar',
      detail: `Pertanyaan interogatif pada diverging gateway terkonfirmasi dan condition expression menggunakan format string context.`
    });
  } else {
    checks.push({
      rule: '5. Gateway & Decision Expressions',
      status: gwIssues.length > 0 ? 'warn' : 'pass',
      title: gwIssues.length > 0 ? 'Catatan Gateway / Decision' : 'Gateway Valid',
      detail: gwIssues.length > 0 ? gwIssues.join(' ') : 'Gateway valid.'
    });
    if(gwIssues.length === 0) passCount++;
  }

  // 6. Database DDL Generator for AlurKerja
  const processTableName = _toSnakeCase(processId || 'process_instance');
  let ddl = `-- ==========================================================\n`;
  ddl += `-- ALURKERJA POSTGRESQL DDL (PT Javan Cipta Solusi)\n`;
  ddl += `-- Generated from: ${currentFileName || 'Process'}\n`;
  ddl += `-- Simulation on: merapi.javan.id:55432 / Nocode Apps\n`;
  ddl += `-- ==========================================================\n\n`;

  ddl += `-- 1. Process Instance Table (1 BPMN = 1 Tabel Utama)\n`;
  ddl += `CREATE TABLE IF NOT EXISTS ${processTableName} (\n`;
  ddl += `    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n`;
  ddl += `    process_instance_id VARCHAR(255) NOT NULL,\n`;

  const startEvent = doc.querySelector('startEvent, bpmn\\:startEvent');
  if(startEvent){
    const startFields = Array.from(startEvent.querySelectorAll('formField, camunda\\:formField'));
    startFields.forEach(f => {
      const fid = _toSnakeCase(f.getAttribute('id') || 'field');
      const ftype = (f.getAttribute('type') || '').toLowerCase();
      const colType = ftype === 'date' ? 'DATE' : (ftype === 'long' || ftype === 'integer') ? 'BIGINT' : 'VARCHAR(255)';
      ddl += `    ${fid} ${colType},\n`;
    });
  }

  ddl += `    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n`;
  ddl += `    created_by UUID,\n`;
  ddl += `    updated_at TIMESTAMP,\n`;
  ddl += `    updated_by UUID,\n`;
  ddl += `    deleted_by UUID\n`;
  ddl += `);\n\n`;

  // 2. User Task Tables
  ddl += `-- 2. User Task Tables (1 User Task = 1 Tabel Tersendiri)\n`;
  userTasks.forEach((ut, idx) => {
    const utId = ut.getAttribute('id') || `task_${idx+1}`;
    const utTable = `${processTableName}_${_toSnakeCase(utId)}`;
    ddl += `CREATE TABLE IF NOT EXISTS ${utTable} (\n`;
    ddl += `    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n`;
    ddl += `    business_key UUID NOT NULL REFERENCES ${processTableName}(id) ON DELETE CASCADE,\n`;

    const fields = Array.from(ut.querySelectorAll('formField, camunda\\:formField'));
    fields.forEach(f => {
      const fid = _toSnakeCase(f.getAttribute('id') || 'field');
      const ftype = (f.getAttribute('type') || '').toLowerCase();
      let colType = 'VARCHAR(255)';
      if(ftype === 'date') colType = 'DATE';
      else if(ftype === 'long' || ftype === 'integer') colType = 'BIGINT';
      else if(ftype === 'enum') colType = 'VARCHAR(50)';
      else if(ftype === 'boolean') colType = 'BOOLEAN';
      ddl += `    ${fid} ${colType},\n`;
    });

    ddl += `    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n`;
    ddl += `    created_by UUID,\n`;
    ddl += `    updated_at TIMESTAMP,\n`;
    ddl += `    updated_by UUID,\n`;
    ddl += `    deleted_by UUID\n`;
    ddl += `);\n\n`;
  });

  _currentAlurkerjaDdl = ddl;
  passCount++; // DDL ready

  // Render UI into Modal
  $('alurkerjaPassCount').textContent = passCount;
  $('alurkerjaModalSubtitle').textContent = `Audited from: ${currentFileName} • Process ID: ${processId || '-'}`;

  const rulesContent = $('alurkerjaTabContentRules');
  rulesContent.innerHTML = '';

  checks.forEach(c => {
    const card = document.createElement('div');
    card.className = 'alurkerja-audit-item ' + c.status;
    const icon = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : '❌';
    card.innerHTML = `
      <div class="alurkerja-audit-item-head">
        <span>${icon} ${c.rule}: ${c.title}</span>
        <span style="font-size:10px;text-transform:uppercase;padding:2px 6px;border-radius:4px;background:var(--hover-bg);">${c.status}</span>
      </div>
      <div class="alurkerja-audit-item-detail">${c.detail}</div>
    `;
    rulesContent.appendChild(card);
  });

  $('alurkerjaSqlCode').textContent = ddl;
  switchAlurkerjaTab('rules');
  $('alurkerjaAuditModal').style.display = 'flex';
}

function closeAlurkerjaAuditModal(){
  const modal = $('alurkerjaAuditModal');
  if(modal) modal.style.display = 'none';
}

function switchAlurkerjaTab(tab){
  const btnRules = $('btnTabAuditRules');
  const btnDdl = $('btnTabAuditDdl');
  const paneRules = $('alurkerjaTabContentRules');
  const paneDdl = $('alurkerjaTabContentDdl');

  if(tab === 'rules'){
    if(btnRules) btnRules.classList.add('active');
    if(btnDdl) btnDdl.classList.remove('active');
    if(paneRules) paneRules.style.display = 'block';
    if(paneDdl) paneDdl.style.display = 'none';
  } else {
    if(btnRules) btnRules.classList.remove('active');
    if(btnDdl) btnDdl.classList.add('active');
    if(paneRules) paneRules.style.display = 'none';
    if(paneDdl) paneDdl.style.display = 'block';
  }
}

async function copyAlurkerjaDdl(){
  if(!_currentAlurkerjaDdl) return;
  try {
    await navigator.clipboard.writeText(_currentAlurkerjaDdl);
    if(typeof showToast==='function') showToast('PostgreSQL DDL copied to clipboard! 📋');
  } catch(e){
    if(typeof showToast==='function') showToast('Failed to copy DDL', 3000, 'error');
  }
}

window.bpmnAuditAlurkerja = bpmnAuditAlurkerja;
window.closeAlurkerjaAuditModal = closeAlurkerjaAuditModal;
window.switchAlurkerjaTab = switchAlurkerjaTab;
window.copyAlurkerjaDdl = copyAlurkerjaDdl;
window.openPreviewInGoogleDrive = openPreviewInGoogleDrive;
window.copyDriveLink = copyDriveLink;



