import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db, repositories, githubInstallations, eq } from "@codeguard/db";
import { handleApiError, jsonError } from "@/lib/api";

const BodySchema = z.object({ enabled: z.boolean() });

/**
 * PATCH /api/github/repos/:owner/:repo/auto-review — toggle automatic reviews.
 * Only the user who installed the GitHub App on that account may change it.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ owner: string; repo: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const { owner, repo } = await params;
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "enabled must be a boolean");

    const [row] = await db
      .select({ id: repositories.id, installationOwner: githubInstallations.userId, installationStatus: githubInstallations.status })
      .from(repositories)
      .leftJoin(githubInstallations, eq(repositories.installationId, githubInstallations.id))
      .where(eq(repositories.fullName, `${owner}/${repo}`))
      .limit(1);

    if (!row) return jsonError(404, "Repository not found");
    // Previously a repo without an installation could be toggled by anyone.
    if (!row.installationOwner || row.installationStatus !== "active") {
      return jsonError(409, "Install the CodeGuard GitHub App on this repository first");
    }
    if (row.installationOwner !== userId) return jsonError(403, "Forbidden");

    await db
      .update(repositories)
      .set({ autoReviewEnabled: parsed.data.enabled, updatedAt: new Date() })
      .where(eq(repositories.id, row.id));

    return NextResponse.json({ success: true, autoReviewEnabled: parsed.data.enabled });
  } catch (err) {
    return handleApiError(err, "PATCH /api/github/repos/[owner]/[repo]/auto-review");
  }
}
