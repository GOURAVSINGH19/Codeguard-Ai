import { handleGitHubWebhook } from "@/server/github-webhook";

/**
 * POST /api/webhooks/github-app: the GitHub App's Webhook URL.
 *
 * Public in src/proxy.ts on purpose: GitHub has no Clerk session. It proves
 * who it is with the HMAC signature instead (checked in handleGitHubWebhook).
 */
export async function POST(req: Request) {
  return handleGitHubWebhook(req);
}
