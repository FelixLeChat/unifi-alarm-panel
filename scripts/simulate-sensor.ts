/**
 * Dev-only CLI to simulate UniFi Alarm Manager's outbound sensor webhook,
 * without real hardware. Sends the same shape /api/hooks/sensor already
 * expects — see lib/services/webhook-intake.ts for the config-mapped fields.
 *
 * Usage: pnpm sensor:trip <sensorId> [eventType] [baseUrl]
 * Example: pnpm sensor:trip front-door open
 *          pnpm sensor:trip motion-1 motion http://localhost:3000
 */
async function main() {
  const [sensorId, eventType, baseUrlArg] = process.argv.slice(2);
  if (!sensorId) {
    console.error("Usage: pnpm sensor:trip <sensorId> [eventType] [baseUrl]");
    process.exit(1);
  }

  const secret = process.env.WEBHOOK_SHARED_SECRET;
  if (!secret) {
    console.error("WEBHOOK_SHARED_SECRET is not set (check your .env).");
    process.exit(1);
  }

  const baseUrl = baseUrlArg ?? "http://localhost:3000";
  const url = `${baseUrl}/api/hooks/sensor?token=${encodeURIComponent(secret)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sensorId, eventType: eventType ?? "open" }),
  });
  const body = await res.json().catch(() => null);
  console.log(`${res.status} ${JSON.stringify(body)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
