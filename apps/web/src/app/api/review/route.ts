import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { ReviewInputSchema } from "@codeguard/types";
import { AIReviewService, ReviewPersistenceService } from "@/services";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const validation = ReviewInputSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid request payload", details: validation.error.format() },
        { status: 400 }
      );
    }

    const { code, language, title } = validation.data;

    const aiService = AIReviewService.fromEnv();
    const reviewOutput = await aiService.reviewSnippet(code, language);

    const persistence = new ReviewPersistenceService();
    const saved = await persistence.saveSnippetReview({
      userId,
      code,
      language,
      title,
      reviewOutput,
    });

    return NextResponse.json({
      id: saved.id,
      score: reviewOutput.score,
      summary: reviewOutput.summary,
      issues: reviewOutput.issues,
      createdAt: saved.createdAt,
    });
  } catch (error: any) {
    console.error("[POST /api/review]", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
