import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { GitHubService } from "@/services";
import { handleApiError, intParam, jsonError } from "@/lib/api";

export async function GET(req: Request, { params }: { params: Promise<{ owner: string; repo: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const { owner, repo } = await params;
    if (!owner || !repo) return jsonError(400, "owner and repo are required");

    const url = new URL(req.url);
    const page = intParam(url.searchParams.get("page"), 1, 1, 1_000);
    const perPage = intParam(url.searchParams.get("perPage"), 30, 1, 100);

    const github = await GitHubService.fromCurrentUser();
    const pulls = await github.listOpenPRs(owner, repo, { page, perPage });
    return NextResponse.json({ pulls, page, perPage, hasMore: pulls.length === perPage });
  } catch (err) {
    return handleApiError(err, "GET /api/github/repos/[owner]/[repo]/pulls");
  }
}
