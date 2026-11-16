import { db, githubInstallations, repositories, and, eq, inArray, not, sql } from "@codeguard/db";
import { installationOctokit, type GhInstallation, type GhRepo } from "./github-app";

/**
 * Keep github_installations + repositories in step with GitHub.
 *
 * Called from three places, in no guaranteed order:
 *   - the install callback        (user just installed)
 *   - `installation*` webhooks     (GitHub tells us what changed)
 *   - the "sync" query param       (user asked to refresh)
 * so every write is an UPSERT keyed on GitHub's ids: running it twice, or in
 * any order, ends in the same state.
 */

type InstallationStatus = "active" | "suspended" | "deleted";

function cleanPermissions(p: GhInstallation["permissions"]): Record<string, string> {
  return Object.fromEntries(Object.entries(p ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
}

export async function upsertInstallation(
  inst: GhInstallation,
  opts: { ownerUserId?: string; status?: InstallationStatus } = {},
): Promise<void> {
  const account = inst.account;
  if (!account) throw new Error(`installation ${inst.id} has no account`);

  const status = opts.status ?? (inst.suspended_at ? "suspended" : "active");
  const values = {
    installationId: inst.id,
    accountId: account.id,
    accountLogin: account.login ?? account.slug ?? String(account.id),
    accountType: account.type ?? "Enterprise",
    accountAvatarUrl: account.avatar_url ?? null,
    ownerUserId: opts.ownerUserId ?? null,
    status,
    permissions: cleanPermissions(inst.permissions),
    events: inst.events ?? [],
  };

  await db
    .insert(githubInstallations)
    .values(values)
    .onConflictDoUpdate({
      target: githubInstallations.installationId,
      set: {
        accountId: values.accountId,
        accountLogin: values.accountLogin,
        accountType: values.accountType,
        accountAvatarUrl: values.accountAvatarUrl,
        status: values.status,
        permissions: values.permissions,
        events: values.events,
        // Never steal an installation that is already linked to someone else:
        // keep the existing owner, only fill it in when it is empty.
        ownerUserId: sql`coalesce(${githubInstallations.ownerUserId}, excluded.owner_user_id)`,
        updatedAt: new Date(),
      },
    });
}

export async function setInstallationStatus(installationId: number, status: InstallationStatus): Promise<void> {
  await db
    .update(githubInstallations)
    .set({ status, updatedAt: new Date() })
    .where(eq(githubInstallations.installationId, installationId));

  if (status === "deleted") {
    // Soft delete: past reviews still display, a reinstall flips them back.
    await db
      .update(repositories)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(repositories.installationId, installationId));
  }
}

export async function upsertRepositories(installationId: number, repos: GhRepo[]): Promise<void> {
  if (repos.length === 0) return;

  const rows = repos.map((r) => {
    const [owner, name] = r.full_name.split("/");
    return {
      githubRepoId: r.id,
      installationId,
      owner,
      name: name ?? r.name,
      fullName: r.full_name,
      private: r.private,
      htmlUrl: r.html_url ?? null,
      language: r.language ?? null,
      description: r.description ?? null,
      active: true,
    };
  });

  await db
    .insert(repositories)
    .values(rows)
    .onConflictDoUpdate({
      target: repositories.githubRepoId,
      set: {
        installationId: sql`excluded.installation_id`,
        owner: sql`excluded.owner`,
        name: sql`excluded.name`,
        fullName: sql`excluded.full_name`, // picks up renames: the id stays, the name changes
        private: sql`excluded.private`,
        // Webhook payloads don't include these; keep what the last full sync stored.
        htmlUrl: sql`coalesce(excluded.html_url, ${repositories.htmlUrl})`,
        language: sql`coalesce(excluded.language, ${repositories.language})`,
        description: sql`coalesce(excluded.description, ${repositories.description})`,
        active: true,
        updatedAt: new Date(),
        // autoReviewEnabled is deliberately NOT here: a sync must never undo the user's switch.
      },
    });
}

export async function deactivateRepositories(githubRepoIds: number[]): Promise<void> {
  if (githubRepoIds.length === 0) return;
  await db
    .update(repositories)
    .set({ active: false, updatedAt: new Date() })
    .where(inArray(repositories.githubRepoId, githubRepoIds));
}

/** Full refresh of one installation's repo list from GitHub's API. */
export async function syncInstallationRepositories(installationId: number): Promise<number> {
  const octokit = await installationOctokit(installationId);
  const repos = (await octokit.paginate("GET /installation/repositories", { per_page: 100 })) as GhRepo[];

  await upsertRepositories(installationId, repos);

  // Anything we still list for this installation that GitHub no longer grants → inactive.
  const granted = repos.map((r) => r.id);
  await db
    .update(repositories)
    .set({ active: false, updatedAt: new Date() })
    .where(
      and(
        eq(repositories.installationId, installationId),
        eq(repositories.active, true),
        granted.length ? not(inArray(repositories.githubRepoId, granted)) : undefined,
      ),
    );

  return repos.length;
}
