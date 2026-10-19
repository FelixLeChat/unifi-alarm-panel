export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import Script from "next/script";
import { Logo } from "@/components/ui/logo";
import { getEngine } from "@/lib/engine";
import { getSetting } from "@/lib/services/settings";
import type { AlarmStateName } from "@/lib/state/machine";
import { getAppVersion } from "@/lib/version";
import { WEATHER_ICON_PATHS } from "./weather-icons";

const STATE_CONFIG: Record<AlarmStateName, { label: string; eyebrow: string; cssClass: string; message: string }> = {
  DISARMED: { label: "Disarmed", eyebrow: "System state", cssClass: "state-disarmed", message: "" },
  ARMING: { label: "Arming", eyebrow: "Exit delay: leave now", cssClass: "state-arming", message: "" },
  ARMED: { label: "Armed", eyebrow: "System state", cssClass: "state-armed", message: "" },
  ENTRY_DELAY: {
    label: "Entry delay",
    eyebrow: "Disarm before the siren fires",
    cssClass: "state-entry-delay",
    message: "Door opened: enter PIN",
  },
  ALARM: {
    label: "ALARM",
    eyebrow: "Siren active: admins alerted",
    cssClass: "state-alarm",
    message: "Enter PIN to silence and disarm",
  },
};

const DIGIT_ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
];

// Fixed pool of door slots (open doors sort first, so a closed one is what gets
// dropped past 8): panel.js only fills/hides these, never adds or removes nodes.
const DOOR_SLOTS = 8;

const CLOCK_TIME_OPTS: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };
const CLOCK_DATE_OPTS: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" };


function BackspaceIcon() {
  return (
    <svg className="backspace-icon" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
      <path d="M367.69-220q-20.77 0-39.04-9.39-18.26-9.38-30.03-26.15L140-480l158.62-223.69q11.77-16.77 29.84-26.54 18.08-9.77 39.23-9.77h380q29.92 0 51.12 21.19Q820-697.61 820-667.69v375.38q0 29.92-21.19 51.12Q777.61-220 747.69-220h-380ZM760-280v-400 400Zm-392.31 0h380q4.62 0 8.46-3.85 3.85-3.84 3.85-8.46v-375.38q0-4.62-3.85-8.46-3.84-3.85-8.46-3.85h-380q-5.77 0-10.96 2.88-5.19 2.89-8.27 7.12L213.38-480l135.08 190q3.08 4.23 8.27 7.12 5.19 2.88 10.96 2.88Zm81.39-53.85 104-104 104 104L699.23-376l-104-104 104-104-42.15-42.15-104 104-104-104L406.92-584l104 104-104 104 42.16 42.15Z" />
    </svg>
  );
}

// The help text comes from Settings > Panel (who to call when something's wrong); the version always shows.
function HelpLine({ className }: { className: string }) {
  const helpText = getSetting("helpText");
  return (
    <div className={`help-line ${className}`}>
      {helpText ? `${helpText} · ` : ""}
      {getAppVersion()}
    </div>
  );
}

export default function PanelPage() {
  const status = getEngine().getStatus();
  const cfg = STATE_CONFIG[status.state];
  const hasCountdown = status.remainingSec != null;
  const isDisarmed = status.state === "DISARMED";
  const doors = [...status.doors].sort((a, b) => Number(b.open) - Number(a.open)).slice(0, DOOR_SLOTS);
  const now = new Date();
  const clockTime = now.toLocaleTimeString("en-CA", CLOCK_TIME_OPTS);
  const clockDate = now.toLocaleDateString("en-CA", CLOCK_DATE_OPTS);

  return (
    <main className="panel" data-version={getAppVersion()}>
      <div id="offline-banner" className="offline-banner" hidden>
        Panel offline. Check the connection.
      </div>

      <div id="test-mode-badge" className="test-mode-badge" hidden={!status.testMode}>
        Test mode: siren off
      </div>

      <span className="line-bg" aria-hidden="true" />

      <div className="col-left">
        <div className="header">
          <div className="brand">
            <Logo decorative className="wordmark" />
            <div className="brand-eyebrow">For UniFi Protect</div>
          </div>
          <div className="clock-block">
            <div id="clock-time" className="clock-time">
              {clockTime}
            </div>
            <div id="clock-date" className="clock-date">
              {clockDate}
            </div>
          </div>
        </div>

        <div id="status-banner" className={`banner ${cfg.cssClass}${hasCountdown ? " has-countdown" : ""}`}>
          <div id="banner-eyebrow" className="banner-eyebrow">
            {cfg.eyebrow}
          </div>
          <div className="banner-main">
            <div id="banner-label" className="banner-label">
              {cfg.label}
            </div>
            <div id="banner-countdown" className="banner-countdown" hidden={!hasCountdown}>
              {hasCountdown ? `${status.remainingSec}s` : ""}
            </div>
          </div>
          <div id="progress-track" className="progress-track" hidden={!hasCountdown}>
            <div id="progress-fill" className="progress-fill" style={{ width: "100%" }} />
          </div>
        </div>

        <div id="armed-info" className="armed-info" hidden />

        <div id="doors" className="doors" role="group" aria-label="Door status">
          {Array.from({ length: DOOR_SLOTS }, (_, i) => (
            <span key={i} id={`door-${i}`} className={`door${doors[i]?.open ? " open" : ""}`} hidden={!doors[i]}>
              <i className="door-dot" />
              <span id={`door-${i}-name`} className="door-name">
                {doors[i]?.name ?? ""}
              </span>
              <span id={`door-${i}-state`} className="door-state">
                {doors[i] ? (doors[i].open ? "open" : "closed") : ""}
              </span>
            </span>
          ))}
        </div>

        <HelpLine className="help-line-left" />
      </div>

      <div className="col-right">
        <div id="message" className="message" aria-live="polite">
          {cfg.message}
        </div>

        {/* Disarmed has no keypad any more (arming is a tap, not a PIN — see
            below), which left this column feeling empty. Fills it with who
            last let themselves in (server-owned 5-minute window, see
            AlarmEngine.getStatus()) and the weather. All values start empty
            /hidden and panel.js fills them from polling — no data at SSR
            time — but the elements themselves always exist so it never
            creates/removes nodes (see the comment on #pin-dots below). */}
        <div id="disarmed-panel" className="disarmed-panel" hidden={!isDisarmed}>
          <div id="welcome-message" className="welcome-message" hidden={!status.welcomeName}>
            Welcome, <span id="welcome-name">{status.welcomeName ?? ""}</span>
          </div>

          {/* Shown until the first weather poll settles (success or failure) —
              panel.js only toggles `hidden`, same no-node-churn rule as above. */}
          <div id="forecast-skeleton" className="forecast-skeleton" aria-hidden="true">
            <div className="sk sk-now" />
            <div className="sk sk-hilo" />
            <div className="forecast-hours">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="sk sk-hour" />
              ))}
            </div>
          </div>

          {/* Weather icon sheet: panel.js points the <use> elements below at "#wi-<key>". The
              symbols carry the Material viewBox (y from -960); the referencing svgs below must
              start at 0,0 or the instantiated symbol lands outside their visible area. */}
          <svg width="0" height="0" aria-hidden="true">
            <defs>
              {Object.entries(WEATHER_ICON_PATHS).map(([key, d]) => (
                <symbol key={key} id={`wi-${key}`} viewBox="0 -960 960 960">
                  <path d={d} />
                </symbol>
              ))}
            </defs>
          </svg>
          <div id="forecast" className="forecast" hidden>
            <div className="forecast-now">
              <svg className="forecast-icon" viewBox="0 0 960 960" fill="currentColor" aria-hidden="true">
                <use id="forecast-icon-use" href="" />
              </svg>
              <span id="forecast-temp" className="forecast-temp" />
            </div>
            {/* Own line, centred like the H/L line below, so both share the block's axis. */}
            <div id="forecast-condition" className="forecast-condition" />
            <div className="forecast-hilo">
              H <span id="forecast-hi" />° · L <span id="forecast-lo" />°
            </div>
            <div className="forecast-hours">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} id={`forecast-hour-${i}`} className="forecast-hour" hidden>
                  <span id={`forecast-hour-${i}-label`} className="forecast-hour-label" />
                  <svg className="forecast-hour-icon" viewBox="0 0 960 960" fill="currentColor" aria-hidden="true">
                    <use id={`forecast-hour-${i}-icon-use`} href="" />
                  </svg>
                  <span id={`forecast-hour-${i}-temp`} className="forecast-hour-temp" />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Only disarming takes a PIN — arming is just a tap + confirm (see
            #arm-confirm-overlay below). PINs are always exactly 4 digits, so
            a fixed 4 dots always exist in the DOM — panel.js only toggles
            `filled` on these, never adds or removes nodes, so it can't
            collide with Next's hydration walk. */}
        <div id="pin-dots" className="pin-dots" hidden={isDisarmed}>
          {Array.from({ length: 4 }, (_, i) => (
            <span key={i} id={`pin-dot-${i}`} className="pin-dot" />
          ))}
        </div>

        <div id="keypad" className="keypad" hidden={isDisarmed}>
          {DIGIT_ROWS.flat().map((d) => (
            <button key={d} type="button" data-digit={d} className="key">
              {d}
            </button>
          ))}
          <button id="clear-btn" type="button" className="key key-minor">
            Clear
          </button>
          <button type="button" data-digit="0" className="key">
            0
          </button>
          <button id="backspace-btn" type="button" className="key key-minor" aria-label="Backspace">
            <BackspaceIcon />
          </button>
        </div>

        <button id="action-btn" type="button" className={`action-btn ${isDisarmed ? "arm" : "disarm"}`}>
          {isDisarmed ? "Arm system" : "Disarm"}
        </button>

        <HelpLine className="help-line-right" />
      </div>

      <div id="dim-overlay" className="dim-overlay" hidden>
        <span id="dim-caption">Quiet hours · tap to wake</span>
      </div>

      <div id="arm-confirm-overlay" className="arm-confirm-overlay" hidden>
        <div className="arm-confirm-box">
          <div id="arm-confirm-title" className="arm-confirm-title">
            Arm the system?
          </div>
          <div id="arm-confirm-sub" className="arm-confirm-sub">
            Everyone should be on their way out.
          </div>
          <div className="arm-confirm-actions">
            <button id="arm-confirm-cancel" type="button" className="arm-confirm-btn arm-confirm-cancel">
              Cancel
            </button>
            <button id="arm-confirm-yes" type="button" className="arm-confirm-btn arm-confirm-yes">
              Yes, arm
            </button>
          </div>
        </div>
      </div>

      {/*
        strategy="afterInteractive" (not a plain <script defer>) matters here:
        this page has zero client components, but Next's App Router still
        hydrates it (attaching to the RSC payload it already sent down). A
        plain deferred script can start mutating the DOM before that
        hydration walk runs, which makes React detect a mismatch and quietly
        regenerate the subtree — replacing the very nodes panel.js just
        grabbed with getElementById, so its cached references go stale and
        stop doing anything. afterInteractive is Next's own mechanism for
        "run this once hydration is done," which sidesteps the race.
      */}
      <Script src="/panel.js" strategy="afterInteractive" />
    </main>
  );
}
