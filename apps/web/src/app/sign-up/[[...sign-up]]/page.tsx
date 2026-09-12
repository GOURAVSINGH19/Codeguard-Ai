import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-4">
      <SignUp
        appearance={{
          elements: {
            card: "bg-zinc-900 border border-zinc-800 text-white shadow-2xl rounded-2xl p-6 w-full max-w-sm",
            headerTitle: "text-white text-xl font-bold text-center",
            headerSubtitle: "text-zinc-400 text-xs text-center mb-2",
            socialButtonsBlockButton: "bg-zinc-800 border-zinc-700 text-white hover:bg-zinc-700 transition py-3 rounded-xl flex items-center justify-center gap-2",
            socialButtonsBlockButtonText: "text-white font-medium text-sm",
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
