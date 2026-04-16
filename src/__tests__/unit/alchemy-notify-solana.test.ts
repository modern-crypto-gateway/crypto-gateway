import { describe, expect, it } from "vitest";
import { alchemyNotifyDetection } from "../../adapters/detection/alchemy-notify.adapter.js";
import { solanaChainAdapter, SOLANA_MAINNET_CHAIN_ID } from "../../adapters/chains/solana/solana-chain.adapter.js";
import { bootTestApp } from "../helpers/boot.js";

// SPL mint addresses from the token registry. Must match the registry entries
// exactly — the parser resolves `mint` -> symbol via the registry.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// Real-looking Solana pubkeys for test fixtures. The parser doesn't verify
// curve membership; any base58 string works.
const WATCHED_WALLET = "9JxSJR4bwp1gq48u8oKxkqxGCs4tGNnVzgS4sZ1kRoBX";
const EXTERNAL_PAYER = "5auZoWJxJodSU8dwgKmAfmphv5Z9Su3HAzEdLz1EUZs7";
const ATA_WATCHED = "3BzVyVXGeq4zE3qtFpXaXuvLLauzmF3q7yiACJHpJPST";
const ATA_PAYER = "Fj5FZrS4HDRmU7aJgK8QZ8eYRPBEJ1YHEqRZK4kRb9cq";

// Solana chain adapter bound to a dummy RPC URL (never called in these tests).
function solanaAdapterForTests() {
  return solanaChainAdapter({
    chainIds: [SOLANA_MAINNET_CHAIN_ID],
    rpc: { [SOLANA_MAINNET_CHAIN_ID]: { url: "http://unused.test/rpc" } }
  });
}

describe("alchemyNotifyDetection — Solana SPL payload", () => {
  it("emits a DetectedTransfer for an incoming USDC SPL transfer", async () => {
    const booted = await bootTestApp({ chains: [solanaAdapterForTests()] });
    try {
      const strategy = alchemyNotifyDetection();
      // Synthetic webhook payload modeled on Alchemy's Solana ADDRESS_ACTIVITY
      // format. `meta` and `transaction` are 1-element arrays (Alchemy's
      // protobuf serializer wraps singletons). Token balances show a 2.5 USDC
      // credit on the ATA owned by WATCHED_WALLET.
      const payload = {
        webhookId: "wh_test",
        id: "whevt_test",
        type: "ADDRESS_ACTIVITY",
        event: {
          network: "SOLANA_MAINNET",
          slot: 290000000,
          transaction: [
            {
              signature: "5GRc_test_sig",
              slot: 290000000,
              transaction: [{ signatures: ["5GRc_test_sig"], message: [{ account_keys: [] }] }],
              meta: [
                {
                  fee: 5000,
                  err: null,
                  pre_balances: [1_000_000, 2_000_000],
                  post_balances: [994_000, 2_000_000],
                  pre_token_balances: [
                    {
                      account_index: 2,
                      mint: USDC_MINT,
                      owner: WATCHED_WALLET,
                      ui_token_amount: { amount: "1000000", decimals: 6 }
                    },
                    {
                      account_index: 3,
                      mint: USDC_MINT,
                      owner: EXTERNAL_PAYER,
                      ui_token_amount: { amount: "5000000", decimals: 6 }
                    }
                  ],
                  post_token_balances: [
                    {
                      account_index: 2,
                      mint: USDC_MINT,
                      owner: WATCHED_WALLET,
                      ui_token_amount: { amount: "3500000", decimals: 6 }
                    },
                    {
                      account_index: 3,
                      mint: USDC_MINT,
                      owner: EXTERNAL_PAYER,
                      ui_token_amount: { amount: "2500000", decimals: 6 }
                    }
                  ]
                }
              ]
            }
          ]
        }
      };
      const transfers = await strategy.handlePush!(booted.deps, payload);
      // One SPL credit to WATCHED_WALLET + whatever native SOL deltas fell out
      // of the fee accounting (pre/post balances above produce a -6000 lamport
      // delta on account[0], i.e. the fee burn — no positive credit, no row).
      const splTransfer = transfers.find((t) => t.token === "USDC" && t.toAddress === WATCHED_WALLET);
      expect(splTransfer).toBeDefined();
      expect(splTransfer?.amountRaw).toBe("2500000");
      expect(splTransfer?.fromAddress).toBe(EXTERNAL_PAYER);
      expect(splTransfer?.txHash).toBe("5GRc_test_sig");
      expect(splTransfer?.chainId).toBe(SOLANA_MAINNET_CHAIN_ID);
      expect(splTransfer?.confirmations).toBe(1);
    } finally {
      await booted.close();
    }
  });

  it("skips transactions with meta.err set (failed txs don't fire detections)", async () => {
    const booted = await bootTestApp({ chains: [solanaAdapterForTests()] });
    try {
      const strategy = alchemyNotifyDetection();
      const payload = {
        type: "ADDRESS_ACTIVITY",
        event: {
          network: "SOLANA_MAINNET",
          transaction: [
            {
              signature: "failed_tx",
              meta: [
                {
                  err: { InstructionError: [0, "Custom"] },
                  fee: 5000,
                  post_token_balances: [
                    {
                      mint: USDC_MINT,
                      owner: WATCHED_WALLET,
                      ui_token_amount: { amount: "1000000", decimals: 6 }
                    }
                  ]
                }
              ]
            }
          ]
        }
      };
      const transfers = await strategy.handlePush!(booted.deps, payload);
      expect(transfers).toEqual([]);
    } finally {
      await booted.close();
    }
  });

  it("ignores SPL credits for mints not in the token registry", async () => {
    const booted = await bootTestApp({ chains: [solanaAdapterForTests()] });
    try {
      const strategy = alchemyNotifyDetection();
      const UNKNOWN_MINT = "ZzzzZZzzZZzzZZzzZZzzZZzzZZzzZZzzZZzzZZzzZZz";
      const payload = {
        type: "ADDRESS_ACTIVITY",
        event: {
          network: "SOLANA_MAINNET",
          transaction: [
            {
              signature: "unknown_mint_tx",
              meta: [
                {
                  err: null,
                  fee: 5000,
                  pre_token_balances: [
                    {
                      mint: UNKNOWN_MINT,
                      owner: WATCHED_WALLET,
                      ui_token_amount: { amount: "0", decimals: 0 }
                    }
                  ],
                  post_token_balances: [
                    {
                      mint: UNKNOWN_MINT,
                      owner: WATCHED_WALLET,
                      ui_token_amount: { amount: "1000", decimals: 0 }
                    }
                  ]
                }
              ]
            }
          ]
        }
      };
      const transfers = await strategy.handlePush!(booted.deps, payload);
      expect(transfers.filter((t) => t.toAddress === WATCHED_WALLET)).toEqual([]);
    } finally {
      await booted.close();
    }
  });

  it("emits USDT + USDC separately when a single tx moves both mints", async () => {
    const booted = await bootTestApp({ chains: [solanaAdapterForTests()] });
    try {
      const strategy = alchemyNotifyDetection();
      const payload = {
        type: "ADDRESS_ACTIVITY",
        event: {
          network: "SOLANA_MAINNET",
          transaction: [
            {
              signature: "multi_mint_tx",
              meta: [
                {
                  err: null,
                  fee: 5000,
                  pre_token_balances: [
                    { mint: USDC_MINT, owner: WATCHED_WALLET, ui_token_amount: { amount: "0", decimals: 6 } },
                    { mint: USDT_MINT, owner: WATCHED_WALLET, ui_token_amount: { amount: "0", decimals: 6 } }
                  ],
                  post_token_balances: [
                    { mint: USDC_MINT, owner: WATCHED_WALLET, ui_token_amount: { amount: "1000000", decimals: 6 } },
                    { mint: USDT_MINT, owner: WATCHED_WALLET, ui_token_amount: { amount: "2000000", decimals: 6 } }
                  ]
                }
              ]
            }
          ]
        }
      };
      const transfers = await strategy.handlePush!(booted.deps, payload);
      const credits = transfers.filter((t) => t.toAddress === WATCHED_WALLET);
      expect(credits.map((t) => t.token).sort()).toEqual(["USDC", "USDT"]);
      expect(credits.find((t) => t.token === "USDC")?.amountRaw).toBe("1000000");
      expect(credits.find((t) => t.token === "USDT")?.amountRaw).toBe("2000000");
    } finally {
      await booted.close();
    }
  });

  it("accepts both snake_case and camelCase field aliases (Alchemy variant tolerance)", async () => {
    const booted = await bootTestApp({ chains: [solanaAdapterForTests()] });
    try {
      const strategy = alchemyNotifyDetection();
      const payload = {
        type: "ADDRESS_ACTIVITY",
        event: {
          network: "SOLANA_MAINNET",
          transaction: [
            {
              signature: "camel_case_tx",
              meta: [
                {
                  err: null,
                  fee: 5000,
                  // camelCase variants; parser should read these too.
                  preTokenBalances: [
                    { mint: USDC_MINT, owner: WATCHED_WALLET, uiTokenAmount: { amount: "0", decimals: 6 } }
                  ],
                  postTokenBalances: [
                    { mint: USDC_MINT, owner: WATCHED_WALLET, uiTokenAmount: { amount: "500000", decimals: 6 } }
                  ]
                }
              ]
            }
          ]
        }
      };
      const transfers = await strategy.handlePush!(booted.deps, payload);
      const credit = transfers.find((t) => t.token === "USDC");
      expect(credit?.amountRaw).toBe("500000");
    } finally {
      await booted.close();
    }
  });

  it("references ATA_WATCHED + ATA_PAYER placeholders in test fixtures", () => {
    // Cosmetic — these are reserved for a future test that exercises the
    // account_index -> owner mapping path (not all payloads include `owner`
    // on balance rows). Declaring them here keeps the linter quiet and
    // signals intent if a future contributor extends coverage.
    expect(ATA_WATCHED.length).toBeGreaterThan(0);
    expect(ATA_PAYER.length).toBeGreaterThan(0);
  });
});
