import { execFileSync } from "node:child_process";
import fs from "node:fs";

const textExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
]);

const exactBlockedFiles = new Set([".env"]);
const blockedFilePrefixes = [".env."];
const blockedPathParts = new Set(["dist", "coverage", "node_modules", ".commentary"]);

const blockedPatterns = [
  {
    name: "Commentary PAT",
    pattern: /\bcomm_pat_[A-Za-z0-9_-]{12,}\b/g,
  },
  {
    name: "npm token",
    pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: "GitHub token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    name: "private key block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },
  {
    name: "local Windows path",
    pattern: /\b[A-Za-z]:[\\/](?:Users|code|tmp|work|projects)[\\/][^\s"'`)]+/gi,
  },
  {
    name: "private Commentary source path",
    pattern: /\b[A-Za-z]:[\\/]code[\\/]commentary(?:[\\/]|$)/gi,
  },
  {
    name: "staging host",
    pattern: new RegExp(["staging", "commentary", "dev"].join("\\."), "gi"),
  },
];

function gitFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  );
  return output.split("\0").filter(Boolean);
}

function extensionOf(filePath) {
  const match = /(\.[^.\\/]+)$/.exec(filePath);
  return match?.[1]?.toLowerCase() ?? "";
}

function shouldScanText(filePath) {
  return textExtensions.has(extensionOf(filePath));
}

function hasBlockedPathPart(filePath) {
  return filePath.split(/[\\/]/).some((part) => blockedPathParts.has(part));
}

function scanFile(filePath) {
  const findings = [];
  const normalized = filePath.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() ?? normalized;

  if (
    exactBlockedFiles.has(basename) ||
    blockedFilePrefixes.some((prefix) => basename.startsWith(prefix))
  ) {
    findings.push("environment file must not be committed");
  }
  if (hasBlockedPathPart(normalized)) {
    findings.push("generated/local workspace path must not be committed");
  }
  if (!shouldScanText(normalized)) {
    return findings;
  }

  const text = fs.readFileSync(filePath, "utf8");
  for (const rule of blockedPatterns) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(text);
    if (match) {
      findings.push(`${rule.name}: ${match[0]}`);
    }
  }
  return findings;
}

const failures = [];
for (const filePath of gitFiles()) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    continue;
  }
  const findings = scanFile(filePath);
  for (const finding of findings) {
    failures.push(`${filePath}: ${finding}`);
  }
}

if (failures.length > 0) {
  console.error("Public readiness check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Public readiness check passed.");
