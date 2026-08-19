import { describe, expect, it } from "vitest";
import {
  TronHttpError,
  tronGridBackend,
  type TrongridTrc20Transfer
} from "../../../../adapters/chains/tron/tron-rpc.js";

const ADDRESS = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
const OTHER_ADDRESS = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

function trc20(id: string): TrongridTrc20Transfer {
  return {
    transaction_id: id,
    block_timestamp: 1_700_000_000_000,
    block: 55_000_000,
    from: OTHER_ADDRESS,
    to: ADDRESS,
    value: "1000000",
    token_info: {
      address: CONTRACT,
      decimals: 6,
      name: "Tether USD",
      symbol: "USDT"
    },
    type: "Transfer"
  };
}

function fakeClock(start = 0): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
} {
  let time = start;
  const sleeps: number[] = [];
  return {
    now: () => time,
    async sleep(ms: number) {
      sleeps.push(ms);
      time += ms;
    },
    sleeps
  };
}

describe("tronGridBackend rate limiting", () => {
  it("paces concurrent request starts to 10 QPS", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const backend = tronGridBackend({
      baseUrl: "https://pacing.test",
      apiKey: "pacing-key",
      requestsPerSecond: 10,
      now: clock.now,
      sleep: clock.sleep,
      sharedRateLimit: false,
      fetch: async () => {
        starts.push(clock.now());
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
    });

    await Promise.all([
      backend.listTrc20Transfers(ADDRESS),
      backend.listTrc20Transfers(OTHER_ADDRESS),
      backend.listTrc20Transfers("TK5uF5h3S7UG5VvFPY5akChfMSUwcgsh41")
    ]);

    expect(starts).toEqual([0, 100, 200]);
    expect(clock.sleeps).toEqual([100, 100]);
  });

  it("shares pacing across backend instances that use the same API key", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const config = {
      baseUrl: "https://shared-pacing.test",
      apiKey: "shared-pacing-key",
      requestsPerSecond: 10,
      now: clock.now,
      sleep: clock.sleep,
      sharedRateLimit: true,
      fetch: async () => {
        starts.push(clock.now());
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
    };
    const firstBackend = tronGridBackend(config);
    const secondBackend = tronGridBackend(config);

    await Promise.all([
      firstBackend.listTrc20Transfers(ADDRESS),
      secondBackend.listTrc20Transfers(OTHER_ADDRESS)
    ]);

    expect(starts).toEqual([0, 100]);
  });

  it("honors the longer body suspension, adds padding, and retries the queued request", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    let calls = 0;
    const backend = tronGridBackend({
      baseUrl: "https://cooldown-retry.test",
      apiKey: "cooldown-key",
      requestsPerSecond: 10,
      maxRetries: 1,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
      sharedRateLimit: false,
      fetch: async () => {
        starts.push(clock.now());
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({ Error: "The key exceeds the frequency limit(15), and the query server is suspended for 12 s" }),
            { status: 429, headers: { "retry-after": "1" } }
          );
        }
        return new Response(JSON.stringify({ data: [trc20("ok")] }), { status: 200 });
      }
    });

    const result = await backend.listTrc20Transfers(ADDRESS);

    expect(result.map((row) => row.transaction_id)).toEqual(["ok"]);
    expect(starts).toEqual([0, 12_500]);
    expect(clock.sleeps).toEqual([12_500]);
  });

  it("keeps queued siblings behind a request's complete 429 retry lifecycle", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    let calls = 0;
    const backend = tronGridBackend({
      baseUrl: "https://queued-during-retry.test",
      apiKey: "queued-retry-key",
      requestsPerSecond: 10,
      maxRetries: 1,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
      sharedRateLimit: false,
      fetch: async () => {
        starts.push(clock.now());
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({ Error: "The query server is suspended for 12 s" }),
            { status: 429 }
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
    });

    await Promise.all([
      backend.listTrc20Transfers(ADDRESS),
      backend.listTrc20Transfers(OTHER_ADDRESS)
    ]);

    // attempt 1, retry after cooldown+padding, then the queued sibling at the
    // normal 10-QPS spacing. No sibling escapes during the suspension.
    expect(starts).toEqual([0, 12_250, 12_350]);
  });

  it("publishes an exhausted 429 cooldown before the next queued call starts", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    let calls = 0;
    const backend = tronGridBackend({
      baseUrl: "https://cooldown-exhausted.test",
      apiKey: "cooldown-key",
      requestsPerSecond: 10,
      maxRetries: 0,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
      sharedRateLimit: false,
      fetch: async () => {
        starts.push(clock.now());
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({ Error: "The key exceeds the frequency limit(15), and the query server is suspended for 12s" }),
            { status: 429 }
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
    });

    const first = backend.listTrc20Transfers(ADDRESS);
    const second = backend.listTrc20Transfers(OTHER_ADDRESS);

    const firstError: unknown = await first.catch((err: unknown) => err);
    expect(firstError).toBeInstanceOf(TronHttpError);
    expect(firstError).toMatchObject({
      name: "TronHttpError",
      status: 429,
      retryAfterMs: 12_000
    });
    await expect(second).resolves.toEqual([]);
    expect(starts).toEqual([0, 12_250]);
  });

  it("parses an HTTP-date Retry-After against the injected clock", async () => {
    const start = Date.UTC(2026, 7, 8, 12, 0, 0);
    const clock = fakeClock(start);
    const backend = tronGridBackend({
      baseUrl: "https://http-date.test",
      maxRetries: 0,
      now: clock.now,
      sleep: clock.sleep,
      sharedRateLimit: false,
      fetch: async () => new Response("rate limited", {
        status: 429,
        headers: { "retry-after": new Date(start + 5_000).toUTCString() }
      })
    });

    const error: unknown = await backend.listTrc20Transfers(ADDRESS).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TronHttpError);
    expect(error).toMatchObject({ retryAfterMs: 5_000 });
  });
});

describe("tronGridBackend fingerprint pagination", () => {
  it("returns every TRC-20 page and preserves the fixed scan filters", async () => {
    const clock = fakeClock();
    const urls: string[] = [];
    const backend = tronGridBackend({
      baseUrl: "https://trc20-pages.test",
      now: clock.now,
      sleep: clock.sleep,
      sharedRateLimit: false,
      fetch: async (url) => {
        urls.push(url);
        if (urls.length === 1) {
          return new Response(
            JSON.stringify({ data: [trc20("page-1")], meta: { fingerprint: "next page" } }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ data: [trc20("page-2")], meta: {} }), { status: 200 });
      }
    });

    const rows = await backend.listTrc20Transfers(ADDRESS, {
      minTimestamp: 1000,
      maxTimestamp: 2000,
      contractAddress: CONTRACT,
      limit: 200
    });

    expect(rows.map((row) => row.transaction_id)).toEqual(["page-1", "page-2"]);
    expect(urls).toHaveLength(2);
    for (const raw of urls) {
      const url = new URL(raw);
      expect(url.searchParams.get("only_to")).toBe("true");
      expect(url.searchParams.get("min_timestamp")).toBe("1000");
      expect(url.searchParams.get("max_timestamp")).toBe("2000");
      expect(url.searchParams.get("contract_address")).toBe(CONTRACT);
      expect(url.searchParams.get("limit")).toBe("200");
    }
    expect(new URL(urls[0]!).searchParams.get("fingerprint")).toBeNull();
    expect(new URL(urls[1]!).searchParams.get("fingerprint")).toBe("next page");
  });

  it("continues native pagination after an empty first page and maps later rows", async () => {
    const clock = fakeClock();
    const urls: string[] = [];
    const backend = tronGridBackend({
      baseUrl: "https://trx-pages.test",
      now: clock.now,
      sleep: clock.sleep,
      sharedRateLimit: false,
      fetch: async (url) => {
        urls.push(url);
        if (urls.length === 1) {
          return new Response(JSON.stringify({ data: [], meta: { fingerprint: "native-next" } }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            data: [
              {
                txID: "native-page-2",
                blockNumber: 123,
                block_timestamp: 1_700_000_000_000,
                raw_data: {
                  contract: [
                    {
                      type: "TransferContract",
                      parameter: {
                        value: { amount: 5_000_000, owner_address: "41aa", to_address: "41bb" }
                      }
                    }
                  ]
                }
              }
            ],
            meta: {}
          }),
          { status: 200 }
        );
      }
    });

    const rows = await backend.listTrxTransfers(ADDRESS, {
      minTimestamp: 1000,
      maxTimestamp: 2000,
      limit: 200
    });

    expect(rows).toEqual([
      {
        txID: "native-page-2",
        blockNumber: 123,
        blockTimestamp: 1_700_000_000_000,
        from: "41aa",
        to: "41bb",
        value: "5000000"
      }
    ]);
    expect(new URL(urls[1]!).searchParams.get("fingerprint")).toBe("native-next");
  });

  it("fails closed when TronGrid repeats a pagination fingerprint", async () => {
    const clock = fakeClock();
    let calls = 0;
    const backend = tronGridBackend({
      baseUrl: "https://cyclic-pages.test",
      now: clock.now,
      sleep: clock.sleep,
      sharedRateLimit: false,
      fetch: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ data: [trc20(`page-${calls}`)], meta: { fingerprint: "same" } }),
          { status: 200 }
        );
      }
    });

    await expect(backend.listTrc20Transfers(ADDRESS)).rejects.toThrow(/repeated pagination fingerprint/);
    expect(calls).toBe(2);
  });

  it("fails closed instead of returning a partial result when a later page fails", async () => {
    const clock = fakeClock();
    let calls = 0;
    const backend = tronGridBackend({
      baseUrl: "https://failed-page.test",
      maxRetries: 0,
      now: clock.now,
      sleep: clock.sleep,
      sharedRateLimit: false,
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({ data: [trc20("page-1")], meta: { fingerprint: "next" } }),
            { status: 200 }
          );
        }
        return new Response("index temporarily unavailable", { status: 503 });
      }
    });

    const error: unknown = await backend.listTrc20Transfers(ADDRESS).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TronHttpError);
    expect(error).toMatchObject({ status: 503 });
    expect(calls).toBe(2);
  });
});
