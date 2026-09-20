/**
 * @deprecated Use UserService.syncCurrentUser() from "@/services" instead.
 * This file is kept only as a compatibility shim and will be removed in a future cleanup.
 */
export { UserService } from "@/services";

/** @deprecated */
export async function syncUserWithDb() {
  const { UserService } = await import("@/services");
  return new UserService().syncCurrentUser();
}
