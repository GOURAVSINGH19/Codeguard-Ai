import { App, type Octokit } from "octokit";
import { getEnv } from "@codeguard/config";

/**
 * The workers act as the GitHub App, like apps/web/src/server/github-app.ts:
 * private key → App JWT → short-lived installation token (octokit caches and refreshes it).
 */
let app: App | undefined;

export function installationOctokit(installationId: number): Promise<Octokit> {
  if (!app) {
    const env = getEnv();
    app = new App({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY });
  }
  return app.getInstallationOctokit(installationId);
}
