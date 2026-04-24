import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { addressToPublicKeyBytes } from "./solana-address.js";
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  computeBudgetInstructionBytes,
  concatBytes,
  encodeCompactU16,
  encodeSetComputeUnitLimit,
  encodeSetComputeUnitPrice,
  u64le
} from "./solana-message.js";

// SPL / Associated Token Account support for Solana payouts.
//
// Layered on top of the native-SOL transaction builder in solana-message.ts.
// `buildSplTransferTransaction` returns the wire-ready message for a
// TransferChecked to the recipient's Associated Token Account (ATA), preceded
// by an idempotent ATA-create so first-time recipients don't need to have
// clicked anything on-chain beforehand.
//
// Not supported (and not needed for any merchant flow we ship):
//   - Token-2022 program (uses a different program id). All mainnet stables
//     are on the classic Token program today.
//   - Multi-signer fee payers / arbitrary payer != owner. The source wallet
//     always pays its own rent + fee.
//
// ComputeBudget instructions ARE supported (optional). Pass
// `{ computeUnitLimit, computeUnitPriceMicroLamports }` to bind priority
// fees so the tx actually lands during congestion. Without it, the tx uses
// the Solana default (200k CU limit, zero priority) and may sit in the
// pending pool while higher-priority txs land first.

// Classic SPL Token program.
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// Associated Token Account program — canonical ATA derivation + creation.
export const SPL_ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
// Stock System program — we need it as a read-only account ref when the
// CreateIdempotent instruction has to allocate a new ATA.
export const SPL_SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// Derive the Associated Token Account address (a Program Derived Address) for
// `{owner, mint}` under the classic SPL token program. Solana PDA derivation
// is: SHA-256(seeds || bump || programId || "ProgramDerivedAddress") for bump
// 255 down to 0, picking the first result that is NOT a valid ed25519 point —
// the off-curve constraint is what makes PDAs un-signable and thus safe to
// treat as program-owned addresses.
export function deriveAssociatedTokenAccount(ownerAddress: string, mintAddress: string): string {
  const ownerBytes = addressToPublicKeyBytes(ownerAddress);
  const tokenProgramBytes = addressToPublicKeyBytes(SPL_TOKEN_PROGRAM_ID);
  const mintBytes = addressToPublicKeyBytes(mintAddress);
  const associatedProgramBytes = addressToPublicKeyBytes(SPL_ASSOCIATED_TOKEN_PROGRAM_ID);
  const pdaMarker = new TextEncoder().encode("ProgramDerivedAddress");

  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = sha256(
      concatBytes(
        ownerBytes,
        tokenProgramBytes,
        mintBytes,
        new Uint8Array([bump]),
        associatedProgramBytes,
        pdaMarker
      )
    );
    if (!isOnEd25519Curve(hash)) {
      return base58.encode(hash);
    }
  }
  // Statistically unreachable (probability ~2^-256) — a seed that collides
  // with on-curve points for every possible bump would be a hash break.
  throw new Error(`deriveAssociatedTokenAccount: no off-curve bump found for ${ownerAddress} / ${mintAddress}`);
}

// Returns true iff the 32-byte sequence decodes as a valid ed25519 public key.
// Uses noble's Point.fromBytes which validates the curve equation and rejects
// non-canonical encodings.
function isOnEd25519Curve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

// Build a SPL TransferChecked transaction message, preceded by an idempotent
// ATA-create instruction so the recipient's token account is materialized
// on-demand if missing. Both instructions live in the same atomic tx — if
// the create fails, the transfer never lands.
//
// Two layouts are supported, selected by the presence of `feePayerAddress`:
//
// Single-signer (no `feePayerAddress`, sender pays its own fee + ATA rent):
//   [0] sender owner         — signer, writable (fee payer + transfer authority)
//   [1] sender ATA           — non-signer, writable
//   [2] recipient ATA        — non-signer, writable (may be created)
//   [3] mint                 — non-signer, readonly
//   [4] recipient owner      — non-signer, readonly
//   [5] system program       — non-signer, readonly
//   [6] SPL token program    — non-signer, readonly
//   [7] associated-token prg — non-signer, readonly
//
// Co-signed (`feePayerAddress` set; fee wallet pays sig fee + ATA rent,
// sender is just the transfer authority):
//   [0] fee wallet           — signer, writable (fee payer + ATA rent payer)
//   [1] sender owner         — signer, readonly (transfer authority only)
//   [2] sender ATA           — non-signer, writable
//   [3] recipient ATA        — non-signer, writable
//   [4] mint                 — non-signer, readonly
//   [5] recipient owner      — non-signer, readonly
//   [6] system program       — non-signer, readonly
//   [7] SPL token program    — non-signer, readonly
//   [8] associated-token prg — non-signer, readonly
//
// In both layouts, when ComputeBudget instructions are included, the
// compute-budget program address is appended as the last readonly-unsigned
// account key.
export function buildSplTransferMessage(args: {
  senderOwner: string;
  senderAssociatedTokenAccount: string;
  recipientOwner: string;
  recipientAssociatedTokenAccount: string;
  mintAddress: string;
  amount: bigint;
  decimals: number;
  recentBlockhash: string;
  computeBudget?: {
    computeUnitLimit?: number;
    computeUnitPriceMicroLamports?: bigint;
  };
  // When set, the tx becomes a two-signer co-signed transaction with this
  // address as the fee payer. See the layout comment above for details.
  feePayerAddress?: string;
}): Uint8Array {
  if (args.decimals < 0 || args.decimals > 255) {
    throw new Error(`SPL decimals must fit in u8: ${args.decimals}`);
  }

  const senderOwnerPk = addressToPublicKeyBytes(args.senderOwner);
  const senderAtaPk = addressToPublicKeyBytes(args.senderAssociatedTokenAccount);
  const recipientAtaPk = addressToPublicKeyBytes(args.recipientAssociatedTokenAccount);
  const mintPk = addressToPublicKeyBytes(args.mintAddress);
  const recipientOwnerPk = addressToPublicKeyBytes(args.recipientOwner);
  const systemProgramPk = addressToPublicKeyBytes(SPL_SYSTEM_PROGRAM_ID);
  const tokenProgramPk = addressToPublicKeyBytes(SPL_TOKEN_PROGRAM_ID);
  const assocProgramPk = addressToPublicKeyBytes(SPL_ASSOCIATED_TOKEN_PROGRAM_ID);

  const cb = args.computeBudget;
  const hasCbLimit = cb?.computeUnitLimit !== undefined;
  const hasCbPrice = cb?.computeUnitPriceMicroLamports !== undefined;
  const hasCb = hasCbLimit || hasCbPrice;

  const hasFeePayer = args.feePayerAddress !== undefined;
  // Rejecting a feePayer that equals the sender owner: the two signers must
  // be distinct keys, otherwise the message is structurally invalid (the
  // sender would need to sign at both index 0 and index 1 with the same key,
  // producing an ambiguous tx). If an operator really wants a single-signer
  // tx, they should not register a fee wallet.
  if (hasFeePayer && args.feePayerAddress === args.senderOwner) {
    throw new Error("buildSplTransferMessage: feePayerAddress must differ from senderOwner");
  }

  const accountKeys = hasFeePayer
    ? [
        addressToPublicKeyBytes(args.feePayerAddress!), // [0] fee payer — writable signer
        senderOwnerPk,                                    // [1] transfer authority — readonly signer
        senderAtaPk,                                      // [2] writable non-signer
        recipientAtaPk,                                   // [3] writable non-signer
        mintPk,                                           // [4] readonly non-signer
        recipientOwnerPk,                                 // [5] readonly non-signer
        systemProgramPk,                                  // [6] readonly non-signer (program)
        tokenProgramPk,                                   // [7] readonly non-signer (program)
        assocProgramPk                                    // [8] readonly non-signer (program)
      ]
    : [
        senderOwnerPk,   // [0] writable signer (pays fee + is authority)
        senderAtaPk,     // [1] writable non-signer
        recipientAtaPk,  // [2] writable non-signer
        mintPk,          // [3] readonly non-signer
        recipientOwnerPk,// [4] readonly non-signer
        systemProgramPk, // [5] readonly non-signer (program)
        tokenProgramPk,  // [6] readonly non-signer (program)
        assocProgramPk   // [7] readonly non-signer (program)
      ];
  const computeBudgetIdx = accountKeys.length;
  if (hasCb) {
    accountKeys.push(addressToPublicKeyBytes(COMPUTE_BUDGET_PROGRAM_ID));
  }

  // Header: [numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned].
  // Co-signed layout: 2 sigs (fee payer writable + sender readonly), 1
  // readonly-signed (sender owner), 5 readonly-unsigned (mint, recipient
  // owner, system, token, assoc) +1 with compute budget.
  const header = hasFeePayer
    ? new Uint8Array([2, 1, hasCb ? 6 : 5])
    : new Uint8Array([1, 0, hasCb ? 6 : 5]);

  const blockhashBytes = base58.decode(args.recentBlockhash);
  if (blockhashBytes.length !== 32) {
    throw new Error(`recentBlockhash must decode to 32 bytes, got ${blockhashBytes.length}`);
  }

  // ---- Instruction indices ----
  //
  // Account indices in instructions reference positions in `accountKeys`.
  // The no-feePayer and with-feePayer layouts differ; pick the right set.
  // Layout offsets:
  //   no feePayer:  senderOwner=0, senderAta=1, recipientAta=2, mint=3,
  //                 recipientOwner=4, system=5, token=6, assoc=7
  //   w/ feePayer:  feePayer=0, senderOwner=1, senderAta=2, recipientAta=3,
  //                 mint=4, recipientOwner=5, system=6, token=7, assoc=8
  const IX_IDX = hasFeePayer
    ? {
        ataPayer: 0,       // fee wallet pays the new-ATA rent
        senderOwner: 1,
        senderAta: 2,
        recipientAta: 3,
        mint: 4,
        recipientOwner: 5,
        systemProgram: 6,
        tokenProgram: 7,
        assocProgram: 8
      }
    : {
        ataPayer: 0,       // sender is both fee payer and ATA-rent payer
        senderOwner: 0,
        senderAta: 1,
        recipientAta: 2,
        mint: 3,
        recipientOwner: 4,
        systemProgram: 5,
        tokenProgram: 6,
        assocProgram: 7
      };

  // ---- Instruction 1: CreateIdempotent ATA for recipient ----
  //
  // Associated-token program discriminator layout:
  //   0 = Create          (errors if the account already exists)
  //   1 = CreateIdempotent (skips if account exists) ← what we want
  //
  // Account order per https://docs.rs/spl-associated-token-account:
  //   [payer (signer, writable), ata (writable), wallet (readonly),
  //    mint (readonly), system_program, token_program]
  const createAtaData = new Uint8Array([1]);
  const createAtaIx = concatBytes(
    new Uint8Array([IX_IDX.assocProgram]),
    encodeCompactU16(6),
    new Uint8Array([
      IX_IDX.ataPayer,
      IX_IDX.recipientAta,
      IX_IDX.recipientOwner,
      IX_IDX.mint,
      IX_IDX.systemProgram,
      IX_IDX.tokenProgram
    ]),
    encodeCompactU16(createAtaData.length),
    createAtaData
  );

  // ---- Instruction 2: TransferChecked ----
  //
  // SPL Token program instruction layout for TransferChecked:
  //   discriminator = 12, then amount (u64 LE), then decimals (u8)
  //
  // Accounts:
  //   [source ATA (writable), mint (readonly), dest ATA (writable),
  //    owner (signer, readonly)]
  const transferData = new Uint8Array(1 + 8 + 1);
  transferData[0] = 12;
  transferData.set(u64le(args.amount), 1);
  transferData[9] = args.decimals;
  const transferIx = concatBytes(
    new Uint8Array([IX_IDX.tokenProgram]),
    encodeCompactU16(4),
    new Uint8Array([IX_IDX.senderAta, IX_IDX.mint, IX_IDX.recipientAta, IX_IDX.senderOwner]),
    encodeCompactU16(transferData.length),
    transferData
  );

  // ComputeBudget instructions go FIRST. SetComputeUnitLimit and
  // SetComputeUnitPrice are both optional — include each only when the
  // caller supplied the corresponding value.
  const prefixInstructions: Uint8Array[] = [];
  if (hasCbLimit) {
    prefixInstructions.push(
      computeBudgetInstructionBytes(
        computeBudgetIdx,
        encodeSetComputeUnitLimit(cb!.computeUnitLimit!)
      )
    );
  }
  if (hasCbPrice) {
    prefixInstructions.push(
      computeBudgetInstructionBytes(
        computeBudgetIdx,
        encodeSetComputeUnitPrice(cb!.computeUnitPriceMicroLamports!)
      )
    );
  }
  const allInstructions = [...prefixInstructions, createAtaIx, transferIx];

  return concatBytes(
    header,
    encodeCompactU16(accountKeys.length),
    ...accountKeys,
    blockhashBytes,
    encodeCompactU16(allInstructions.length),
    ...allInstructions
  );
}
