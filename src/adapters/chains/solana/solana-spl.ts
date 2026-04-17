import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { addressToPublicKeyBytes } from "./solana-address.js";
import { concatBytes, encodeCompactU16, u64le } from "./solana-message.js";

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
//   - ComputeBudget instructions. Default CU limit (200k) is ample for
//     one CreateIdempotent + one TransferChecked (~20k CU combined).

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

// Build a single-signer SPL TransferChecked transaction message, preceded by
// an idempotent ATA-create instruction so the recipient's token account is
// materialized on-demand if missing. Both instructions live in the same
// atomic transaction — if the create fails, the transfer never lands.
//
// Account-key ordering follows Solana's strict layout rule:
//   signers (writable, then readonly) → non-signers (writable, then readonly)
//
// For this flow:
//   [0] sender owner                       — signer, writable (fee payer)
//   [1] sender ATA                         — non-signer, writable
//   [2] recipient ATA                      — non-signer, writable (may be created)
//   [3] mint                               — non-signer, readonly
//   [4] recipient owner                    — non-signer, readonly
//   [5] system program                     — non-signer, readonly
//   [6] SPL token program                  — non-signer, readonly
//   [7] associated-token program           — non-signer, readonly (program invoked)
export function buildSplTransferMessage(args: {
  senderOwner: string;
  senderAssociatedTokenAccount: string;
  recipientOwner: string;
  recipientAssociatedTokenAccount: string;
  mintAddress: string;
  amount: bigint;
  decimals: number;
  recentBlockhash: string;
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

  const accountKeys = [
    senderOwnerPk,
    senderAtaPk,
    recipientAtaPk,
    mintPk,
    recipientOwnerPk,
    systemProgramPk,
    tokenProgramPk,
    assocProgramPk
  ];

  // Header: 1 required signature (sender owner), 0 readonly-signed,
  // 5 readonly-unsigned (mint, recipient owner, system, token, assoc).
  const header = new Uint8Array([1, 0, 5]);

  const blockhashBytes = base58.decode(args.recentBlockhash);
  if (blockhashBytes.length !== 32) {
    throw new Error(`recentBlockhash must decode to 32 bytes, got ${blockhashBytes.length}`);
  }

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
    new Uint8Array([7]), // program_id_index = assoc program
    encodeCompactU16(6),
    new Uint8Array([0, 2, 4, 3, 5, 6]), // sender, ata, wallet, mint, system, token
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
    new Uint8Array([6]), // program_id_index = token program
    encodeCompactU16(4),
    new Uint8Array([1, 3, 2, 0]), // sender_ata, mint, dest_ata, owner
    encodeCompactU16(transferData.length),
    transferData
  );

  return concatBytes(
    header,
    encodeCompactU16(accountKeys.length),
    ...accountKeys,
    blockhashBytes,
    encodeCompactU16(2), // two instructions: create-idempotent, then transfer
    createAtaIx,
    transferIx
  );
}
