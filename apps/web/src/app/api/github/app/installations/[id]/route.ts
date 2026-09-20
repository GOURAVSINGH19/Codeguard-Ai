import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db, githubInstallations, repositories } from "@codeguard/db";
import { eq } from "drizzle-orm";
import { Octokit } from "octokit";
import { GitHubAppService } from "@/services/GitHubAppService";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const installationId = Number(id);

    // Verify ownership
    const [installation] = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, Number(installationId)))
      .limit(1);

    if (!installation || installation.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Delete from GitHub
    const appService = GitHubAppService.fromEnv();
    const octokit = await appService.createInstallationOctokit(installationId);
    
    try {
      await octokit.rest.apps.deleteInstallation({
        installation_id: installationId,
      });
    } catch (err: any) {
      console.warn("[DELETE installation] Failed to delete from GitHub:", err.message);
      // Continue with local cleanup even if GitHub delete fails
    }

    // Mark repositories as inactive
    await db
      .update(repositories)
      .set({ status: "inactive", updatedAt: new Date() })
      .where(eq(repositories.installationId, installation.id));

    // Mark installation as deleted
    await db
      .update(githubInstallations)
      .set({ status: "deleted", updatedAt: new Date() })
      .where(eq(githubInstallations.id, installation.id));

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("[DELETE /api/github/app/installations/[id]]", error);
    return NextResponse.json(
      { error: error.message || "Failed to uninstall" },
      { status: 500 }
    );
  }
}