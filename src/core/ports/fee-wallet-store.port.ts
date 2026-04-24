import type { ChainFamily } from "../types/chain.js";

// Persistent repository for the per-family fee-wallet configuration. At most
// one row per family; operators swap by `remove` + `put`. The store is
// deliberately thin — domain logic (capability checks, signing, broadcast
// wiring) lives in chain adapters and the payout service. This port is just
// the shape of what gets written to / read from the fee_wallets table, with
// the imported-key ciphertext separated from the plaintext API so the
// storage layer never sees raw keys.

export interface FeeWalletRecord {
  readonly family: ChainFamily;
  // How the private key is resolved at sign time.
  //   "hd-pool"   — `address` points at an existing address_pool row in the
  //                 same family; signerStore derives the key from MASTER_SEED
  //                 on demand.
  //   "imported"  — ciphertext/nonce are present; signerStore decrypts via
  //                 secretsCipher.
  readonly mode: "hd-pool" | "imported";
  readonly address: string;
}

// A row already persisted, including the encrypted-at-rest private key
// payload when mode='imported'. Returned by `getWithSecret` only — the
// public `get` surface omits the ciphertext so domain code can't
// accidentally copy it around. Ciphertext is the self-describing
// secretsCipher format (currently `v1:<base64>`; nonce + auth tag are
// bundled inside the encoded payload, no separate nonce field needed).
export interface FeeWalletRecordWithSecret extends FeeWalletRecord {
  readonly privateKeyCiphertext: string | null;
}

// Shape passed to `put`. Writers supply the plaintext private key for
// imported mode; the store itself encrypts via secretsCipher before the
// INSERT, so plaintext never touches a log or a DB row. For hd-pool mode
// the `privateKey` field is omitted.
export type PutFeeWalletInput =
  | {
      readonly family: ChainFamily;
      readonly mode: "hd-pool";
      readonly address: string;
    }
  | {
      readonly family: ChainFamily;
      readonly mode: "imported";
      readonly address: string;
      // Raw private key bytes as hex (with or without 0x prefix — the
      // store canonicalizes). Zeroed from memory after encryption.
      readonly privateKey: string;
    };

export interface FeeWalletStore {
  // Fetch the record for a family, or null when none is registered. Does
  // NOT return ciphertext — use `getWithSecret` on the signing path only.
  get(family: ChainFamily): Promise<FeeWalletRecord | null>;

  // Signing-path variant: returns the record + ciphertext so the caller
  // can decrypt via secretsCipher. Throws when no row exists (caller
  // should have checked `get` first) — this is intentional, makes a bug
  // where we try to decrypt a non-existent wallet fail loudly.
  getWithSecret(family: ChainFamily): Promise<FeeWalletRecordWithSecret>;

  // Upsert the row. Encrypts the plaintext key inline for imported mode;
  // no existing ciphertext is ever overwritten with plaintext. The store
  // replaces any prior registration for the same family (one-per-family
  // invariant is enforced at the DB level too).
  put(input: PutFeeWalletInput): Promise<FeeWalletRecord>;

  // Remove the row for this family. Returns true if a row was deleted,
  // false if none existed (idempotent).
  remove(family: ChainFamily): Promise<boolean>;

  // Fast existence check. Used by the chain adapter's fee-wallet path
  // gate: no row → no capability → planner stays on the self-pay flow.
  has(family: ChainFamily): Promise<boolean>;
}
