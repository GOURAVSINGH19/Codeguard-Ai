import { ClerkProvider, SignInButton, SignUpButton, Show, UserButton } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";

const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CodeGuard AI",
  description: "AI-powered Code Review & Guarding",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={cn("h-full", "antialiased", geistSans.variable, geistMono.variable, "font-mono", jetbrainsMono.variable)}
    >
      <body className="min-h-full flex flex-col">
        <ClerkProvider
          appearance={{
            elements: {
              card: "bg-zinc-900 border border-zinc-800 text-white shadow-2xl rounded-2xl p-6",
              headerTitle: "text-white text-xl font-bold text-center",
              headerSubtitle: "text-zinc-400 text-xs text-center mb-2",
              socialButtonsBlockButton: "bg-zinc-800 border-zinc-700 text-white hover:bg-zinc-700 transition py-3 rounded-xl flex items-center justify-center gap-2",
              socialButtonsBlockButtonText: "text-white font-medium text-sm",
              socialButtonsProviderIcon: "w-5 h-5",
              socialButtonsBlockButton__google: "!hidden",
              socialButtonsIconButton__github: "visible",
              form: "!hidden",
              formField: "!hidden",
              formFieldRow: "!hidden",
              formFieldInput: "!hidden",
              formFieldLabel: "!hidden",
              formButtonPrimary: "!hidden",
              dividerRow: "!hidden",
              dividerText: "!hidden",
              footer: "!hidden",
              footerAction: "!hidden",
              identityPreview: "!hidden",
            },
          }}
        >
          <header className="flex justify-between items-center p-4 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
            <div className="font-bold text-lg text-white flex items-center gap-2">
              <span className="text-xl">🛡️</span> CodeGuard AI
            </div>
            <div className="flex gap-3 items-center">
              <Show when="signed-out">
                <SignInButton mode="modal">
                  <button className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold transition border border-zinc-700/70 flex items-center gap-2 shadow-sm">
                    <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                      <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                    </svg>
                    <span>Sign in with GitHub</span>
                  </button>
                </SignInButton>
              </Show>
              <Show when="signed-in">
                <UserButton appearance={{ elements: { avatarBox: "w-9 h-9 border border-zinc-700" } }} />
              </Show>
            </div>
          </header>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}