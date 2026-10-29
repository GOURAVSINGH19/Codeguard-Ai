import { describe, it, expect } from "vitest";
import {
  breakingChangeFindings,
  changedFunctionNames,
  detectSignatureChanges,
  findCallSites,
  findDefinitions,
  formatCodeContext,
  identifiersUsed,
  parameterArity,
  parseDeclaration,
} from "../assurance/code-context";
import type { PRFileInput } from "../diff";

const file = (filename: string, patch: string): PRFileInput => ({ filename, status: "modified", additions: 1, deletions: 1, patch });

describe("parseDeclaration", () => {
  it.each([
    ["export async function chargeCard(id: string, amount: number) {", "chargeCard", "function", "id: string, amount: number"],
    ["export const formatMoney = (dollars: number): string =>", "formatMoney", "function", "dollars: number"],
    ["def load_user(self, user_id, *, fresh=False):", "load_user", "function", "self, user_id, *, fresh=False"],
    ["func (s *Store) Save(ctx context.Context, u User) error {", "Save", "function", "ctx context.Context, u User"],
    ["pub fn parse<T>(input: &str) -> T {", "parse", "function", "input: &str"],
    ["export interface UserSession {", "UserSession", "class", null],
    ["export type Money = { cents: number };", "Money", "type", null],
    ["const MAX_RETRIES = 3;", "MAX_RETRIES", "variable", null],
  ])("%s", (line, name, kind, params) => {
    expect(parseDeclaration(line)).toEqual({ name, kind, params });
  });

  it("ignores ordinary statements", () => {
    expect(parseDeclaration("  return chargeCard(id, 10);")).toBeNull();
  });
});

describe("parameterArity", () => {
  it("counts required, optional, defaulted and rest parameters", () => {
    expect(parameterArity("a: string, b?: number, c = 3")).toEqual({ required: 1, max: 3 });
    expect(parameterArity("a, ...rest: string[]")).toEqual({ required: 1, max: null });
    expect(parameterArity("opts: { a: number, b: string }, cb: (x: number, y: number) => void")).toEqual({ required: 2, max: 2 });
    expect(parameterArity("self, user_id, fresh=False")).toEqual({ required: 1, max: 2 });
    expect(parameterArity("")).toEqual({ required: 0, max: 0 });
  });
});

describe("definitions", () => {
  const patch = '@@ -0,0 +1,3 @@\n+import { formatMoney } from "../utils/money";\n+// formatMoney is great\n+export const label = (o: Order) => formatMoney(o.totalCents) + " total";';

  it("lists identifiers used on added lines, without keywords, builtins, strings or comments", () => {
    const ids = identifiersUsed([file("src/a.ts", patch)]);
    expect(ids).toContain("formatMoney");
    expect(ids).toContain("Order");
    expect(ids).not.toContain("label"); // declared here
    expect(ids).not.toContain("total"); // inside a string
    expect(ids).not.toContain("great"); // inside a comment
  });

  it("keeps calls inside template literals", () => {
    const tpl = "@@ -0,0 +1,1 @@\n+  return `Total: ${formatMoney(order.totalCents)}`;";
    expect(identifiersUsed([file("src/r.ts", tpl)])).toContain("formatMoney");
  });

  it("finds the declaring block in another file", () => {
    const money = 'import x from "y";\n\n/** Dollars, not cents. */\nexport function formatMoney(dollars: number): string {\n  return `$${dollars.toFixed(2)}`;\n}\n\nconst other = 1;';
    const [def] = findDefinitions(["formatMoney"], [{ path: "src/utils/money.ts", text: money }]);
    // Starts at the doc comment: it carries the meaning ("Dollars, not cents").
    expect(def).toMatchObject({ name: "formatMoney", file: "src/utils/money.ts", startLine: 3, endLine: 6 });
    expect(def.text).toContain("Dollars, not cents");
    expect(def.text).toContain("dollars.toFixed");
    expect(def.text).not.toContain("import x");
    expect(def.text).not.toContain("other");
  });

  it("reads a Python body by indentation", () => {
    const py = "def total(items):\n    s = 0\n    for i in items:\n        s += i\n    return s\n\nx = total([1])";
    const [def] = findDefinitions(["total"], [{ path: "m.py", text: py }]);
    expect(def.endLine).toBe(5);
  });
});

describe("call sites", () => {
  const checkout = 'import { chargeCard } from "../billing/charge";\n\nexport async function checkout(cart: Cart) {\n  await chargeCard(cart.customerId, cart.total);\n  return true;\n}';

  it("finds calls with their argument count and skips imports and declarations", () => {
    const sites = findCallSites(["chargeCard"], [{ path: "src/orders/checkout.ts", text: checkout }], new Set());
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ file: "src/orders/checkout.ts", line: 4, argCount: 2, inPR: false });
    expect(sites[0].snippet).toContain("   4 >   await chargeCard(");
  });

  it("puts callers outside the PR first", () => {
    const sites = findCallSites(["chargeCard"], [{ path: "in.ts", text: "chargeCard(1, 2, 3)" }, { path: "out.ts", text: "x.chargeCard(1)" }], new Set(["in.ts"]));
    expect(sites.map((s) => s.file)).toEqual(["out.ts", "in.ts"]);
  });

  it("does not count a spread or a multi-line call", () => {
    const sites = findCallSites(["f"], [{ path: "a.ts", text: "fff(1)\nf(...args)\nf(\n  1,\n)" }], new Set());
    expect(sites.map((s) => s.argCount)).toEqual([null, null]);
  });

  it("names functions changed in a patch, including git's hunk context", () => {
    const p = "@@ -10,3 +10,3 @@ export async function checkout(cartId: string) {\n   a();\n-  b();\n+  c();\n";
    expect(changedFunctionNames([file("src/c.ts", p)])).toEqual(["checkout"]);
  });
});

describe("breaking changes", () => {
  const charge = file(
    "src/billing/charge.ts",
    "@@ -1,3 +1,3 @@\n-export function chargeCard(customerId: string, amount: number) {\n+export function chargeCard(customerId: string, amount: number, currency: string) {\n   return gateway.charge(customerId, amount);\n }"
  );

  it("detects a new required parameter", () => {
    const [change] = detectSignatureChanges([charge]);
    expect(change).toMatchObject({ name: "chargeCard", line: 1, requiredBefore: 2, requiredAfter: 3, maxAfter: 3 });
  });

  it("ignores an added optional parameter", () => {
    const optional = file("a.ts", "@@ -1,1 +1,1 @@\n-function f(a: number) {\n+function f(a: number, b = 2) {");
    expect(detectSignatureChanges([optional])).toHaveLength(1); // max changed…
    const sites = findCallSites(["f"], [{ path: "b.ts", text: "f(1)" }], new Set());
    expect(breakingChangeFindings(detectSignatureChanges([optional]), sites)).toEqual([]); // …but old calls still work
  });

  it("flags only callers outside the PR that pass the old number of arguments", () => {
    const sites = findCallSites(
      ["chargeCard"],
      [
        { path: "src/orders/checkout.ts", text: "await chargeCard(c.id, c.total);" },
        { path: "src/orders/refund.ts", text: "await chargeCard(c.id, -c.total, 'usd');" },
        { path: "src/billing/charge.test.ts", text: "chargeCard('a', 1)" },
      ],
      new Set(["src/billing/charge.ts", "src/billing/charge.test.ts"])
    );
    const [f] = breakingChangeFindings(detectSignatureChanges([charge]), sites);
    expect(f).toMatchObject({ source: "blast_radius", severity: "high", file: "src/billing/charge.ts", line: 1, ruleId: "breaking-change/arity", deterministic: true });
    expect(f.message).toContain("src/orders/checkout.ts:1 passes 2");
    expect(f.message).not.toContain("refund");
    expect(f.message).not.toContain("charge.test");
    expect(f.confidence).toBeLessThan(0.9); // still goes to the verifier
  });

  it("flags a removed function that is still called, but not one moved to another file", () => {
    const removed = file("src/a.ts", "@@ -1,2 +0,0 @@\n-export function oldName(x: number) {\n-}");
    const sites = findCallSites(["oldName"], [{ path: "src/b.ts", text: "oldName(1)" }], new Set(["src/a.ts"]));
    expect(breakingChangeFindings(detectSignatureChanges([removed]), sites)[0]).toMatchObject({ ruleId: "breaking-change/removed" });

    const moved = file("src/c.ts", "@@ -0,0 +1,2 @@\n+export function oldName(x: number) {\n+}");
    expect(detectSignatureChanges([removed, moved])).toEqual([]);
  });
});

describe("formatCodeContext", () => {
  it("labels outside callers, stays in budget, and returns nothing when empty", () => {
    expect(formatCodeContext({ definitions: [], callSites: [], signatureChanges: [] })).toBeUndefined();
    const site = { name: "f", file: "b.ts", line: 3, argCount: 1, snippet: "   3 > f(1)", inPR: false };
    const text = formatCodeContext({ definitions: [], callSites: [site, { ...site, file: "c.ts" }], signatureChanges: [] }, 200)!;
    expect(text).toContain("NOT changed by this PR");
    expect(text.length).toBeLessThanOrEqual(220);
  });
});
