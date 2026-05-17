import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeReviewPath, normalizeSlashes } from "./content.js";
import { CliError, ExitCode } from "./errors.js";
import type { DraftReviewGitBaseMetadata } from "./types.js";

const execFileAsync = promisify(execFile);

export type GitBaseOptions = {
  gitBase?: string | undefined;
  gitBaseRepo?: string | undefined;
  gitBaseSha?: string | undefined;
  gitBaseRef?: string | undefined;
  gitBasePath?: string | undefined;
  gitRemote?: string | undefined;
};

export type GitCommandRunner = (args: string[], cwd: string) => Promise<string>;

type ReviewFilePath = {
  path: string;
  absolutePath?: string | undefined;
};

export async function defaultGitCommandRunner(args: string[], cwd: string) {
  const result = await execFileAsync("git", args, { cwd });
  return String(result.stdout).trim();
}

export function parseGitHubRemoteUrl(value: string) {
  const remote = value.trim();
  const patterns = [
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/)?$/i,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/)?$/i,
  ];
  for (const pattern of patterns) {
    const match = remote.match(pattern);
    if (match?.[1] && match[2]) {
      return { owner: match[1], repo: match[2] };
    }
  }
  return null;
}

export function parseGitHubRepo(value: string) {
  const repo = value
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "");
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra) {
    throw new CliError("GitHub base repo must be in owner/repo form.", ExitCode.Usage);
  }
  return { owner, repo: name };
}

export function hasGitBaseRequest(options: GitBaseOptions) {
  return Boolean(
    options.gitBase ||
    options.gitBaseRepo ||
    options.gitBaseSha ||
    options.gitBaseRef ||
    options.gitBasePath,
  );
}

export function validateGitBaseFilePath(files: ReviewFilePath[], gitBasePath?: string | undefined) {
  if (files.length !== 1) {
    throw new CliError(
      "GitHub base metadata is supported for single-file draft reviews. Review one file or omit --git-base.",
      ExitCode.Usage,
    );
  }
  const reviewPath = normalizeReviewPath(files[0]!.path);
  const basePath = gitBasePath ? normalizeReviewPath(gitBasePath) : reviewPath;
  if (basePath !== reviewPath) {
    throw new CliError(
      `GitHub base path must match the draft review file path (${reviewPath}). Use the repository root as --root so paths line up.`,
      ExitCode.Usage,
    );
  }
  return basePath;
}

export async function resolveGitRoot(input: {
  cwd: string;
  runner?: GitCommandRunner | undefined;
}) {
  const runner = input.runner ?? defaultGitCommandRunner;
  try {
    return path.resolve(await runner(["rev-parse", "--show-toplevel"], input.cwd));
  } catch {
    throw new CliError(
      "Could not resolve the local git repository root for --git-base auto.",
      ExitCode.Usage,
    );
  }
}

export async function defaultReviewRootForGitBase(input: {
  cwd: string;
  explicitRoot?: string | undefined;
  options: GitBaseOptions;
  runner?: GitCommandRunner | undefined;
}) {
  if (input.explicitRoot || input.options.gitBase !== "auto") {
    return path.resolve(input.cwd, input.explicitRoot ?? ".");
  }
  return resolveGitRoot({ cwd: input.cwd, runner: input.runner });
}

export async function resolveGitBase(input: {
  cwd: string;
  root: string;
  files: ReviewFilePath[];
  options: GitBaseOptions;
  runner?: GitCommandRunner | undefined;
}): Promise<DraftReviewGitBaseMetadata | undefined> {
  if (!hasGitBaseRequest(input.options)) {
    return undefined;
  }
  if (input.options.gitBase && input.options.gitBase !== "auto") {
    throw new CliError(
      "Use --git-base auto, or pass --git-base-repo and --git-base-sha.",
      ExitCode.Usage,
    );
  }
  if (input.options.gitBase === "auto") {
    return resolveAutoGitBase(input);
  }
  return resolveExplicitGitBase(input.files, input.options);
}

function resolveExplicitGitBase(
  files: ReviewFilePath[],
  options: GitBaseOptions,
): DraftReviewGitBaseMetadata {
  if (!options.gitBaseRepo || !options.gitBaseSha) {
    throw new CliError(
      "Explicit GitHub base metadata requires --git-base-repo <owner/repo> and --git-base-sha <sha>.",
      ExitCode.Usage,
    );
  }
  const { owner, repo } = parseGitHubRepo(options.gitBaseRepo);
  return {
    provider: "github",
    owner,
    repo,
    ref: options.gitBaseRef?.trim() || null,
    sha: options.gitBaseSha.trim(),
    path: validateGitBaseFilePath(files, options.gitBasePath),
  };
}

async function resolveAutoGitBase(input: {
  cwd: string;
  root: string;
  files: ReviewFilePath[];
  options: GitBaseOptions;
  runner?: GitCommandRunner | undefined;
}): Promise<DraftReviewGitBaseMetadata> {
  const runner = input.runner ?? defaultGitCommandRunner;
  const gitRoot = await resolveGitRoot({ cwd: input.root, runner });
  const reviewPath = validateGitBaseFilePath(input.files, input.options.gitBasePath);
  const file = input.files[0]!;
  if (file.absolutePath) {
    const repoRelative = normalizeReviewPath(
      normalizeSlashes(path.relative(gitRoot, file.absolutePath)),
    );
    if (repoRelative !== reviewPath) {
      throw new CliError(
        `GitHub base path must match the draft review file path (${reviewPath}). Use --root ${gitRoot} so paths line up.`,
        ExitCode.Usage,
      );
    }
  }
  const remoteName = input.options.gitRemote?.trim() || "origin";
  let remoteUrl: string;
  let sha: string;
  let ref: string | null;
  try {
    [remoteUrl, sha, ref] = await Promise.all([
      runner(["remote", "get-url", remoteName], gitRoot),
      runner(["rev-parse", "HEAD"], gitRoot),
      runner(["branch", "--show-current"], gitRoot).catch(() => ""),
    ]);
  } catch {
    throw new CliError(
      `Could not resolve GitHub base metadata from git remote ${remoteName}. Pass explicit --git-base-repo and --git-base-sha instead.`,
      ExitCode.Usage,
    );
  }
  const repo = parseGitHubRemoteUrl(remoteUrl);
  if (!repo) {
    throw new CliError(
      `Git remote ${remoteName} is not a GitHub remote. Pass explicit --git-base-repo and --git-base-sha instead.`,
      ExitCode.Usage,
    );
  }
  return {
    provider: "github",
    owner: repo.owner,
    repo: repo.repo,
    ref: ref.trim() || null,
    sha: sha.trim(),
    path: reviewPath,
  };
}
