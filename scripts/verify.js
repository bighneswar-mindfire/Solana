// Checks the module's output against Solana's public RPC, block by block.
//
// Usage: node scripts/verify.js [startBlock] [lastBlock]
//   defaults: 385870151 385870156 (both inclusive)
// Env: SOLANA_RPC_URL (default https://api.mainnet-beta.solana.com),
//      SUBSTREAMS_ENDPOINT (see run.js).
// Exits 1 if any block differs.
//
// For each block, the expected transfers are rebuilt from the RPC's own decoded
// (`jsonParsed`) instructions of successful transactions, inner instructions
// included. That independently checks instruction decoding, lookup-table
// accounts and failed-transaction filtering. Owners and mints of token accounts
// come from the same records the module uses (token balances, pre-balances
// first, then the InitializeAccount* instruction for accounts with no balance
// record), so that part checks the module reads those records correctly, not
// the choice of records itself.
const { parseBlockArgs, spawnSubstreams, exitProblem } = require("./run");
const { readMessages, transfersOf } = require("./flatten");

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MAX_DIFFS_SHOWN = 5;

const key = (from, to, amount, mint) => JSON.stringify([from, to, String(amount), mint]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** getBlock via RPC; null when the slot was skipped. Retries rate limits and server errors. */
async function getBlock(slot) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getBlock",
    params: [
      slot,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, transactionDetails: "full", rewards: false },
    ],
  });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`RPC HTTP ${res.status} for block ${slot}`);
    const json = await res.json();
    if (json.error) {
      if (json.error.code === -32007) return null; // slot skipped
      throw new Error(`RPC error for block ${slot}: ${json.error.message}`);
    }
    return json.result;
  }
}

const isToken = (ix) => ix.program === "spl-token" || ix.program === "spl-token-2022";

/** Expected transfer keys of one block, from the RPC's decoded instructions. */
function expectedTransfers(block) {
  const out = [];
  for (const tx of block.transactions) {
    if (tx.meta.err) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
    const instructions = [...tx.transaction.message.instructions];
    for (const inner of tx.meta.innerInstructions || []) instructions.push(...inner.instructions);

    const owners = {};
    const mints = {};
    // Post first, then pre, so pre-balances win (as in the module).
    for (const b of [...(tx.meta.postTokenBalances || []), ...(tx.meta.preTokenBalances || [])]) {
      const account = keys[b.accountIndex];
      if (b.owner) owners[account] = b.owner;
      if (b.mint) mints[account] = b.mint;
    }
    for (const ix of instructions) {
      if (!isToken(ix) || !ix.parsed || !/^initializeAccount/.test(ix.parsed.type)) continue;
      const { account, owner, mint } = ix.parsed.info;
      if (!(account in owners)) owners[account] = owner;
      if (!(account in mints)) mints[account] = mint;
    }
    const ownerOf = (account) => owners[account] || account;

    for (const ix of instructions) {
      if (!ix.parsed || typeof ix.parsed !== "object") continue;
      const { type, info } = ix.parsed;
      if (ix.program === "system" && (type === "transfer" || type === "transferWithSeed")) {
        out.push(key(info.source, info.destination, info.lamports, SOL_MINT));
      } else if (isToken(ix) && type === "transfer") {
        const mint = mints[info.source] || mints[info.destination] || null;
        out.push(key(ownerOf(info.source), ownerOf(info.destination), info.amount, mint));
      } else if (isToken(ix) && (type === "transferChecked" || type === "transferCheckedWithFee")) {
        out.push(key(ownerOf(info.source), ownerOf(info.destination), info.tokenAmount.amount, info.mint));
      }
    }
  }
  return out;
}

/** Runs the module and returns { block number: [transfer keys] }. */
async function actualTransfers(start, last) {
  const substreams = spawnSubstreams(start, last);
  const problem = exitProblem(substreams, "substreams CLI");
  const byBlock = {};
  const { done } = readMessages(substreams.stdout, (msg) => {
    const transfers = transfersOf(msg);
    if (msg["@module"] === "map_transfers") {
      byBlock[msg["@block"]] = transfers.map((t) => key(t.from, t.to, t.amount, t.mint));
    }
  });
  try {
    await done;
  } catch (e) {
    substreams.kill();
    throw e;
  }
  const failure = await problem;
  if (failure) throw new Error(failure);
  return byBlock;
}

/** Differences between two multisets of keys, as printable lines. */
function differences(actual, expected) {
  const count = (list) => list.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
  const a = count(actual);
  const e = count(expected);
  const lines = [];
  for (const [k, n] of a) if ((e.get(k) || 0) < n) lines.push(`  only in substreams: ${k} (x${n - (e.get(k) || 0)})`);
  for (const [k, n] of e) if ((a.get(k) || 0) < n) lines.push(`  only in RPC:        ${k} (x${n - (a.get(k) || 0)})`);
  return lines;
}

async function main() {
  const { start, last } = parseBlockArgs(process.argv.slice(2), "node scripts/verify.js [startBlock] [lastBlock]");
  const slots = [];
  for (let s = BigInt(start); s <= BigInt(last); s++) slots.push(Number(s));

  const actualPromise = actualTransfers(start, last);
  const rpcBlocks = [];
  for (const slot of slots) rpcBlocks.push(await getBlock(slot)); // one at a time: public RPC rate limits
  const actual = await actualPromise;

  let ok = true;
  let total = 0;
  console.log("block        substreams   rpc  result");
  slots.forEach((slot, i) => {
    const mine = actual[slot] || [];
    const block = rpcBlocks[i];
    if (block === null) {
      const fine = mine.length === 0;
      ok = ok && fine;
      console.log(`${slot}  ${String(mine.length).padStart(10)}     -  ${fine ? "skipped slot" : "FAIL: skipped slot has output"}`);
      return;
    }
    const expected = expectedTransfers(block);
    const diff = differences(mine, expected);
    ok = ok && diff.length === 0;
    total += mine.length;
    console.log(`${slot}  ${String(mine.length).padStart(10)}  ${String(expected.length).padStart(4)}  ${diff.length ? "FAIL" : "match"}`);
    for (const line of diff.slice(0, MAX_DIFFS_SHOWN)) console.log(line);
    if (diff.length > MAX_DIFFS_SHOWN) console.log(`  ... ${diff.length - MAX_DIFFS_SHOWN} more`);
  });
  console.log(ok ? `all ${slots.length} blocks match (${total} transfers)` : "MISMATCH");
  process.exit(ok ? 0 : 1);
}

module.exports = { expectedTransfers, differences };

if (require.main === module) {
  main().catch((e) => {
    console.error(`verify.js: ${e.message}`);
    process.exit(1);
  });
}
