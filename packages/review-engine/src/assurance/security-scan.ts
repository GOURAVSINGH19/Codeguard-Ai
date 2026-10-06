import { addedLines } from "../diff";
import type { PRFileInput } from "../diff";
import { makeFinding } from "./types";
import type { Finding } from "./types";

/**
 * Deterministic security checks on ADDED lines only. Nothing here executes
 * the PR's code — it is text matching, safe to run on untrusted input.
 *
 * - Secrets: provider-specific token formats (high confidence) and generic
 *   `password = "..."` assignments gated by entropy (lower confidence).
 * - Risky patterns: eval, shell injection, disabled TLS checks, unsafe
 *   deserialization… These are hints, so they go through LLM verification.
 */

interface SecretRule {
  id: string;
  label: string;
  pattern: RegExp;
}

const SECRET_RULES: SecretRule[] = [
  { id: "secret/aws-access-key", label: "AWS access key ID", pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "secret/github-token", label: "GitHub token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { id: "secret/anthropic-key", label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: "secret/openai-key", label: "OpenAI API key", pattern: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/ },
  { id: "secret/stripe-live-key", label: "Stripe live key", pattern: /\b(sk|rk)_live_[0-9a-zA-Z]{20,}\b/ },
  { id: "secret/slack-token", label: "Slack token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  { id: "secret/google-api-key", label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "secret/private-key", label: "private key", pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/ },
  { id: "secret/db-url-password", label: "database URL with a password", pattern: /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]{6,}@/ },
];

const GENERIC_ASSIGNMENT = /\b([A-Za-z0-9_]*(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret))\b["']?\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/i;
const PLACEHOLDER = /^(x+|\*+|changeme|example|placeholder|your[_-]?.*|<.*>|\$\{.*\}|process\.env.*|test|dummy|sample|redacted|null|undefined|todo)$/i;

/** Files where example credentials are expected. */
const LOW_TRUST_PATH = /(^|\/)(__tests__|tests?|fixtures?|mocks?|examples?|docs?)\/|\.(test|spec)\.|\.example$|\.sample$|\.md$/i;

export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function redact(value: string): string {
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}…${value.slice(-2)}`;
}

export function scanSecrets(files: PRFileInput[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const lowTrust = LOW_TRUST_PATH.test(file.filename);
    for (const { line, text } of addedLines(file.patch)) {
      let matched = false;
      for (const rule of SECRET_RULES) {
        const m = rule.pattern.exec(text);
        if (!m) continue;
        matched = true;
        findings.push(
          makeFinding({
            source: "security",
            severity: lowTrust ? "medium" : "critical",
            category: "security",
            file: file.filename,
            line,
            message: `Possible ${rule.label} committed in source (\`${redact(m[0])}\`). Anyone with read access to the repository or its history can use it.`,
            suggestion: "Remove it from the code, rotate the credential now (it stays in git history), and load it from an environment variable or secret manager.",
            confidence: lowTrust ? 0.6 : 0.95,
            ruleId: rule.id,
            deterministic: true,
          })
        );
        break;
      }
      if (matched) continue;

      const g = GENERIC_ASSIGNMENT.exec(text);
      if (g && !PLACEHOLDER.test(g[3]) && shannonEntropy(g[3]) >= 3.5) {
        findings.push(
          makeFinding({
            source: "security",
            severity: lowTrust ? "low" : "high",
            category: "security",
            file: file.filename,
            line,
            message: `Hard-coded value assigned to \`${g[1]}\` looks like a real secret (\`${redact(g[3])}\`).`,
            suggestion: "Read it from configuration or a secret manager instead of committing it.",
            confidence: lowTrust ? 0.35 : 0.7,
            ruleId: "secret/generic-assignment",
            deterministic: true,
          })
        );
      }
    }
  }
  return findings;
}

interface PatternRule {
  id: string;
  /** File extensions the rule applies to. */
  ext: RegExp;
  pattern: RegExp;
  severity: Finding["severity"];
  message: string;
  suggestion: string;
  confidence: number;
}

const JS = /\.(m?[jt]sx?|cjs|vue|svelte)$/;
const PY = /\.py$/;

const PATTERN_RULES: PatternRule[] = [
  { id: "rule/js-eval", ext: JS, pattern: /\beval\s*\(|\bnew\s+Function\s*\(/, severity: "high", message: "Dynamic code execution (`eval` / `new Function`). If any part of the input is user-controlled this is remote code execution.", suggestion: "Replace with explicit parsing or a lookup table.", confidence: 0.6 },
  { id: "rule/js-shell-exec", ext: JS, pattern: /\b(exec|execSync)\s*\(\s*(`[^`]*\$\{|[^)]*\+)/, severity: "high", message: "Shell command built from interpolated values — command injection risk.", suggestion: "Use `execFile`/`spawn` with an argument array and no shell.", confidence: 0.65 },
  { id: "rule/js-inner-html", ext: JS, pattern: /\.innerHTML\s*=|dangerouslySetInnerHTML/, severity: "medium", message: "Raw HTML is injected into the page — XSS risk if the value is not sanitized.", suggestion: "Render text content, or sanitize with a vetted library (e.g. DOMPurify).", confidence: 0.5 },
  { id: "rule/tls-disabled", ext: /.*/, pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=?\s*["']?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/, severity: "high", message: "TLS certificate verification is disabled, which allows man-in-the-middle attacks.", suggestion: "Keep verification on; trust a custom CA instead if needed.", confidence: 0.75 },
  { id: "rule/sql-interpolation", ext: /.*/, pattern: /["'`]\s*(SELECT|INSERT|UPDATE|DELETE)\b[^"'`]*(\$\{|["'`]\s*\+|%s|\{\})/i, severity: "high", message: "SQL text is built by string interpolation — SQL injection risk.", suggestion: "Use parameterized queries or the query builder's bound parameters.", confidence: 0.55 },
  { id: "rule/py-shell-true", ext: PY, pattern: /subprocess\.\w+\([^)]*shell\s*=\s*True/, severity: "high", message: "`subprocess` with `shell=True` — command injection risk.", suggestion: "Pass an argument list and leave `shell` off.", confidence: 0.65 },
  { id: "rule/py-unsafe-deserialize", ext: PY, pattern: /pickle\.loads?\(|yaml\.load\((?![^)]*Loader\s*=\s*yaml\.SafeLoader)/, severity: "high", message: "Unsafe deserialization can execute code from untrusted input.", suggestion: "Use `json`, or `yaml.safe_load`.", confidence: 0.6 },
  { id: "rule/cors-wildcard-credentials", ext: JS, pattern: /origin\s*:\s*["']\*["'][^}]*credentials\s*:\s*true|credentials\s*:\s*true[^}]*origin\s*:\s*["']\*["']/, severity: "medium", message: "CORS allows any origin together with credentials.", suggestion: "List the allowed origins explicitly.", confidence: 0.6 },
  { id: "rule/weak-hash-password", ext: /.*/, pattern: /(md5|sha1)\s*\(.*pass(word)?|createHash\(\s*["'](md5|sha1)["']\s*\)[^;\n]*pass/i, severity: "high", message: "Passwords hashed with a fast, broken hash (MD5/SHA-1).", suggestion: "Use bcrypt, scrypt or argon2.", confidence: 0.6 },
];

export function scanRiskyPatterns(files: PRFileInput[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const rules = PATTERN_RULES.filter((r) => r.ext.test(file.filename));
    if (rules.length === 0) continue;
    for (const { line, text } of addedLines(file.patch)) {
      if (/^\s*(\/\/|#|\*|\/\*)/.test(text)) continue; // comments
      for (const rule of rules) {
        if (!rule.pattern.test(text)) continue;
        findings.push(
          makeFinding({
            source: "security",
            severity: rule.severity,
            category: "security",
            file: file.filename,
            line,
            message: rule.message,
            suggestion: rule.suggestion,
            confidence: rule.confidence,
            ruleId: rule.id,
            deterministic: true,
          })
        );
      }
    }
  }
  return findings;
}
