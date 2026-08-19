import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isTronChainAdapter,
  TRON_MAINNET_CHAIN_ID
} from "../../../../adapters/chains/tron/tron-chain.adapter.js";
import type { TronRpcBackend } from "../../../../adapters/chains/tron/tron-rpc.js";
import { wireTron } from "../../../../adapters/chains/tron/wire.js";
import type { Logger } from "../../../../core/ports/logger.port.js";

const WATCHED_ADDRESS = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function noopLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger
  };
  return logger;
}

function wireBothProviders(): TronRpcBackend {
  const result = wireTron({
    network: "mainnet",
    alchemyApiKey: "alchemy-key",
    trongridApiKey: "trongrid-key",
    logger: noopLogger()
  });
  if (result.chainAdapter === undefined || !isTronChainAdapter(result.chainAdapter)) {
    throw new Error("expected the Tron chain adapter to be wired");
  }
  return result.chainAdapter.tronBackend(TRON_MAINNET_CHAIN_ID);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("wireTron provider priority", () => {
  it("uses Alchemy first for supported /wallet methods", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        urls.push(url);
        if (url === "https://tron-mainnet.g.alchemy.com/v2/alchemy-key/wallet/getnowblock") {
          return new Response(
            JSON.stringify({ block_header: { raw_data: { number: 123 } } }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const backend = wireBothProviders();
    expect(backend.name).toBe("composite(alchemy-tron,trongrid)");

    const block = await backend.getNowBlock();

    expect(block.block_header.raw_data.number).toBe(123);
    expect(urls).toEqual([
      "https://tron-mainnet.g.alchemy.com/v2/alchemy-key/wallet/getnowblock"
    ]);
  });

  it("falls back to TronGrid when an Alchemy /wallet request fails", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        urls.push(url);
        if (url.startsWith("https://tron-mainnet.g.alchemy.com/")) {
          return new Response("temporarily unavailable", { status: 503 });
        }
        if (url === "https://api.trongrid.io/wallet/getnowblock") {
          return new Response(
            JSON.stringify({ block_header: { raw_data: { number: 456 } } }),
            { status: 200 }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const block = await wireBothProviders().getNowBlock();

    expect(block.block_header.raw_data.number).toBe(456);
    expect(urls).toEqual([
      "https://tron-mainnet.g.alchemy.com/v2/alchemy-key/wallet/getnowblock",
      "https://api.trongrid.io/wallet/getnowblock"
    ]);
  });

  it("routes both indexed detection list methods directly to TronGrid", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        urls.push(url);
        if (!url.startsWith("https://api.trongrid.io/v1/accounts/")) {
          throw new Error(`unexpected fetch: ${url}`);
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      })
    );

    const backend = wireBothProviders();
    await backend.listTrc20Transfers(WATCHED_ADDRESS, { limit: 200 });
    await backend.listTrxTransfers(WATCHED_ADDRESS, { limit: 200 });

    expect(urls).toEqual([
      `https://api.trongrid.io/v1/accounts/${WATCHED_ADDRESS}/transactions/trc20?only_to=true&limit=200`,
      `https://api.trongrid.io/v1/accounts/${WATCHED_ADDRESS}/transactions?only_to=true&only_confirmed=true&search_internal=false&limit=200`
    ]);
  });
});
