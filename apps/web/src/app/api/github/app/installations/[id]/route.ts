import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db, githubInstallations, repositories, eq } from "@codeguard/db";
import { GitHubAppService } from "@/services/GitHubAppService";
import { handleApiError, jsonError } from "@/lib/api";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const installationId = Number((await params).id);
    if (!Number.isInteger(installationId) || installationId <= 0) return jsonError(400, "Invalid installation id");

    const [installation] = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);

    if (!installation || installation.userId !== userId) return jsonError(404, "Not found");

    // /app/installations/:id requires the App JWT, not an installation token.
    try {
      await GitHubAppService.fromEnv().deleteInstallation(installationId);
    } catch (err) {
      console.warn("[DELETE installation] GitHub uninstall failed, cleaning up locally:", (err as Error).message);
    }

    await db
      .update(repositories)
      .set({ status: "inactive", autoReviewEnabled: true, updatedAt: new Date() })
      .where(eq(repositories.installationId, installation.id));

    await db
      .update(githubInstallations)
      .set({ status: "deleted", updatedAt: new Date() })
      .where(eq(githubInstallations.id, installation.id));

    return NextResponse.json({ success: true });
  } catch (err) {
    return handleApiError(err, "DELETE /api/github/app/installations/[id]");
  }
}
