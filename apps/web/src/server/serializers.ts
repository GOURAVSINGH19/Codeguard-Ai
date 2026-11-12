import type { GithubInstallation, Repository } from "@codeguard/db";

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
