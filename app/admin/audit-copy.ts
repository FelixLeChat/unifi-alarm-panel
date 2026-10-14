// Maps the real audit event enum (lib/state/machine.ts AUDIT effects, plus
// the admin-route events in app/api/admin/*) to the README's four filter
// categories and to human-readable copy. The handoff's own examples
// ("armed|disarmed|siren", "System armed (exit delay 45 s)") were prototype
// flavor text over a demo enum — this is grounded in the actual event
// strings the engine records.

export type AuditCategory = "Arming" | "Sensors" | "PINs" | "Config";

const CATEGORY_BY_EVENT: Record<string, AuditCategory> = {
  disarmed: "Arming",
  disarm_while_disarmed: "Arming",
  arming_started: "Arming",
  armed: "Arming",
  arm_ignored_already_arming: "Arming",
  arm_ignored_already_armed: "Arming",
  arm_ignored_entry_delay: "Arming",
  arm_ignored_during_alarm: "Arming",
  arm_locked_out: "Arming",
  arm_failed_invalid_pin: "Arming",
  arm_rejected_sensors_open: "Arming",
  arm_forced_with_sensors_open: "Arming",
  disarm_locked_out: "Arming",
  disarm_failed_invalid_pin: "Arming",
  alarm_pin_lockout: "Arming",
  pin_lockout_during_alarm: "Arming",
  alarm_instant: "Arming",
  alarm_instant_during_entry_delay: "Arming",
  alarm_entry_timeout: "Arming",
  entry_delay_started: "Arming",
  panel_recovered_default_disarmed: "Arming",
  initial_boot_disarmed: "Arming",
  stale_timer_ignored: "Arming",
  sensor_trip_while_disarmed: "Sensors",
  sensor_trip_while_arming: "Sensors",
  sensor_trip_ignored_mode: "Sensors",
  sensor_trip_during_entry_delay: "Sensors",
  sensor_trip_during_alarm: "Sensors",
  protect_breach_detected: "Arming",
  device_health_degraded: "Sensors",
  webhook_unparseable: "Sensors",
  webhook_rejected: "Sensors",
  sensor_deleted: "Sensors",
  pin_created: "PINs",
  pin_revoked: "PINs",
  pin_updated: "PINs",
  config_updated: "Config",
  settings_updated: "Config",
  update_requested: "Config",
};

export function categorizeAuditEvent(event: string): AuditCategory | null {
  return CATEGORY_BY_EVENT[event] ?? null;
}

function detailValue(detail: unknown, key: string): string | undefined {
  if (!detail || typeof detail !== "object") return undefined;
  const v = (detail as Record<string, unknown>)[key];
  if (v == null) return undefined;
  return typeof v === "string" ? v : String(v);
}

export function humanizeAuditEvent(event: string, detail: unknown): string {
  const sensorId = detailValue(detail, "sensorId");
  switch (event) {
    case "armed":
      return "System armed";
    case "disarmed":
      return "System disarmed";
    case "disarm_while_disarmed":
      return "Disarm requested: already disarmed";
    case "arming_started":
      return "Arming started (exit delay running)";
    case "arm_ignored_already_arming":
      return "Arm requested: already arming";
    case "arm_ignored_already_armed":
      return "Arm requested: already armed";
    case "arm_ignored_entry_delay":
      return "Arm requested: entry delay in progress";
    case "arm_ignored_during_alarm":
      return "Arm requested: alarm in progress";
    case "arm_locked_out": {
      const source = detailValue(detail, "source");
      return source ? `Arm attempt blocked: too many failed PINs from ${source}` : "Arm attempt blocked: too many failed PINs";
    }
    case "arm_failed_invalid_pin": {
      const source = detailValue(detail, "source");
      return source ? `Failed arm attempt: invalid PIN from ${source}` : "Failed arm attempt: invalid PIN";
    }
    case "disarm_locked_out": {
      const source = detailValue(detail, "source");
      return source ? `Disarm attempt blocked: too many failed PINs from ${source}` : "Disarm attempt blocked: too many failed PINs";
    }
    case "disarm_failed_invalid_pin": {
      const source = detailValue(detail, "source");
      return source ? `Failed disarm attempt: invalid PIN from ${source}` : "Failed disarm attempt: invalid PIN";
    }
    case "alarm_pin_lockout": {
      const source = detailValue(detail, "source");
      return source ? `ALARM triggered: too many failed PINs from ${source}` : "ALARM triggered: too many failed PINs";
    }
    case "pin_lockout_during_alarm": {
      const source = detailValue(detail, "source");
      return source ? `Another failed-PIN lockout from ${source}: already in ALARM` : "Another failed-PIN lockout: already in ALARM";
    }
    case "arm_rejected_sensors_open": {
      const sensors = detail && typeof detail === "object" ? (detail as Record<string, unknown>).sensors : undefined;
      const names = Array.isArray(sensors) ? sensors.map((s) => (s as { name?: string })?.name).filter(Boolean).join(", ") : undefined;
      return names ? `Arm blocked. Door(s) open: ${names}` : "Arm blocked. A door is open";
    }
    case "arm_forced_with_sensors_open": {
      const sensors = detail && typeof detail === "object" ? (detail as Record<string, unknown>).sensors : undefined;
      const names = Array.isArray(sensors) ? sensors.map((s) => (s as { name?: string })?.name).filter(Boolean).join(", ") : undefined;
      return names ? `Armed anyway with door(s) open: ${names}` : "Armed anyway with a door open";
    }
    case "alarm_instant":
      return sensorId ? `ALARM triggered: sensor '${sensorId}' (instant)` : "ALARM triggered (instant sensor)";
    case "alarm_instant_during_entry_delay":
      return sensorId ? `ALARM triggered: sensor '${sensorId}' during entry delay` : "ALARM triggered during entry delay";
    case "alarm_entry_timeout":
      return "Entry delay elapsed without disarm: ALARM triggered";
    case "entry_delay_started":
      return sensorId ? `Entry delay started: sensor '${sensorId}'` : "Entry delay started";
    case "panel_recovered_default_disarmed":
      return "Controller restarted: recovered to disarmed";
    case "initial_boot_disarmed":
      return "Controller booted: initial state disarmed";
    case "stale_timer_ignored":
      return "Stale timer ignored";
    case "protect_breach_detected": {
      // Recorded once on the rising edge by lib/services/protect-alarm-sync.ts.
      // This app does NOT enter its own ALARM on it (see syncExternalArmState's
      // comment), so the audit row is the only place a UniFi-side breach shows
      // up — it renders as prose rather than a raw event name for that reason.
      const profiles = detail && typeof detail === "object" ? (detail as Record<string, unknown>).profiles : undefined;
      const titles = Array.isArray(profiles)
        ? profiles.map((p) => (p as { title?: string })?.title).filter(Boolean).join(", ")
        : undefined;
      return titles ? `UniFi reported a breach. Profile(s): ${titles}` : "UniFi reported a breach";
    }
    case "device_health_degraded":
      // One line per newly-degraded device, written by the 2h device-health
      // poll (lib/services/protect-device-health.ts) — already prose there,
      // because it is the same text the Slack/ntfy alert carries.
      return detailValue(detail, "message") ?? "A sensor device reported a problem";
    case "sensor_trip_while_disarmed":
      return sensorId ? `Sensor '${sensorId}' tripped while disarmed` : "Sensor tripped while disarmed";
    case "sensor_trip_while_arming":
      return sensorId ? `Sensor '${sensorId}' tripped during exit delay` : "Sensor tripped during exit delay";
    case "sensor_trip_ignored_mode":
      return sensorId ? `Sensor '${sensorId}' ignored (mode: ignore)` : "Sensor ignored (mode: ignore)";
    case "sensor_trip_during_entry_delay":
      return sensorId ? `Sensor '${sensorId}' tripped during entry delay` : "Sensor tripped during entry delay";
    case "sensor_trip_during_alarm":
      return sensorId ? `Sensor '${sensorId}' tripped during ALARM` : "Sensor tripped during ALARM";
    case "webhook_unparseable":
      return "Sensor webhook payload could not be parsed";
    case "webhook_rejected": {
      const source = detailValue(detail, "source");
      return source ? `Sensor webhook rejected: bad shared secret, from ${source}` : "Sensor webhook rejected: bad shared secret";
    }
    case "sensor_deleted": {
      const unifiId = detailValue(detail, "unifiId");
      return unifiId ? `Sensor '${unifiId}' deleted` : "Sensor deleted";
    }
    case "pin_created": {
      const label = detailValue(detail, "label");
      return label ? `PIN '${label}' created` : "PIN created";
    }
    case "pin_revoked": {
      const id = detailValue(detail, "id");
      return id ? `PIN #${id} revoked` : "PIN revoked";
    }
    case "pin_updated": {
      const id = detailValue(detail, "id");
      return id ? `PIN #${id} edited` : "PIN edited";
    }
    case "update_requested": {
      const tag = detailValue(detail, "tag");
      return tag ? `Update to ${tag} requested` : "Update requested";
    }
    case "settings_updated": {
      // Names which fields changed, never their values (some are credentials).
      const group = detailValue(detail, "group");
      const keys = detail && typeof detail === "object" ? (detail as Record<string, unknown>).keys : undefined;
      const label = group ? `${group[0].toUpperCase()}${group.slice(1)} settings updated` : "Settings updated";
      return Array.isArray(keys) && keys.length > 0 ? `${label}: ${keys.join(", ")}` : label;
    }
    case "config_updated": {
      const configKeys = detail && typeof detail === "object" ? (detail as Record<string, unknown>).configKeys : undefined;
      const sensorIds = detail && typeof detail === "object" ? (detail as Record<string, unknown>).sensorIds : undefined;
      const parts: string[] = [];
      if (Array.isArray(configKeys) && configKeys.length > 0) parts.push(configKeys.join(", "));
      if (Array.isArray(sensorIds) && sensorIds.length > 0) parts.push(`sensors: ${sensorIds.join(", ")}`);
      return parts.length > 0 ? `Config updated: ${parts.join("; ")}` : "Config updated";
    }
    default:
      return event;
  }
}
