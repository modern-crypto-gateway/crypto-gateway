import { base58 } from "@scure/base";
import { addressToPublicKeyBytes } from "./solana-address.js";

// Solana transaction construction, limited to what's needed for a native-SOL
// transfer. Phase 7.5 adds SPL TransferChecked for USDC/USDT. That extension
// lives entirely in this file + solana-chain.adapter — no core/domain changes.

// System Program — the built-in program that handles native SOL transfers.
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
// ComputeBudget — the built-in program that raises/lowers compute-unit caps
// and sets per-compute-unit priority fees. Every SLIP/SPL tx that wants to
// influence landing priority on congested mainnet prepends one or two
// ComputeBudget instructions before its real work.
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

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

// Little-endian u32 encoding for instruction fields that take a compute-unit
// count (ComputeBudget SetComputeUnitLimit).
export function u32le(n: number): Uint8Array {
  if (n < 0 || n > 0xffffffff) throw new Error(`u32 out of range: ${n}`);
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

// Build the raw instruction bytes for a ComputeBudget instruction. Takes
// `programIdIndex` (the index of ComputeBudget in the tx's accountKeys) and
// a discriminator+payload pair. ComputeBudget instructions take NO account
// inputs, so the account-indices array is always empty.
export function computeBudgetInstructionBytes(
  programIdIndex: number,
  data: Uint8Array
): Uint8Array {
  return concatBytes(
    new Uint8Array([programIdIndex]),
    encodeCompactU16(0), // zero account indices
    encodeCompactU16(data.length),
    data
  );
}

// ComputeBudget SetComputeUnitLimit — discriminator 2, u32 LE limit.
export function encodeSetComputeUnitLimit(units: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = 2;
  out.set(u32le(units), 1);
  return out;
}

// ComputeBudget SetComputeUnitPrice — discriminator 3, u64 LE micro-lamports.
export function encodeSetComputeUnitPrice(microLamports: bigint): Uint8Array {
  const out = new Uint8Array(9);
  out[0] = 3;
  out.set(u64le(microLamports), 1);
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
//
// Optional `computeBudget` binds priority fees via ComputeBudget instructions
// prepended to the tx. When set, ComputeBudget is added to accountKeys (as a
// readonly program) and one or two instructions precede the transfer:
//   - SetComputeUnitLimit(limit) — caps the tx's CU allocation
//   - SetComputeUnitPrice(microLamportsPerCu) — binds the priority fee paid
//     per CU consumed. Validators prioritize txs with higher prices during
//     congestion. When omitted, the Solana default (null price, ~200k CU
//     limit) applies and the tx only pays the base signature fee (5k
//     lamports) — fine on quiet networks, risky during congestion.
export function buildNativeTransferMessage(args: {
  sourceAddress: string;
  destinationAddress: string;
  lamports: bigint;
  recentBlockhash: string; // base58-encoded 32 bytes
  computeBudget?: {
    computeUnitLimit?: number;
    computeUnitPriceMicroLamports?: bigint;
  };
  // When set, the tx becomes a two-signer co-signed transaction with this
  // address as the fee payer (accountKeys[0], writable signer). The source
  // becomes a readonly signer (it authorizes the transfer but doesn't pay
  // the signature fee). Source's SOL balance still drops by `lamports` —
  // only the ~5000-lamport signature fee shifts to the fee payer.
  feePayerAddress?: string;
}): Uint8Array {
  const sourcePubkey = addressToPublicKeyBytes(args.sourceAddress);
  const destPubkey = addressToPublicKeyBytes(args.destinationAddress);
  const systemProgramPubkey = addressToPublicKeyBytes(SYSTEM_PROGRAM_ID);
  const blockhashBytes = base58.decode(args.recentBlockhash);
  if (blockhashBytes.length !== 32) {
    throw new Error(`recentBlockhash must decode to 32 bytes, got ${blockhashBytes.length}`);
  }

  const cb = args.computeBudget;
  const hasCbLimit = cb?.computeUnitLimit !== undefined;
  const hasCbPrice = cb?.computeUnitPriceMicroLamports !== undefined;
  const hasCb = hasCbLimit || hasCbPrice;

  const hasFeePayer = args.feePayerAddress !== undefined;
  if (hasFeePayer && args.feePayerAddress === args.sourceAddress) {
    throw new Error("buildNativeTransferMessage: feePayerAddress must differ from sourceAddress");
  }

  // Account ordering: signers (writable then readonly), then non-signers
  // (writable then readonly). For a transfer:
  //
  // Single-signer (no feePayer):
  //   [0] source         — signer, writable (pays fee + is source of value)
  //   [1] destination    — non-signer, writable
  //   [2] system program — non-signer, readonly (program)
  //
  // Co-signed (feePayer set):
  //   [0] fee wallet     — signer, writable (pays signature fee only)
  //   [1] source         — signer, readonly (transfer authority — wait, source is writable)
  //
  // Wait — for a native SOL transfer where source sends SOL, source MUST
  // be writable (its lamports balance changes). So under co-sign the source
  // is a writable signer too:
  //   [0] fee wallet     — signer, writable
  //   [1] source         — signer, writable (both writable signers)
  //   [2] destination    — non-signer, writable
  //   [3] system program — non-signer, readonly
  // Header = [2, 0, 1] (both signers writable, 1 readonly-unsigned).
  const accountKeys = hasFeePayer
    ? [addressToPublicKeyBytes(args.feePayerAddress!), sourcePubkey, destPubkey, systemProgramPubkey]
    : [sourcePubkey, destPubkey, systemProgramPubkey];
  const computeBudgetIdx = accountKeys.length;
  if (hasCb) {
    accountKeys.push(addressToPublicKeyBytes(COMPUTE_BUDGET_PROGRAM_ID));
  }

  // Header: num_required_signatures, num_readonly_signed, num_readonly_unsigned.
  //   no feePayer: 1 signer (writable), 0 readonly-signed, 1 readonly-unsigned (+1 CB)
  //   w/ feePayer: 2 signers (both writable), 0 readonly-signed, 1 readonly-unsigned (+1 CB)
  const header = hasFeePayer
    ? new Uint8Array([2, 0, hasCb ? 2 : 1])
    : new Uint8Array([1, 0, hasCb ? 2 : 1]);

  // Instruction index offsets for the transfer instruction. Source-to-dest
  // account indices shift by +1 when feePayer is prepended.
  const sourceIdx = hasFeePayer ? 1 : 0;
  const destIdx = hasFeePayer ? 2 : 1;
  const systemIdx = hasFeePayer ? 3 : 2;

  // Instruction: transfer = discriminator 2 (u32 LE), followed by lamports (u64 LE).
  const instructionData = new Uint8Array(12);
  instructionData[0] = 2; // SystemProgram::Transfer = 2
  // bytes 1-3 stay zero (u32 LE, only LSB used)
  instructionData.set(u64le(args.lamports), 4);

  const transferInstructionBytes = concatBytes(
    new Uint8Array([systemIdx]),
    encodeCompactU16(2),
    new Uint8Array([sourceIdx, destIdx]),
    encodeCompactU16(instructionData.length),
    instructionData
  );

  // ComputeBudget instructions go FIRST in the tx. Build each optional one.
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

  const allInstructions = [...prefixInstructions, transferInstructionBytes];

  return concatBytes(
    header,
    encodeCompactU16(accountKeys.length),
    ...accountKeys,
    blockhashBytes,
    encodeCompactU16(allInstructions.length),
    ...allInstructions
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
