import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

type EachMessage = (p: { message: { key: Buffer | null; value: Buffer | null }; heartbeat: () => Promise<void> }) => Promise<void>;
let eachMessage: EachMessage;
const dlq = vi.fn(async () => {});

vi.mock("@codeguard/kafka", () => ({
  createConsumer: async () => ({
    subscribe: async () => {},
    run: async ({ eachMessage: fn }: { eachMessage: EachMessage }) => {
      eachMessage = fn;
    },
    disconnect: async () => {},
  }),
  sendToDeadLetter: (...args: unknown[]) => dlq(...(args as [])),
  getSharedProducer: async () => ({}),
  disconnectSharedProducer: async () => {},
}));

vi.useFakeTimers({ shouldAdvanceTime: true });

const { runConsumer, PermanentError } = await import("../consumer.js");

const schema = z.object({ n: z.number() });
const msg = (value: string | null) => ({ message: { key: Buffer.from("k"), value: value === null ? null : Buffer.from(value) }, heartbeat: async () => {} });

async function start(handler: (e: { n: number }) => Promise<void>) {
  await runConsumer({ name: "t", groupId: "g", topic: "topic", schema, handler, maxAttempts: 3 });
}

beforeEach(() => dlq.mockClear());

describe("runConsumer", () => {
  it("sends invalid JSON straight to the DLQ without calling the handler", async () => {
    const handler = vi.fn();
    await start(handler);
    await eachMessage(msg("{oops"));
    expect(handler).not.toHaveBeenCalled();
    expect(dlq).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ topic: "topic", value: "{oops", attempts: 0 }));
  });

  it("sends schema mismatches to the DLQ", async () => {
    await start(vi.fn());
    await eachMessage(msg(JSON.stringify({ n: "x" })));
    expect(dlq).toHaveBeenCalledOnce();
  });

  it("retries a failing handler, then dead-letters it", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("GitHub 502"));
    await start(handler);
    const run = eachMessage(msg(JSON.stringify({ n: 1 })));
    await vi.runAllTimersAsync();
    await run;
    expect(handler).toHaveBeenCalledTimes(3);
    expect(dlq).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ attempts: 3 }));
  });

  it("does not retry permanent errors", async () => {
    const handler = vi.fn().mockRejectedValue(new PermanentError("bad payload"));
    await start(handler);
    await eachMessage(msg(JSON.stringify({ n: 1 })));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(dlq).toHaveBeenCalledOnce();
  });

  it("succeeds after a transient failure without touching the DLQ", async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue(undefined);
    await start(handler);
    const run = eachMessage(msg(JSON.stringify({ n: 1 })));
    await vi.runAllTimersAsync();
    await run;
    expect(handler).toHaveBeenCalledTimes(2);
    expect(dlq).not.toHaveBeenCalled();
  });
});
