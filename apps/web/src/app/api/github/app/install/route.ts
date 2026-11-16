import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { installUrl } from "@/server/github-app";
import { STATE_COOKIE, newState, stateCookieOptions } from "@/server/install-state";
import { errorResponse } from "@/server/http";

/**
 * GET /api/github/app/install
 * Start the install flow: remember a random state in a cookie, send the user to GitHub.
 */
export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.redirect(new URL("/install?error=not_authenticated", req.url));

  try {
    const state = newState();
    const res = NextResponse.redirect(installUrl(state));
    res.cookies.set(STATE_COOKIE, state, stateCookieOptions);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
