// Runs the Substreams package over a block range and prints one JSON object
// per transfer: {"from": "...", "to": "...", "amount": 325253, "mint": "..."}
//
// Usage: node scripts/run.js [--strict] [startBlock] [lastBlock]
//   defaults: 385870151 385870156 (both inclusive)
//   --strict: leave out `mint` (exactly {"from", "to", "amount"})
// Env: SUBSTREAMS_ENDPOINT (default mainnet.sol.streamingfast.io:443).
// The API key is read by the substreams CLI from .substreams.env or
// SUBSTREAMS_API_TOKEN / SUBSTREAMS_API_KEY.
//
// Only final blocks are requested, so a chain reorganization can't put
// transfers from orphaned blocks in the output.
const { spawn } = require("child_process");
const path = require("path");
const { writeTransfers, exitOnClosedStdout } = require("./flatten");

const ROOT = path.join(__dirname, "..");
const SPKG = "solana-transfers-v0.1.0.spkg";
const DEFAULT_ENDPOINT = "mainnet.sol.streamingfast.io:443";
const DEFAULT_START = "385870151";
const DEFAULT_LAST = "385870156";

/** Parses [startBlock] [lastBlock]; prints usage and exits on bad input. */
function parseBlockArgs(args, usage) {
  const [start = DEFAULT_START, last = DEFAULT_LAST, ...rest] = args;
  if (rest.length || !/^\d+$/.test(start) || !/^\d+$/.test(last) || BigInt(last) < BigInt(start)) {
    console.error(`usage: ${usage}  (lastBlock >= startBlock)`);
    process.exit(2);
  }
  return { start, last };
}

/** Starts `substreams run` for blocks start..last (inclusive), JSONL on stdout. */
function spawnSubstreams(start, last) {
  const stop = String(BigInt(last) + 1n); // --stop-block is exclusive
  const endpoint = process.env.SUBSTREAMS_ENDPOINT || DEFAULT_ENDPOINT;
  return spawn(
    "substreams",
    [
      "run", "-e", endpoint, SPKG, "map_transfers",
      "--start-block", start, "--stop-block", stop,
      "--final-blocks-only", "-o", "jsonl",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] }
  );
}

/** Resolves with a description of how the child failed, or null if it exited 0. */
function exitProblem(child, name) {
  return new Promise((resolve) => {
    child.on("error", (e) => resolve(`could not start ${name}: ${e.message}`));
    child.on("close", (code, signal) => {
      if (signal) resolve(`${name} was killed by ${signal}`);
      else if (code !== 0) resolve(`${name} exited with code ${code}`);
      else resolve(null);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const { start, last } = parseBlockArgs(
    args.filter((a) => a !== "--strict"),
    "node scripts/run.js [--strict] [startBlock] [lastBlock]"
  );

  const substreams = spawnSubstreams(start, last);
  const problem = exitProblem(substreams, "substreams CLI");
  exitOnClosedStdout(() => substreams.kill());

  try {
    await writeTransfers(substreams.stdout, { strict });
  } catch (e) {
    substreams.kill();
    console.error(`run.js: ${e.message}`);
    process.exit(1);
  }
  const failure = await problem;
  if (failure) {
    console.error(failure);
    process.exit(1);
  }
}

module.exports = { parseBlockArgs, spawnSubstreams, exitProblem };

if (require.main === module) main();
