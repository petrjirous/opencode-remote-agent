import { execSync } from "child_process";
import { readFileSync, unlinkSync, statSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { putObject, getObject } from "./aws/s3.js";
import type { RemoteAgentConfig } from "./config.js";

const MAX_TARBALL_SIZE_MB = 500;
const MAX_TARBALL_SIZE_BYTES = MAX_TARBALL_SIZE_MB * 1024 * 1024;

/**
 * Check if a directory is inside a git repository.
 */
function isGitRepo(directory: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: directory,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the workspace directory from context values.
 * Falls back through multiple sources to find a valid project directory.
 */
function resolveWorkDir(directory: string, worktree: string): string {
  // Try worktree first (git root), then directory (project dir), then cwd
  const candidates = [worktree, directory, process.cwd()];

  for (const candidate of candidates) {
    if (
      candidate &&
      candidate !== "/" &&
      candidate !== "." &&
      candidate.length >= 3 &&
      existsSync(candidate)
    ) {
      return candidate;
    }
  }

  // All candidates were invalid — provide a detailed error
  throw new Error(
    `Cannot determine workspace directory. All sources resolved to invalid paths:\n` +
      `  context.worktree = "${worktree}"\n` +
      `  context.directory = "${directory}"\n` +
      `  process.cwd() = "${process.cwd()}"\n` +
      `Make sure you are running OpenCode from a project directory, not /.`,
  );
}

/**
 * Package the local workspace into a .tar.gz tarball.
 *
 * If inside a git repo: uses `git ls-files` to respect .gitignore
 * and includes both tracked and untracked-but-not-ignored files.
 *
 * If not a git repo: uses tar with --exclude-vcs to skip VCS dirs.
 *
 * @returns Path to the temporary tarball file.
 */
export async function packageWorkspace(
  directory: string,
  worktree: string,
): Promise<string> {
  const tarballPath = join("/tmp", `workspace-${randomUUID()}.tar.gz`);
  const workDir = resolveWorkDir(directory, worktree);

  if (isGitRepo(workDir)) {
    // Use git ls-files to get all files respecting .gitignore:
    // - tracked files (git ls-files -z)
    // - untracked but not ignored files (git ls-files --others --exclude-standard -z)
    // Combine both lists and pipe to tar
    execSync(
      `{ git ls-files -z; git ls-files --others --exclude-standard -z; } | tar --null -czf "${tarballPath}" -T -`,
      {
        cwd: workDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 50 * 1024 * 1024, // 50MB stdout buffer
        timeout: 120000, // 2 min timeout
      },
    );
  } else {
    // Fallback for non-git directories: exclude common VCS and large dirs
    execSync(
      `tar --exclude-vcs ` +
        `--exclude='node_modules' ` +
        `--exclude='.next' ` +
        `--exclude='dist' ` +
        `--exclude='build' ` +
        `--exclude='__pycache__' ` +
        `--exclude='.venv' ` +
        `-czf "${tarballPath}" -C "${workDir}" .`,
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120000,
      },
    );
  }

  // Check tarball size
  const stat = statSync(tarballPath);
  if (stat.size > MAX_TARBALL_SIZE_BYTES) {
    unlinkSync(tarballPath);
    throw new Error(
      `Workspace tarball is ${Math.round(stat.size / 1024 / 1024)}MB, ` +
        `exceeding the ${MAX_TARBALL_SIZE_MB}MB limit. ` +
        `Consider using repo_url instead, or adding large files to .gitignore.`,
    );
  }

  return tarballPath;
}

/**
 * Get the size of the tarball in a human-readable format.
 */
export function getTarballSize(tarballPath: string): string {
  const stat = statSync(tarballPath);
  if (stat.size < 1024) return `${stat.size} B`;
  if (stat.size < 1024 * 1024) return `${Math.round(stat.size / 1024)} KB`;
  return `${(stat.size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Upload workspace tarball to S3.
 * @returns The S3 key where the tarball was uploaded.
 */
export async function uploadWorkspace(
  config: RemoteAgentConfig,
  taskId: string,
  tarballPath: string,
): Promise<string> {
  const key = `tasks/${taskId}/workspace.tar.gz`;
  const body = readFileSync(tarballPath);
  await putObject(config, key, body, "application/gzip");

  // Clean up temp file
  try {
    unlinkSync(tarballPath);
  } catch {
    // Ignore cleanup errors
  }

  return key;
}

/**
 * Download the changes patch from S3 for a completed task.
 * @returns The patch content as a string, or null if no patch exists.
 */
export async function downloadPatch(
  config: RemoteAgentConfig,
  taskId: string,
): Promise<string | null> {
  return getObject(config, `tasks/${taskId}/changes.patch`);
}
