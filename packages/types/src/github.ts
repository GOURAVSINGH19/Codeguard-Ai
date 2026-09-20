/**
 * Shared GitHub domain types used across apps/web and apps/workers.
 */

export interface PRCoordinates {
  owner: string;
  repo: string;
  pullNumber: number;
}

export interface WebhookPRPayload {
  action: "opened" | "synchronize" | "closed" | "reopened";
  pull_request: {
    number: number;
    title: string;
    head: { sha: string; ref: string };
    base: { ref: string; repo: { full_name: string; owner: { login: string }; name: string } };
  };
  repository: {
    id: number;
    full_name: string;
    owner: { login: string };
    name: string;
  };
  installation?: { id: number };
}
