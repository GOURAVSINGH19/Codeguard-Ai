import { handleGitHubWebhook } from "@/lib/github-webhook";

/**
 * POST /api/webhooks/github-app — GitHub App webhook endpoint.
 * Signature check, delivery dedupe, installation sync and Kafka fan-out all
 * live in `handleGitHubWebhook` (shared with the legacy route).
 */
export async function POST(req: Request) {
  return handleGitHubWebhook(req, "github-app-webhook");
}
