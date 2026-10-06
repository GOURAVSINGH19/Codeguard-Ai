import { auth } from "@clerk/nextjs/server";
import { UuidSchema } from "@codeguard/types";
import { ReviewPersistenceService } from "@/services";
import { jsonError } from "@/lib/api";

/** How long one stream stays open; the browser reconnects (EventSource does it itself). */
const STREAM_MS = 4 * 60_000;
const POLL_MS = 1_500;

/**
 * GET /api/reviews/:id/events — Server-Sent Events with the review's status
 * and the pipeline node currently running.
 *
 *   event: progress  data: {"status":"in_progress","progress":"security"}
 *   event: done      data: {"status":"completed","score":7.4}
 *
 * The worker records progress on the review row; this route watches the row,
 * so it works no matter which worker instance runs the review.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return jsonError(401, "Unauthorized");

  const { id } = await params;
  if (!UuidSchema.safeParse(id).success) return jsonError(400, "Invalid review ID format (must be a valid UUID)");

  const persistence = new ReviewPersistenceService();
  const first = await persistence.getReviewStatus(id, userId);
  if (!first) return jsonError(404, "Review not found");

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const deadline = Date.now() + STREAM_MS;
      let last = "";
      let current = first;
      try {
        controller.enqueue(encoder.encode(`retry: 3000\n\n`));
        while (!req.signal.aborted) {
          const key = `${current.status}|${current.progress}`;
          if (current.status === "completed" || current.status === "failed") {
            send("done", { status: current.status, score: current.score });
            break;
          }
          if (key !== last) {
            send("progress", { status: current.status, progress: current.progress });
            last = key;
          } else {
            controller.enqueue(encoder.encode(`: keep-alive\n\n`));
          }
          if (Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, POLL_MS));
          const next = await persistence.getReviewStatus(id, userId);
          if (!next) break;
          current = next;
        }
      } catch (err) {
        console.error(`[GET /api/reviews/${id}/events]`, err);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
