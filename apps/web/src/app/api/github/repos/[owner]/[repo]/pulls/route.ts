import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { GitHubService } from "@/services";
import { handleApiError, jsonError } from "@/lib/api";

export async function GET(_req: Request, { params }: { params: Promise<{ owner: string; repo: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const { owner, repo } = await params;
    if (!owner || !repo) return jsonError(400, "owner and repo are required");

    const github = await GitHubService.fromCurrentUser();
    const pulls = await github.listOpenPRs(owner, repo);
    return NextResponse.json({ pulls });
  } catch (err) {
    return handleApiError(err, "GET /api/github/repos/[owner]/[repo]/pulls");
  }
}
