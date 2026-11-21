// Splits `substreams run` output (one Transfers message per block) into one
// JSON object per transfer:
//   {"from": "...", "to": "...", "amount": 325253, "mint": "..."}
// `amount` is in the smallest units of `mint` (lamports for native SOL, whose
// mint is reported as So11111111111111111111111111111111111111112).
// With --strict, `mint` is left out, giving exactly the assignment's format:
//   {"from": "...", "to": "...", "amount": 325253}
//
// Streams stdin, so it can sit at the end of a pipe:
//   substreams run ... map_transfers ... -o jsonl | node scripts/flatten.js [--strict]
// or read a saved file (either `-o jsonl` or `-o json` output):
//   node scripts/flatten.js [--strict] output.txt
//
// Notes:
// - Protobuf JSON omits zero-valued fields, so a missing `amount` means 0 and
//   a missing `mint` means the mint is unknown (written as null).
// - Protobuf JSON encodes uint64 as a string; it is written back as a bare
//   integer without going through Number, so amounts above 2^53 stay exact.
// - A chain reorganization (undo signal) is an error: transfers already written
//   would include orphaned blocks. Request final blocks only to avoid it.
const fs = require("fs");
const readline = require("readline");

/** One transfer from protobuf JSON, checked and normalized. Throws on malformed input. */
function normalize(t, block) {
  for (const field of ["from", "to"]) {
    if (typeof t[field] !== "string" || t[field] === "") {
      throw new Error(`block ${block}: transfer without "${field}": ${JSON.stringify(t)}`);
    }
  }
  const amount = t.amount === undefined ? "0" : String(t.amount);
  if (!/^\d+$/.test(amount)) {
    throw new Error(`block ${block}: bad amount ${JSON.stringify(t.amount)}`);
  }
  return { from: t.from, to: t.to, amount, mint: t.mint || null };
}

/**
 * The transfers in one `substreams run` JSON message: [] for messages of other
 * modules. Throws on an undo signal, since earlier output is then wrong.
 */
function transfersOf(msg) {
  if (msg.undo_until) {
    throw new Error(
      `chain reorganization: undo back to block ${msg.undo_until.num}; output already ` +
        `written includes orphaned blocks. Run with --final-blocks-only.`
    );
  }
  if (msg["@module"] !== "map_transfers") return [];
  const transfers = (msg["@data"] && msg["@data"].transfers) || [];
  return transfers.map((t) => normalize(t, msg["@block"]));
}

/** One output line (without newline). `amount` is already a digit string. */
function formatLine(t, strict) {
  const mint = strict ? "" : `, "mint": ${JSON.stringify(t.mint)}`;
  return `{"from": ${JSON.stringify(t.from)}, "to": ${JSON.stringify(t.to)}, "amount": ${t.amount}${mint}}`;
}

/**
 * Calls onMessage for each JSON message in `substreams run` output read from
 * `input`: `-o jsonl` gives one message per line; `-o json` pretty-prints each
 * message across many lines, ending with a line that is just "}".
 * Returns { rl, done }; `done` rejects on bad input or when onMessage throws.
 */
function readMessages(input, onMessage) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const done = new Promise((resolve, reject) => {
    let buffer = null;
    let failed = false;
    const fail = (e) => {
      failed = true;
      rl.close();
      reject(e);
    };
    input.on("error", fail);
    rl.on("error", fail); // readline re-emits input errors on itself
    rl.on("line", (line) => {
      if (failed) return;
      try {
        if (buffer === null) {
          if (line.startsWith("{") && line.endsWith("}")) return onMessage(JSON.parse(line));
          if (line === "{") buffer = [line];
          return; // ignore anything outside a message
        }
        buffer.push(line);
        if (line === "}") {
          const text = buffer.join("\n");
          buffer = null;
          onMessage(JSON.parse(text));
        }
      } catch (e) {
        fail(e);
      }
    });
    rl.on("close", () => {
      if (failed) return;
      if (buffer !== null) reject(new Error("output ended in the middle of a message (truncated?)"));
      else resolve();
    });
  });
  return { rl, done };
}

/** Writes one line per transfer to stdout, pausing input while stdout is full. */
function writeTransfers(input, { strict = false } = {}) {
  let waiting = false;
  const { rl, done } = readMessages(input, (msg) => {
    for (const t of transfersOf(msg)) {
      if (!process.stdout.write(formatLine(t, strict) + "\n") && !waiting) {
        waiting = true;
        rl.pause();
        process.stdout.once("drain", () => {
          waiting = false;
          rl.resume();
        });
      }
    }
  });
  return done;
}

/** Exits quietly when the reader of stdout goes away (e.g. `| head`). */
function exitOnClosedStdout(beforeExit = () => {}) {
  process.stdout.on("error", (e) => {
    if (e.code !== "EPIPE") throw e;
    beforeExit();
    process.exit(0);
  });
}

module.exports = { transfersOf, formatLine, readMessages, writeTransfers, exitOnClosedStdout };

if (require.main === module) {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const files = args.filter((a) => a !== "--strict");
  if (files.length > 1 || files.some((f) => f.startsWith("-"))) {
    console.error("usage: node scripts/flatten.js [--strict] [substreams-output-file]");
    process.exit(2);
  }
  exitOnClosedStdout();
  writeTransfers(files[0] ? fs.createReadStream(files[0]) : process.stdin, { strict }).catch((e) => {
    console.error(`flatten.js: ${e.message}`);
    process.exit(1);
  });
}
