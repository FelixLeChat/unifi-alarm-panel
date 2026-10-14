(function () {
  "use strict";

  var MAX_PIN_LEN = 4; // PINs are always exactly 4 digits — see app/api/admin/pins/route.ts.
  var POLL_MS = 2000;
  var WEATHER_POLL_MS = 15 * 60 * 1000;
  var SUCCESS_MSG_MS = 3200;
  var SNOOZE_MS = 60 * 1000;
  var SHAKE_MS = 450;
  var AUTO_SUBMIT_DELAY_MS = 150; // lets the 4th dot render before submitPin() clears them

  var pinDigits = "";
  var offline = false;
  var currentState = "DISARMED";

  var localRemaining = null;
  var localTotal = null;
  var countdownTimer = null;
  var countdownEndsAt = 0;
  var lastArmingTripCount = null;
  var lastArmingDoors = "";
  var firstStatus = true;

  var audioEnabled = true;
  var testMode = false; // admin Test mode: only the alarm siren is muted, every other sound plays
  var quietHoursStart = 22;
  var quietHoursEnd = 6;
  var snoozeUntil = 0;
  var audioCtx = null;

  var messageTimer = null;

  // Version this page was rendered with (server-side, from VERSION) — a
  // different one in /api/status means the server was redeployed under us.
  var pageVersion = (document.querySelector(".panel") || {}).dataset
    ? document.querySelector(".panel").dataset.version
    : null;
  var reloadPending = false;

  var banner = document.getElementById("status-banner");
  var bannerEyebrow = document.getElementById("banner-eyebrow");
  var bannerLabel = document.getElementById("banner-label");
  var bannerCountdown = document.getElementById("banner-countdown");
  var progressTrack = document.getElementById("progress-track");
  var progressFill = document.getElementById("progress-fill");
  var offlineBanner = document.getElementById("offline-banner");
  var pinDots = document.getElementById("pin-dots");
  var messageEl = document.getElementById("message");
  var keypad = document.getElementById("keypad");
  var actionBtn = document.getElementById("action-btn");
  var clearBtn = document.getElementById("clear-btn");
  var backspaceBtn = document.getElementById("backspace-btn");
  var clockTimeEl = document.getElementById("clock-time");
  var clockDateEl = document.getElementById("clock-date");
  var dimOverlay = document.getElementById("dim-overlay");
  var dimCaption = document.getElementById("dim-caption");
  var armConfirmOverlay = document.getElementById("arm-confirm-overlay");
  var armConfirmTitleEl = document.getElementById("arm-confirm-title");
  var armConfirmSubEl = document.getElementById("arm-confirm-sub");
  var armConfirmYesBtn = document.getElementById("arm-confirm-yes");
  var armConfirmCancelBtn = document.getElementById("arm-confirm-cancel");
  var disarmedPanel = document.getElementById("disarmed-panel");
  var welcomeMessage = document.getElementById("welcome-message");
  var welcomeNameEl = document.getElementById("welcome-name");
  var testBadge = document.getElementById("test-mode-badge");
  var armedInfoEl = document.getElementById("armed-info");
  var DOOR_SLOTS = 8;
  var doorEls = [];
  for (var di = 0; di < DOOR_SLOTS; di++) {
    doorEls.push({
      row: document.getElementById("door-" + di),
      name: document.getElementById("door-" + di + "-name"),
      state: document.getElementById("door-" + di + "-state"),
    });
  }
  var forecast = document.getElementById("forecast");
  var forecastTemp = document.getElementById("forecast-temp");
  var forecastCondition = document.getElementById("forecast-condition");
  var forecastHi = document.getElementById("forecast-hi");
  var forecastLo = document.getElementById("forecast-lo");
  var FORECAST_HOUR_COUNT = 4;
  var forecastHourEls = [];
  for (var fhi = 0; fhi < FORECAST_HOUR_COUNT; fhi++) {
    forecastHourEls.push({
      row: document.getElementById("forecast-hour-" + fhi),
      label: document.getElementById("forecast-hour-" + fhi + "-label"),
      iconPath: document.getElementById("forecast-hour-" + fhi + "-icon-path"),
      temp: document.getElementById("forecast-hour-" + fhi + "-temp"),
    });
  }

  var STATE_CONFIG = {
    DISARMED: { label: "Disarmed", eyebrow: "System state", cssClass: "state-disarmed" },
    ARMING: { label: "Arming", eyebrow: "Exit delay: leave now", cssClass: "state-arming" },
    ARMED: { label: "Armed", eyebrow: "System state", cssClass: "state-armed" },
    ENTRY_DELAY: { label: "Entry delay", eyebrow: "Disarm before the siren fires", cssClass: "state-entry-delay" },
    ALARM: { label: "ALARM", eyebrow: "Siren active: admins alerted", cssClass: "state-alarm" },
  };

  var ENTRY_MESSAGE = "Door opened: enter PIN";
  var ALARM_MESSAGE = "Enter PIN to silence and disarm";

  var ARM_CONFIRM_TITLE = "Arm the system?";
  var ARM_CONFIRM_SUB = "Everyone should be on their way out.";

  var WEATHER_ICONS = {
    "clear-day":
      "M450-751.54v-147.69h60v147.69h-60Zm242.92 100.77-41.15-41.15 103.15-106.54 42.54 43.15-104.54 104.54ZM751.54-450v-60h147.69v60H751.54ZM450-60.77v-147.31h60v147.31h-60ZM267.85-652.38 161.54-754.92l43.54-42.16 104.54 104.16-41.77 40.54Zm486.46 490.84L651.77-268.08l40.54-40.15 104.77 101.92-42.77 44.77ZM60.77-450v-60h147.69v60H60.77Zm143.92 288.46-41.77-43.54 103.16-103.15 21.69 20.46 22.08 21.08-105.16 105.15ZM480.09-260q-91.63 0-155.86-64.14Q260-388.28 260-479.91q0-91.63 64.14-155.86Q388.28-700 479.91-700q91.63 0 155.86 64.14Q700-571.72 700-480.09q0 91.63-64.14 155.86Q571.72-260 480.09-260Zm-.09-60q66 0 113-47t47-113q0-66-47-113t-113-47q-66 0-113 47t-47 113q0 66 47 113t113 47Zm0-160Z",
    "partly-cloudy":
      "M450-751.54v-147.69h60v147.69h-60Zm242.92 100.77-42.15-42.54 104.54-105.15 42.15 43.15-104.54 104.54ZM751.54-450v-60h147.69v60H751.54Zm3.77 287.46L650.77-267.08l42.54-42.54 105.15 103.93-43.15 43.15ZM267.46-650.38l-105.3-105.31 43.15-42.39 104.31 105.54-42.16 42.16Zm-15.92 452.69h172.31q28.84 0 49.42-20.58 20.58-20.58 20.58-49.42 0-28.85-19.89-49.23-19.88-20.39-48.73-20.39h-44.84l-17.31-41.46q-14.77-34.54-46.12-54.81-31.34-20.27-69.27-20.27-52.69 0-89.42 36.73-36.73 36.73-36.73 89.43 0 54.23 37.88 92.11 37.89 37.89 92.12 37.89Zm0 60q-78.77 0-134.38-55.62-55.62-55.61-55.62-134.38 0-77.62 54.27-131.89 54.27-54.27 131.88-54.27 57.31 0 104.31 31.74 47 31.73 68.31 84.8 54.15 0 93.65 36.66 39.5 36.65 39.89 96.26-1.24 53.16-38.85 89.93-37.62 36.77-91.15 36.77H251.54Zm301.54-134.39q-3.85-15-7.7-29.19-3.84-14.19-7.69-29.19 46.16-19.39 74.23-59.58Q640-430.23 640-480q0-66-47-113t-113-47q-61.15 0-106.54 40.35-45.38 40.34-51.84 101.5-15-3.85-30.62-7.08-15.61-3.23-30.61-7.08 11.69-81.84 74.42-134.77Q397.54-700 480-700q91.54 0 155.77 64.23T700-480q0 70.46-40.35 126.96-40.34 56.5-106.57 80.96ZM481-480Z",
    cloudy:
      "M260-180q-82.92 0-141.46-57.62Q60-295.23 60-378.15q0-73.39 47-130.54 47-57.16 119.92-67.62Q246.15-666 317.12-723q70.96-57 162.88-57 108.54 0 184.27 75.73T740-520v20h12.31q63.23 4.92 105.46 50.85Q900-403.23 900-340q0 66.92-46.54 113.46Q806.92-180 740-180H260Zm0-60h480q42 0 71-29t29-71q0-42-29-71t-71-29h-60v-80q0-83-58.5-141.5T480-720q-83 0-141.5 58.5T280-520h-20q-58 0-99 41t-41 99q0 58 41 99t99 41Zm220-240Z",
    fog: "M720-207.69q-13.73 0-23.02-9.29T687.69-240q0-13.73 9.29-23.02t23.02-9.29q13.73 0 23.02 9.29t9.29 23.02q0 13.73-9.29 23.02T720-207.69Zm-440 120q-13.73 0-23.02-9.29T247.69-120q0-13.73 9.29-23.02t23.02-9.29q13.73 0 23.02 9.29t9.29 23.02q0 13.73-9.29 23.02T280-87.69ZM240-210q-12.75 0-21.37-8.63-8.63-8.63-8.63-21.38 0-12.76 8.63-21.37Q227.25-270 240-270h360q12.75 0 21.37 8.63 8.63 8.63 8.63 21.38 0 12.76-8.63 21.37Q612.75-210 600-210H240ZM400-90q-12.75 0-21.37-8.63-8.63-8.63-8.63-21.38 0-12.76 8.63-21.37Q387.25-150 400-150h280q12.75 0 21.37 8.63 8.63 8.63 8.63 21.38 0 12.76-8.63 21.37Q692.75-90 680-90H400ZM300-330q-87.15 0-148.58-61.42Q90-452.85 90-540q0-80.31 53.65-139.61 53.66-59.31 133.5-69.16 30.89-56.64 84.44-88.93Q415.15-870 479.85-870q88.23 0 152.42 57.31 64.19 57.31 76.27 142.92 71.31 5.23 116.38 54.12Q870-566.77 870-499.88q0 70.65-49.58 120.26Q770.83-330 700-330H300Zm0-60h400q45.85 0 77.92-32.08Q810-454.15 810-500t-32.08-77.92Q745.85-610 700-610h-50v-30q0-70.13-49.95-120.06Q550.09-810 479.94-810q-51.02 0-92.97 27.67-41.96 27.66-63.2 74.48L316.41-690H298q-61.13 2.14-104.57 45.54Q150-601.07 150-540q0 62.14 43.93 106.07Q237.86-390 300-390Zm180-210Z",
    rain: "M555.31-89.77q-11.16 6.08-22.81 1.92-11.65-4.15-17.73-15.3l-63.85-127.7q-6.07-11.15-1.92-22.8 4.15-11.66 15.31-17.73 11.15-6.08 23-1.73 11.84 4.34 17.92 15.49l63.85 127.31q6.07 11.16 1.73 22.81-4.35 11.65-15.5 17.73Zm240.38 0q-11.15 6.08-22.8 1.92-11.66-4.15-17.74-15.3l-63.84-127.7q-6.08-11.15-1.92-22.8 4.15-11.66 15.3-17.73 11.16-6.08 23-1.73 11.85 4.34 17.92 15.49l63.85 127.31q6.08 11.16 1.73 22.81-4.34 11.65-15.5 17.73Zm-480.38 0q-11.16 6.08-23 1.92-11.85-4.15-17.92-15.3l-63.85-127.7q-6.08-11.15-1.73-22.8 4.34-11.66 15.5-17.73 11.15-6.08 22.8-1.73 11.66 4.34 17.74 15.49l63.84 127.31q6.08 11.16 1.92 22.81-4.15 11.65-15.3 17.73ZM300-330q-87.15 0-148.58-61.42Q90-452.85 90-540q0-80.31 53.65-139.61 53.66-59.31 133.5-69.16 30.85-56.61 84.43-88.92Q415.15-870 480-870q88.08 0 152.27 57.31 64.19 57.31 76.27 142.92 71.31 5.23 116.38 54.12Q870-566.77 870-500q0 70.77-49.62 120.38Q770.77-330 700-330H300Zm0-60h400q45.85 0 77.92-32.08Q810-454.15 810-500t-32.08-77.92Q745.85-610 700-610h-50v-30q0-70.23-49.88-120.12Q550.23-810 480-810q-51.08 0-93.08 27.73t-63.15 74.42L316.46-690H298q-61.23 2-104.62 45.38Q150-601.23 150-540q0 62.23 43.88 106.12Q237.77-390 300-390Zm180-210Z",
    snow: "M260-208.46q-17.15 0-29.35-12.19-12.19-12.2-12.19-29.35 0-17.15 12.19-29.35 12.2-12.19 29.35-12.19 17.15 0 29.35 12.19 12.19 12.2 12.19 29.35 0 17.15-12.19 29.35-12.2 12.19-29.35 12.19Zm120 120q-17.15 0-29.35-12.19-12.19-12.2-12.19-29.35 0-17.15 12.19-29.35 12.2-12.19 29.35-12.19 17.15 0 29.35 12.19 12.19 12.2 12.19 29.35 0 17.15-12.19 29.35-12.2 12.19-29.35 12.19Zm120-120q-17.15 0-29.35-12.19-12.19-12.2-12.19-29.35 0-17.15 12.19-29.35 12.2-12.19 29.35-12.19 17.15 0 29.35 12.19 12.19 12.2 12.19 29.35 0 17.15-12.19 29.35-12.2 12.19-29.35 12.19Zm240 0q-17.15 0-29.35-12.19-12.19-12.2-12.19-29.35 0-17.15 12.19-29.35 12.2-12.19 29.35-12.19 17.15 0 29.35 12.19 12.19 12.2 12.19 29.35 0 17.15-12.19 29.35-12.2 12.19-29.35 12.19Zm-120 120q-17.15 0-29.35-12.19-12.19-12.2-12.19-29.35 0-17.15 12.19-29.35 12.2-12.19 29.35-12.19 17.15 0 29.35 12.19 12.19 12.2 12.19 29.35 0 17.15-12.19 29.35-12.2 12.19-29.35 12.19ZM300-370q-87.15 0-148.58-61.42Q90-492.85 90-580q0-80.31 53.65-139.61 53.66-59.31 133.5-69.16 30.89-56.64 84.44-88.93Q415.15-910 479.85-910q88.23 0 152.42 57.31 64.19 57.31 76.27 142.92 71.31 5.23 116.38 54.12Q870-606.77 870-539.88q0 70.65-49.58 120.26Q770.83-370 700-370H300Zm0-60h400q45.85 0 77.92-32.08Q810-494.15 810-540t-32.08-77.92Q745.85-650 700-650h-50v-30q0-70.13-49.95-120.06Q550.09-850 479.94-850q-51.02 0-92.97 27.67-41.96 27.66-63.2 74.48L316.41-730H298q-61.13 2.14-104.57 45.54Q150-641.07 150-580q0 62.14 43.93 106.07Q237.86-430 300-430Zm180-110Z",
    storm:
      "m483.92-10 88.24-100.08-80-40L596.62-270h79.46l-88.24 100.08 80 40L563.38-10h-79.46Zm-240 0 88.24-100.08-80-40L356.62-270h79.46l-88.24 100.08 80 40L323.38-10h-79.46ZM300-330q-87.15 0-148.58-61.42Q90-452.85 90-540q0-80.31 53.65-139.61 53.66-59.31 133.5-69.16 30.85-56.61 84.43-88.92Q415.15-870 480-870q88.08 0 152.27 57.31 64.19 57.31 76.27 142.92 71.31 5.23 116.38 54.12Q870-566.77 870-500q0 70.77-49.62 120.38Q770.77-330 700-330H300Zm0-60h400q45.85 0 77.92-32.08Q810-454.15 810-500t-32.08-77.92Q745.85-610 700-610h-50v-30q0-70.23-49.88-120.12Q550.23-810 480-810q-51.08 0-93.08 27.73t-63.15 74.42L316.46-690H298q-61.23 2-104.62 45.38Q150-601.23 150-540q0 62.23 43.88 106.12Q237.77-390 300-390Zm180-210Z",
  };

  // ---------- PIN buffer + dots -------------------------------------------

  var MAX_DOTS = 4; // PINs are always exactly 4 digits.
  var pinDotEls = [];
  for (var pdi = 0; pdi < MAX_DOTS; pdi++) pinDotEls.push(document.getElementById("pin-dot-" + pdi));

  // Toggles `filled` on the 4 dots that are already in the DOM — never
  // creates or removes nodes (that would fight Next's hydration walk of the
  // server-rendered tree; see the comment in page.tsx).
  function renderPin() {
    for (var i = 0; i < MAX_DOTS; i++) {
      var dot = pinDotEls[i];
      if (!dot) continue;
      dot.className = "pin-dot" + (i < pinDigits.length ? " filled" : "");
    }
    // The 4th digit auto-submits, so Disarm is only a distraction mid-entry.
    if (actionBtn) actionBtn.disabled = currentState !== "DISARMED" && pinDigits.length > 0;
  }

  function shakePinRow() {
    pinDots.className = "pin-dots shake";
    setTimeout(function () {
      pinDots.className = "pin-dots";
    }, SHAKE_MS);
  }

  function addDigit(d) {
    if (submitting || pinDigits.length >= MAX_PIN_LEN) return;
    pinDigits += d;
    renderPin();
    play("key");
    // PINs are always exactly 4 digits, so the 4th digit is always the last
    // one — no reason to make someone also tap Disarm. Captures the buffer
    // now and only submits if it's unchanged by the time the delay fires, so
    // a manual Disarm tap landing in that same window (which clears the
    // buffer itself) can't cause a double submit.
    if (pinDigits.length === MAX_PIN_LEN) {
      var pinAtSchedule = pinDigits;
      setTimeout(function () {
        if (pinDigits === pinAtSchedule) submitPin();
      }, AUTO_SUBMIT_DELAY_MS);
    }
  }

  function clearPin() {
    pinDigits = "";
    renderPin();
  }

  function backspace() {
    if (submitting) return;
    pinDigits = pinDigits.slice(0, -1);
    renderPin();
    play("backspace");
  }

  // Keys fire on pointerdown, not click: on a touchscreen a tap whose finger
  // slides a few px (or lingers) never becomes a click, which dropped presses.
  // The click that follows a pointerdown is swallowed; a click with no pointer
  // before it (keyboard, assistive tech) still works.
  function onTap(el, fn) {
    if (!el) return;
    var lastPointerAt = 0;
    el.addEventListener("pointerdown", function (e) {
      if (e.button) return;
      lastPointerAt = Date.now();
      fn(el);
    });
    el.addEventListener("click", function () {
      if (Date.now() - lastPointerAt > 700) fn(el);
    });
  }

  if (keypad) {
    var digitButtons = keypad.querySelectorAll("button[data-digit]");
    for (var i = 0; i < digitButtons.length; i++) {
      onTap(digitButtons[i], function (el) {
        addDigit(el.getAttribute("data-digit"));
      });
    }
  }
  onTap(clearBtn, function () {
    if (submitting) return;
    clearPin();
    play("backspace");
  });
  onTap(backspaceBtn, backspace);

  // ---------- Messages ------------------------------------------------------

  function setMessage(text, ok, warn) {
    clearTimeout(messageTimer);
    messageTimer = null;
    messageEl.textContent = text || "";
    messageEl.className = "message" + (ok ? " ok" : "") + (warn ? " warn" : "");
  }

  function flashMessage(text) {
    setMessage(text, true);
    messageTimer = setTimeout(function () {
      setMessage("");
    }, SUCCESS_MSG_MS);
  }

  // ---------- Submit (disarm — the only PIN-gated action) ---------------------

  var submitting = false;

  // The dots stay filled and pulse while the server checks the PIN, so a slow
  // network doesn't look like a dropped entry. Digits are ignored meanwhile.
  function finishSubmit() {
    submitting = false;
    pinDots.className = "pin-dots";
    clearPin();
  }

  function submitPin() {
    if (submitting) return;
    if (pinDigits.length < 4) {
      shakePinRow();
      setMessage("Enter your 4-digit PIN", false);
      return;
    }
    var pin = pinDigits;
    submitting = true;
    pinDots.className = "pin-dots checking";
    setMessage("Checking…", false);

    fetch("/api/disarm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: pin }),
    })
      .then(function (res) {
        if (res.status === 429) {
          // The lockout itself already triggered the alarm server-side (see
          // handlePinLockout in lib/state/machine.ts) — reflect that now
          // rather than waiting for the next status poll.
          finishSubmit();
          shakePinRow();
          play("lockout");
          setMessage("Too many attempts. Alarm triggered. Locked out for a few minutes.", false);
          pollStatus();
          return;
        }
        return res.json().then(function (data) {
          finishSubmit();
          if (!res.ok) {
            shakePinRow();
            play("wrong-pin");
            var remaining = data && data.remainingAttempts;
            if (remaining === 1) {
              setMessage("LAST TRY: one more wrong PIN triggers the alarm", false, true);
            } else {
              setMessage(
                typeof remaining === "number" ? "Incorrect PIN. " + remaining + " tries remaining" : "Incorrect PIN",
                false,
              );
            }
            return;
          }
          play("disarm");
          flashMessage("System disarmed");
          pollStatus();
        });
      })
      .catch(function () {
        finishSubmit();
        setMessage("Panel offline.", false);
      });
  }

  // ---------- Arm (no PIN — tap-to-confirm) ------------------------------------

  var pendingForceArm = false;

  function showSensorsOpenConfirm(openSensors) {
    var names = (openSensors || []).map(function (s) { return s.name; }).join(", ");
    armConfirmTitleEl.textContent = "Door open. Arm anyway?";
    armConfirmSubEl.textContent = names ? "Still open: " + names : "A door is still open.";
    pendingForceArm = true;
    armConfirmOverlay.hidden = false;
    play("arm-refused");
  }

  function confirmArm(force) {
    armConfirmOverlay.hidden = true;
    fetch("/api/panel/arm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: !!force }),
    })
      .then(function (res) {
        if (res.status === 409) {
          return res.json().then(function (data) {
            if (data.reason === "sensors_open") {
              showSensorsOpenConfirm(data.openSensors);
            } else {
              setMessage("Could not arm. Try again.", false);
            }
          });
        }
        if (!res.ok) {
          setMessage("Could not arm. Try again.", false);
          return;
        }
        play("arm-confirmed");
        flashMessage("Armed: exit now");
        pollStatus();
      })
      .catch(function () {
        setMessage("Panel offline.", false);
      });
  }

  if (armConfirmYesBtn) {
    armConfirmYesBtn.addEventListener("click", function () {
      confirmArm(pendingForceArm);
    });
  }
  if (armConfirmCancelBtn) {
    armConfirmCancelBtn.addEventListener("click", function () {
      armConfirmOverlay.hidden = true;
    });
  }

  if (actionBtn) {
    actionBtn.addEventListener("click", function () {
      if (currentState === "DISARMED") {
        pendingForceArm = false;
        armConfirmTitleEl.textContent = ARM_CONFIRM_TITLE;
        armConfirmSubEl.textContent = ARM_CONFIRM_SUB;
        armConfirmOverlay.hidden = false;
        return;
      }
      submitPin();
    });
  }

  // ---------- Status polling + countdown --------------------------------------

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function renderCountdown() {
    bannerCountdown.textContent = localRemaining + "s";
    banner.classList.toggle("urgent", localRemaining <= URGENT_SEC && !!TICK_SOUND[currentState]);
    var pct = localTotal ? Math.max(0, Math.min(100, Math.round((localRemaining / localTotal) * 100))) : 0;
    progressFill.style.width = pct + "%";
  }

  // One beat per second; a second beat half a second later near the end.
  var TICK_SOUND = { ARMING: "exit-beep", ENTRY_DELAY: "entry-beep" };
  var URGENT_SEC = 10; // the countdown pulses from here, so it reads without sound
  var FAST_TICK_SEC = { ARMING: 5, ENTRY_DELAY: 10 };

  function countdownTick() {
    var state = currentState;
    var name = TICK_SOUND[state];
    // Nothing at 0: the state flips on the next poll and "armed" plays over it.
    if (!name || !localRemaining) return;
    play(name);
    if (localRemaining <= FAST_TICK_SEC[state]) {
      setTimeout(function () {
        if (currentState === state) play(name);
      }, 500);
    }
  }

  function startCountdown(remainingSec, isNewCountdown) {
    if (isNewCountdown || localTotal === null) localTotal = remainingSec;
    bannerCountdown.hidden = false;
    progressTrack.hidden = false;
    // Counts down against a wall-clock deadline, so a throttled tab can't fall
    // behind, and the timer is never restarted by a poll (that made the beat
    // land every 2s). A poll only moves the deadline if it drifted past 1s.
    if (isNewCountdown || !countdownTimer) {
      stopCountdown();
      countdownEndsAt = Date.now() + remainingSec * 1000;
      localRemaining = remainingSec;
      renderCountdown();
      countdownTick();
      countdownTimer = setInterval(function () {
        var rem = Math.max(0, Math.ceil((countdownEndsAt - Date.now()) / 1000));
        if (rem === localRemaining) return;
        localRemaining = rem;
        renderCountdown();
        countdownTick();
      }, 200);
    } else if (Math.abs(localRemaining - remainingSec) > 1) {
      countdownEndsAt = Date.now() + remainingSec * 1000;
      localRemaining = remainingSec;
    }
    renderCountdown(); // also re-applies the urgent class applyStatus just reset
  }

  function endCountdown() {
    stopCountdown();
    localRemaining = null;
    localTotal = null;
    bannerCountdown.hidden = true;
    progressTrack.hidden = true;
  }

  // Reload only in quiet states. A reload drops the AudioContext (iOS needs a
  // fresh tap to unlock it), so never do it mid ARMING/ENTRY_DELAY/ALARM.
  function reloadWhenIdle() {
    reloadPending = true;
    if (currentState === "DISARMED" || currentState === "ARMED") location.reload();
  }

  function msUntilMidnight() {
    var now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  }

  function applyStatus(status) {
    if (status.version && pageVersion && status.version !== pageVersion) reloadWhenIdle();
    else if (reloadPending) reloadWhenIdle();
    if (offline) {
      offline = false;
      offlineBanner.hidden = true;
    }

    var wasState = currentState;
    currentState = status.state;
    var cfg = STATE_CONFIG[status.state] || STATE_CONFIG.DISARMED;

    if (wasState === "ARMING" && status.state === "ARMED") play("armed");

    if (status.state === "ARMING") {
      // First status after a (re)load: trips already counted aren't news.
      var tripBaseline = firstStatus ? status.armingTripCount : wasState === "ARMING" ? lastArmingTripCount : 0;
      if (typeof status.armingTripCount === "number" && tripBaseline !== null && status.armingTripCount > tripBaseline) {
        play("door");
      }
      lastArmingTripCount = status.armingTripCount;
      // Say which door, for as long as the exit delay runs.
      var doors = (status.armingTripDoors || []).join(", ");
      if (doors !== lastArmingDoors) {
        lastArmingDoors = doors;
        if (doors) setMessage("Door opened: " + doors, false);
      }
    } else {
      lastArmingTripCount = null;
      lastArmingDoors = "";
    }
    firstStatus = false;

    banner.className = "banner " + cfg.cssClass + (status.remainingSec != null ? " has-countdown" : "");
    bannerEyebrow.textContent = cfg.eyebrow;
    bannerLabel.textContent = cfg.label;

    if (status.remainingSec != null) {
      startCountdown(status.remainingSec, wasState !== status.state);
    } else {
      endCountdown();
    }

    if (wasState !== status.state) {
      if (status.state === "ENTRY_DELAY") {
        setMessage(status.triggeredByName ? status.triggeredByName + " opened: enter PIN" : ENTRY_MESSAGE, false);
      }
      else if (status.state === "ALARM") setMessage(ALARM_MESSAGE, false);
      // messageTimer is non-null while a flashMessage() is in flight (e.g.
      // "System disarmed", fired by submitPin() right before
      // this same poll runs) — its own timeout already clears the message
      // on schedule, so clearing here too would wipe it early instead of
      // letting the admin actually read it.
      else if ((wasState === "ENTRY_DELAY" || wasState === "ALARM" || wasState === "ARMING") && !messageTimer) setMessage("");
    }

    var isDisarmed = status.state === "DISARMED";
    actionBtn.textContent = isDisarmed ? "Arm system" : "Disarm";
    actionBtn.className = "action-btn " + (isDisarmed ? "arm" : "disarm");
    pinDots.hidden = isDisarmed;
    keypad.hidden = isDisarmed;
    disarmedPanel.hidden = !isDisarmed;
    // Only relevant if another kiosk/admin armed it out from under this one
    // while the confirm dialog was open here.
    if (!isDisarmed) armConfirmOverlay.hidden = true;

    // Server-owned 5-minute window (see AlarmEngine.getStatus()) — this just
    // reflects whatever it says, never runs its own timer.
    if (status.welcomeName) {
      welcomeNameEl.textContent = status.welcomeName;
      welcomeMessage.hidden = false;
    } else {
      welcomeMessage.hidden = true;
    }

    testMode = !!status.testMode;
    testBadge.hidden = !testMode;
    renderDoors(status.doors || []);
    if (status.armedAt && status.armedBy && !isDisarmed) {
      armedInfoEl.textContent =
        "Armed by " + status.armedBy + " at " +
        new Date(status.armedAt).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false });
      armedInfoEl.hidden = false;
    } else {
      armedInfoEl.hidden = true;
    }

    // Test mode mutes only the siren, and also stops one that was already sounding when it got switched on.
    if (status.state === "ALARM" && !testMode) {
      unlockAudio();
      startAlarmTone();
    }
    else stopAlarmTone();

    if (isDisarmed) pinDigits = "";
    renderPin();
    updateDim();
  }

  // Open doors first, so the 8-slot pool only ever drops closed ones.
  function renderDoors(doors) {
    var sorted = doors.slice().sort(function (a, b) {
      return Number(b.open) - Number(a.open);
    });
    for (var i = 0; i < DOOR_SLOTS; i++) {
      var slot = doorEls[i];
      var d = sorted[i];
      if (!slot.row) continue;
      if (d) {
        slot.name.textContent = d.name;
        slot.state.textContent = d.open ? "open" : "closed";
        slot.row.className = "door" + (d.open ? " open" : "");
        slot.row.hidden = false;
      } else {
        slot.row.hidden = true;
      }
    }
  }

  function markOffline() {
    if (!offline) {
      offline = true;
      offlineBanner.hidden = false;
    }
    // The number is now a local guess, not the server's.
    banner.classList.add("stale");
  }

  function pollStatus() {
    fetch("/api/status", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("bad status");
        return res.json();
      })
      .then(applyStatus)
      .catch(markOffline);
  }

  // ---------- Clock ------------------------------------------------------------

  function renderClock() {
    var now = new Date();
    clockTimeEl.textContent = now.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false });
    clockDateEl.textContent = now.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" });
  }

  // ---------- Weather + panel context -------------------------------------------

  var forecastSkeleton = document.getElementById("forecast-skeleton");

  var contextRetryTimer = null;

  function applyContext(ctx) {
    forecastSkeleton.hidden = true;
    // Weather missing (server fetch failed) — retry soon instead of waiting a
    // full WEATHER_POLL_MS. Single timer so repeated failures can't stack.
    clearTimeout(contextRetryTimer);
    if (ctx.tempC == null) contextRetryTimer = setTimeout(pollContext, 60 * 1000);
    audioEnabled = ctx.audioEnabled !== false;
    if (typeof ctx.quietHoursStart === "number") quietHoursStart = ctx.quietHoursStart;
    if (typeof ctx.quietHoursEnd === "number") quietHoursEnd = ctx.quietHoursEnd;
    dimCaption.textContent =
      "Quiet hours · " + pad2(quietHoursStart) + ":00–" + pad2(quietHoursEnd) + ":00 · Tap to wake";

    if (ctx.tempC != null && ctx.condition) {
      var d = WEATHER_ICONS[ctx.icon] || WEATHER_ICONS.cloudy;
      document.getElementById("forecast-icon-path").setAttribute("d", d);
      forecastTemp.textContent = ctx.tempC + "°";
      forecastCondition.textContent = ctx.condition;
      forecastHi.textContent = ctx.hiC;
      forecastLo.textContent = ctx.loC;
      forecast.hidden = false;
    } else {
      forecast.hidden = true;
    }

    var hours = ctx.hourly || [];
    for (var hi = 0; hi < FORECAST_HOUR_COUNT; hi++) {
      var slot = forecastHourEls[hi];
      var hour = hours[hi];
      if (!slot.row) continue;
      if (hour) {
        slot.label.textContent = hour.hour;
        slot.iconPath.setAttribute("d", WEATHER_ICONS[hour.icon] || WEATHER_ICONS.cloudy);
        slot.temp.textContent = hour.tempC + "°";
        slot.row.hidden = false;
      } else {
        slot.row.hidden = true;
      }
    }

    updateDim();
  }

  function pollContext() {
    fetch("/api/panel/context", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("bad context");
        return res.json();
      })
      .then(applyContext)
      .catch(function () {
        forecastSkeleton.hidden = true;
      });
  }

  // ---------- Night dim ----------------------------------------------------------

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function isQuietHours(now) {
    var h = now.getHours();
    if (quietHoursStart === quietHoursEnd) return false;
    if (quietHoursStart < quietHoursEnd) return h >= quietHoursStart && h < quietHoursEnd;
    return h >= quietHoursStart || h < quietHoursEnd;
  }

  function updateDim() {
    // Someone is racing a countdown: never make the first tap just wake the screen.
    if (Date.now() < snoozeUntil || currentState === "ENTRY_DELAY" || currentState === "ALARM") {
      dimOverlay.hidden = true;
      return;
    }
    dimOverlay.hidden = !isQuietHours(new Date());
  }

  function wake() {
    snoozeUntil = Date.now() + SNOOZE_MS;
    dimOverlay.hidden = true;
  }

  if (dimOverlay) {
    dimOverlay.addEventListener("touchstart", wake);
    dimOverlay.addEventListener("click", wake);
  }

  // ---------- Sounds --------------------------------------------------------------
  // Files in /sounds, rendered by scripts/generate-sounds.py (docs/sounds/ has
  // the listening page). Decoded once into Web Audio buffers after first unlock.

  var SOUND_NAMES = [
    "key", "backspace", "arm-confirmed", "exit-beep", "door", "armed",
    "arm-refused", "entry-beep", "disarm", "wrong-pin", "lockout", "alarm",
  ];
  var soundBuffers = {};
  var soundsRequested = false;

  function loadSounds() {
    soundsRequested = true;
    SOUND_NAMES.forEach(function (name) {
      fetch("/sounds/" + name + ".wav")
        .then(function (res) {
          return res.arrayBuffer();
        })
        .then(function (data) {
          audioCtx.decodeAudioData(data, function (buf) {
            soundBuffers[name] = buf;
          }, function () {});
        })
        .catch(function () {});
    });
  }

  // Also tried at boot and on every alarm poll: a kiosk WebView that allows
  // autoplay then has sound after a reload with no tap; otherwise the first
  // touch is what unlocks it.
  function unlockAudio() {
    if (!audioCtx) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(function () {});
    if (!soundsRequested) loadSounds();
  }
  document.addEventListener("touchstart", unlockAudio);
  document.addEventListener("click", unlockAudio);

  function play(name, opts) {
    opts = opts || {};
    if (!audioEnabled) return null;
    // Everything respects quiet hours except the ALARM — a real break-in
    // shouldn't stay silent at 2am.
    if (!opts.ignoreQuietHours && isQuietHours(new Date())) return null;
    if (audioCtx && audioCtx.state === "running" && soundBuffers[name]) {
      var src = audioCtx.createBufferSource();
      src.buffer = soundBuffers[name];
      src.loop = !!opts.loop;
      src.connect(audioCtx.destination);
      src.start();
      return src;
    }
    // Web Audio is still locked (after a reload, until a tap): Fully Kiosk's
    // native player needs no gesture. One sound at a time, so never while its
    // siren is the thing playing.
    if (!opts.loop && !fullySirenOn && window.fully && typeof window.fully.playSound === "function") {
      window.fully.playSound(location.origin + "/sounds/" + name + ".wav", false);
    }
    return null;
  }

  // ---------- ALARM siren ----------------------------------------------------------

  var alarmSource = null;
  // Fully Kiosk's native player (JS Interface, PLUS) plays without a user
  // gesture — Web Audio can't after a reload. Used when present.
  var fullySirenOn = false;

  function startAlarmTone() {
    if (alarmSource || fullySirenOn) return;
    if (window.fully && typeof window.fully.playSound === "function") {
      if (!audioEnabled || testMode) return;
      window.fully.playSound(location.origin + "/sounds/alarm.wav", true);
      fullySirenOn = true;
      return;
    }
    alarmSource = play("alarm", { loop: true, ignoreQuietHours: true });
  }

  function stopAlarmTone() {
    if (fullySirenOn) {
      window.fully.stopSound();
      fullySirenOn = false;
    }
    if (alarmSource) {
      alarmSource.stop();
      alarmSource = null;
    }
  }

  // ---------- Boot -----------------------------------------------------------------

  renderPin();
  renderClock();
  unlockAudio();
  pollStatus();
  pollContext();
  setInterval(pollStatus, POLL_MS);
  setInterval(pollContext, WEATHER_POLL_MS);
  // Nightly fresh start: drops any accumulated browser memory and re-reads all
  // server state. Deferred via reloadWhenIdle() if an alarm sequence is live.
  setTimeout(reloadWhenIdle, msUntilMidnight());
  setInterval(function () {
    renderClock();
    updateDim();
  }, 10000);
})();
