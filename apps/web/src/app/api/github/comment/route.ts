import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getGitHubClient } from "@/lib/github";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { owner, repo, pullNumber, score, summary, issues } = body;

    const prNum = parseInt(pullNumber, 10);
    if (!owner || !repo || isNaN(prNum)) {
      return NextResponse.json(
        { error: "Owner, repo, and pullNumber are required" },
        { status: 400 }
      );
    }

    const octokit = await getGitHubClient();

    // Format GitHub Review comment body
    const formattedIssuesText = (issues || [])
      .map(
        (i: any, idx: number) =>
          `### ${idx + 1}. [${(i.severity || "info").toUpperCase()}] ${i.category || "General"}\n` +
          `**Message**: ${i.message}\n` +
          (i.line ? `**Line**: ${i.line}\n` : "") +
          (i.suggestion ? `\n\`\`\`suggestion\n${i.suggestion}\n\`\`\`\n` : "")
      )
      .join("\n\n");

    const reviewBody = `## 🛡️ CodeGuard AI Review Summary

**Quality Score**: \`${score !== undefined ? score.toFixed(1) : "N/A"} / 10\`

### Executive Summary
${summary || "No summary provided."}

---

### Identified Issues (${(issues || []).length})
${formattedIssuesText || "🎉 No major security or code quality issues detected!"}

---
*Powered by CodeGuard AI Reviewer*`;

    let htmlUrl = "";
    let reviewId = 0;

    try {
      // 1. Attempt to post official PR Review
      const { data: createdReview } = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNum,
        event: score >= 8.0 ? "APPROVE" : "COMMENT",
        body: reviewBody,
      });
      htmlUrl = createdReview.html_url;
      reviewId = createdReview.id;
    } catch (err: any) {
      console.warn("pulls.createReview failed, trying issues.createComment fallback:", err?.message);
      const { data: issueComment } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNum,
        body: reviewBody,
      });
      htmlUrl = issueComment.html_url;
      reviewId = issueComment.id;
    }

    return NextResponse.json({
      success: true,
      githubReviewId: reviewId,
      htmlUrl: htmlUrl || `https://github.com/${owner}/${repo}/pull/${prNum}`,
      message: "Successfully posted CodeGuard AI review to GitHub PR!",
    });
  } catch (error: any) {
    console.error("Error posting review comment to GitHub PR:", error);
    return NextResponse.json(
      { error: error.message || "Failed to post review comment to GitHub PR. Check repo permissions." },
      { status: error.status || 500 }
    );
  }
}
