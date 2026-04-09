// Exposes non-sensitive server config to the frontend.
import { readFileSync } from 'fs';
import { resolve } from 'path';

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

export async function GET(_req: any) {
  return {
    repoPath:     process.env.REPO_PATH || '',
    githubRepoUrl: process.env.GITHUB_REPO_URL || '',
  };
}
