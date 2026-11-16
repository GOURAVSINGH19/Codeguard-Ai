import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import { RequestError } from "octokit";
import { githubApp, type GhInstallation } from "@/server/github-app";
import { STATE_COOKIE, stateCookieOptions, stateMatches } from "@/server/install-state";
import { getGitHubIdentity, ownsAccount } from "@/server/ownership";
import { syncInstallationRepositories, upsertInstallation } from "@/server/installation-sync";

/**
 * GET /api/github/app/callback?installation_id=…&setup_action=install&state=…
 *
 * GitHub's "Setup URL". Anyone can call this URL with any installation id, so
 * it is checked twice before anything is linked:
 *   1. state === the cookie we set in /install   (this browser started the flow)
 *   2. GitHub confirms the user owns the account  (see server/ownership.ts)
 * The result is reported to /install as ?success=1 or ?error=<code>.
 */
export async function GET(req: Request) {
  const back = (query: string) => {
    const res = NextResponse.redirect(new URL(`/install?${query}`, req.url));
    res.cookies.set(STATE_COOKIE, "", { ...stateCookieOptions, maxAge: 0 }); // one-time use
    return res;
  };

  const { userId } = await auth();
  if (!userId) return back("error=not_authenticated");

  const url = new URL(req.url);
  const setupAction = url.searchParams.get("setup_action");
  const installationId = Number(url.searchParams.get("installation_id"));

  // An org member asked an admin to approve the install: nothing to link yet.
  if (setupAction === "request") return back("success=requested");
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return back("error=missing_params");

  // 1. CSRF check
  const expected = (await cookies()).get(STATE_COOKIE)?.value;
  if (!stateMatches(expected, url.searchParams.get("state"))) return back("error=invalid_state");

  try {
    // Load the installation AS THE APP: proves it exists and gives us the real account.
    const { data } = await githubApp().octokit.request("GET /app/installations/{installation_id}", {
      installation_id: installationId,
    });
    const installation = data as unknown as GhInstallation;

    // 2. Ownership check with the user's own GitHub token
    const identity = await getGitHubIdentity(userId);
    if (!identity || !ownsAccount(identity, installation.account)) return back("error=forbidden");

    await upsertInstallation(installation, { ownerUserId: userId });
    // The repo list can also arrive by webhook; a failure here isn't fatal.
    await syncInstallationRepositories(installationId).catch((err) =>
      console.warn(`[callback] repo sync for ${installationId} failed:`, (err as Error).message),
    );
    return back("success=1");
  } catch (err) {
    if (err instanceof RequestError && err.status === 404) return back("error=installation_not_found");
    console.error("[callback] install failed:", err);
    return back("error=install_failed");
  }
}
