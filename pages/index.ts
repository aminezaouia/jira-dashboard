import { LitElement, html, css } from 'lit';

// No server-side loader — data is fetched client-side via /api/jira
// This avoids Windows path-normalization issues with the LumenJS loader transform.

export class PageIndex extends LitElement {
  static properties = {
    tickets:         { type: Array },
    error:           { type: String },
    configured:      { type: Boolean },
    loading:         { type: Boolean },
    githubRepoUrl:   { type: String },
    showModal:       { type: Boolean },
    selectedTicket:  { type: Object },
    repoPath:        { type: String },
    addContext:      { type: String },
    solving:         { type: Boolean },
    solveResult:     { type: Object },
    solveError:      { type: String },
    branchResults:       { type: Object },
    filterStatus:        { type: String },
    searchQuery:         { type: String },
    refreshing:          { type: Boolean },
    needsCookie:         { type: Boolean },
    cookieInput:         { type: String },
    savingCookie:        { type: Boolean },
    cookieSaved:         { type: Boolean },
    autoLoadingBranches: { type: Boolean },
    branchStatus:        { type: String },
    versions:            { type: Array },
    selectedVersions:    { type: Array },
  };

  tickets        = [];
  error          = null;
  configured     = false;
  loading        = true;
  githubRepoUrl  = '';
  showModal      = false;
  selectedTicket = null;
  repoPath       = '';
  addContext     = '';
  solving        = false;
  solveResult    = null;
  solveError     = null;
  branchResults       = {};
  filterStatus        = 'all';
  searchQuery         = '';
  refreshing          = false;
  needsCookie         = false;
  cookieInput         = '';
  savingCookie        = false;
  cookieSaved         = false;
  autoLoadingBranches = false;
  branchStatus        = '';
  versions            = [];   // all version branches from repo
  selectedVersions    = [];   // chosen target versions for solve/branch

  connectedCallback() {
    super.connectedCallback();
    const saved = localStorage.getItem('jira_dash_repo_path');
    if (saved) this.repoPath = saved.replace(/\\/g, '/');
    Promise.all([this._loadConfig(), this._loadTickets()]).then(() => {
      if (this.repoPath) this._loadBranches();
    });
  }

  // ------------------------------------------------------------------
  // Computed
  // ------------------------------------------------------------------

  get _filtered() {
    return this.tickets.filter((t) => {
      if (this.filterStatus !== 'all' && t.statusCategory !== this.filterStatus) return false;
      if (this.searchQuery) {
        const q = this.searchQuery.toLowerCase();
        return t.key.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q);
      }
      return true;
    });
  }

  get _counts() {
    const c = { all: this.tickets.length };
    for (const t of this.tickets) {
      c[t.statusCategory] = (c[t.statusCategory] || 0) + 1;
    }
    return c;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  _sc(cat) {
    return { done: '#22c55e', indeterminate: '#3b82f6', new: '#64748b' }[cat] || '#64748b';
  }

  _pc(p) {
    const v = (p || '').toLowerCase();
    if (v === 'highest' || v === 'critical') return '#ef4444';
    if (v === 'high') return '#f97316';
    if (v === 'medium') return '#eab308';
    if (v === 'low') return '#3b82f6';
    return '#64748b';
  }

  _pa(p) {
    const v = (p || '').toLowerCase();
    if (v === 'highest' || v === 'critical') return '\u25b2\u25b2';
    if (v === 'high') return '\u25b2';
    if (v === 'medium') return '\u25b6';
    if (v === 'low') return '\u25bc';
    if (v === 'lowest') return '\u25bc\u25bc';
    return '\u2022';
  }

  _saveRepo(val) {
    const normalized = (val || '').replace(/\\/g, '/');
    this.repoPath = normalized;
    localStorage.setItem('jira_dash_repo_path', normalized);
    if (normalized) this._loadBranches();
  }

  // Rough token/cost estimate for claude-opus-4-6 ($15/M input, $75/M output)
  _estimateCost(ticket) {
    const inputTokens = Math.ceil(
      350 + // system prompt
      200 + // user prompt template
      (ticket.summary || '').length / 4 +
      (ticket.description || '').length / 4 +
      1500  // repo context (capped 6000 chars)
    );
    const outputTokens = 3000;
    const usd = (inputTokens * 15 + outputTokens * 75) / 1_000_000;
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, usd };
  }

  // Find an existing git branch for a ticket by searching all IDs in the key + summary
  _findBranchForTicket(ticket, branches) {
    const ids = [ticket.key, ...((ticket.summary || '').match(/[A-Z]+-\d+/g) || [])];
    for (const id of ids) {
      const lower = id.toLowerCase();
      const found = branches.find(b => b.toLowerCase().includes(lower));
      if (found) return found;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  async _loadConfig() {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      // Only use env default if user hasn't set one in localStorage
      if (data.repoPath && !localStorage.getItem('jira_dash_repo_path')) {
        this.repoPath = data.repoPath.replace(/\\/g, '/');
      }
      if (data.githubRepoUrl) this.githubRepoUrl = data.githubRepoUrl;
    } catch {}
  }

  async _loadBranches() {
    if (!this.repoPath) { this.branchStatus = 'No repo path set'; return; }
    this.autoLoadingBranches = true;
    this.branchStatus = 'Scanning...';
    try {
      const res = await fetch('/api/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath: this.repoPath }),
      });
      const data = await res.json();
      if (data.error) {
        this.branchStatus = `Git error: ${data.error}`;
        this.autoLoadingBranches = false;
        return;
      }
      const branches = data.branches || [];
      const versions  = data.versions  || [];
      this.versions = versions;

      // Default-select the latest version/bdu/* branch if nothing selected yet
      if (this.selectedVersions.length === 0 && versions.length > 0) {
        const latestBdu = versions.find(v => v.startsWith('version/bdu/')) || versions[0];
        this.selectedVersions = [latestBdu];
      }

      this.branchStatus = `${branches.length} feature branches · ${versions.length} versions`;

      const results = { ...this.branchResults };
      for (const ticket of this.tickets) {
        if (results[ticket.key]?.branchName) continue;
        const branch = this._findBranchForTicket(ticket, branches);
        results[ticket.key] = branch ? { branchName: branch, existed: true } : { notFound: true };
      }
      this.branchResults = results;
    } catch (e: any) {
      this.branchStatus = `Error: ${e.message}`;
    }
    this.autoLoadingBranches = false;
  }

  async _loadTickets() {
    this.loading = true;
    try {
      const res = await fetch('/api/jira');
      const data = await res.json();
      if (data.error && data.error !== null && !data.configured) {
        this.configured = false;
      } else {
        this.configured = data.configured !== false;
      }
      this.tickets = data.tickets || [];
      this.error = data.error || null;
      this.needsCookie = data.needsCookie === true;
    } catch (e) {
      this.configured = true;
      this.error = 'Could not reach /api/jira: ' + e.message;
    } finally {
      this.loading = false;
    }
  }

  async _refresh() {
    this.refreshing = true;
    this.branchResults = {}; // reset so branches re-detect after reload
    await this._loadTickets();
    if (this.repoPath) await this._loadBranches();
    this.refreshing = false;
  }

  _openSolve(ticket) {
    this.selectedTicket = ticket;
    this.solveResult = null;
    this.solveError = null;
    this.addContext = '';
    this.showModal = true;
  }

  _closeModal() {
    this.showModal = false;
    this.selectedTicket = null;
  }

  async _saveSession() {
    if (!this.cookieInput.trim()) return;
    this.savingCookie = true;
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: this.cookieInput.trim() }),
      });
      const data = await res.json();
      if (data.error) {
        this.error = data.error;
      } else {
        this.cookieSaved = true;
        this.needsCookie = false;
        this.cookieInput = '';
        await this._loadTickets();
      }
    } catch (e) {
      this.error = e.message;
    } finally {
      this.savingCookie = false;
    }
  }

  async _solve() {
    if (!this.selectedTicket || !this.repoPath) return;
    this.solving = true;
    this.solveResult = null;
    this.solveError = null;
    try {
      const res = await fetch('/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket: this.selectedTicket,
          repoPath: this.repoPath,
          additionalContext: this.addContext,
          targetVersions: this.selectedVersions,
          primaryVersion: this.selectedVersions[0] || null,
        }),
      });
      const data = await res.json();
      if (data.error) {
        this.solveError = data.error;
      } else {
        this.solveResult = data;
        if (data.branchName) {
          this.branchResults = { ...this.branchResults, [this.selectedTicket.key]: { branchName: data.branchName, existed: false } };
        }
      }
    } catch (e) {
      this.solveError = e.message;
    } finally {
      this.solving = false;
    }
  }

  // ------------------------------------------------------------------
  // Styles
  // ------------------------------------------------------------------

  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      background: #0f172a;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    /* ---- Header ---- */
    .header {
      background: #1e293b;
      border-bottom: 1px solid #334155;
      padding: .875rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 20;
    }
    .brand { display: flex; align-items: center; gap: .625rem; }
    .logo {
      width: 34px; height: 34px;
      background: linear-gradient(135deg,#6366f1,#8b5cf6);
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 1rem; color: #fff; flex-shrink: 0;
    }
    .brand h1 { font-size: 1rem; font-weight: 600; margin: 0; color: #f8fafc; }
    .brand p  { font-size: .7rem; color: #64748b; margin: 0; }
    .hactions { display: flex; align-items: center; gap: .5rem; }
    .search {
      background: #0f172a; border: 1px solid #334155; border-radius: 8px;
      padding: .375rem .75rem; color: #f1f5f9; font-size: .8125rem;
      outline: none; width: 200px; transition: border-color .15s;
    }
    .search:focus { border-color: #6366f1; }
    .icon-btn {
      background: #0f172a; border: 1px solid #334155; border-radius: 8px;
      color: #94a3b8; cursor: pointer; padding: .375rem .625rem;
      font-size: .875rem; transition: all .15s;
    }
    .icon-btn:hover { border-color: #6366f1; color: #a5b4fc; }

    /* ---- Repo bar ---- */
    .repo-bar {
      background: #162032; border-bottom: 1px solid #1e3349;
      padding: .5rem 1.5rem; display: flex; align-items: center; gap: .75rem;
    }
    .repo-label { font-size: .7rem; color: #475569; white-space: nowrap; }
    .repo-input {
      background: #0f172a; border: 1px solid #1e3349; border-radius: 6px;
      padding: .3rem .625rem; color: #94a3b8;
      font-size: .8rem; font-family: monospace;
      outline: none; flex: 1; max-width: 400px; transition: border-color .15s, color .15s;
    }
    .repo-input:focus { border-color: #6366f1; color: #f1f5f9; }
    .repo-hint { font-size: .65rem; color: #334155; }

    /* ---- Filters ---- */
    .filters {
      background: #1e293b; border-bottom: 1px solid #334155;
      padding: .5rem 1.5rem; display: flex; gap: .375rem; flex-wrap: wrap;
    }
    .fbtn {
      background: transparent; border: 1px solid #334155; border-radius: 6px;
      padding: .25rem .75rem; color: #64748b; font-size: .75rem;
      cursor: pointer; transition: all .15s;
      display: flex; align-items: center; gap: .375rem;
    }
    .fbtn:hover { border-color: #6366f1; color: #a5b4fc; }
    .fbtn.active { background: #6366f1; border-color: #6366f1; color: #fff; }
    .fcount {
      background: rgba(255,255,255,.15); border-radius: 9999px;
      padding: 0 .375rem; font-size: .65rem; line-height: 1.4;
    }

    /* ---- Dashboard ---- */
    .dash { padding: 1.25rem 1.5rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(300px,1fr)); gap: .875rem; }

    /* ---- Card ---- */
    .card {
      background: #1e293b; border: 1px solid #334155; border-radius: 12px;
      padding: 1rem; display: flex; flex-direction: column; gap: .625rem;
      transition: border-color .2s, box-shadow .2s;
    }
    .card:hover { border-color: #4f5e74; box-shadow: 0 4px 20px rgba(0,0,0,.3); }
    .card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: .5rem; }
    .tkey {
      font-family: monospace; font-size: .75rem; font-weight: 600;
      color: #818cf8; text-decoration: none;
    }
    .tkey:hover { color: #a5b4fc; text-decoration: underline; }
    .badges { display: flex; gap: .3rem; flex-wrap: wrap; }
    .badge {
      font-size: .6rem; padding: .15rem .45rem; border-radius: 9999px;
      font-weight: 600; letter-spacing: .02em; white-space: nowrap;
    }
    .title { font-size: .875rem; font-weight: 500; color: #e2e8f0; line-height: 1.45; }
    .desc {
      font-size: .75rem; color: #475569; line-height: 1.5;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .meta { font-size: .7rem; color: #334155; display: flex; align-items: center; gap: .5rem; }
    .branch-ok {
      font-family: monospace; font-size: .7rem; color: #86efac;
      background: #052e16; border: 1px solid #166534;
      border-radius: 6px; padding: .3rem .5rem; word-break: break-all;
    }
    .branch-err {
      font-size: .7rem; color: #fca5a5; background: #1c0a0a;
      border: 1px solid #7f1d1d; border-radius: 6px; padding: .3rem .5rem;
    }

    /* ---- Actions ---- */
    .actions { display: flex; gap: .5rem; margin-top: auto; }
    .btn {
      flex: 1; padding: .45rem .625rem; border-radius: 8px; border: none;
      cursor: pointer; font-size: .75rem; font-weight: 500; transition: all .15s;
      display: flex; align-items: center; justify-content: center;
      gap: .3rem; white-space: nowrap;
    }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .btn-link {
      flex: 0; background: transparent; border: 1px solid #334155; color: #94a3b8;
      padding: .45rem .625rem; border-radius: 8px; cursor: pointer; font-size: .875rem;
    }
    .btn-link:hover { border-color: #f0f6fc; color: #f0f6fc; background: #161b22; }
    .btn-out { background: transparent; border: 1px solid #334155; color: #94a3b8; }
    .btn-out:hover:not(:disabled) { border-color: #60a5fa; color: #60a5fa; background: #0f1f33; }
    .btn-ai { background: linear-gradient(135deg,#6366f1,#8b5cf6); color: #fff; }
    .btn-ai:hover:not(:disabled) { background: linear-gradient(135deg,#4f46e5,#7c3aed); }

    /* ---- Misc ---- */
    .err-banner {
      background: #1c0a0a; border: 1px solid #7f1d1d; border-radius: 8px;
      padding: .75rem 1rem; margin-bottom: 1rem; color: #fca5a5; font-size: .8125rem;
    }
    .empty { text-align: center; padding: 5rem 2rem; color: #334155; }
    .empty-icon { font-size: 2.5rem; margin-bottom: .75rem; }
    .spin { display: inline-block; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ---- Setup screen ---- */
    .setup-wrap { display: flex; align-items: center; justify-content: center; min-height: 80vh; padding: 2rem; }
    .setup-card {
      background: #1e293b; border: 1px solid #334155; border-radius: 16px;
      padding: 2rem; max-width: 520px; width: 100%;
    }
    .setup-card h2 { color: #f8fafc; margin: 0 0 .5rem; font-size: 1.25rem; }
    .setup-card p  { color: #94a3b8; font-size: .875rem; line-height: 1.6; margin: 0 0 1rem; }
    .env-block {
      background: #0f172a; border: 1px solid #334155; border-radius: 8px;
      padding: 1rem; font-family: monospace; font-size: .8rem;
      color: #86efac; white-space: pre; overflow-x: auto;
    }

    /* ---- Loading ---- */
    .loading-wrap { display: flex; align-items: center; justify-content: center; min-height: 60vh; }
    .loading-text { color: #475569; font-size: .9rem; }

    /* ---- Modal ---- */
    .overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,.75);
      backdrop-filter: blur(4px); z-index: 50;
      display: flex; align-items: center; justify-content: center; padding: 1rem;
    }
    .modal {
      background: #1e293b; border: 1px solid #334155; border-radius: 16px;
      width: 100%; max-width: 560px; max-height: 90vh; overflow-y: auto; padding: 1.5rem;
    }
    .modal-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1.25rem; }
    .modal-title { font-size: 1.0625rem; font-weight: 600; color: #f8fafc; margin: 0; }
    .modal-sub   { font-size: .75rem; color: #64748b; margin: .2rem 0 0; }
    .close-btn {
      background: transparent; border: none; color: #64748b;
      font-size: 1.1rem; cursor: pointer; padding: .25rem .375rem;
      border-radius: 6px; line-height: 1;
    }
    .close-btn:hover { background: #334155; color: #f1f5f9; }
    .tbox {
      background: #0f172a; border: 1px solid #334155; border-radius: 10px;
      padding: .875rem; margin-bottom: 1rem;
    }
    .tbox-key {
      font-family: monospace; font-size: .7rem; color: #818cf8;
      margin-bottom: .3rem; display: flex; align-items: center; gap: .5rem;
    }
    .tbox-title { font-size: .875rem; font-weight: 500; color: #e2e8f0; }
    .tbox-desc  {
      font-size: .75rem; color: #475569; margin-top: .375rem; line-height: 1.5;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
    }
    .flabel { display: block; font-size: .75rem; font-weight: 500; color: #94a3b8; margin-bottom: .3rem; }
    .fgroup { margin-bottom: .875rem; }
    .finput, .ftextarea {
      width: 100%; background: #0f172a; border: 1px solid #334155; border-radius: 8px;
      padding: .5rem .75rem; color: #f1f5f9; font-size: .8125rem;
      outline: none; box-sizing: border-box; font-family: inherit; transition: border-color .15s;
    }
    .finput:focus, .ftextarea:focus { border-color: #6366f1; }
    .ftextarea { resize: vertical; min-height: 80px; }
    .btn-full {
      width: 100%; padding: .625rem; border-radius: 10px; border: none; cursor: pointer;
      font-size: .875rem; font-weight: 600;
      background: linear-gradient(135deg,#6366f1,#8b5cf6); color: #fff;
      transition: opacity .15s; display: flex; align-items: center; justify-content: center; gap: .375rem;
    }
    .btn-full:hover:not(:disabled) { opacity: .9; }
    .btn-full:disabled { opacity: .5; cursor: not-allowed; }
    .sol-box {
      background: #052e16; border: 1px solid #166534; border-radius: 10px;
      padding: 1rem; margin-top: 1rem;
    }
    .sol-box h4 { color: #86efac; font-size: .875rem; margin: 0 0 .75rem; }
    .sol-branch {
      font-family: monospace; font-size: .8rem; color: #86efac;
      background: #042b0f; padding: .375rem .625rem;
      border-radius: 6px; margin-bottom: .625rem; word-break: break-all;
    }
    .sol-sum  { font-size: .8125rem; color: #bbf7d0; line-height: 1.55; margin-bottom: .75rem; }
    .sol-fl   { font-size: .7rem; color: #4ade80; margin-bottom: .25rem; }
    .sol-list { list-style: disc; margin: 0; padding-left: 1.25rem; }
    .sol-list li { font-family: monospace; font-size: .7rem; color: #86efac; margin-bottom: .125rem; }
    .sol-msg  { font-size: .7rem; color: #4ade80; margin-top: .5rem; font-style: italic; }
    .err-box  {
      background: #1c0a0a; border: 1px solid #7f1d1d; border-radius: 10px;
      padding: .875rem; margin-top: 1rem; color: #fca5a5; font-size: .8125rem; line-height: 1.5;
    }
    .cost-hint {
      font-size: .7rem; color: #475569; margin-bottom: .5rem; text-align: center;
    }
    .cost-hint strong { color: #94a3b8; }

    /* ---- Version checkboxes in modal ---- */
    .ver-checks {
      display: flex; flex-wrap: wrap; gap: .375rem; margin-top: .25rem;
    }
    .ver-check {
      display: flex; align-items: center; gap: .3rem;
      border: 1px solid #334155; border-radius: 6px;
      padding: .25rem .6rem; cursor: pointer; font-size: .75rem;
      color: #64748b; transition: all .15s; font-family: monospace;
    }
    .ver-check input { accent-color: #6366f1; cursor: pointer; }
    .ver-check-on { border-color: #6366f1; color: #c7d2fe; background: #1e1b4b; }
    .ver-primary { font-size: .7rem; color: #475569; margin-top: .375rem; }
    .ver-primary strong { color: #a5b4fc; font-family: monospace; }

    /* ---- Version bar ---- */
    .version-bar {
      background: #111827; border-bottom: 1px solid #1e2d45;
      padding: .4rem 1.5rem; display: flex; align-items: center; gap: .375rem; flex-wrap: wrap;
    }
    .vgroup-label { font-size: .65rem; color: #334155; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
    .vgroup-sep   { color: #1e3349; font-size: .875rem; margin: 0 .125rem; }
    .vchip {
      background: transparent; border: 1px solid #1e3349; border-radius: 5px;
      color: #475569; font-size: .7rem; padding: .15rem .5rem;
      cursor: pointer; transition: all .15s; white-space: nowrap; font-family: monospace;
    }
    .vchip:hover  { border-color: #6366f1; color: #a5b4fc; }
    .vchip-on     { background: #312e81; border-color: #6366f1; color: #c7d2fe; }

    /* ---- Cookie banner ---- */
    .cookie-banner {
      background: #1c1700; border: 1px solid #854d0e; border-radius: 10px;
      padding: 1rem 1.25rem; margin-bottom: 1rem;
    }
    .cookie-banner h3 { color: #fbbf24; margin: 0 0 .4rem; font-size: .9rem; }
    .cookie-banner p  { color: #92400e; font-size: .8rem; margin: 0 0 .75rem; line-height: 1.5; }
    .cookie-row { display: flex; gap: .5rem; align-items: flex-start; }
    .cookie-input {
      flex: 1; background: #0f172a; border: 1px solid #854d0e; border-radius: 8px;
      padding: .5rem .75rem; color: #f1f5f9; font-size: .75rem; font-family: monospace;
      outline: none; resize: vertical; min-height: 60px; transition: border-color .15s;
    }
    .cookie-input:focus { border-color: #f59e0b; }
    .cookie-save {
      background: #b45309; border: none; border-radius: 8px; color: #fff;
      padding: .5rem 1rem; cursor: pointer; font-size: .8rem; font-weight: 600;
      white-space: nowrap; transition: background .15s;
    }
    .cookie-save:hover:not(:disabled) { background: #d97706; }
    .cookie-save:disabled { opacity: .5; cursor: not-allowed; }
    .cookie-steps {
      margin: .5rem 0 0; padding-left: 1.25rem; font-size: .75rem; color: #78350f;
    }
    .cookie-steps li { margin-bottom: .2rem; }
  `;

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  render() {
    if (this.loading) {
      return html`
        <div class="loading-wrap">
          <span class="loading-text"><span class="spin">&#x27f3;</span> Loading tickets...</span>
        </div>
      `;
    }

    if (!this.configured) {
      return html`
        <div class="setup-wrap">
          <div class="setup-card">
            <h2>Setup Required</h2>
            <p>
              Copy <strong>.env.example</strong> to <strong>.env</strong> in the project root,
              fill in your credentials, then restart the dev server.
            </p>
            <div class="env-block">JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=your_jira_api_token

ANTHROPIC_API_KEY=sk-ant-...

# Optional — enables GitHub branch links on cards
GITHUB_REPO_URL=https://github.com/org/repo</div>
            <p style="margin-top:1rem;font-size:.8rem">
              Get your Jira API token at
              <strong>id.atlassian.com/manage-profile/security/api-tokens</strong>
            </p>
          </div>
        </div>
      `;
    }

    return html`
      ${this._renderHeader()}
      ${this._renderRepoBar()}
      ${this._renderVersionBar()}
      ${this._renderFilters()}
      <div class="dash">
        ${this.error && !this.needsCookie ? html`<div class="err-banner">&#x26a0; ${this.error}</div>` : ''}
        ${this.needsCookie ? this._cookieBanner() : ''}
        ${this._filtered.length
          ? html`<div class="grid">${this._filtered.map(t => this._card(t))}</div>`
          : !this.needsCookie ? html`<div class="empty"><div class="empty-icon">&#x1f4cb;</div><div>No tickets match</div></div>` : ''}
      </div>
      ${this.showModal ? this._modal() : ''}
    `;
  }

  _renderHeader() {
    return html`
      <div class="header">
        <div class="brand">
          <div class="logo">J</div>
          <div>
            <h1>Jira Dashboard</h1>
            <p>${this._filtered.length} of ${this.tickets.length} tickets</p>
          </div>
        </div>
        <div class="hactions">
          <input class="search" type="text" placeholder="Search tickets..."
            .value=${this.searchQuery}
            @input=${e => this.searchQuery = e.target.value}
          />
          <button class="icon-btn" @click=${this._refresh} title="Refresh">
            <span class=${this.refreshing ? 'spin' : ''}>&#x21bb;</span>
          </button>
        </div>
      </div>
    `;
  }

  _renderRepoBar() {
    return html`
      <div class="repo-bar">
        <span class="repo-label">REPO PATH</span>
        <input class="repo-input" type="text"
          placeholder="C:\path\to\local\git\repo"
          .value=${this.repoPath}
          @change=${e => this._saveRepo(e.target.value)}
        />
        <button class="icon-btn" style="flex-shrink:0"
          title="Rescan branches"
          @click=${() => { this.branchResults = {}; this._loadBranches(); }}>
          <span class=${this.autoLoadingBranches ? 'spin' : ''}>⟳</span>
        </button>
        ${this.branchStatus
          ? html`<span class="repo-hint" style="color:${this.branchStatus.startsWith('Git error') || this.branchStatus.startsWith('Error') ? '#f87171' : '#475569'}">${this.branchStatus}</span>`
          : html`<span class="repo-hint">Set path to auto-detect branches</span>`}
      </div>
    `;
  }

  _renderVersionBar() {
    if (!this.versions.length) return html``;
    // Group by type: version/bdu, version/legacy, master/main
    const bdu    = this.versions.filter(v => v.startsWith('version/bdu/'));
    const legacy = this.versions.filter(v => v.startsWith('version/legacy/'));
    const other  = this.versions.filter(v => !v.startsWith('version/'));

    const _toggle = (v) => {
      const sel = this.selectedVersions;
      this.selectedVersions = sel.includes(v) ? sel.filter(s => s !== v) : [...sel, v];
    };

    const _chip = (v) => {
      const active = this.selectedVersions.includes(v);
      const label  = v.replace('version/bdu/', '').replace('version/legacy/', 'legacy/');
      return html`
        <button class="vchip ${active ? 'vchip-on' : ''}"
          @click=${() => _toggle(v)} title=${v}>
          ${label}
        </button>`;
    };

    return html`
      <div class="version-bar">
        <span class="repo-label">TARGET VERSION</span>
        <span class="vgroup-label">BDU</span>
        ${bdu.map(_chip)}
        ${legacy.length ? html`<span class="vgroup-sep">|</span><span class="vgroup-label">Legacy</span>${legacy.map(_chip)}` : ''}
        ${other.map(_chip)}
        <span class="vgroup-sep">·</span>
        <span class="repo-hint" style="font-size:.68rem">
          ${this.selectedVersions.length
            ? `${this.selectedVersions.length} selected — fix targets`
            : 'Select version(s) to target'}
        </span>
      </div>
    `;
  }

  _renderFilters() {
    const tabs = [
      { key: 'all',           label: 'All' },
      { key: 'new',           label: 'To Do' },
      { key: 'indeterminate', label: 'In Progress' },
      { key: 'done',          label: 'Done' },
    ];
    return html`
      <div class="filters">
        ${tabs.map(f => html`
          <button class="fbtn ${this.filterStatus === f.key ? 'active' : ''}"
            @click=${() => this.filterStatus = f.key}>
            ${f.label}
            ${this._counts[f.key] !== undefined
              ? html`<span class="fcount">${this._counts[f.key]}</span>` : ''}
          </button>
        `)}
      </div>
    `;
  }

  _card(t) {
    const br          = this.branchResults[t.key];
    const hasBranch   = !!br?.branchName;
    const notFound    = br?.notFound === true;
    const isDone      = t.statusCategory === 'done';
    const sc          = this._sc(t.statusCategory);
    const pc          = this._pc(t.priority);
    const cost        = this._estimateCost(t);
    // For done tickets: link to GitLab MR search for the ticket key
    // For active tickets with branch: link to branch on GitLab
    const branchLink  = hasBranch && this.githubRepoUrl
      ? `${this.githubRepoUrl}/tree/${br.branchName}`
      : null;
    const mrLink      = isDone && this.githubRepoUrl
      ? `${this.githubRepoUrl}/-/merge_requests?scope=all&search=${t.key}`
      : null;

    return html`
      <div class="card">
        <div class="card-top">
          <a class="tkey" href=${t.url} target="_blank" rel="noopener">${t.key}</a>
          <div class="badges">
            <span class="badge" style="background:${pc}22;color:${pc};border:1px solid ${pc}55">
              ${this._pa(t.priority)} ${t.priority}
            </span>
            <span class="badge" style="background:${sc}22;color:${sc};border:1px solid ${sc}55">
              ${t.status}
            </span>
          </div>
        </div>
        <div class="title">${t.summary}</div>
        ${t.description ? html`<div class="desc">${t.description}</div>` : ''}
        <div class="meta">
          <span>📋 ${t.type}</span>
          <span>👤 ${t.assignee}</span>
        </div>
        ${hasBranch
          ? html`<div class="branch-ok">⎇ ${br.branchName}</div>`
          : ''}
        <div class="actions">
          <button class="btn btn-link" title="Open in Jira"
            @click=${() => window.open(t.url, '_blank')}>
            🔗
          </button>
          ${isDone
            ? html`<button class="btn btn-out" style="color:#a78bfa;border-color:#a78bfa55"
                title="Search merged MRs for ${t.key}"
                @click=${() => mrLink ? window.open(mrLink, '_blank') : null}
                ?disabled=${!mrLink}>
                ⎇ Merged MR
              </button>`
            : html`<button class="btn btn-out"
                ?disabled=${!hasBranch && !this.autoLoadingBranches}
                title=${this.autoLoadingBranches ? 'Scanning branches...' : hasBranch ? br.branchName : notFound ? 'No matching branch in git' : !this.repoPath ? 'Set repo path first' : 'No branch found'}
                @click=${() => branchLink ? window.open(branchLink, '_blank') : null}>
                ${this.autoLoadingBranches && !br
                  ? html`<span class="spin">⟳</span>`
                  : hasBranch
                    ? html`⎇ View Branch`
                    : html`⎇ No Branch`}
              </button>`}
          <button class="btn btn-ai" @click=${() => this._openSolve(t)}
            title="Estimated cost: ~$${cost.usd.toFixed(2)} (${cost.totalTokens.toLocaleString()} tokens)">
            ✦ Solve ~$${cost.usd.toFixed(2)}
          </button>
        </div>
      </div>
    `;
  }

  _cookieBanner() {
    return html`
      <div class="cookie-banner">
        <h3>&#x1f510; Jira Session Required</h3>
        <p>${this.error || 'Paste your Jira session cookie to connect. It will be saved locally and reused automatically on restart.'}</p>
        <ol class="cookie-steps">
          <li>Open your Jira instance in your browser (log in if needed)</li>
          <li>Open DevTools → Application → Cookies → your Jira domain</li>
          <li>Copy the <strong>cloud.session.token</strong> value</li>
          <li>Paste it below (just the value, no name prefix needed)</li>
        </ol>
        <div class="cookie-row" style="margin-top:.75rem">
          <textarea class="cookie-input"
            placeholder="eyJraWQiOi..."
            .value=${this.cookieInput}
            @input=${e => this.cookieInput = e.target.value}
          ></textarea>
          <button class="cookie-save" ?disabled=${this.savingCookie || !this.cookieInput.trim()}
            @click=${this._saveSession}>
            ${this.savingCookie ? html`<span class="spin">&#x27f3;</span>` : 'Save & Connect'}
          </button>
        </div>
      </div>
    `;
  }

  _modal() {
    const t = this.selectedTicket;
    if (!t) return html``;
    const pc   = this._pc(t.priority);
    const sc   = this._sc(t.statusCategory);
    const cost = this._estimateCost(t);
    return html`
      <div class="overlay" @click=${e => { if (e.target === e.currentTarget) this._closeModal(); }}>
        <div class="modal">
          <div class="modal-head">
            <div>
              <p class="modal-title">&#x2726; Solve with Claude AI</p>
              <p class="modal-sub">Analyzes ticket, writes code, creates branch &amp; commits &mdash; no push</p>
            </div>
            <button class="close-btn" @click=${this._closeModal}>&#x2715;</button>
          </div>

          <div class="tbox">
            <div class="tbox-key">
              <a href=${t.url} target="_blank" style="color:inherit;text-decoration:none">${t.key}</a>
              <span class="badge" style="background:${pc}22;color:${pc};border:1px solid ${pc}55">
                ${this._pa(t.priority)} ${t.priority}
              </span>
              <span class="badge" style="background:${sc}22;color:${sc};border:1px solid ${sc}55">
                ${t.status}
              </span>
            </div>
            <div class="tbox-title">${t.summary}</div>
            ${t.description ? html`<div class="tbox-desc">${t.description}</div>` : ''}
          </div>

          <div class="fgroup">
            <label class="flabel">Git Repository Path *</label>
            <input class="finput" type="text" placeholder="/path/to/repo"
              .value=${this.repoPath}
              @input=${e => this._saveRepo(e.target.value)}
            />
          </div>

          ${this.versions.length ? html`
          <div class="fgroup">
            <label class="flabel">Target Version(s) — branch will be created from primary (first selected)</label>
            <div class="ver-checks">
              ${this.versions.map(v => {
                const label  = v.replace('version/bdu/', 'BDU: ').replace('version/legacy/', 'Legacy: ');
                const active = this.selectedVersions.includes(v);
                return html`
                  <label class="ver-check ${active ? 'ver-check-on' : ''}">
                    <input type="checkbox" ?checked=${active}
                      @change=${() => {
                        const sel = this.selectedVersions;
                        this.selectedVersions = active ? sel.filter(s => s !== v) : [...sel, v];
                      }}
                    />
                    ${label}
                  </label>`;
              })}
            </div>
            ${this.selectedVersions.length
              ? html`<div class="ver-primary">Primary (branch base): <strong>${this.selectedVersions[0]}</strong></div>`
              : html`<div class="ver-primary" style="color:#f87171">Select at least one version</div>`}
          </div>
          ` : ''}

          <div class="fgroup">
            <label class="flabel">Additional Context (optional)</label>
            <textarea class="ftextarea"
              placeholder="Relevant files, constraints, tech stack, acceptance criteria..."
              .value=${this.addContext}
              @input=${e => this.addContext = e.target.value}
            ></textarea>
          </div>

          <div class="cost-hint">
            Estimated cost: <strong>~$${cost.usd.toFixed(2)}</strong>
            &nbsp;·&nbsp; ~${cost.inputTokens.toLocaleString()} input + ${cost.outputTokens.toLocaleString()} output tokens
            &nbsp;·&nbsp; claude-opus-4-6
          </div>

          <button class="btn-full" ?disabled=${this.solving || !this.repoPath} @click=${this._solve}>
            ${this.solving
              ? html`<span class="spin">⟳</span> Claude is thinking...`
              : html`✦ Generate Solution &amp; Commit`}
          </button>

          ${this.solveResult ? html`
            <div class="sol-box">
              <h4>&#x2713; Solution committed &mdash; no push made</h4>
              <div class="sol-branch">&#x2387; ${this.solveResult.branchName}</div>
              <div class="sol-sum">${this.solveResult.summary}</div>
              ${this.solveResult.files?.length ? html`
                <div class="sol-fl">Files written:</div>
                <ul class="sol-list">
                  ${this.solveResult.files.map(f => html`<li>${f}</li>`)}
                </ul>
              ` : ''}
              ${this.solveResult.commitMessage
                ? html`<div class="sol-msg">Commit: "${this.solveResult.commitMessage}"</div>` : ''}
              ${this.solveResult.primaryVersion
                ? html`<div class="sol-msg">Branched from: ${this.solveResult.primaryVersion}</div>` : ''}
              ${this.solveResult.targetVersions?.length > 1
                ? html`<div class="sol-msg">Backport needed for: ${this.solveResult.targetVersions.slice(1).join(', ')}</div>` : ''}
            </div>
          ` : ''}

          ${this.solveError ? html`<div class="err-box">&#x2717; ${this.solveError}</div>` : ''}
        </div>
      </div>
    `;
  }
}

// autoDefinePlugin doesn't run on Windows due to path separator mismatch — register manually.
if (!customElements.get('page-index')) {
  customElements.define('page-index', PageIndex);
}
