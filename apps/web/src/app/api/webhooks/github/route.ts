import { handleGitHubWebhook } from "@/lib/github-webhook";

/**
 * POST /api/webhooks/github — legacy repository-webhook endpoint.
 *
 * Kept so existing repo webhooks keep working; it runs the exact same handler
 * as `/api/webhooks/github-app` and accepts either GITHUB_APP_WEBHOOK_SECRET or
 * GITHUB_WEBHOOK_SECRET. Deliveries are deduplicated by X-GitHub-Delivery, so
 * a repo configured with both endpoints is still reviewed once.
 */
export async function POST(req: Request) {
  return handleGitHubWebhook(req, "github-webhook");
}
