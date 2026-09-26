import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Authentication is enforced here, by default, for every API route and the
 * signed-in pages — a new route is protected unless it is listed as public.
 * Route handlers still read `auth()` for the user id.
 *
 * Public: the landing page, sign-in/up, and GitHub webhooks (which are
 * authenticated by their HMAC signature instead).
 */
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks/(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
