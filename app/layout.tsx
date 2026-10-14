import type { Metadata } from "next";
import { Figtree, Fraunces, JetBrains_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// next/font downloads these at build time and serves them from this app, so the kiosk never calls out.
const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree", display: "swap" });
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", display: "swap" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap" });

export const metadata: Metadata = {
  title: "UniFi Alarm Panel",
  description: "Self-hosted alarm panel and PIN keypad for UniFi Protect.",
  manifest: "/site.webmanifest",
  icons: {
    // The SVG follows the browser's light or dark theme on its own (see the media query inside it).
    icon: { url: "/icon.svg", type: "image/svg+xml" },
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
};

// Every route in this app is already meant to be dynamic (no I/O should ever
// be cached across requests here). Setting it once at the root also makes
// the per-request CSP nonce proxy.ts issues actually line up with the
// nonce baked into each page's inline hydration scripts — a statically
// prerendered page would ship a stale nonce and CSP would block hydration.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${figtree.variable} ${fraunces.variable} ${jetbrainsMono.variable}`}>
      {/* globals.css's `@layer base` already styles <body> (background,
          foreground, font) for every route. app/panel/panel.css intentionally
          overrides it with plain (unlayered) CSS, which always wins over an
          @layer rule regardless of source order — see docs/design.md. */}
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
