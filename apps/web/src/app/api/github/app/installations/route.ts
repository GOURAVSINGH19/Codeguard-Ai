import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db, githubInstallations } from "@codeguard/db";
import { eq } from "drizzle-orm";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const installations = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.userId, userId));

    return NextResponse.json({ installations });
  } catch (error: any) {
    console.error("[GET /api/github/app/installations]", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch installations" },
      { status: 500 }
    );
  }
}