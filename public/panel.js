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

  // A request that never settles must not wedge the keypad or the poll. Older WebViews lack AbortSignal.timeout; they fall back to no timeout.
  function timeoutSignal(ms) {
    return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
  }

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
      iconUse: document.getElementById("forecast-hour-" + fhi + "-icon-use"),
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


  // ---------- PIN buffer + dots -------------------------------------------

  var pinDotEls = [];
  for (var pdi = 0; pdi < MAX_PIN_LEN; pdi++) pinDotEls.push(document.getElementById("pin-dot-" + pdi));

  // Toggles `filled` on the 4 dots that are already in the DOM — never
  // creates or removes nodes (that would fight Next's hydration walk of the
  // server-rendered tree; see the comment in page.tsx).
  function renderPin() {
    for (var i = 0; i < MAX_PIN_LEN; i++) {
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
      signal: timeoutSignal(8000),
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
      } else if (status.state === "ALARM") setMessage(ALARM_MESSAGE, false);
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
    } else stopAlarmTone();

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

  // Single-flight: a slow poll must not pile up behind the 2s interval, and an old response landing after a disarm must not put the panel back into ALARM.
  var pollInFlight = false;

  function pollStatus() {
    if (pollInFlight) return;
    pollInFlight = true;
    fetch("/api/status", { cache: "no-store", signal: timeoutSignal(5000) })
      .then(function (res) {
        if (!res.ok) throw new Error("bad status");
        return res.json();
      })
      .then(applyStatus)
      .catch(markOffline)
      .then(function () {
        pollInFlight = false;
      });
  }

  // ---------- Clock ------------------------------------------------------------

  function renderClock() {
    var now = new Date();
    clockTimeEl.textContent = now.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false });
    clockDateEl.textContent = now.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" });
  }

  // ---------- Weather + panel context -------------------------------------------

  var forecastSkeleton = document.getElementById("forecast-skeleton");
  var forecastIconUse = document.getElementById("forecast-icon-use");

  // The icons are <symbol>s the page renders from app/panel/weather-icons.ts;
  // an unknown key falls back to the cloud rather than an empty slot.
  function weatherIconRef(key) {
    return document.getElementById("wi-" + key) ? "#wi-" + key : "#wi-cloudy";
  }

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
      forecastIconUse.setAttribute("href", weatherIconRef(ctx.icon));
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
        slot.iconUse.setAttribute("href", weatherIconRef(hour.icon));
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
        // Same retry as a server-side weather miss (see applyContext), instead of waiting the full 15 minutes.
        clearTimeout(contextRetryTimer);
        contextRetryTimer = setTimeout(pollContext, 60 * 1000);
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
          if (!res.ok) throw new Error("sound " + name + " " + res.status);
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
