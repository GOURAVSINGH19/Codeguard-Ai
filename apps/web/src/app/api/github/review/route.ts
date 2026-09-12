import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getGitHubClient } from "@/lib/github";
import { db, repositories, pullRequests, reviews, reviewComments } from "@codeguard/db";
import { ReviewOutputSchema } from "@codeguard/types";
import { eq, and } from "drizzle-orm";
import { syncUserWithDb } from "@/lib/user-sync";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Sync user with Neon DB
    await syncUserWithDb();

    const body = await req.json();
    const { owner, repo, pullNumber } = body;

    const prNum = parseInt(pullNumber, 10);
    if (!owner || !repo || isNaN(prNum)) {
      return NextResponse.json(
        { error: "Invalid payload parameters (owner, repo, pullNumber required)" },
        { status: 400 }
      );
    }

    const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "AI service configuration missing (GROQ_API_KEY is not set)" },
        { status: 500 }
      );
    }

    const octokit = await getGitHubClient();

    // 1. Fetch GitHub PR details and changed files
    const { data: prData } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNum,
    });

    const { data: filesData } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNum,
      per_page: 50,
    });

    // 2. Ensure repository record exists in DB
    let [repoRecord] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.githubRepoId, prData.base.repo.id))
      .limit(1);

    if (!repoRecord) {
      const [newRepo] = await db
        .insert(repositories)
        .values({
          githubRepoId: prData.base.repo.id,
          fullName: `${owner}/${repo}`,
          owner,
          name: repo,
          defaultBranch: prData.base.repo.default_branch || "main",
          isPrivate: prData.base.repo.private || false,
          language: prData.base.repo.language || null,
          cloneUrl: prData.base.repo.clone_url || null,
          htmlUrl: prData.base.repo.html_url || null,
        })
        .returning();
      repoRecord = newRepo;
    }

    // 3. Ensure pull request record exists in DB
    let [prRecord] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repoRecord.id),
          eq(pullRequests.prNumber, prNum)
        )
      )
      .limit(1);

    if (!prRecord) {
      const [newPr] = await db
        .insert(pullRequests)
        .values({
          repositoryId: repoRecord.id,
          githubPrId: prData.id,
          prNumber: prNum,
          title: prData.title,
          body: prData.body || "",
          state: prData.state === "open" ? "open" : "closed",
          headBranch: prData.head.ref,
          baseBranch: prData.base.ref,
          headSha: prData.head.sha,
          baseSha: prData.base.sha,
          authorGithubId: prData.user?.id ? String(prData.user.id) : null,
          authorLogin: prData.user?.login || "unknown",
          additions: prData.additions,
          deletions: prData.deletions,
          changedFiles: prData.changed_files,
        })
        .returning();
      prRecord = newPr;
    }

    // 4. Create initial pending review record
    const [pendingReview] = await db
      .insert(reviews)
      .values({
        userId,
        pullRequestId: prRecord.id,
        title: `PR #${prNum}: ${prData.title}`,
        codeSnippet: `PR #${prNum} Diff (${prData.changed_files} files changed, +${prData.additions} -${prData.deletions})`,
        language: prData.base.repo.language || "code",
        status: "pending",
        reviewType: "automated",
        model: process.env.GROQ_MODEL,
      })
      .returning();

    // 5. Construct diff payload for AI prompt
    const diffContext = filesData
      .map((f) => `File: ${f.filename} (${f.status})\nPatch:\n${f.patch || "No patch available"}`)
      .join("\n\n---\n\n");

    const systemPrompt = `You are CodeGuard AI, an expert code reviewer analyzing a GitHub Pull Request diff.
Analyze the PR diff for security flaws, bugs, performance bottlenecks, maintainability issues, and style improvements.

PR Title: "${prData.title}"
PR Description: "${prData.body || "No description provided"}"

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

    const userPrompt = `Pull Request Diff to Review:\n\n${diffContext.slice(0, 12000)}`;

    let reviewResult;
    try {
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
        console.error("Groq API error for PR review:", errorText);
        await db.update(reviews).set({ status: "failed", updatedAt: new Date() }).where(eq(reviews.id, pendingReview.id));
        return NextResponse.json({ error: "AI service failed to process PR review", details: errorText }, { status: 502 });
      }

      const aiData = await aiResponse.json();
      const rawContent = aiData.choices?.[0]?.message?.content;

      if (!rawContent) {
        await db.update(reviews).set({ status: "failed", updatedAt: new Date() }).where(eq(reviews.id, pendingReview.id));
        return NextResponse.json({ error: "Empty AI response" }, { status: 502 });
      }

      const parsedContent = JSON.parse(rawContent);
      reviewResult = ReviewOutputSchema.parse(parsedContent);
    } catch (err: any) {
      console.error("AI PR review completion error:", err);
      await db.update(reviews).set({ status: "failed", updatedAt: new Date() }).where(eq(reviews.id, pendingReview.id));
      return NextResponse.json({ error: "AI PR review parsing failed", details: err.message }, { status: 502 });
    }

    // 6. Update review status to completed
    const [updatedReview] = await db
      .update(reviews)
      .set({
        status: "completed",
        score: reviewResult.score,
        overallScore: `${reviewResult.score.toFixed(1)}/10`,
        summary: reviewResult.summary,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(reviews.id, pendingReview.id))
      .returning();

    // 7. Insert review issue comments into DB
    if (reviewResult.issues.length > 0) {
      await db.insert(reviewComments).values(
        reviewResult.issues.map((issue) => ({
          reviewId: updatedReview.id,
          filePath: filesData[0]?.filename || "PR diff",
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
      id: updatedReview.id,
      prNumber: prNum,
      title: prData.title,
      score: reviewResult.score,
      summary: reviewResult.summary,
      issues: reviewResult.issues,
      changedFiles: filesData.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      })),
      headSha: prData.head.sha,
      createdAt: updatedReview.createdAt,
    });
  } catch (error: any) {
    console.error("Error processing PR review:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
