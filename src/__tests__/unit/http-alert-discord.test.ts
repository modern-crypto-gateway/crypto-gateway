import { describe, expect, it, vi } from "vitest";
import {
  formatAlertBody,
  httpAlertSink,
  isDiscordWebhookUrl,
  postAlert
} from "../../adapters/logging/http-alert.adapter.js";

const DISCORD_URL = "https://discordapp.com/api/webhooks/123456789/abcDEF-ghi";
const GENERIC_URL = "https://alerts.example.test/hook";

const LINE = JSON.stringify({
  ts: "2026-09-21T10:00:00.000Z",
  level: "error",
  msg: "[RATE_REFRESH_FAILED] USD rate refresh failed",
  service: "crypto-gateway",
  runtime: "workers",
  alertKind: "failure",
  source: "cron",
  consecutiveFailures: 3,
  providerFailures: [{ provider: "coingecko", error: "coingecko returned 429" }],
  investigate: ["check providerFailures"]
});
const FIELDS = { ts: "2026-09-21T10:00:00.000Z", msg: "[RATE_REFRESH_FAILED] USD rate refresh failed", source: "cron" };

describe("isDiscordWebhookUrl", () => {
  it("matches discord.com, discordapp.com, canary/ptb and versioned API paths", () => {
    expect(isDiscordWebhookUrl(DISCORD_URL)).toBe(true);
    expect(isDiscordWebhookUrl("https://discord.com/api/webhooks/1/x")).toBe(true);
    expect(isDiscordWebhookUrl("https://canary.discord.com/api/v10/webhooks/1/x")).toBe(true);
    expect(isDiscordWebhookUrl(GENERIC_URL)).toBe(false);
    expect(isDiscordWebhookUrl("https://discord.com/channels/1/2")).toBe(false);
  });
});

describe("formatAlertBody", () => {
  it("keeps the raw JSON shape for non-Discord URLs", () => {
    const body = formatAlertBody({ url: GENERIC_URL, level: "error", line: LINE, fields: FIELDS });
    expect(body).toEqual({ level: "error", line: LINE, fields: FIELDS });
  });

  it("builds a Discord message with headline, embed fields and a JSON detail block", () => {
    const body = formatAlertBody({ url: DISCORD_URL, level: "error", line: LINE, fields: FIELDS }) as {
      content: string;
      embeds: Array<{
        title: string;
        color: number;
        timestamp: string;
        fields?: Array<{ name: string; value: string }>;
        description: string;
        footer: { text: string };
      }>;
      allowed_mentions: { parse: string[] };
    };
    expect(body.content).toBe("🚨 **crypto-gateway** ERROR: [RATE_REFRESH_FAILED] USD rate refresh failed");
    expect(body.embeds).toHaveLength(1);
    const embed = body.embeds[0]!;
    expect(embed.title).toBe("[RATE_REFRESH_FAILED] USD rate refresh failed");
    expect(embed.color).toBe(0xe74c3c);
    expect(embed.timestamp).toBe("2026-09-21T10:00:00.000Z");
    // Scalars become inline fields; the headline keys are not repeated.
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        { name: "source", value: "cron", inline: true },
        { name: "consecutiveFailures", value: "3", inline: true }
      ])
    );
    expect(embed.fields!.map((f) => f.name)).not.toContain("msg");
    // The nested diagnostics land in the code block.
    expect(embed.description).toContain("```json");
    expect(embed.description).toContain("coingecko returned 429");
    expect(embed.footer.text).toBe("workers • error");
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("prefers the redacted JSON line over the raw fields", () => {
    const body = formatAlertBody({
      url: DISCORD_URL,
      level: "error",
      line: JSON.stringify({ msg: "x", secret: "[REDACTED]" }),
      fields: { msg: "x", secret: "hunter2" }
    }) as { embeds: Array<{ description: string }> };
    expect(body.embeds[0]!.description).toContain("[REDACTED]");
    expect(body.embeds[0]!.description).not.toContain("hunter2");
  });

  it("renders recovery notices green with a distinct headline", () => {
    const body = formatAlertBody({
      url: DISCORD_URL,
      level: "error",
      line: JSON.stringify({ msg: "[RATE_REFRESH_RECOVERED] ok", alertKind: "recovery", service: "crypto-gateway" }),
      fields: {}
    }) as { content: string; embeds: Array<{ color: number }> };
    expect(body.content).toBe("✅ **crypto-gateway** recovered: [RATE_REFRESH_RECOVERED] ok");
    expect(body.embeds[0]!.color).toBe(0x2ecc71);
  });

  it("stays inside Discord's size limits for a huge payload and reports rate-limit drops", () => {
    const huge = JSON.stringify({ msg: "m".repeat(500), blob: "x".repeat(20_000) });
    const body = formatAlertBody({
      url: DISCORD_URL,
      level: "error",
      line: huge,
      fields: {},
      droppedSinceLastAlert: 4
    }) as { content: string; embeds: Array<{ title: string; description: string; footer: { text: string } }> };
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(body.embeds[0]!.title.length).toBeLessThanOrEqual(256);
    expect(body.embeds[0]!.description.length).toBeLessThanOrEqual(4096);
    expect(body.embeds[0]!.description).toContain("(truncated)");
    expect(body.embeds[0]!.footer.text).toContain("4 alert(s) dropped");
  });
});

describe("postAlert / httpAlertSink", () => {
  it("POSTs the Discord-shaped body to a Discord URL and reports the status", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const result = await postAlert({ url: DISCORD_URL, level: "error", line: LINE, fields: FIELDS, fetch: fakeFetch });
    expect(result).toEqual({ ok: true, status: 204 });
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0]!.init.body as string) as { content?: string; embeds?: unknown[] };
    expect(sent.content).toContain("[RATE_REFRESH_FAILED]");
    expect(sent.embeds).toHaveLength(1);
  });

  it("never throws on network failure", async () => {
    const failing = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const result = await postAlert({ url: DISCORD_URL, level: "error", line: LINE, fields: FIELDS, fetch: failing });
    expect(result).toEqual({ ok: false, error: "ECONNRESET" });
  });

  it("sink fires the same formatter synchronously", async () => {
    const bodies: unknown[] = [];
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const sink = httpAlertSink({ url: DISCORD_URL, fetch: fakeFetch });
    sink("error", LINE, FIELDS);
    await Promise.resolve();
    await Promise.resolve();
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as { content: string }).content).toContain("crypto-gateway");
  });
});
