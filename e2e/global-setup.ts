import { ADMIN_TOKEN, BASE_URL, DURESS_PIN, DURESS_PIN_LABEL, STANDARD_PIN, STANDARD_PIN_LABEL } from "./constants";

// Waits for the webServer's health check to actually succeed before seeding
// — not just relying on Playwright's own webServer readiness ordering,
// which isn't documented strongly enough to depend on here.
async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // Server not accepting connections yet — retry.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for the e2e server to become healthy");
}

async function createPin(label: string, pin: string, isDuress: boolean): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/admin/pins`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({ label, pin, isDuress }),
  });
  if (!res.ok) throw new Error(`Failed to seed PIN "${label}": ${res.status}`);
}

export default async function globalSetup(): Promise<void> {
  await waitForHealth();
  await createPin(STANDARD_PIN_LABEL, STANDARD_PIN, false);
  await createPin(DURESS_PIN_LABEL, DURESS_PIN, true);
}
