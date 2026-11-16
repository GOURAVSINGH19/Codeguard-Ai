import { clerkClient } from "@clerk/nextjs/server";
import { Octokit } from "octokit";
import { db, githubInstallations, and, eq, isNull } from "@codeguard/db";
import { githubApp, type GhAccount, type GhInstallation } from "./github-app";
import { syncInstallationRepositories, upsertInstallation } from "./installation-sync";

/**
 * "Does this signed-in user really own that GitHub installation?"
 *
 * Anyone can visit /api/github/app/callback?installation_id=<someone else's id>.
 * So we never trust the id alone. We ask GitHub, using the USER's own token
 * (Clerk stores it because they signed in with GitHub):
 *   - personal install: installation account id === the user's GitHub id
 *   - org install:      the user is an active ADMIN of that org
 *                       (needs the `read:org` scope on Clerk's GitHub connection)
 * Ids are compared, not names, because names can be renamed and reused.
 */
export interface GitHubIdentity {
  githubUserId: number;
  login: string;
  adminOrgs: string[]; // lower-cased org logins
}

export async function getGitHubIdentity(userId: string): Promise<GitHubIdentity | null> {
  const client = await clerkClient();
  const tokens = await client.users.getUserOauthAccessToken(userId, "github");
  const token = tokens.data[0]?.token;
  if (!token) return null; // signed in some other way, or the GitHub connection was removed

  const octokit = new Octokit({ auth: token });
  const { data: me } = await octokit.rest.users.getAuthenticated();

  const adminOrgs = await octokit
    .paginate(octokit.rest.orgs.listMembershipsForAuthenticatedUser, { state: "active", per_page: 100 })
    .then((ms) => ms.filter((m) => m.role === "admin").map((m) => m.organization.login.toLowerCase()))
    .catch(() => [] as string[]); // missing read:org scope → only personal installs can be verified

  return { githubUserId: me.id, login: me.login, adminOrgs };
}

export function ownsAccount(identity: GitHubIdentity, account: GhAccount | null): boolean {
  if (!account) return false;
  if (account.type === "Organization") {
    return !!account.login && identity.adminOrgs.includes(account.login.toLowerCase());
  }
  return account.type === "User" && account.id === identity.githubUserId;
}

/**
 * Link installations of this app that the user owns but that have no owner yet.
 *
 * Why this exists: the callback is not the only way to install. Installing
 * straight from github.com, or with the install tab left open, skips our
 * callback. The webhook still stores the installation (owner = NULL), and the
 * install button polls GET /installations, which calls this to finish the link.
 *
 * Best effort: any GitHub/Clerk failure leaves things unchanged.
 */
export async function claimUnlinkedInstallations(userId: string): Promise<number> {
  try {
    const identity = await getGitHubIdentity(userId);
    if (!identity) return 0;

    const all = (await githubApp().octokit.paginate("GET /app/installations", { per_page: 100 })) as GhInstallation[];
    const mine = all.filter((inst) => ownsAccount(identity, inst.account));

    let linked = 0;
    for (const inst of mine) {
      // Creates the row if the webhook never arrived; keeps any existing owner.
      await upsertInstallation(inst);
      const claimed = await db
        .update(githubInstallations)
        .set({ ownerUserId: userId, updatedAt: new Date() })
        .where(and(eq(githubInstallations.installationId, inst.id), isNull(githubInstallations.ownerUserId)))
        .returning({ id: githubInstallations.id });

      if (claimed.length) {
        linked++;
        await syncInstallationRepositories(inst.id).catch((err) =>
          console.warn(`[claim] repo sync for installation ${inst.id} failed:`, (err as Error).message),
        );
      }
    }
    if (linked) console.info(`[claim] linked ${linked} installation(s) to ${userId}`);
    return linked;
  } catch (err) {
    console.warn("[claim] skipped:", (err as Error).message);
    return 0;
  }
}

/** Installations owned by the user, excluding uninstalled ones. */
export async function userInstallations(userId: string) {
  return db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.ownerUserId, userId))
    .orderBy(githubInstallations.createdAt)
    .then((rows) => rows.filter((r) => r.status !== "deleted"));
}

/** Installation ids the user may act through right now (active only). */
export async function activeInstallationIds(userId: string): Promise<number[]> {
  const rows = await userInstallations(userId);
  return rows.filter((r) => r.status === "active").map((r) => r.installationId);
}
