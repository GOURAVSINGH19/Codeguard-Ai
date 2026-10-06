import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { UuidSchema } from "@codeguard/types";
import { ReviewPersistenceService } from "@/services";
import { FINDING_STATUSES } from "@/services/ReviewPersistenceService";
import { handleApiError, jsonError } from "@/lib/api";

const BodySchema = z.object({
  status: z.enum(FINDING_STATUSES),
  note: z.string().max(500).optional(),
});

/**
 * PATCH /api/reviews/:id/findings/:findingId — resolve, dismiss or reopen a finding.
 *   { "status": "resolved" | "dismissed" | "open", "note"?: string }
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; findingId: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const { id, findingId } = await params;
    if (!UuidSchema.safeParse(id).success || !UuidSchema.safeParse(findingId).success) return jsonError(400, "Invalid ID format (must be a valid UUID)");

    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, `status must be one of: ${FINDING_STATUSES.join(", ")}`);

    const finding = await new ReviewPersistenceService().updateFindingStatus({ reviewId: id, findingId, userId, ...parsed.data });
    if (!finding) return jsonError(404, "Finding not found");
    return NextResponse.json({ finding });
  } catch (err) {
    return handleApiError(err, "PATCH /api/reviews/[id]/findings/[findingId]");
  }
}
