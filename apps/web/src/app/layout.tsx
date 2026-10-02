import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import AppShell from "@/components/AppShell";

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
          <AppShell>{children}</AppShell>
        </ClerkProvider>
      </body>
    </html>
  );
}