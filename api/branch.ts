// Creates a local git branch for a Jira ticket. Does NOT push.
// LumenJS API routes receive a plain nkRequest and must return plain objects.

import { execSync } from 'child_process';

function slugify(text: string, maxLen = 50): string {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

export async function POST(req: any) {
  const { ticketId, summary } = req.body || {};
  const repoPath = (req.body?.repoPath || '').replace(/\\/g, '/');

  if (!ticketId || !repoPath) {
    return { error: 'ticketId and repoPath are required' };
  }

  const branchName = `feature/${ticketId.toLowerCase()}-${slugify(summary || ticketId)}`.slice(0, 80);

  try {
    const existing = execSync(`git -C "${repoPath}" branch --list "${branchName}"`, { stdio: 'pipe' })
      .toString().trim();

    if (existing) {
      execSync(`git -C "${repoPath}" checkout "${branchName}"`, { stdio: 'pipe' });
      return { success: true, branchName, existed: true };
    }

    execSync(`git -C "${repoPath}" checkout -b "${branchName}"`, { stdio: 'pipe' });
    return { success: true, branchName, existed: false };
  } catch (e: any) {
    const msg = (e.stderr?.toString() || e.message || 'Unknown git error').trim();
    return { error: msg };
  }
}
