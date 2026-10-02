import { clerkClient } from "@clerk/nextjs/server";
import { Octokit } from "octokit";
import { db, githubInstallations, and, eq, isNull, inArray, or } from "@codeguard/db";
import { GitHubAppService, type AppInstallation } from "@/services/GitHubAppService";

/**
 * Link GitHub App installations that arrived without an owner to `userId`.
 *
 * Installations are normally linked in the setup callback, but that step is
 * skipped when the app is installed straight from GitHub, the Setup URL / OAuth
 * option isn't configured, or the state cookie is missing. The webhook still
 * stores those rows, with user_id NULL — and the user is asked to install again.
 *
 * If the webhook never arrived either, the row is imported from GitHub using
 * the App's own credentials (GET /app/installations) before linking.
 *
 * Ownership is proven with the user's own GitHub token (from Clerk), never by
 * matching names alone:
 *   - personal installs: the installation account id is the user's GitHub id
 *   - org installs:      the user is an active *admin* of that organization
 *
 * Best-effort: any GitHub/Clerk failure leaves things unchanged.
 */
export async function claimUnlinkedInstallations(userId: string): Promise<number> {
  try {
    const client = await clerkClient();
    const tokenRes = await client.users.getUserOauthAccessToken(userId, "oauth_github");
    const token = tokenRes.data?.[0]?.token;
    if (!token) return 0;

    const octokit = new Octokit({ auth: token });
    const { data: me } = await octokit.rest.users.getAuthenticated();

    // Needs the read:org scope; without it only personal installs are claimed.
    const adminOrgs = await octokit
      .paginate(octokit.rest.orgs.listMembershipsForAuthenticatedUser, { state: "active", per_page: 100 })
      .then((ms) => ms.filter((m) => m.role === "admin").map((m) => m.organization.login))
      .catch(() => [] as string[]);

    await importMissingInstallations(me.id, adminOrgs);

    const owned = or(
      and(eq(githubInstallations.accountType, "User"), eq(githubInstallations.accountId, me.id)),
      adminOrgs.length
        ? and(eq(githubInstallations.accountType, "Organization"), inArray(githubInstallations.accountLogin, adminOrgs))
        : undefined
    );

    const claimed = await db
      .update(githubInstallations)
      .set({ userId, updatedAt: new Date() })
      .where(and(isNull(githubInstallations.userId), eq(githubInstallations.status, "active"), owned))
      .returning({ id: githubInstallations.id });

    if (claimed.length) console.info(`[claim-installations] linked ${claimed.length} installation(s) to ${userId}`);
    return claimed.length;
  } catch (err) {
    console.warn("[claim-installations] skipped:", (err as Error).message);
    return 0;
  }
}

/** Store (or reactivate) installations of this app the user owns that the DB doesn't have as active. */
async function importMissingInstallations(githubUserId: number, adminOrgs: string[]): Promise<void> {
  try {
    const app = GitHubAppService.fromEnv();
    const appOctokit = await app.createAppOctokit();
    const all = (await appOctokit.paginate(appOctokit.rest.apps.listInstallations, { per_page: 100 })) as unknown as AppInstallation[];

    const mine = all.filter((i) =>
      !i.account ? false : i.account.type === "Organization" ? adminOrgs.includes(i.account.login) : i.account.id === githubUserId
    );
    if (!mine.length) return;

    const known = await db
      .select({ installationId: githubInstallations.installationId, status: githubInstallations.status })
      .from(githubInstallations)
      .where(inArray(githubInstallations.installationId, mine.map((i) => i.id)));
    // Live on GitHub but missing here, or still marked deleted from an earlier uninstall.
    const upToDate = new Set(known.filter((k) => k.status === "active").map((k) => Number(k.installationId)));

    for (const inst of mine) {
      if (!upToDate.has(inst.id)) await app.handleInstallationEvent("created", inst);
    }
  } catch (err) {
    // App credentials missing or GitHub unreachable — fall back to existing rows.
    console.warn("[claim-installations] import skipped:", (err as Error).message);
  }
}
