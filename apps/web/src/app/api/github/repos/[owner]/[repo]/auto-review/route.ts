import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db, repositories } from "@codeguard/db";
import { eq } from "drizzle-orm";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { owner, repo } = await params;
    const body = await req.json();
    const { enabled } = body;

    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }

    // Verify user has access to this repo
    const [repoRecord] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.fullName, `${owner}/${repo}`))
      .limit(1);

    if (!repoRecord) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }

    // Check if user owns the installation
    if (repoRecord.installationId) {
      const { githubInstallations } = await import("@codeguard/db");
      const [installation] = await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.id, repoRecord.installationId))
        .limit(1);

      if (installation?.userId !== userId) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    // Update auto-review setting
    await db
      .update(repositories)
      .set({ autoReviewEnabled: enabled, updatedAt: new Date() })
      .where(eq(repositories.id, repoRecord.id));

    return NextResponse.json({ success: true, autoReviewEnabled: enabled });
  } catch (error: any) {
    console.error("[PATCH /api/github/repos/[owner]/[repo]/auto-review]", error);
    return NextResponse.json(
      { error: error.message || "Failed to update auto-review setting" },
      { status: 500 }
    );
  }
}