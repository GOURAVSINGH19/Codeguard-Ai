import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db, githubInstallations, eq, and, ne } from "@codeguard/db";
import { handleApiError, jsonError } from "@/lib/api";
import { claimUnlinkedInstallations } from "@/lib/claim-installations";

function listInstallations(userId: string) {
  return db
    .select({
      id: githubInstallations.id,
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
      accountAvatarUrl: githubInstallations.accountAvatarUrl,
      status: githubInstallations.status,
      permissions: githubInstallations.permissions,
      events: githubInstallations.events,
      createdAt: githubInstallations.createdAt,
    })
    .from(githubInstallations)
    .where(and(eq(githubInstallations.userId, userId), ne(githubInstallations.status, "deleted")));
}

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    let installations = await listInstallations(userId);
    // Installed but never linked (e.g. installed straight from GitHub)? Claim it.
    // Re-read even when nothing was claimed: a reactivated row may already be ours.
    if (!installations.some((i) => i.status === "active")) {
      await claimUnlinkedInstallations(userId);
      installations = await listInstallations(userId);
    }

    return NextResponse.json({ installations });
  } catch (err) {
    return handleApiError(err, "GET /api/github/app/installations");
  }
}
