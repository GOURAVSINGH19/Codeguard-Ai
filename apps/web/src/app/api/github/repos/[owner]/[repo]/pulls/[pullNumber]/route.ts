import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { GitHubService } from "@/services";
import { handleApiError, jsonError } from "@/lib/api";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ owner: string; repo: string; pullNumber: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const { owner, repo, pullNumber } = await params;
    const prNum = Number.parseInt(pullNumber, 10);
    if (!owner || !repo || !Number.isInteger(prNum) || prNum <= 0) return jsonError(400, "Invalid PR parameters");

    const github = await GitHubService.fromCurrentUser();
    const detail = await github.getPRDetail(owner, repo, prNum);
    // Patches can be megabytes; the browser only needs the file list.
    return NextResponse.json({ pr: { ...detail, patches: undefined } });
  } catch (err) {
    return handleApiError(err, "GET /api/github/repos/[owner]/[repo]/pulls/[pullNumber]");
  }
}
