import { afterEach, describe, expect, it } from "bun:test";
import { structuredLog } from "../src/structured-log";

describe("structuredLog", () => {
  const origLog = console.log;
  const origErr = console.error;

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
  });

  it("writes one JSON line per message in production", () => {
    const lines: string[] = [];
    console.log = (msg: unknown) => {
      lines.push(String(msg));
    };
    console.error = () => {};

    structuredLog(
      { nodeEnv: "production", namespace: "test-ns" },
      "queuehouse-api",
      "info",
      "hello",
      { requestId: "r1", actor: "admin:u1" },
    );

    expect(lines.length).toBe(1);
    const o = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(o.msg).toBe("hello");
    expect(o.requestId).toBe("r1");
    expect(o.actor).toBe("admin:u1");
    expect(o.service).toBe("queuehouse-api");
    expect(o.namespace).toBe("test-ns");
    expect(o.level).toBe("info");
    expect(typeof o.ts).toBe("string");
  });

  it("uses stderr for warn in production", () => {
    const errLines: string[] = [];
    console.log = () => {};
    console.error = (msg: unknown) => {
      errLines.push(String(msg));
    };

    structuredLog(
      { nodeEnv: "production", namespace: "n" },
      "queuehouse-worker",
      "warn",
      "careful",
    );

    expect(errLines.length).toBe(1);
    const o = JSON.parse(errLines[0]!) as Record<string, unknown>;
    expect(o.level).toBe("warn");
  });
});
