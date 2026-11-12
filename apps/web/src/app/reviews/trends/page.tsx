"use client";

import { useUser } from "@clerk/nextjs";
import InstallGate from "@/components/InstallGate";
import ReviewHistory from "@/components/ReviewHistory";

/**
 * Reports — every past review for the signed-in user. Score / issue trends
 * live on the dashboard (ReviewerDashboard), which reads /api/reviews/trends.
 */
export default function TrendsPage() {
  return (
    <InstallGate>
      <Reports />
    </InstallGate>
  );
}

function Reports() {
  const { isSignedIn } = useUser();

  if (!isSignedIn) {
    return (
      <div className="w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-8">
        <div className="text-center py-12">
          <h1 className="text-2xl font-bold text-cg-text mb-4">Reports</h1>
          <p className="text-cg-muted mb-6">Sign in to view your code review history</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-5xl mx-auto px-4 md:px-6 pt-4 pb-10 flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold text-cg-text">Reports</h1>
        <p className="text-sm text-cg-subtle">All your pull request reviews. Click one for the full report.</p>
      </div>
      <ReviewHistory />
    </div>
  );
}
