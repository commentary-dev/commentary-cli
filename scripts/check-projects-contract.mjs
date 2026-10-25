import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--source")) {
  console.error("Usage: npm run contracts:check -- [--source <canonical-contract.json>]");
  process.exit(2);
}
const read = (location) => JSON.parse(readFileSync(location, "utf8"));
const snapshot = read(new URL("../contracts/projects-agent-v1.json", import.meta.url));
const runtime = read(new URL("../src/projects-contract.json", import.meta.url));
const source = args.length ? read(args[1]) : snapshot;
if (!isDeepStrictEqual(snapshot, runtime) || !isDeepStrictEqual(source, runtime)) {
  console.error(
    "Projects contract drift: synchronize the canonical snapshot and runtime catalog before release.",
  );
  process.exit(1);
}
console.log(
  `Projects contract v${runtime.contractVersion}: ${runtime.operations.length} operations match (${runtime.digest}).`,
);
