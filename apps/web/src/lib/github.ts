import { auth, clerkClient } from "@clerk/nextjs/server";
import { Octokit } from "octokit";

export async function getGitHubClient() {
  const { userId } = await auth();
  if (!userId) {
    throw new Error("Unauthorized");
  }

  const client = await clerkClient();
  const response = await client.users.getUserOauthAccessToken(userId, "oauth_github");

  const token = response.data?.[0]?.token;

  if (!token) {
    throw new Error("GitHub OAuth token not found. Please sign in with GitHub.");
  }

  return new Octokit({ auth: token });
}
