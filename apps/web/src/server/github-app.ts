import { App, Octokit } from "octokit";
import { getEnv } from "@codeguard/config";

/**
 * CodeGuard's identity on GitHub.
 *
 * Two kinds of token, both handled by `octokit`:
 *   private key ──sign──▶ App JWT (~10 min)          → app.octokit: "I am app #123"
 *   App JWT ──exchange──▶ installation token (~1 h)  → getInstallationOctokit(id): act on that install's repos
 *
 * The private key only ever lives in server env vars.
 */
let app: App | undefined;

export function githubApp(): App {
  if (!app) {
    const env = getEnv();
    app = new App({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY });
  }
  return app;
}

/** Octokit authenticated as one installation (token is cached and refreshed by octokit). */
export function installationOctokit(installationId: number): Promise<Octokit> {
  return githubApp().getInstallationOctokit(installationId);
}

/** Link that starts the GitHub install flow; GitHub sends `state` back to our callback. */
export function installUrl(state: string): string {
  const { GITHUB_APP_SLUG } = getEnv();
  return `https://github.com/apps/${encodeURIComponent(GITHUB_APP_SLUG)}/installations/new?state=${encodeURIComponent(state)}`;
}

/** Minimal shapes of the GitHub objects we store (from REST responses or webhook payloads). */
export interface GhAccount {
  id: number;
  login?: string;
  slug?: string; // enterprise accounts have a slug instead of a login
  type?: string;
  avatar_url?: string | null;
}

export interface GhInstallation {
  id: number;
  account: GhAccount | null;
  permissions?: Record<string, string | undefined>;
  events?: string[];
  suspended_at?: string | null;
}

export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url?: string;
  language?: string | null;
  description?: string | null;
}
