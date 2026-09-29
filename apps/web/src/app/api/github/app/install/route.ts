import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { GitHubAppService } from "@/services/GitHubAppService";
import { handleApiError, jsonError } from "@/lib/api";

export const INSTALL_STATE_COOKIE = "cg_install_state";

/**
 * GET /api/github/app/install
 *
 * Starts the GitHub App installation. A random `state` is stored in an
 * httpOnly cookie and passed to GitHub; the callback only accepts a request
 * that returns the same value (CSRF protection).
 */
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const app = GitHubAppService.fromEnv();
    const state = randomBytes(24).toString("hex");
    const url = new URL(app.installUrl);
    url.searchParams.set("state", state);

    const res = NextResponse.redirect(url);
    res.cookies.set(INSTALL_STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/github/app/callback",
      maxAge: 15 * 60,
    });
    return res;
  } catch (err) {
    return handleApiError(err, "GET /api/github/app/install");
  }
}
