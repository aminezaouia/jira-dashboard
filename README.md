# Jira Dashboard

A full-stack developer dashboard built on [LumenJS](https://github.com/Nuralyio/lumenjs) that pulls your assigned Jira tickets and lets you branch, solve, and ship — without leaving your terminal workflow.

---

## What it does

- **Fetches your Jira tickets** — assigned to you, ordered by last updated
- **Auto-detects git branches** — scans your local repo and matches feature branches to tickets by ID (`SWBD-*`, `NBDOC-*`, `BDM-*`, etc.)
- **Version targeting** — picks up `version/bdu/*` and `version/legacy/*` branches from your repo so you can select which version to fix and which ones need backporting
- **Solve with Claude AI** — sends the ticket description + repo context to `claude-opus-4-6`, which generates a complete solution, creates a branch from the selected version, writes files, and commits — no push
- **Cost estimate** — shows estimated token count and USD cost before you hit Solve
- **Session cookie auth** — works even when your org enforces SSO (API tokens blocked); paste your `cloud.session.token` once, it's saved locally and reused on restart
- **Done tickets** — link directly to GitLab/GitHub MR search filtered by ticket key

---

## Stack

| Layer | Tech |
|---|---|
| Framework | [LumenJS](https://github.com/Nuralyio/lumenjs) |
| UI Components | [Lit](https://lit.dev) web components |
| AI | [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) — `claude-opus-4-6` |
| Auth | Jira session cookie (SSO-safe) |
| Build | Vite (via LumenJS) |

---

## Screen Shots

Home page: 

<img width="1083" height="564" alt="image" src="https://github.com/user-attachments/assets/6b74bda8-40a8-4eaa-824d-772fb670892d" />

"Salve with Claude" window:

![Capture d&#39;écran 2026-04-09 111153(2)](https://github.com/user-attachments/assets/5a3bc902-5ed3-4e80-9b5f-8ceef0136842)

## Setup

```bash
git clone https://github.com/aminezaouia/jira-dashboard
cd jira-dashboard
npm install
cp .env.example .env
```

Fill in `.env`:

```env
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=your_jira_api_token

ANTHROPIC_API_KEY=sk-ant-...

GITHUB_REPO_URL=https://github.com/org/repo   # optional — for branch/MR links
REPO_PATH=C:/path/to/your/local/repo          # optional — auto-fills repo path bar
```

```bash
npm run dev
# → http://localhost:3000
```

> **SSO / managed account?** If your org blocks API token auth, the dashboard shows a cookie banner. Open your Jira in the browser, go to DevTools → Application → Cookies, copy `cloud.session.token`, paste it in — done. It's saved to `session.local` (gitignored) and loaded automatically on every restart.

---

## Project structure

```
api/
  jira.ts        # GET  — fetch assigned tickets
  branches.ts    # POST — list local branches + version branches
  branch.ts      # POST — create a feature branch
  solve.ts       # POST — Claude AI solver (branch + write + commit)
  session.ts     # POST — save/clear Jira session cookie
  config.ts      # GET  — expose non-sensitive env config to frontend

pages/
  index.ts       # The entire dashboard UI — one Lit web component
```

---

## A note on LumenJS

Big thanks to [@Nuralyio](https://github.com/Nuralyio) for building [LumenJS](https://github.com/Nuralyio/lumenjs).

The thing that genuinely impressed us: **file-based routing with zero config, backed by Lit web components and Vite**. Drop a class in `pages/foo.ts`, export it — that's your route. No router setup, no framework adapter, no boilerplate. The API routes follow the same philosophy: `export async function GET()`, return a plain object, done. Frontend and backend share the same port and dev server, so there's no CORS config, no proxy, no separate Express process to manage.

For a full-stack tool that needed to move fast, that combination was exactly right.

---

## Caveats

- Branch creation and commits are **local only** — nothing is pushed automatically
- The AI solver uses `claude-opus-4-6` which costs real money — check the estimate shown before running
- Session cookies expire (typically weeks) — the dashboard will prompt you when it does

---

## License

MIT
