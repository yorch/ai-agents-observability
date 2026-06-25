import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Returns the root of Claude Code's projects directory.
 * Override with CLAUDE_PROJECTS_DIR env var (used in tests).
 */
export function claudeProjectsDir(): string {
  return process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
}

export type SessionFile = {
  path: string;
  sessionId: string; // filename without .jsonl
  projectDir: string; // the parent directory name (base64/slug of cwd)
};

/**
 * Recursively lists all *.jsonl files under `root`.
 * Never throws — returns empty array on any read error.
 * sessionId is the filename without the .jsonl extension.
 */
export function listSessionFiles(root?: string): SessionFile[] {
  const dir = root ?? claudeProjectsDir();
  const results: SessionFile[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(dir);
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(dir, projectDir);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(projectPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    let sessionFiles: string[];
    try {
      sessionFiles = readdirSync(projectPath);
    } catch {
      continue;
    }

    for (const fileName of sessionFiles) {
      if (!fileName.endsWith('.jsonl')) {
        continue;
      }
      const filePath = join(projectPath, fileName);
      let fileStat: ReturnType<typeof statSync>;
      try {
        fileStat = statSync(filePath);
      } catch {
        continue;
      }
      if (!fileStat.isFile()) {
        continue;
      }
      results.push({
        path: filePath,
        projectDir,
        sessionId: fileName.slice(0, -'.jsonl'.length),
      });
    }
  }

  return results;
}
