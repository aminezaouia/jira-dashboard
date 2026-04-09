// Lists local git branches, separated into versions and feature branches.
// POST body: { repoPath: string }
import { execSync } from 'child_process';

export async function POST(req: any) {
  const raw = (req.body || {}).repoPath;
  if (!raw) return { error: 'repoPath is required', branches: [], versions: [] };
  const repoPath = raw.replace(/\\/g, '/');

  try {
    // List all local branches
    const localOut = execSync(`git -C "${repoPath}" branch --list`, { stdio: 'pipe' }).toString();
    const localBranches = localOut
      .split('\n')
      .map((b: string) => b.replace(/^\*?\s+/, '').trim())
      .filter(Boolean);

    // Also list remote-tracking branches to catch version branches not checked out locally
    let remoteBranches: string[] = [];
    try {
      const remoteOut = execSync(`git -C "${repoPath}" branch -r`, { stdio: 'pipe' }).toString();
      remoteBranches = remoteOut
        .split('\n')
        .map((b: string) => b.trim().replace(/^origin\//, ''))
        .filter((b: string) => b && !b.includes('->'));
    } catch {}

    const allBranches = [...new Set([...localBranches, ...remoteBranches])];

    // Version branches: version/**, master, main, develop
    const versionPatterns = [/^version\//i, /^master$/i, /^main$/i, /^develop$/i];
    const versions = allBranches
      .filter(b => versionPatterns.some(p => p.test(b)))
      .sort((a, b) => {
        // Sort version/* branches newest-first by version number, master last
        if (a.startsWith('version/') && b.startsWith('version/')) {
          return b.localeCompare(a, undefined, { numeric: true });
        }
        if (a.startsWith('version/')) return -1;
        if (b.startsWith('version/')) return 1;
        return a.localeCompare(b);
      });

    // Feature branches: everything else
    const branches = localBranches.filter(b => !versionPatterns.some(p => p.test(b)));

    return { branches, versions };
  } catch (e: any) {
    return { error: (e.stderr || e.message).toString().trim(), branches: [], versions: [] };
  }
}
