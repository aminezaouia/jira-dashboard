// Saves the Jira session cookie to a local file for persistence across server restarts.
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const SESSION_FILE = resolve(process.cwd(), 'session.local');

export function loadSessionCookie(): string {
  if (process.env.JIRA_SESSION_COOKIE) return process.env.JIRA_SESSION_COOKIE;
  try {
    if (existsSync(SESSION_FILE)) {
      const val = readFileSync(SESSION_FILE, 'utf-8').trim();
      if (val) {
        process.env.JIRA_SESSION_COOKIE = val;
        return val;
      }
    }
  } catch {}
  return '';
}

export async function POST(req: any) {
  const { cookie } = req.body || {};
  if (!cookie || typeof cookie !== 'string' || !cookie.trim()) {
    return { error: 'cookie is required' };
  }
  const val = cookie.trim();
  try {
    writeFileSync(SESSION_FILE, val, 'utf-8');
    process.env.JIRA_SESSION_COOKIE = val;
    return { success: true };
  } catch (e: any) {
    return { error: `Failed to save session: ${e.message}` };
  }
}

export async function DELETE(_req: any) {
  try {
    if (existsSync(SESSION_FILE)) {
      writeFileSync(SESSION_FILE, '', 'utf-8');
    }
    delete process.env.JIRA_SESSION_COOKIE;
    return { success: true };
  } catch (e: any) {
    return { error: e.message };
  }
}
