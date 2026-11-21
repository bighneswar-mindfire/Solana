mod pb;

use std::collections::HashMap;

use pb::{Transfer, Transfers};
use substreams_solana::b58;
use substreams_solana::base58;
use substreams_solana::pb::sf::solana::r#type::v1::{Block, ConfirmedTransaction};

const SYSTEM_PROGRAM: [u8; 32] = b58!("11111111111111111111111111111111");
const TOKEN_PROGRAM: [u8; 32] = b58!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM: [u8; 32] = b58!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Reported as the `mint` of native SOL transfers, so every `amount` reads as
/// "smallest units of `mint`" (lamports here, 9 decimals, same as wrapped SOL).
const NATIVE_SOL_MINT: &str = "So11111111111111111111111111111111111111112";

// System Program instructions: u32 LE tag, then u64 LE lamports.
const SYSTEM_TRANSFER: u32 = 2; // accounts: [from, to]
const SYSTEM_TRANSFER_WITH_SEED: u32 = 11; // accounts: [from, base, to]

// SPL Token / Token-2022 instructions: u8 tag, then u64 LE amount.
const TOKEN_TRANSFER: u8 = 3; // accounts: [source, destination, authority]
const TOKEN_TRANSFER_CHECKED: u8 = 12; // accounts: [source, mint, destination, authority]
// Token-2022 only: tag 26 (TransferFeeExtension), sub-tag 1 (TransferCheckedWithFee),
// then u64 LE amount. accounts: [source, mint, destination, authority]
const TOKEN_TRANSFER_FEE_EXTENSION: u8 = 26;
const TRANSFER_CHECKED_WITH_FEE: u8 = 1;
// Token account creation, used to learn about accounts with no balance record.
const TOKEN_INITIALIZE_ACCOUNT: u8 = 1; // accounts: [account, mint, owner, rent]
const TOKEN_INITIALIZE_ACCOUNT_2: u8 = 16; // data: tag + owner; accounts: [account, mint, rent]
const TOKEN_INITIALIZE_ACCOUNT_3: u8 = 18; // data: tag + owner; accounts: [account, mint]

#[substreams::handlers::map]
fn map_transfers(block: Block) -> Result<Transfers, substreams::errors::Error> {
    let mut transfers = Vec::new();

    // `transactions()` yields successful transactions only.
    for trx in block.transactions() {
        let token_accounts = token_accounts(trx);

        // Includes top-level and inner (CPI) instructions.
        for ix in trx.walk_instructions() {
            let program = ix.program_id();
            let program = program.as_ref();
            let data = ix.data();
            let accounts = ix.accounts();

            if program == SYSTEM_PROGRAM {
                if data.len() < 12 {
                    continue;
                }
                let tag = u32::from_le_bytes(data[0..4].try_into().unwrap());
                let (from, to) = match tag {
                    SYSTEM_TRANSFER if accounts.len() >= 2 => (0, 1),
                    SYSTEM_TRANSFER_WITH_SEED if accounts.len() >= 3 => (0, 2),
                    _ => continue,
                };
                transfers.push(Transfer {
                    from: accounts[from].to_string(),
                    to: accounts[to].to_string(),
                    amount: read_u64(&data[4..12]),
                    mint: NATIVE_SOL_MINT.to_string(),
                });
            } else if program == TOKEN_PROGRAM || program == TOKEN_2022_PROGRAM {
                // (source index, destination index, mint index if the instruction names it, amount)
                let (from, to, mint, amount) = match data.first() {
                    Some(&TOKEN_TRANSFER) if data.len() >= 9 && accounts.len() >= 3 => {
                        (0, 1, None, read_u64(&data[1..9]))
                    }
                    Some(&TOKEN_TRANSFER_CHECKED) if data.len() >= 9 && accounts.len() >= 4 => {
                        (0, 2, Some(1), read_u64(&data[1..9]))
                    }
                    Some(&TOKEN_TRANSFER_FEE_EXTENSION)
                        if program == TOKEN_2022_PROGRAM
                            && data.len() >= 10
                            && data[1] == TRANSFER_CHECKED_WITH_FEE
                            && accounts.len() >= 4 =>
                    {
                        (0, 2, Some(1), read_u64(&data[2..10]))
                    }
                    _ => continue,
                };
                let source = token_accounts.get(accounts[from].as_ref());
                let destination = token_accounts.get(accounts[to].as_ref());
                let mint = match mint {
                    Some(i) => accounts[i].to_string(),
                    // Plain `Transfer` doesn't name the mint; both accounts hold the same one.
                    None => source
                        .and_then(|a| a.mint.clone())
                        .or_else(|| destination.and_then(|a| a.mint.clone()))
                        .unwrap_or_default(),
                };
                // Token instructions name token accounts; report the wallets that own them.
                transfers.push(Transfer {
                    from: owner_or_account(source, accounts[from].as_ref()),
                    to: owner_or_account(destination, accounts[to].as_ref()),
                    amount,
                    mint,
                });
            }
        }
    }

    Ok(Transfers { transfers })
}

fn read_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().unwrap())
}

/// What the transaction tells us about a token account.
#[derive(Default)]
struct TokenAccount {
    owner: Option<String>,
    mint: Option<String>,
}

/// Collects the owner wallet and mint of each token account the transaction touches.
///
/// 1. Token balances the runtime records before and after execution. Pre-balances
///    win, so an account re-assigned during the transaction keeps the owner it
///    had when the transfer happened.
/// 2. For accounts with no balance record (temporary accounts, typically wrapped
///    SOL, created and closed inside the same transaction), the
///    `InitializeAccount`, `InitializeAccount2` or `InitializeAccount3`
///    instruction that created them in that transaction.
fn token_accounts(trx: &ConfirmedTransaction) -> HashMap<&[u8], TokenAccount> {
    let mut found: HashMap<&[u8], TokenAccount> = HashMap::new();
    let Some(meta) = trx.meta.as_ref() else {
        return found;
    };
    let accounts = trx.resolved_accounts();
    for balance in meta.post_token_balances.iter().chain(meta.pre_token_balances.iter()) {
        let Some(account) = accounts.get(balance.account_index as usize) else {
            continue;
        };
        let entry = found.entry(account.as_slice()).or_default();
        if !balance.owner.is_empty() {
            entry.owner = Some(balance.owner.clone());
        }
        if !balance.mint.is_empty() {
            entry.mint = Some(balance.mint.clone());
        }
    }

    for ix in trx.walk_instructions() {
        let program = ix.program_id();
        let program = program.as_ref();
        if program != TOKEN_PROGRAM && program != TOKEN_2022_PROGRAM {
            continue;
        }
        let data = ix.data();
        let accounts = ix.accounts();
        let owner = match data.first() {
            Some(&TOKEN_INITIALIZE_ACCOUNT) if accounts.len() >= 3 => accounts[2].to_string(),
            Some(&TOKEN_INITIALIZE_ACCOUNT_2) | Some(&TOKEN_INITIALIZE_ACCOUNT_3)
                if data.len() >= 33 && accounts.len() >= 2 =>
            {
                base58::encode(&data[1..33])
            }
            _ => continue,
        };
        let entry = found.entry(accounts[0].0.as_slice()).or_default();
        entry.owner.get_or_insert(owner);
        entry.mint.get_or_insert_with(|| accounts[1].to_string());
    }
    found
}

/// The owner wallet of a token account, or the token account itself when the
/// transaction carries no record of its owner.
fn owner_or_account(info: Option<&TokenAccount>, token_account: &[u8]) -> String {
    info.and_then(|a| a.owner.clone())
        .unwrap_or_else(|| base58::encode(token_account))
}
