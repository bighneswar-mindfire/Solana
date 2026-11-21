# solana-transfers

Substreams module `map_transfers` that extracts transfers from successful
Solana transactions, including inner (CPI) instructions:

| Program | Instructions | `from` / `to` | `amount` | `mint` |
|---|---|---|---|---|
| System | `Transfer`, `TransferWithSeed` | sender / recipient wallet | lamports | `So11111111111111111111111111111111111111112` |
| SPL Token, Token-2022 | `Transfer`, `TransferChecked` | owner wallets of the token accounts | raw token units | the token's mint |
| Token-2022 | `TransferCheckedWithFee` | owner wallets of the token accounts | raw token units | the token's mint |

`amount` is always in the smallest units of `mint`. Native SOL is reported
under the SOL mint (lamports, 9 decimals, the same units as wrapped SOL).

Token instructions name token accounts, not wallets. The module resolves each
token account to its owner and mint from the transaction's token balance
records, or, for temporary accounts created and closed in the same transaction
(usually wrapped SOL), from the `InitializeAccount*` instruction that created
them. `TransferChecked` names the mint itself; plain `Transfer` takes it from
those records.

Checked against Solana's public RPC (`getBlock`, `jsonParsed`) for blocks
385870151–385870156: identical `from`, `to`, `amount` and `mint` in every
block (3,974 transfers, 181 mints). See [Verify](#verify) to reproduce.

## Setup

- **Rust** with the WebAssembly target: install via [rustup](https://rustup.rs),
  then `rustup target add wasm32-unknown-unknown`.
- **Substreams CLI**: see [Substreams CLI on Windows](#substreams-cli-on-windows)
  below; on Linux or macOS use the release binary.
- **Node.js 18+** for the scripts in `scripts/`.
- **API key**: run `substreams auth` (it writes `.substreams.env`, which is
  git-ignored) or set `SUBSTREAMS_API_TOKEN`. Every `substreams run` needs it.

## Build

```
cargo build --target wasm32-unknown-unknown --release
substreams pack substreams.yaml
```

## Run: one JSON object per transfer

`transfers.jsonl` in this repo is the output for blocks 385870151–385870156 in
the `--strict` format (exactly `from`, `to`, `amount`):

```
node scripts/run.js --strict 385870151 385870156 > transfers.jsonl
```

Without `--strict`, each object also has a `mint` field. Both block numbers
are inclusive. Each line is one transfer:

```
{"from": "8ryouP8NbMv2EKL9V5xiAq5EEt5hKwnT9DDZHjqgTTWR", "to": "DduRAGKHQ5AN1BR3HGUW7ymL8MrTao7sQwZyoYCeSU69", "amount": 2829556537, "mint": "So11111111111111111111111111111111111111112"}
```

With `--strict`, `mint` is left out:

```
{"from": "8ryouP8NbMv2EKL9V5xiAq5EEt5hKwnT9DDZHjqgTTWR", "to": "DduRAGKHQ5AN1BR3HGUW7ymL8MrTao7sQwZyoYCeSU69", "amount": 2829556537}
```

A Substreams map module emits one message per block, so `map_transfers`
outputs a `Transfers` message holding every transfer in that block. In that
raw output `amount` is a string, because protobuf JSON encodes `uint64` as a
string. `scripts/run.js` runs `substreams run ... --final-blocks-only -o jsonl`
and splits each block's message into one object per transfer, with an integer
`amount`. Requesting final blocks only means a chain reorganization can't leave
transfers from orphaned blocks in the output.

`scripts/flatten.js` does the same split on output you saved or piped
yourself (`-o jsonl` or `-o json`). It stops with an error if it sees an undo
(reorg) signal or truncated output, so it never writes a partial or wrong file
silently:

```
substreams run -e mainnet.sol.streamingfast.io:443 solana-transfers-v0.1.0.spkg map_transfers --start-block 385870151 --stop-block 385870157 --final-blocks-only -o jsonl | node scripts/flatten.js
```

## Verify

```
node scripts/verify.js 385870151 385870156
```

Runs the module, fetches the same blocks from Solana's public RPC
(`SOLANA_RPC_URL` to use another), rebuilds each block's transfers from the
RPC's own decoded instructions, and compares them block by block. Exits 1 and
prints the differing transfers on any mismatch. Instruction decoding, inner
instructions, lookup-table accounts and failed-transaction filtering are
checked independently. Owners and mints come from the same transaction records
the module uses, so that part checks the module reads them correctly.

## Limitations

- **Wrapped SOL:** a native SOL transfer into a wrapped-SOL token account is
  reported with that token account as `to`, not its owner. That is what the
  System Program instruction contains, and it matches the RPC.
- **Unknown mint:** if a transaction carries no record of a token account's
  mint, `mint` is `null` (none occur in blocks 385870151–385870156).
- **Other transfer types:** only the instructions in the table above are
  extracted. Other ways of moving value (for example Token-2022 confidential
  transfers) are not.

## Substreams CLI on Windows

StreamingFast ships no Windows build of the CLI, so it was built from source
(v1.27.0) with Go. The source was changed to drop the `wasmtime` runtime: Go
1.27.4 refuses to link its prebuilt library (it carries an LTO section), and
with Go 1.27.0 MinGW's linker can't link it either. `pack` and remote `run`
are unaffected; only running modules locally would need that runtime. On Linux
or macOS, use the official release binary.
