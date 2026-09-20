import { NextResponse } from "next/server";
import { GitHubAppService } from "@/services/GitHubAppService";
import { db, githubInstallations, users } from "@codeguard/db";
import { eq } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const installationId = url.searchParams.get("installation_id");
    const setupAction = url.searchParams.get("setup_action");

    if (!code || !installationId) {
      return NextResponse.redirect(
        new URL("/install?error=missing_params", req.url)
      );
    }

    const appService = GitHubAppService.fromEnv();

    // Exchange the code for an installation token
    const octokitAuth = (await import("@octokit/auth-app")).createAppAuth({
      appId: process.env.GITHUB_APP_ID!,
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
    });

    const { token } = await octokitAuth({
      type: "installation",
      installationId: Number(installationId),
    });

    // Get installation details
    const octokit = (await import("octokit")).Octokit;
    const octokitInstance = new octokit({ auth: token });
    const { data: installation } = await octokitInstance.rest.apps.getInstallation({
      installation_id: Number(installationId),
    });

    // Get the current user from Clerk
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.redirect(
        new URL("/install?error=not_authenticated", req.url)
      );
    }

    // Sync installation to database
    await appService.handleInstallationEvent(
      setupAction === "install" ? "created" : "new_permissions_accepted",
      installation as any
    );

    // Link installation to user
    await db
      .update(githubInstallations)
      .set({ userId })
      .where(eq(githubInstallations.installationId, Number(installationId)));

    // If this is a new installation, sync repositories
    if (setupAction === "install") {
      await appService.syncInstallationRepositories(Number(installationId));
    }

    return NextResponse.redirect(
      new URL("/install?success=true", req.url)
    );
  } catch (error: any) {
    console.error("[GET /api/github/app/callback]", error);
    return NextResponse.redirect(
      new URL(`/install?error=${encodeURIComponent(error.message)}`, req.url)
    );
  }
}