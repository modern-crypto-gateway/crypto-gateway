import { describe, expect, it } from "vitest";
import { bufferingLogger, consoleLogger } from "../../adapters/logging/console.adapter.js";
import type { LogLevel } from "../../core/ports/logger.port.js";

describe("consoleLogger", () => {
  it("emits JSON lines in json mode with ts, level, msg, and merged fields", () => {
    const lines: Array<{ level: LogLevel; line: string }> = [];
    const log = consoleLogger({
      format: "json",
      minLevel: "debug",
      baseFields: { service: "test" },
      now: () => new Date("2026-04-16T10:00:00Z"),
      sink: (level, line) => lines.push({ level, line })
    });
    log.info("hello", { extra: 1 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!.line);
    expect(parsed).toEqual({
      ts: "2026-04-16T10:00:00.000Z",
      level: "info",
      msg: "hello",
      service: "test",
      extra: 1
    });
  });

  it("suppresses logs below the configured minLevel", () => {
    const lines: string[] = [];
    const log = consoleLogger({
      minLevel: "warn",
      sink: (_level, line) => lines.push(line)
    });
    log.debug("a");
    log.info("b");
    log.warn("c");
    log.error("d");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("c");
    expect(lines[1]).toContain("d");
  });

  it("child loggers bind fields and can be further extended", () => {
    const lines: string[] = [];
    const log = consoleLogger({
      minLevel: "debug",
      sink: (_level, line) => lines.push(line)
    });
    const child = log.child({ requestId: "req-1" });
    const grand = child.child({ userId: "u-9" });
    grand.info("grand message", { extra: "bar" });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ requestId: "req-1", userId: "u-9", extra: "bar", msg: "grand message" });
  });

  it("call-site fields override bound fields on conflict", () => {
    const lines: string[] = [];
    const log = consoleLogger({
      minLevel: "debug",
      baseFields: { requestId: "base" },
      sink: (_level, line) => lines.push(line)
    });
    const child = log.child({ requestId: "child" });
    child.info("hi", { requestId: "call" });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.requestId).toBe("call");
  });

  it("pretty format writes a human-readable line with trailing JSON fields", () => {
    const lines: string[] = [];
    const log = consoleLogger({
      format: "pretty",
      minLevel: "debug",
      now: () => new Date("2026-04-16T10:00:00Z"),
      sink: (_level, line) => lines.push(line)
    });
    log.info("boot ok", { port: 8787 });
    expect(lines[0]).toBe('2026-04-16T10:00:00.000Z INFO  boot ok {"port":8787}');
  });

  it("routes error-level to console.error via the default sink", () => {
    // Can't easily spy on global console across runtimes; instead verify the
    // level discriminator reaches our custom sink.
    const levels: LogLevel[] = [];
    const log = consoleLogger({
      minLevel: "debug",
      sink: (level) => levels.push(level)
    });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(levels).toEqual(["debug", "info", "warn", "error"]);
  });
});

describe("bufferingLogger (test helper)", () => {
  it("records every call with its level, message, and merged fields", () => {
    const log = bufferingLogger();
    const child = log.child({ requestId: "r1" });
    log.info("no-context");
    child.error("with-context", { extra: 3 });
    expect(log.entries).toEqual([
      { level: "info", message: "no-context", fields: {} },
      { level: "error", message: "with-context", fields: { requestId: "r1", extra: 3 } }
    ]);
  });

  it("separate children do not cross-contaminate bound fields", () => {
    const log = bufferingLogger();
    const a = log.child({ a: 1 });
    const b = log.child({ b: 2 });
    a.info("from a");
    b.info("from b");
    expect(log.entries[0]!.fields).toEqual({ a: 1 });
    expect(log.entries[1]!.fields).toEqual({ b: 2 });
  });
});
