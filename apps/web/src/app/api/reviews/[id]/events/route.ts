import { db, reviews, eq } from "@codeguard/db";
import { errorResponse, requireUserId } from "@/server/http";
import { requireUserReview } from "@/server/review-access";

type Ctx = { params: Promise<{ id: string }> };

const POLL_MS = 1_000;
const MAX_STREAM_MS = 5 * 60_000; // hosts cap open responses; the browser reconnects or falls back to polling

/**
 * GET /api/reviews/:id/events: Server-Sent Events with live pipeline progress.
 *
 *   event: progress   data: {"status":"in_progress","progress":"quality"}
 *   event: done       data: {}
 *
 * The workers write `reviews.progress`; this route watches it (1 query/s) and
 * forwards each change. src/lib/poll-review.ts consumes it.
 */
export async function GET(req: Request, { params }: Ctx) {
  let reviewId: string;
  try {
    const userId = await requireUserId();
    reviewId = (await requireUserReview(userId, (await params).id)).id;
  } catch (err) {
    return errorResponse(err);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const startedAt = Date.now();
      let last = "";
      try {
        while (!req.signal.aborted && Date.now() - startedAt < MAX_STREAM_MS) {
          const [r] = await db
            .select({ status: reviews.status, progress: reviews.progress })
            .from(reviews)
            .where(eq(reviews.id, reviewId))
            .limit(1);
          if (!r) break;
          const now = `${r.status}:${r.progress}`;
          if (now !== last) {
            send("progress", { status: r.status, progress: r.progress });
            last = now;
          }
          if (r.status === "completed" || r.status === "failed") {
            send("done", {});
            break;
          }
          await new Promise((res) => setTimeout(res, POLL_MS));
        }
      } catch (err) {
        console.warn(`[sse] ${reviewId}:`, (err as Error).message);
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed by the client */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // tell proxies not to buffer the stream
    },
  });
}
