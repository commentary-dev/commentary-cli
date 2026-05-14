import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_BASE_URL } from "./constants.js";

type StoredToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
};

type StoredConfig = {
  tokens?: Record<string, StoredToken>;
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
  } catch {
    return {};
  }
}

async function writeConfig(config: StoredConfig) {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function normalizeBaseUrl(baseUrl: string | undefined | null) {
  const value = baseUrl?.trim() || process.env.COMMENTARY_BASE_URL || DEFAULT_BASE_URL;
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export async function getStoredToken(baseUrl: string) {
  const config = await readConfig();
  return config.tokens?.[normalizeBaseUrl(baseUrl)] ?? null;
}

export async function setStoredToken(baseUrl: string, token: StoredToken) {
  const config = await readConfig();
  config.tokens ??= {};
  config.tokens[normalizeBaseUrl(baseUrl)] = token;
  await writeConfig(config);
}

export async function removeStoredToken(baseUrl: string) {
  const config = await readConfig();
  if (config.tokens) {
    delete config.tokens[normalizeBaseUrl(baseUrl)];
  }
  await writeConfig(config);
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
