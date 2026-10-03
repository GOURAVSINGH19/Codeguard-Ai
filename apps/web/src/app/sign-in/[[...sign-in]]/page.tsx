import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-cg-bg p-4">
      <SignIn
        appearance={{
          elements: {
            card: "bg-cg-panel border border-cg-border text-cg-text shadow-2xl rounded-2xl p-6 w-full max-w-sm",
            headerTitle: "text-cg-text text-xl font-bold text-center",
            headerSubtitle: "text-cg-muted text-xs text-center mb-2",
            socialButtonsBlockButton: "bg-cg-raised border-cg-border text-cg-text hover:bg-cg-border transition py-3 rounded-xl flex items-center justify-center gap-2",
            socialButtonsBlockButtonText: "text-cg-text font-medium text-sm",
            socialButtonsProviderIcon: "w-5 h-5",
            form: "hidden",
            formField: "hidden",
            formFieldRow: "hidden",
            formFieldInput: "hidden",
            formFieldLabel: "hidden",
            formButtonPrimary: "hidden",
            dividerRow: "hidden",
            dividerText: "hidden",
            footer: "hidden",
            footerAction: "hidden",
            identityPreview: "hidden",
          },
        }}
      />
    </div>
  );
}
