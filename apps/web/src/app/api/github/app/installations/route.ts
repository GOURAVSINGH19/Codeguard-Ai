import { requireUserId, withErrors } from "@/server/http";
import { claimUnlinkedInstallations, userInstallations } from "@/server/ownership";
import { toInstallationRow } from "@/server/serializers";

/**
 * GET /api/github/app/installations[?sync=1]
 * The signed-in user's installations.
 *
 * While the user has no active installation (the install button polls this),
 * or when ?sync=1 is passed, we first try to claim installations they own that
 * arrived without going through our callback.
 */
export const GET = withErrors(async (req: Request) => {
  const userId = await requireUserId();
  const sync = new URL(req.url).searchParams.has("sync");

  let rows = await userInstallations(userId);
  if (sync || !rows.some((r) => r.status === "active")) {
    if (await claimUnlinkedInstallations(userId)) rows = await userInstallations(userId);
  }

  return Response.json({ installations: rows.map(toInstallationRow) });
});
