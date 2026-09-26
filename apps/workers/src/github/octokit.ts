import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { db, githubInstallations, repositories, eq } from "@codeguard/db";
import { getEnv, getGitHubAppConfig, MissingConfigError } from "@codeguard/config";

/**
 * GitHub auth for the workers.
 *
 * Production uses the GitHub App: a short-lived (1h) installation token per
 * repository owner, so the worker can act on every customer's repos without a
 * personal token. `GITHUB_TOKEN` is accepted ONLY outside production, as a
 * local-development shortcut.
 */

const tokenCache = new Map<number, { octokit: Octokit; expiresAt: number }>();

export async function getInstallationOctokit(installationId: number): Promise<Octokit> {
  const cached = tokenCache.get(installationId);
  // Refresh 5 minutes before GitHub's 60-minute expiry.
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.octokit;

  const app = getGitHubAppConfig();
  const auth = createAppAuth({ appId: app.appId, privateKey: app.privateKey });
  const { token, expiresAt } = await auth({ type: "installation", installationId });
  const octokit = new Octokit({ auth: token });
  tokenCache.set(installationId, { octokit, expiresAt: new Date(expiresAt).getTime() });
  return octokit;
}

/** Find the installation that owns a repository (from the webhook or our DB). */
export async function resolveInstallationId(
  owner: string,
  repo: string,
  hint?: number | null
): Promise<number | null> {
  if (hint) return hint;
  const [row] = await db
    .select({ installationId: githubInstallations.installationId })
    .from(repositories)
    .innerJoin(githubInstallations, eq(repositories.installationId, githubInstallations.id))
    .where(eq(repositories.fullName, `${owner}/${repo}`))
    .limit(1);
  return row?.installationId ? Number(row.installationId) : null;
}

export async function getRepoOctokit(owner: string, repo: string, installationHint?: number | null): Promise<Octokit> {
  const installationId = await resolveInstallationId(owner, repo, installationHint);
  if (installationId) return getInstallationOctokit(installationId);

  const env = getEnv();
  const devToken = process.env.GITHUB_TOKEN;
  if (env.NODE_ENV !== "production" && devToken) {
    console.warn(`[github] No installation for ${owner}/${repo}; using GITHUB_TOKEN (development only)`);
    return new Octokit({ auth: devToken });
  }
  throw new MissingConfigError(["a GitHub App installation for this repository"], `GitHub access to ${owner}/${repo}`);
}
