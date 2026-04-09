// Claude AI solver — reads the Jira ticket, understands the codebase,
// generates a solution, creates a branch, writes files, and commits.
// Does NOT push to remote.
// LumenJS API routes receive a plain nkRequest and must return plain objects.
import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// LumenJS doesn't load .env automatically — parse it ourselves (ESM-safe, no dotenv)
try {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (k && !process.env[k]) process.env[k] = v;
    }
  }
} catch { /* env vars must come from OS */ }
import * as fs from 'fs';
import * as path from 'path';

function slugify(text: string, maxLen = 40): string {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

function buildRepoContext(repoPath: string): string {
  const lines: string[] = [];
  try {
    const tracked = execSync(`git -C "${repoPath}" ls-files`, { stdio: 'pipe' })
      .toString().trim().split('\n').filter(Boolean);
    lines.push('=== Repository files (git-tracked) ===');
    lines.push(tracked.slice(0, 60).join('\n'));
    lines.push('');
    for (const name of ['README.md', 'package.json', 'tsconfig.json', 'pyproject.toml', 'go.mod']) {
      const fp = path.join(repoPath, name);
      if (fs.existsSync(fp)) {
        lines.push(`=== ${name} ===`);
        lines.push(fs.readFileSync(fp, 'utf-8').slice(0, 800));
        lines.push('');
      }
    }
  } catch {
    lines.push('(could not read repository context)');
  }
  return lines.join('\n').slice(0, 6000);
}

export async function POST(req: any) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { error: 'ANTHROPIC_API_KEY is not set. Add it to your .env file.' };
  }

  const { ticket, additionalContext, primaryVersion, targetVersions } = req.body || {};
  const repoPath = (req.body?.repoPath || '').replace(/\\/g, '/');

  if (!ticket || !repoPath) {
    return { error: 'ticket and repoPath are required' };
  }

  const repoContext  = buildRepoContext(repoPath);
  const description  = ticket.description || 'No description provided.';

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `You are a senior software engineer. You will be given a Jira ticket and context about a repository. Your job is to produce a complete, working solution.

Rules:
- Return ONLY a valid JSON object. No markdown, no explanation outside the JSON.
- The JSON must follow this schema exactly:
{
  "branch_name": "feature/TICKET-KEY-short-description",
  "commit_message": "TICKET-KEY: what was done",
  "summary": "2-3 sentence plain-English explanation of the solution",
  "files": [
    { "path": "relative/path/from/repo/root.ext", "content": "full file content", "action": "create" }
  ]
}
- branch_name: lowercase, hyphens, starts with "feature/"
- files: provide complete file content (never partial). If modifying an existing file, rewrite it fully.
- Keep the solution minimal but correct — only the files needed.`;

  const userPrompt = `Jira Ticket:
ID: ${ticket.key}
Type: ${ticket.type || 'Task'}
Priority: ${ticket.priority || 'Medium'}
Summary: ${ticket.summary}
Description:
${description}

${additionalContext ? `Developer notes:\n${additionalContext}\n` : ''}${primaryVersion ? `Target version branch: ${primaryVersion}\n` : ''}${targetVersions?.length > 1 ? `Also needs backporting to: ${targetVersions.slice(1).join(', ')}\n` : ''}
Repository context:
${repoContext}

Generate the solution JSON now.`;

  let solution: any;
  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const raw   = response.content[0].type === 'text' ? response.content[0].text : '';
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    solution    = JSON.parse(clean);
  } catch (e: any) {
    return { error: `Claude response parsing failed: ${e.message}` };
  }

  const branchName = solution.branch_name
    || `feature/${slugify(ticket.key)}-${slugify(ticket.summary)}`;

  // Create branch off primaryVersion if specified, otherwise off current HEAD
  try {
    const exists = execSync(`git -C "${repoPath}" branch --list "${branchName}"`, { stdio: 'pipe' })
      .toString().trim();
    if (exists) {
      execSync(`git -C "${repoPath}" checkout "${branchName}"`, { stdio: 'pipe' });
    } else if (primaryVersion) {
      // Fetch the version branch from remote if not local
      try {
        execSync(`git -C "${repoPath}" fetch origin "${primaryVersion}:${primaryVersion}" --no-tags`, { stdio: 'pipe' });
      } catch {}
      execSync(`git -C "${repoPath}" checkout -b "${branchName}" "${primaryVersion}"`, { stdio: 'pipe' });
    } else {
      execSync(`git -C "${repoPath}" checkout -b "${branchName}"`, { stdio: 'pipe' });
    }
  } catch (e: any) {
    return { error: `Failed to create branch: ${(e.stderr || e.message).toString().trim()}` };
  }

  // Write files
  const writtenPaths: string[] = [];
  try {
    for (const file of solution.files || []) {
      const abs = path.join(repoPath, file.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, file.content, 'utf-8');
      execSync(`git -C "${repoPath}" add "${file.path}"`, { stdio: 'pipe' });
      writtenPaths.push(file.path);
    }
  } catch (e: any) {
    return { error: `Failed to write files: ${e.message}` };
  }

  // Commit (no push)
  const commitMsg = (solution.commit_message || `${ticket.key}: AI-generated solution`)
    .replace(/"/g, '\\"');
  try {
    execSync(`git -C "${repoPath}" commit -m "${commitMsg}"`, { stdio: 'pipe' });
  } catch (e: any) {
    const msg = (e.stderr || e.message).toString();
    if (!msg.includes('nothing to commit')) {
      return { error: `git commit failed: ${msg.trim()}` };
    }
  }

  return {
    success:        true,
    branchName,
    commitMessage:  solution.commit_message,
    summary:        solution.summary,
    files:          writtenPaths,
    primaryVersion: primaryVersion || null,
    targetVersions: targetVersions || [],
  };
}
