import { ReviewOutputSchema } from "@codeguard/types";
import type { ReviewOutput } from "@codeguard/types";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_DIFF_CHARS = 12_000;

/**
 * AIReviewService
 *
 * Single owner of all AI/LLM logic:
 * - Prompt construction
 * - Groq API calls
 * - Response parsing + Zod validation
 *
 * No DB access. No HTTP framework imports.
 * Returns strongly-typed ReviewOutput or throws a descriptive Error.
 */
export class AIReviewService {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  /**
   * Factory — reads env vars so call-sites stay clean.
   */
  static fromEnv(): AIReviewService {
    const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "AI service configuration missing. Set GROQ_API_KEY in your environment."
      );
    }
    const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
    return new AIReviewService(apiKey, model);
  }

  /**
   * Review a pasted code snippet.
   */
  async reviewSnippet(
    code: string,
    language: string
  ): Promise<ReviewOutput> {
    const systemPrompt = `You are CodeGuard AI, an elite static analysis and code review engine.
Analyze the provided ${language} code for security flaws, bugs, performance bottlenecks, maintainability issues, and style improvements.

Constraints:
1. Provide an overall quality score from 0.0 (worst) to 10.0 (perfect).
2. Write a concise executive summary.
3. List all identified issues.
4. Issue severities MUST be one of: "critical", "high", "medium", "low".
5. Issue categories MUST be one of: "security", "bug", "performance", "maintainability", "style".
6. If a specific line number applies to an issue, specify it as an integer line number (1-indexed). Otherwise set line to null.
7. Always provide an actionable code suggestion for fixing the issue when applicable.

Return ONLY valid raw JSON matching this schema:
{
  "score": 6.5,
  "summary": "High-level review summary...",
  "issues": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "category": "security" | "bug" | "performance" | "maintainability" | "style",
      "line": number | null,
      "message": "Clear explanation of the issue",
      "suggestion": "Suggested code fix"
    }
  ]
}`;

    const userPrompt = `Language: ${language}\nCode to Review:\n\`\`\`${language}\n${code}\n\`\`\``;

    return this.callGroq(systemPrompt, userPrompt);
  }

  /**
   * Review a GitHub PR diff.
   * diffContext is automatically truncated to MAX_DIFF_CHARS to stay within token limits.
   */
  async reviewPRDiff(
    diffContext: string,
    prTitle: string,
    prBody: string | null
  ): Promise<ReviewOutput> {
    const systemPrompt = `You are CodeGuard AI, an expert code reviewer analyzing a GitHub Pull Request diff.
Analyze the PR diff for security flaws, bugs, performance bottlenecks, maintainability issues, and style improvements.

PR Title: "${prTitle}"
PR Description: "${prBody || "No description provided"}"

Constraints:
1. Provide an overall quality score from 0.0 (worst) to 10.0 (perfect).
2. Write a concise executive summary of the changes and overall quality.
3. List all identified issues in the diff.
4. Issue severities MUST be one of: "critical", "high", "medium", "low".
5. Issue categories MUST be one of: "security", "bug", "performance", "maintainability", "style".
6. Specify line numbers accurately from the diff patches when applicable. Otherwise set line to null.
7. Always provide an actionable code suggestion fixing the issue.

Return ONLY valid raw JSON matching this schema:
{
  "score": 7.5,
  "summary": "High-level review summary of the PR diff...",
  "issues": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "category": "security" | "bug" | "performance" | "maintainability" | "style",
      "line": number | null,
      "message": "Explanation of issue in file context",
      "suggestion": "Suggested fix"
    }
  ]
}`;

    const truncated = diffContext.slice(0, MAX_DIFF_CHARS);
    const userPrompt = `Pull Request Diff to Review:\n\n${truncated}`;

    return this.callGroq(systemPrompt, userPrompt);
  }

  /**
   * Shared Groq API call + parse logic.
   * Throws on HTTP error, empty response, or Zod validation failure.
   */
  private async callGroq(
    systemPrompt: string,
    userPrompt: string
  ): Promise<ReviewOutput> {
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content;

    if (!rawContent) {
      throw new Error("Groq returned an empty response.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      throw new Error(`Groq returned invalid JSON: ${rawContent.slice(0, 200)}`);
    }

    // Zod validates structure + enum values — throws ZodError on failure
    return ReviewOutputSchema.parse(parsed);
  }
}
