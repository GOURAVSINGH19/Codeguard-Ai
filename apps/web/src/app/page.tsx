import ReviewerDashboard from "@/components/ReviewerDashboard";
import InstallGate from "@/components/InstallGate";

export default function Home() {
  return (
    <InstallGate>
      <ReviewerDashboard />
    </InstallGate>
  );
}
