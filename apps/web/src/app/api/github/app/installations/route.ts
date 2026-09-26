import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db, githubInstallations, eq, and, ne } from "@codeguard/db";
import { handleApiError, jsonError } from "@/lib/api";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const installations = await db
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

    return NextResponse.json({ installations });
  } catch (err) {
    return handleApiError(err, "GET /api/github/app/installations");
  }
}
