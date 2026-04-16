import { base58 } from "@scure/base";
import { addressToPublicKeyBytes } from "./solana-address.js";

// Solana transaction construction, limited to what's needed for a native-SOL
// transfer. Phase 7.5 adds SPL TransferChecked for USDC/USDT. That extension
// lives entirely in this file + solana-chain.adapter — no core/domain changes.

// System Program — the built-in program that handles native SOL transfers.
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// "Compact-u16" / "shortvec" length prefix used pervasively in Solana's wire
// format. Integers 0..127 fit in one byte; 128..16383 in two; 16384..65535 in three.
export function encodeCompactU16(n: number): Uint8Array {
  if (n < 0 || n > 0xffff) throw new Error(`compact-u16 out of range: ${n}`);
  const out: number[] = [];
  let remaining = n;
  while (true) {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining === 0) {
      out.push(byte);
      return new Uint8Array(out);
    }
    byte |= 0x80;
    out.push(byte);
  }
}

// Concatenate arbitrary byte buffers.
export function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// Little-endian u64 encoding for instruction amount fields.
export function u64le(n: bigint): Uint8Array {
  if (n < 0n) throw new Error(`u64 must be non-negative: ${n}`);
  const out = new Uint8Array(8);
  let remaining = n;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining > 0n) throw new Error(`u64 overflow: ${n}`);
  return out;
}

// Build the raw-message bytes for a single native SOL transfer.
// `sourceAddress` is the payer + signer; `destinationAddress` is the recipient.
export function buildNativeTransferMessage(args: {
  sourceAddress: string;
  destinationAddress: string;
  lamports: bigint;
  recentBlockhash: string; // base58-encoded 32 bytes
}): Uint8Array {
  const sourcePubkey = addressToPublicKeyBytes(args.sourceAddress);
  const destPubkey = addressToPublicKeyBytes(args.destinationAddress);
  const systemProgramPubkey = addressToPublicKeyBytes(SYSTEM_PROGRAM_ID);
  const blockhashBytes = base58.decode(args.recentBlockhash);
  if (blockhashBytes.length !== 32) {
    throw new Error(`recentBlockhash must decode to 32 bytes, got ${blockhashBytes.length}`);
  }

  // Account ordering: signer(s) first, then read-write non-signers, then
  // read-only non-signers (which programs fall under). For a transfer:
  //   [0] source        — signer, writable
  //   [1] destination   — non-signer, writable
  //   [2] system program — non-signer, read-only (invoked as program)
  const accountKeys = [sourcePubkey, destPubkey, systemProgramPubkey];

  // Header: num_required_signatures, num_readonly_signed, num_readonly_unsigned.
  const header = new Uint8Array([1, 0, 1]);

  // Instruction: transfer = discriminator 2 (u32 LE), followed by lamports (u64 LE).
  const instructionData = new Uint8Array(12);
  instructionData[0] = 2; // SystemProgram::Transfer = 2
  // bytes 1-3 stay zero (u32 LE, only LSB used)
  instructionData.set(u64le(args.lamports), 4);

  const instructionBytes = concatBytes(
    new Uint8Array([2]), // program_id_index (systemProgramPubkey at index 2)
    encodeCompactU16(2), // account-index count
    new Uint8Array([0, 1]), // account indices: source, destination
    encodeCompactU16(instructionData.length),
    instructionData
  );

  return concatBytes(
    header,
    encodeCompactU16(accountKeys.length),
    ...accountKeys,
    blockhashBytes,
    encodeCompactU16(1), // one instruction
    instructionBytes
  );
}

// Wrap a signed message into the full on-wire transaction form and return
// base58. Format: compact-array of signatures, each 64 bytes, then the
// message bytes. For a single-signer transfer there is exactly one signature.
export function encodeSignedTransaction(message: Uint8Array, signatures: readonly Uint8Array[]): string {
  const parts: Uint8Array[] = [encodeCompactU16(signatures.length)];
  for (const sig of signatures) {
    if (sig.length !== 64) throw new Error(`ed25519 signature must be 64 bytes, got ${sig.length}`);
    parts.push(sig);
  }
  parts.push(message);
  return base58.encode(concatBytes(...parts));
}
