import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { db, githubInstallations, repositories } from "@codeguard/db";
import { eq } from "drizzle-orm";
import crypto from "crypto";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
  repositories?: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
  }>;
}

export interface AppInstallation {
  id: number;
  account: {
    login: string;
    id: number;
    type: "User" | "Organization";
    avatar_url: string;
  };
  repository_selection: "all" | "selected";
  permissions: Record<string, string>;
  events: string[];
}

/**
 * GitHubAppService
 *
 * Handles GitHub App authentication and installation management.
 * Uses @octokit/auth-app for JWT-based authentication flow.
 */
export class GitHubAppService {
  private readonly config: GitHubAppConfig;

  constructor(config: GitHubAppConfig) {
    this.config = config;
  }

  static fromEnv(): GitHubAppService {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;

    if (!appId || !privateKey || !webhookSecret) {
      throw new Error(
        "GitHub App configuration missing. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_WEBHOOK_SECRET in your environment."
      );
    }

    return new GitHubAppService({ appId, privateKey, webhookSecret });
  }

  /**
   * Get the authentication instance for the GitHub App.
   * Used for generating JWTs and installation tokens.
   */
  private getAuth() {
    return createAppAuth({
      appId: this.config.appId,
      privateKey: this.config.privateKey,
    });
  }

  /**
   * Get an installation access token for a specific installation.
   * This token can be used to make API calls on behalf of the installation.
   */
  async getInstallationToken(installationId: number): Promise<InstallationToken> {
    const auth = this.getAuth();
    const { token, expiresAt } = await auth({
      type: "installation",
      installationId,
    });

    return { token, expiresAt };
  }

  /**
   * Create an Octokit instance authenticated as a specific installation.
   */
  async createInstallationOctokit(installationId: number): Promise<Octokit> {
    const { token } = await this.getInstallationToken(installationId);
    return new Octokit({ auth: token });
  }

  /**
   * Create an Octokit instance authenticated as the GitHub App.
   */
  private async createAppOctokit(): Promise<Octokit> {
    const { token } = await this.getAuth()({ type: "app" });
    return new Octokit({ auth: token });
  }

  /**
   * Get all installations for this GitHub App.
   */
  async listInstallations(): Promise<AppInstallation[]> {
    const octokit = await this.createAppOctokit();
    const { data } = await octokit.rest.apps.listInstallations();
    return data as AppInstallation[];
  }

  /**
   * Get an installation by its ID.
   */
  async getInstallation(installationId: number): Promise<AppInstallation | null> {
    const octokit = await this.createAppOctokit();

    try {
      const { data } = await octokit.rest.apps.getInstallation({
        installation_id: installationId,
      });
      return data as AppInstallation;
    } catch (err: any) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Get repositories accessible by an installation.
   */
  async getInstallationRepositories(installationId: number) {
    const octokit = await this.createInstallationOctokit(installationId);
    const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({
      per_page: 100,
    });
    return data.repositories;
  }

  /**
   * Store or update a GitHub App installation in the database.
   */
  async syncInstallation(installation: AppInstallation): Promise<void> {
    const { id, account, permissions, events } = installation;

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
        webhookSecret: this.config.webhookSecret,
      })
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: {
          accountLogin: account.login,
          accountAvatarUrl: account.avatar_url,
          status: "active",
          permissions,
          events,
          webhookSecret: this.config.webhookSecret,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Handle installation event (created, deleted, suspended, etc.)
   */
  async handleInstallationEvent(
    action: "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted",
    installation: AppInstallation
  ): Promise<void> {
    switch (action) {
      case "created":
        await this.syncInstallation(installation);
        // Auto-sync repositories for this installation
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

  /**
   * Sync repositories for an installation to our database.
   */
  async syncInstallationRepositories(installationId: number): Promise<void> {
    const repos = await this.getInstallationRepositories(installationId);

    // Get the installation record from DB
    const [installation] = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);

    if (!installation) return;

    for (const repo of repos) {
      await db
        .insert(repositories)
        .values({
          githubRepoId: repo.id,
          installationId: installation.id,
          fullName: repo.full_name,
          owner: repo.owner.login,
          name: repo.name,
          defaultBranch: repo.default_branch,
          isPrivate: repo.private,
          language: repo.language,
          description: repo.description,
          autoReviewEnabled: false, // Default to off, user enables per-repo
          cloneUrl: repo.clone_url,
          htmlUrl: repo.html_url,
        })
        .onConflictDoUpdate({
          target: repositories.githubRepoId,
          set: {
            installationId: installation.id,
            fullName: repo.full_name,
            defaultBranch: repo.default_branch,
            isPrivate: repo.private,
            language: repo.language,
            description: repo.description,
            cloneUrl: repo.clone_url,
            htmlUrl: repo.html_url,
            updatedAt: new Date(),
          },
        });
    }
  }

  /**
   * Verify a webhook signature from GitHub App.
   */
  verifyWebhookSignature(payload: string, signature: string): boolean {
    const expected = "sha256=" + crypto
      .createHmac("sha256", this.config.webhookSecret)
      .update(payload)
      .digest("hex");

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);

    return (
      sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)
    );
  }

  /**
   * Get the installation ID for a repository.
   */
  async getInstallationIdForRepo(owner: string, repo: string): Promise<number | null> {
    const [repoRecord] = await db
      .select({ installationId: repositories.installationId })
      .from(repositories)
      .where(eq(repositories.fullName, `${owner}/${repo}`))
      .limit(1);

    if (!repoRecord?.installationId) return null;

    const [installation] = await db
      .select({ installationId: githubInstallations.installationId })
      .from(githubInstallations)
      .where(eq(githubInstallations.id, repoRecord.installationId))
      .limit(1);

    return installation?.installationId ? Number(installation.installationId) : null;
  }
}