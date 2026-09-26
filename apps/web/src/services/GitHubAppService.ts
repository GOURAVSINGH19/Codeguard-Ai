import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { db, githubInstallations, repositories, eq } from "@codeguard/db";
import { getGitHubAppConfig, getGitHubAppOAuthConfig } from "@codeguard/config";
import type { GitHubAppConfig } from "@codeguard/config";

export type { GitHubAppConfig };

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

export interface AppInstallation {
  id: number;
  account: {
    login: string;
    id: number;
    type: "User" | "Organization" | string;
    avatar_url: string;
  } | null;
  repository_selection: "all" | "selected";
  permissions: Record<string, string | undefined>;
  events: string[];
}

export type InstallationAction = "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted";

/**
 * GitHubAppService
 *
 * GitHub App authentication and installation management. App-level calls
 * (get/delete installation) use the app JWT; repository calls use a
 * short-lived installation token.
 */
export class GitHubAppService {
  constructor(private readonly config: GitHubAppConfig) {}

  static fromEnv(): GitHubAppService {
    return new GitHubAppService(getGitHubAppConfig());
  }

  get installUrl(): string {
    return `https://github.com/apps/${this.config.slug}/installations/new`;
  }

  private getAuth() {
    return createAppAuth({ appId: this.config.appId, privateKey: this.config.privateKey });
  }

  async getInstallationToken(installationId: number): Promise<InstallationToken> {
    const { token, expiresAt } = await this.getAuth()({ type: "installation", installationId });
    return { token, expiresAt };
  }

  async createInstallationOctokit(installationId: number): Promise<Octokit> {
    const { token } = await this.getInstallationToken(installationId);
    return new Octokit({ auth: token });
  }

  /** Octokit authenticated as the App itself (JWT) — required for /app/* endpoints. */
  async createAppOctokit(): Promise<Octokit> {
    const { token } = await this.getAuth()({ type: "app" });
    return new Octokit({ auth: token });
  }

  async getInstallation(installationId: number): Promise<AppInstallation | null> {
    const octokit = await this.createAppOctokit();
    try {
      const { data } = await octokit.rest.apps.getInstallation({ installation_id: installationId });
      return data as unknown as AppInstallation;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  async deleteInstallation(installationId: number): Promise<void> {
    const octokit = await this.createAppOctokit();
    await octokit.rest.apps.deleteInstallation({ installation_id: installationId });
  }

  /**
   * Exchange the OAuth `code` GitHub sends to the setup URL for a user token,
   * then list the installations that user can actually access. This is how we
   * prove the signed-in person really owns/administers `installation_id`
   * (the query parameter alone can be forged).
   */
  async userCanAccessInstallation(code: string, installationId: number): Promise<boolean> {
    const { clientId, clientSecret } = getGitHubAppOAuthConfig();
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string };
    if (!res.ok || !body.access_token) return false;

    const userOctokit = new Octokit({ auth: body.access_token });
    const installations = await userOctokit.paginate(userOctokit.rest.apps.listInstallationsForAuthenticatedUser, { per_page: 100 });
    return installations.some((i) => i.id === installationId);
  }

  async getInstallationRepositories(installationId: number) {
    const octokit = await this.createInstallationOctokit(installationId);
    return octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
  }

  /** Store or update an installation. Secrets are never copied into the DB. */
  async syncInstallation(installation: AppInstallation): Promise<void> {
    const { id, account, permissions, events } = installation;
    if (!account) return;

    await db
      .insert(githubInstallations)
      .values({
        installationId: id,
        githubAppId: Number(this.config.appId),
        accountId: account.id,
        accountLogin: account.login,
        accountType: account.type,
        accountAvatarUrl: account.avatar_url,
        status: "active",
        permissions,
        events,
      })
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: {
          accountLogin: account.login,
          accountAvatarUrl: account.avatar_url,
          status: "active",
          permissions,
          events,
          updatedAt: new Date(),
        },
      });
  }

  async handleInstallationEvent(action: InstallationAction | string, installation: AppInstallation): Promise<void> {
    switch (action) {
      case "created":
        await this.syncInstallation(installation);
        await this.syncInstallationRepositories(installation.id);
        break;
      case "deleted":
        await db
          .update(githubInstallations)
          .set({ status: "deleted", updatedAt: new Date() })
          .where(eq(githubInstallations.installationId, installation.id));
        break;
      case "suspend":
        await db
          .update(githubInstallations)
          .set({ status: "suspended", suspendedAt: new Date(), updatedAt: new Date() })
          .where(eq(githubInstallations.installationId, installation.id));
        break;
      case "unsuspend":
        await db
          .update(githubInstallations)
          .set({ status: "active", suspendedAt: null, updatedAt: new Date() })
          .where(eq(githubInstallations.installationId, installation.id));
        break;
      case "new_permissions_accepted":
        await this.syncInstallation(installation);
        break;
    }
  }

  async syncInstallationRepositories(installationId: number): Promise<void> {
    const [installation] = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);
    if (!installation) return;

    const repos = await this.getInstallationRepositories(installationId);
    for (const repo of repos) {
      await db
        .insert(repositories)
        .values({
          githubRepoId: repo.id,
          installationId: installation.id,
          fullName: repo.full_name,
          owner: repo.owner.login,
          name: repo.name,
          defaultBranch: repo.default_branch ?? "main",
          isPrivate: repo.private,
          language: repo.language ?? null,
          description: repo.description ?? null,
          autoReviewEnabled: false, // off by default; enabled per repo by the owner
          cloneUrl: repo.clone_url,
          htmlUrl: repo.html_url,
        })
        .onConflictDoUpdate({
          target: repositories.githubRepoId,
          set: {
            installationId: installation.id,
            fullName: repo.full_name,
            defaultBranch: repo.default_branch ?? "main",
            isPrivate: repo.private,
            language: repo.language ?? null,
            description: repo.description ?? null,
            cloneUrl: repo.clone_url,
            htmlUrl: repo.html_url,
            status: "active",
            updatedAt: new Date(),
          },
        });
    }
  }

  /** Installation that owns a repository, if the app is installed there. */
  async getInstallationIdForRepo(owner: string, repo: string): Promise<number | null> {
    const [row] = await db
      .select({ installationId: githubInstallations.installationId })
      .from(repositories)
      .innerJoin(githubInstallations, eq(repositories.installationId, githubInstallations.id))
      .where(eq(repositories.fullName, `${owner}/${repo}`))
      .limit(1);
    return row?.installationId ? Number(row.installationId) : null;
  }
}
