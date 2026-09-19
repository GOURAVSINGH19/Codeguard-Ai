import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const appId = process.env.GITHUB_APP_ID;
  if (!appId) {
    return NextResponse.json(
      { error: "GitHub App not configured" },
      { status: 500 }
    );
  }

  // Redirect to GitHub App installation page
  const installUrl = `https://github.com/apps/${process.env.GITHUB_APP_SLUG || "codeguard-ai"}/installations/new`;

  return NextResponse.redirect(installUrl);
}