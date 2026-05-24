import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

const attempts = Number.parseInt(process.env.NPM_PUBLISH_ATTEMPTS ?? "3", 10);
const publishAttempts = Number.isFinite(attempts) && attempts > 0 ? attempts : 3;
const retryDelayMs = 5_000;

function runNpm(args) {
  return spawnSync("npm", args, { encoding: "utf8" });
}

function printResult(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function npmOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function isRetryablePublishFailure(result) {
  const output = npmOutput(result);
  return (
    /\bnpm error code E404\b/.test(output) ||
    /\bnpm error code E5\d\d\b/.test(output) ||
    /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|FetchError)\b/.test(output)
  );
}

function isVersionPublished() {
  const result = runNpm(["view", `${pkg.name}@${pkg.version}`, "version"]);
  return result.status === 0 && result.stdout.trim() === pkg.version;
}

if (isVersionPublished()) {
  console.log(`${pkg.name}@${pkg.version} is already published.`);
  process.exit(0);
}

let lastResult = null;
for (let attempt = 1; attempt <= publishAttempts; attempt += 1) {
  if (attempt > 1) {
    console.error(`Retrying npm publish (${attempt}/${publishAttempts})...`);
  }

  lastResult = runNpm(["publish", "--access", "public", "--provenance"]);
  printResult(lastResult);

  if (lastResult.status === 0) {
    process.exit(0);
  }

  if (isVersionPublished()) {
    console.log(`${pkg.name}@${pkg.version} is now published.`);
    process.exit(0);
  }

  if (attempt === publishAttempts || !isRetryablePublishFailure(lastResult)) {
    break;
  }

  console.error(
    `npm publish failed with a retryable registry error; waiting ${retryDelayMs / 1000}s.`,
  );
  await delay(retryDelayMs);
}

if (lastResult && /\bnpm error code E404\b/.test(npmOutput(lastResult))) {
  console.error(
    [
      `npm returned E404 while publishing ${pkg.name}@${pkg.version}.`,
      "Verify that NPM_TOKEN can publish to this package scope and that the npm organization/package still exists.",
    ].join(" "),
  );
}

process.exit(lastResult?.status ?? 1);
