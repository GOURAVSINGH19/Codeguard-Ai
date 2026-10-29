import { describe, it, expect } from "vitest";
import { StructuredLLM } from "@codeguard/review-engine";
import type { ChatMessage, LLMProvider, LLMResult } from "@codeguard/review-engine";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactError, runCase } from "../harness.js";
import { EvalCaseSchema } from "../scoring.js";
import type { Logger } from "../../lib/logger.js";
import type { EvalCase } from "../scoring.js";

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };

const sqlCase: EvalCase = {
  id: "sql",
  title: "Add user lookup",
  body: "",
  tags: [],
  files: [
    {
      filename: "src/db/users.ts",
      status: "added",
      patch: "@@ -0,0 +1,4 @@\n+export async function find(email: string) {\n+  return pool.query(`SELECT * FROM users WHERE email = '${email}'`);\n+}\n+",
    },
  ],
  expected: [{ file: "src/db/users.ts", lines: [2, 2], category: "security" }],
  repoFiles: [],
};

/**
 * Scripted model: the security reviewer reports the real bug, the quality
 * reviewer reports a made-up one, and the verifier rejects the made-up one.
 */
class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  readonly model = "scripted-1";
  async completeJSON(messages: ChatMessage[]): Promise<LLMResult> {
    const system = messages[0].content;
    const user = messages[messages.length - 1].content;
    const reply = (value: unknown): LLMResult => ({ content: JSON.stringify(value), usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } });

    if (system.includes("verifier")) {
      const ids = [...user.matchAll(/^\{"id":(\d+).*"message":"([^"]*)"/gm)];
      return reply({ verdicts: ids.map(([, id, message]) => ({ id: Number(id), verdict: message.includes("made-up") ? "rejected" : "confirmed", reason: "checked" })) });
    }
    if (system.includes("application security engineer")) {
      return reply({ summary: "s", issues: [{ severity: "critical", category: "security", file: "src/db/users.ts", line: 2, message: "SQL injection via email", suggestion: null, confidence: 0.9 }] });
    }
    if (system.includes("correctness and maintainability")) {
      return reply({ summary: "q", issues: [{ severity: "high", category: "bug", file: "src/db/users.ts", line: 1, message: "made-up null handling problem", suggestion: null, confidence: 0.8 }] });
    }
    if (system.includes("Work out WHY")) return reply({ summary: "lookup", changeType: "feature", stated: false });
    return reply({ summary: "nothing", issues: [] });
  }
}

class BrokenProvider implements LLMProvider {
  readonly name = "broken";
  readonly model = "broken-1";
  async completeJSON(): Promise<LLMResult> {
    throw new Error("provider down");
  }
}

describe("runCase", () => {
  it("runs the real stages offline and shows what the verifier removed", async () => {
    // Tolerance 0: the made-up finding (line 1) sits next to the real bug (line 2).
    const run = await runCase(sqlCase, new StructuredLLM(new ScriptedProvider(), { warn: () => {} }), silent, 0);

    expect(run.error).toBeUndefined();
    expect(run.beforeVerify).toMatchObject({ truePositives: 1, falsePositives: 1 });
    expect(run.final).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0 });
    expect(run.verification).toMatchObject({ status: "verified", rejected: [{ message: "made-up null handling problem" }] });
    expect(run.llmCalls).toBeGreaterThan(0);
  });

  it("records failed model calls, even ones a reviewer swallows, so the case can be left out", async () => {
    const run = await runCase(sqlCase, new StructuredLLM(new BrokenProvider(), { warn: () => {} }), silent);
    expect(run.final.caseId).toBe("sql");
    // The security node catches its model error and keeps deterministic findings: no trace entry for it.
    expect(run.modelErrors.length).toBeGreaterThan(run.trace.filter((t) => t.status === "failed").length);
    expect(run.modelErrors[0]).toMatch(/provider down/);
  });

  it("has no model errors on a clean run", async () => {
    const run = await runCase(sqlCase, new StructuredLLM(new ScriptedProvider(), { warn: () => {} }), silent);
    expect(run.modelErrors).toEqual([]);
  });
});

describe("code context in the eval", () => {
  const CASES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../evals/cases");
  const load = (id: string) => EvalCaseSchema.parse(JSON.parse(readFileSync(join(CASES, `${id}.json`), "utf8")));

  /** Reports nothing itself, confirms every finding, and keeps every prompt it was sent. */
  class RecordingProvider implements LLMProvider {
    readonly name = "recording";
    readonly model = "recording-1";
    readonly prompts: string[] = [];
    async completeJSON(messages: ChatMessage[]): Promise<LLMResult> {
      const user = messages[messages.length - 1].content;
      this.prompts.push(`${messages[0].content}\n${user}`);
      const reply = (value: unknown): LLMResult => ({ content: JSON.stringify(value), usage: null });
      if (messages[0].content.includes("verifier")) {
        const ids = [...user.matchAll(/^\{"id":(\d+)/gm)].map((m) => Number(m[1]));
        return reply({ verdicts: ids.map((id) => ({ id, verdict: "confirmed", reason: "ok" })) });
      }
      if (messages[0].content.includes("Work out WHY")) return reply({ summary: "x", changeType: "feature", stated: false });
      return reply({ summary: "nothing", issues: [] });
    }
  }

  it("catches a caller outside the PR that a signature change breaks, with no model finding", async () => {
    const provider = new RecordingProvider();
    const run = await runCase(load("ctx-breaking-signature"), new StructuredLLM(provider, { warn: () => {} }), silent);
    expect(run.final).toMatchObject({ truePositives: 1, falseNegatives: 0, falsePositives: 0 });
    expect(run.final.matches[0].finding).toMatchObject({ source: "blast_radius", file: "src/billing/charge.js" });
    // The reviewers saw the caller's code, not just its file name.
    expect(provider.prompts.some((p) => p.includes("NOT changed by this PR") && p.includes("await chargeCard(cart.customerId, cart.total);"))).toBe(true);
  });

  it("shows the reviewers the definition of a function the diff calls", async () => {
    const provider = new RecordingProvider();
    await runCase(load("ctx-cents-vs-dollars"), new StructuredLLM(provider, { warn: () => {} }), silent);
    const review = provider.prompts.find((p) => p.includes("correctness and maintainability"))!;
    expect(review).toContain("Definitions used by the changed code");
    expect(review).toContain("Format an amount in DOLLARS (not cents)");
    expect(review).toContain("Integer amount in cents");
  });
});

describe("redactError", () => {
  it("hides account ids and keeps messages short", () => {
    const msg = redactError(`groq API error (429): limit for organization \`org_01jpqbb6xxez18dcs0ct1wqysh\` ${"x".repeat(500)}`);
    expect(msg).not.toMatch(/01jpqbb6/);
    expect(msg).toContain("org_***");
    expect(msg.length).toBeLessThanOrEqual(200);
  });
});
