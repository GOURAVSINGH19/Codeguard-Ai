import type { GithubInstallation, Repository, Review, ReviewFinding } from "@codeguard/db";

/**
 * DB rows → the JSON shapes the existing UI expects.
 * Keep these in sync with the interfaces in the components named below.
 */

/** src/lib/installations.ts → InstallationRow */
export function toInstallationRow(r: GithubInstallation) {
  return {
    id: r.id,
    installationId: r.installationId,
    accountLogin: r.accountLogin,
    accountType: r.accountType,
    accountAvatarUrl: r.accountAvatarUrl,
    status: r.status,
    permissions: r.permissions,
    events: r.events,
    createdAt: r.createdAt.toISOString(),
  };
}

/** src/app/install/page.tsx → Repository, src/components/RepoDrawer.tsx → GrantedRepo, RepoPulls.tsx → RepoInfo */
export function toRepoJson(r: Repository) {
  return {
    id: r.githubRepoId,
    fullName: r.fullName,
    owner: r.owner,
    name: r.name,
    private: r.private,
    language: r.language,
    description: r.description,
    autoReviewEnabled: r.autoReviewEnabled,
    htmlUrl: r.htmlUrl ?? `https://github.com/${r.fullName}`,
    account: r.owner,
  };
}

/** src/components/ReviewerDashboard.tsx → ReviewRow, ReviewHistory.tsx → HistoryRow */
export function toReviewRow(r: Review, issues: Array<Pick<ReviewFinding, "severity" | "category">>) {
  return {
    id: r.id,
    title: r.prTitle ?? `${r.repoFullName}#${r.prNumber}`,
    score: r.score,
    status: r.status,
    reviewType: r.reviewType,
    createdAt: r.createdAt.toISOString(),
    repo: r.repoFullName,
    prNumber: r.prNumber,
    issues: issues.map((i) => ({ severity: i.severity, category: i.category })),
  };
}

/** src/app/reviews/[id]/page.tsx → ReviewDetail */
export function toReviewDetail(r: Review, findings: ReviewFinding[]) {
  return {
    id: r.id,
    title: r.prTitle ?? `${r.repoFullName}#${r.prNumber}`,
    codeSnippet: null,
    language: null,
    score: r.score,
    summary: r.summary,
    status: r.status,
    reviewType: r.reviewType,
    model: r.model,
    headSha: r.headSha,
    createdAt: r.createdAt.toISOString(),
    issues: findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      category: f.category,
      file: f.file,
      line: f.line,
      message: f.message,
      suggestion: f.suggestion,
      status: f.status,
      source: f.source,
      confidence: f.confidence,
    })),
    repo: r.repoFullName,
    prNumber: r.prNumber,
    pullRequest: r.pullRequest ?? null,
    details: {
      tokens: r.tokens,
      durationMs: r.durationMs,
      githubUrl: r.githubReviewUrl ?? r.pullRequest?.htmlUrl ?? null,
    },
    assurance: r.assurance ?? null,
    progress: r.progress,
    error: r.error,
  };
}
