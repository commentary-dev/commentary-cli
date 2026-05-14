import { execFileSync } from "node:child_process";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
let published = null;
try {
  published = execFileSync("npm", ["view", pkg.name, "version"], { encoding: "utf8" }).trim();
} catch {
  published = null;
}

if (published === pkg.version) {
  console.log(`${pkg.name}@${pkg.version} is already published.`);
  process.exit(0);
}

execFileSync("npm", ["publish", "--access", "public", "--provenance"], { stdio: "inherit" });
