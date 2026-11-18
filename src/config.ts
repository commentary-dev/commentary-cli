import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { DEFAULT_BASE_URL } from "./constants.js";
import { CliError, ExitCode } from "./errors.js";

export type StoredToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
};

type StoredConfig = {
  tokens?: Record<string, StoredToken>;
  profiles?: Record<string, Record<string, StoredToken>>;
};

function configDir() {
  if (process.env.COMMENTARY_CONFIG_DIR) {
    return process.env.COMMENTARY_CONFIG_DIR;
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "commentary");
  }
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "commentary");
  }
  return path.join(os.homedir(), ".config", "commentary");
}

export function configPath() {
  return path.join(configDir(), "config.json");
}

async function readConfig(): Promise<StoredConfig> {
  try {
    return JSON.parse(await fs.readFile(configPath(), "utf8")) as StoredConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CliError(
      "Could not read saved credentials. Check the Commentary config file.",
      ExitCode.Auth,
    );
  }
}

async function writeConfig(config: StoredConfig) {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  const temporary = `${configPath()}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, configPath());
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function withConfigLock<T>(suffix: string, run: () => Promise<T>): Promise<T> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(`${configPath()}.${suffix}`, {
    realpath: false,
    stale: 30_000,
    update: 5_000,
    retries: { retries: 300, minTimeout: 200, maxTimeout: 200, randomize: false },
  });
  try {
    return await run();
  } finally {
    await release();
  }
}

export function withStoredTokenRefreshLock<T>(
  baseUrl: string,
  profile: string | undefined,
  run: () => Promise<T>,
) {
  validateProfile(profile);
  const key = createHash("sha256")
    .update(JSON.stringify([normalizeBaseUrl(baseUrl), profile ?? null]))
    .digest("hex");
  return withConfigLock(`refresh-${key}`, run);
}

function tokenFromConfig(config: StoredConfig, baseUrl: string, profile?: string) {
  if (profile) {
    const profiles = config.profiles?.[normalizeBaseUrl(baseUrl)];
    return profiles && Object.hasOwn(profiles, profile) ? (profiles[profile] ?? null) : null;
  }
  return config.tokens?.[normalizeBaseUrl(baseUrl)] ?? null;
}

function putToken(
  config: StoredConfig,
  baseUrl: string,
  token: StoredToken | null,
  profile?: string,
) {
  if (profile) {
    config.profiles ??= {};
    config.profiles[normalizeBaseUrl(baseUrl)] ??= {};
    if (token) config.profiles[normalizeBaseUrl(baseUrl)]![profile] = token;
    else delete config.profiles[normalizeBaseUrl(baseUrl)]![profile];
  } else {
    config.tokens ??= {};
    if (token) config.tokens[normalizeBaseUrl(baseUrl)] = token;
    else delete config.tokens[normalizeBaseUrl(baseUrl)];
  }
}

/** A stale refresh must never overwrite or erase a concurrent explicit login. */
export function replaceStoredToken(
  baseUrl: string,
  expected: StoredToken,
  next: StoredToken | null,
  profile?: string,
) {
  validateProfile(profile);
  return withConfigLock("write", async () => {
    const config = await readConfig();
    const current = tokenFromConfig(config, baseUrl, profile);
    if (
      current?.accessToken !== expected.accessToken ||
      current?.refreshToken !== expected.refreshToken
    )
      return current;
    putToken(config, baseUrl, next, profile);
    await writeConfig(config);
    return next;
  });
}

export function normalizeBaseUrl(baseUrl: string | undefined | null) {
  const value = baseUrl?.trim() || process.env.COMMENTARY_BASE_URL || DEFAULT_BASE_URL;
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function validateProfile(profile: string | undefined) {
  if (profile !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(profile))
    throw new CliError(
      "--profile must be a name of 1 to 80 letters, digits, underscores, or hyphens.",
      ExitCode.Usage,
    );
}

export async function getStoredToken(baseUrl: string, profile?: string) {
  validateProfile(profile);
  return tokenFromConfig(await readConfig(), baseUrl, profile);
}

export async function setStoredToken(baseUrl: string, token: StoredToken, profile?: string) {
  validateProfile(profile);
  await withConfigLock("write", async () => {
    const config = await readConfig();
    putToken(config, baseUrl, token, profile);
    await writeConfig(config);
  });
}

export async function removeStoredToken(baseUrl: string, profile?: string) {
  validateProfile(profile);
  await withConfigLock("write", async () => {
    const config = await readConfig();
    putToken(config, baseUrl, null, profile);
    await writeConfig(config);
  });
}

export async function resolveToken(input: { baseUrl: string; token?: string | null | undefined }) {
  if (input.token?.trim()) {
    return input.token.trim();
  }
  if (process.env.COMMENTARY_TOKEN?.trim()) {
    return process.env.COMMENTARY_TOKEN.trim();
  }
  const stored = await getStoredToken(input.baseUrl);
  return stored?.accessToken ?? null;
}

export function shouldRefreshStoredToken(token: StoredToken, now = Date.now()) {
  if (!token.refreshToken) {
    return false;
  }
  if (!token.expiresAt) {
    return true;
  }
  const expiresAt = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return true;
  }
  return expiresAt - now <= 5 * 60 * 1000;
}
