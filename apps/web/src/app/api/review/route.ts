import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db, reviews, reviewComments } from "@codeguard/db";
import { ReviewInputSchema, ReviewOutputSchema } from "@codeguard/types";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const inputValidation = ReviewInputSchema.safeParse(body);
    if (!inputValidation.success) {
      return NextResponse.json(
        { error: "Invalid request payload", details: inputValidation.error.format() },
        { status: 400 }
      );
    }

    const { code, language, title } = inputValidation.data;

    const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "AI service configuration missing (GROQ_API_KEY is not set)" },
        { status: 500 }
      );
    }

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

    const aiResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error("Groq API error:", errorText);
      return NextResponse.json(
        { error: "AI service failed to process review", details: errorText },
        { status: 502 }
      );
    }

    const aiData = await aiResponse.json();
    const rawContent = aiData.choices?.[0]?.message?.content;

    if (!rawContent) {
      return NextResponse.json({ error: "Empty response received from AI service" }, { status: 502 });
    }

    let parsedContent;
    try {
      parsedContent = JSON.parse(rawContent);
    } catch (err) {
      console.error("Failed to parse AI response JSON:", rawContent);
      return NextResponse.json({ error: "AI returned invalid JSON format" }, { status: 500 });
    }

    // Enforce Zod schema validation
    const reviewResult = ReviewOutputSchema.parse(parsedContent);

    // Save Review to Neon PostgreSQL DB
    const [insertedReview] = await db
      .insert(reviews)
      .values({
        userId,
        title: title || `${language.toUpperCase()} Code Review`,
        codeSnippet: code,
        language,
        score: reviewResult.score,
        overallScore: `${reviewResult.score.toFixed(1)}/10`,
        summary: reviewResult.summary,
        status: "completed",
        reviewType: "paste_code",
        model: process.env.GROQ_MODEL,
      })
      .returning();

    // Insert review issue comments into Neon Postgres DB if any exist
    if (reviewResult.issues.length > 0) {
      await db.insert(reviewComments).values(
        reviewResult.issues.map((issue) => ({
          reviewId: insertedReview.id,
          filePath: "snippet",
          lineNumber: issue.line ?? undefined,
          lineStart: issue.line ?? undefined,
          lineEnd: issue.line ?? undefined,
          body: issue.message,
          comment: issue.message,
          suggestion: issue.suggestion ?? undefined,
          severity: issue.severity,
          category: issue.category,
        }))
      );
    }

    return NextResponse.json({
      id: insertedReview.id,
      score: reviewResult.score,
      summary: reviewResult.summary,
      issues: reviewResult.issues,
      createdAt: insertedReview.createdAt,
    });
  } catch (error: any) {
    console.error("Error processing review:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
