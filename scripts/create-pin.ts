/**
 * Dev/ops CLI to seed a PIN before the admin API (M3) exists, or to add one
 * from a shell on the box. Not exposed over HTTP.
 *
 * Usage: pnpm pin:add "Alex" 1234 [--duress]
 */
import { createDb } from "../lib/db";
import { createPin, isPinTaken } from "../lib/services/pins";

async function main() {
  const [label, pin, flag] = process.argv.slice(2);
  if (!label || !pin) {
    console.error('Usage: pnpm pin:add "<label>" <pin> [--duress]');
    process.exit(1);
  }
  if (!/^\d{4}$/.test(pin)) {
    console.error("PIN must be exactly 4 digits");
    process.exit(1);
  }

  const db = createDb(process.env.DATABASE_PATH ?? "./data/alarm.db");
  // verifyPin returns the first matching active hash, so a duplicate code
  // would be permanently shadowed by whichever PIN was created first — and a
  // shadowed duress code never fires. Refuse rather than create a dead PIN.
  if (await isPinTaken(db, pin)) {
    console.error("That PIN is already in use by another active PIN — pick a different one.");
    db.close();
    process.exit(1);
  }
  await createPin(db, label, pin, flag === "--duress");
  db.close();
  console.log(`Created PIN for "${label}"${flag === "--duress" ? " (duress)" : ""}.`);
}

main();
