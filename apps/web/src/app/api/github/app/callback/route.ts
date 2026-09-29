import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { db, githubInstallations, eq } from "@codeguard/db";
import { GitHubAppService } from "@/services/GitHubAppService";

const INSTALL_STATE_COOKIE = "cg_install_state";

/**
 * GET /api/github/app/callback — GitHub App "Setup URL".
 *
 * Requires "Request user authorization (OAuth) during installation" to be
 * enabled on the GitHub App so GitHub sends `code` along with
 * `installation_id`.
 *
 * Security: `installation_id` is attacker-controlled. We only link it to the
 * signed-in user after
 *   1. the `state` matches the cookie set by /api/github/app/install, and
 *   2. GitHub confirms (via the user's OAuth token) that this user can access
 *      that installation.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const done = (query: string) => {
    const res = NextResponse.redirect(new URL(`/install?${query}`, req.url));
    res.cookies.delete({ name: INSTALL_STATE_COOKIE, path: "/api/github/app/callback" });
    return res;
  };

  try {
    const { userId } = await auth();
    if (!userId) return done("error=not_authenticated");

    const code = url.searchParams.get("code");
    const installationId = Number(url.searchParams.get("installation_id"));
    const setupAction = url.searchParams.get("setup_action");
    const state = url.searchParams.get("state") ?? "";
    const expectedState = req.headers.get("cookie")?.match(new RegExp(`${INSTALL_STATE_COOKIE}=([a-f0-9]+)`))?.[1] ?? "";

    if (!code || !Number.isInteger(installationId) || installationId <= 0) {
      return done("error=missing_params");
    }
    if (!expectedState || !safeEqual(state, expectedState)) {
      return done("error=invalid_state");
    }

    const app = GitHubAppService.fromEnv();
    if (!(await app.userCanAccessInstallation(code, installationId))) {
      console.warn(`[github-app-callback] user ${userId} tried to link installation ${installationId} they cannot access`);
      return done("error=forbidden");
    }

    const installation = await app.getInstallation(installationId);
    if (!installation) return done("error=installation_not_found");

    await app.handleInstallationEvent(setupAction === "update" ? "new_permissions_accepted" : "created", installation);

    await db
      .update(githubInstallations)
      .set({ userId, updatedAt: new Date() })
      .where(eq(githubInstallations.installationId, installationId));

    return done("success=true");
  } catch (err) {
    console.error("[GET /api/github/app/callback]", err);
    return done("error=install_failed");
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
