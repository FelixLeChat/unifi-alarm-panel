import Link from "next/link";
import { Logomark } from "@/components/ui/logo";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col items-start justify-center gap-4 p-8">
      <Logomark decorative className="size-10 text-foreground" />
      <h1 className="text-title-s font-display">UniFi Alarm Panel</h1>
      <p className="text-muted-foreground">Backend is running.</p>
      <nav className="flex gap-4 text-sm underline">
        <Link href="/panel">Kiosk panel</Link>
        <Link href="/admin">Admin</Link>
        <a href="/api/health">/api/health</a>
      </nav>
    </main>
  );
}
