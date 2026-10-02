import { Suspense } from "react";
import ReviewerDashboard from "@/components/ReviewerDashboard";
import InstallGate from "@/components/InstallGate";

export default function Home() {
  return (
    <InstallGate>
      {/* ReviewerDashboard reads ?repo= (useSearchParams). */}
      <Suspense>
        <ReviewerDashboard />
      </Suspense>
    </InstallGate>
  );
}
