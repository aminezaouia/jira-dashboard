// Jira API route — fetches tickets assigned to the authenticated user.
// Supports Basic auth (email + API token) and session cookie (for SSO-managed accounts).
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// LumenJS doesn't load .env automatically — parse it ourselves (ESM-safe, no dotenv)
try {
  const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf-8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (k && !process.env[k]) process.env[k] = v;
  }
} catch {}

// Load persisted session cookie from session.local
function loadSessionCookie(): string {
  if (process.env.JIRA_SESSION_COOKIE) return process.env.JIRA_SESSION_COOKIE;
  try {
    const f = resolve(process.cwd(), 'session.local');
    if (existsSync(f)) {
      const val = readFileSync(f, 'utf-8').trim();
      if (val) { process.env.JIRA_SESSION_COOKIE = val; return val; }
    }
  } catch {}
  return '';
}

function adfToText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node)) return node.map(adfToText).join('');
  if (node.content) return node.content.map(adfToText).join('\n');
  return '';
}

function mapTickets(data: any, baseUrl: string) {
  return (data.issues || []).map((issue: any) => ({
    key:            issue.key,
    id:             issue.id,
    url:            `${baseUrl}/browse/${issue.key}`,
    summary:        issue.fields.summary || '',
    description:    adfToText(issue.fields.description),
    status:         issue.fields.status?.name || 'Unknown',
    statusCategory: issue.fields.status?.statusCategory?.key || 'new',
    priority:       issue.fields.priority?.name || 'Medium',
    type:           issue.fields.issuetype?.name || 'Task',
    assignee:       issue.fields.assignee?.displayName || 'Unassigned',
  }));
}

async function jiraFetch(url: string, headers: Record<string, string>) {
  return fetch(url, { headers, redirect: 'manual' });
}

export async function GET(_req: any) {
  const baseUrl = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) return { configured: false, tickets: [], error: null };

  // Determine auth headers — prefer session cookie, fall back to Basic auth
  const sessionCookie = loadSessionCookie();
  const email   = process.env.JIRA_EMAIL;
  const token   = process.env.JIRA_API_TOKEN;

  let headers: Record<string, string> = { Accept: 'application/json' };
  let authMode: 'cookie' | 'basic' | 'none' = 'none';

  if (sessionCookie) {
    headers['Cookie'] = sessionCookie;
    authMode = 'cookie';
  } else if (email && token) {
    headers['Authorization'] = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    authMode = 'basic';
  } else {
    return { configured: false, tickets: [], error: null, needsCookie: true };
  }

  // Probe /myself first to catch auth errors cleanly
  const myselfUrl = `${baseUrl}/rest/api/2/myself`;
  try {
    const probe = await jiraFetch(myselfUrl, headers);

    if (probe.status === 301 || probe.status === 302 || probe.status === 303) {
      // Redirect = session expired or auth failed → need new cookie
      return {
        configured: true, tickets: [], needsCookie: true,
        error: authMode === 'cookie'
          ? 'Session cookie has expired. Please paste a new one.'
          : 'Jira redirected to login — Basic auth likely blocked by SSO. Use session cookie instead.',
      };
    }

    if (probe.status === 401) {
      return {
        configured: true, tickets: [], needsCookie: authMode === 'basic',
        error: authMode === 'cookie'
          ? 'Session cookie rejected (401). Please paste a new one.'
          : 'Authentication failed (401). Your API token may be blocked by SSO. Use session cookie instead.',
      };
    }

    if (probe.status === 403) {
      return { configured: true, tickets: [], error: 'Forbidden (403) — account may not have API access.' };
    }

    const ct = probe.headers.get('content-type') || '';
    if (probe.status === 200 && !ct.includes('application/json')) {
      return {
        configured: true, tickets: [], needsCookie: true,
        error: 'Got HTML instead of JSON — session cookie may be needed or has expired.',
      };
    }
  } catch (e: any) {
    return { configured: true, tickets: [], error: `Connection error: ${e.message}` };
  }

  // Fetch tickets using the current Jira Cloud search API (api/3/search/jql)
  const jql    = encodeURIComponent('assignee = currentUser() ORDER BY updated DESC');
  const fields = 'summary,description,status,priority,issuetype,assignee';
  const url    = `${baseUrl}/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=50`;

  try {
    const res = await jiraFetch(url, headers);
    if (res.status >= 300 && res.status < 400) {
      return { configured: true, tickets: [], needsCookie: true, error: 'Session expired — please refresh your cookie.' };
    }
    if (!res.ok) {
      const text = await res.text();
      return { configured: true, tickets: [], error: `Jira API ${res.status}: ${text.slice(0, 200)}` };
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return { configured: true, tickets: [], needsCookie: true, error: 'Got HTML from Jira search — session may have expired.' };
    }
    const data: any = await res.json();
    return { configured: true, tickets: mapTickets(data, baseUrl), error: null };
  } catch (e: any) {
    return { configured: true, tickets: [], error: `Connection error: ${e.message}` };
  }
}
