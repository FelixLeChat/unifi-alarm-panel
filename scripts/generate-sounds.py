#!/usr/bin/env python3
"""Renders the panel's sounds to WAV files for listening/review (stdlib only).

  python3 scripts/generate-sounds.py

Writes docs/sounds/current/*.wav (exact replicas of what public/panel.js plays
today, at its real gain levels) and docs/sounds/proposed/*.wav (candidate
replacements). docs/sounds/index.html is the listening page.
"""
import math
import os
import shutil
import struct
import wave

SR = 44100
ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "docs", "sounds")


def write(path, samples):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32767)) for s in samples))


def silence(sec):
    return [0.0] * int(SR * sec)


def tone(freq, dur, gain, wave_="sine", attack=0.0, freq_end=None, harmonics=None):
    """One note. Gain decays exponentially to 0.0001 (like WebAudio's
    exponentialRampToValueAtTime in panel.js); `attack` > 0 adds a linear
    fade-in (panel.js has none, which is why today's beeps click)."""
    n = int(SR * dur)
    out = []
    phase = 0.0
    for i in range(n):
        t = i / SR
        f = freq if freq_end is None else freq + (freq_end - freq) * (t / dur)
        phase += 2 * math.pi * f / SR
        if wave_ == "sine":
            v = math.sin(phase)
        elif wave_ == "square":
            v = 1.0 if math.sin(phase) >= 0 else -1.0
        else:  # soft: sine + a little 2nd/3rd harmonic, easier to hear on a tablet speaker
            v = math.sin(phase) + 0.35 * math.sin(2 * phase) + 0.12 * math.sin(3 * phase)
            v /= 1.47
        env = gain * (0.0001 / gain) ** (t / dur)
        if attack and t < attack:
            env *= t / attack
        out.append(v * env)
    return out


def cat(*parts):
    r = []
    for p in parts:
        r += p
    return r


def repeat_every(note, period, count):
    pad = silence(max(0.0, period - len(note) / SR))
    return cat(*([note + pad] * count))


# ---------------------------------------------------------------- current ---
# Exact replicas of public/panel.js (beep(): sine, instant attack, exp decay).
cur = os.path.join(OUT, "current")
write(os.path.join(cur, "01-key-press.wav"), cat(tone(880, 0.04, 0.05), silence(0.3)))
write(os.path.join(cur, "02-entry-delay-tick.wav"), repeat_every(tone(660, 0.04, 0.05), 1.0, 4))
write(os.path.join(cur, "03-door-open-during-exit-delay.wav"), cat(tone(523, 0.1, 0.07), silence(0.3)))
siren = []
for i in range(9):  # startAlarmTone(): 900/1200 alternating, 250ms beeps every 350ms
    siren += tone(1200 if i % 2 else 900, 0.25, 0.12) + silence(0.1)
write(os.path.join(cur, "04-alarm-siren-webaudio.wav"), siren)
fully_siren = os.path.join(ROOT, "public", "sounds", "siren.wav")  # the pre-E2 Fully Kiosk siren; only while it still exists
if os.path.exists(fully_siren):
    shutil.copy(fully_siren, os.path.join(cur, "05-alarm-siren-fully-kiosk.wav"))

# --------------------------------------------------------------- proposed ---
# Design rules: every event gets a distinct shape (rising = good/done, falling
# = leaving/locked, low + buzzy = error, fast + repeated = urgent), 5 ms+ attack
# so nothing clicks, harmonics so it carries on a small tablet speaker.
pro = os.path.join(OUT, "proposed")
P = "soft"


def note(f, d, g=0.12):
    return tone(f, d, g, P, attack=0.005)


write(os.path.join(pro, "01-key-press.wav"), cat(note(1000, 0.05, 0.08), silence(0.3)))
write(os.path.join(pro, "02-backspace.wav"), cat(note(600, 0.05, 0.08), silence(0.3)))
write(os.path.join(pro, "03-arm-confirmed.wav"), cat(note(523, 0.12), note(784, 0.22), silence(0.3)))
# Exit delay: slow beep each second, then twice a second for the last stretch.
write(
    os.path.join(pro, "04-exit-delay-countdown.wav"),
    cat(repeat_every(note(700, 0.08), 1.0, 4), repeat_every(note(700, 0.08), 0.5, 6)),
)
write(os.path.join(pro, "05-door-open-during-exit-delay.wav"), cat(note(659, 0.15), note(523, 0.3), silence(0.3)))
write(os.path.join(pro, "06-armed.wav"), cat(note(784, 0.12), note(523, 0.12), note(392, 0.3), silence(0.3)))
write(os.path.join(pro, "07-arm-blocked-door-open.wav"), cat(repeat_every(note(330, 0.12), 0.2, 3), silence(0.3)))
# Entry delay: double beep each second, then faster for the final seconds.
pair = cat(note(880, 0.09), silence(0.08), note(880, 0.09))
write(os.path.join(pro, "08-entry-delay-countdown.wav"), cat(repeat_every(pair, 1.0, 4), repeat_every(pair, 0.5, 6)))
write(os.path.join(pro, "09-disarm-success.wav"), cat(note(523, 0.09), note(659, 0.09), note(784, 0.3), silence(0.3)))
# Errors use the same soft timbre as everything else (a square buzz sounded like a different product): low, flat, repeated = "no".
write(os.path.join(pro, "10-wrong-pin.wav"), cat(note(262, 0.16, 0.14), silence(0.08), note(262, 0.16, 0.14), silence(0.3)))
write(os.path.join(pro, "11-lockout.wav"), cat(repeat_every(note(196, 0.3, 0.16), 0.42, 3), silence(0.3)))
# Siren notes use constant gain (no decay), so they need their own renderer.
def flat(freq, dur, g, f_end):
    n = int(SR * dur)
    ph = 0.0
    out = []
    for i in range(n):
        f = freq + (f_end - freq) * (i / n)
        ph += 2 * math.pi * f / SR
        v = (math.sin(ph) + 0.35 * math.sin(2 * ph) + 0.12 * math.sin(3 * ph)) / 1.47
        fade = min(1.0, i / (SR * 0.01), (n - i) / (SR * 0.01))
        out.append(v * g * fade)
    return out
wail = []
for _ in range(4):
    wail += flat(650, 0.7, 0.3, 1350) + flat(1350, 0.7, 0.3, 650)
write(os.path.join(pro, "12-alarm-A-wail.wav"), wail)  # reference: liked over today's, "still not ideal"
# C: yelp — fast rising sweeps, urgent.
yelp = []
for _ in range(14):
    yelp += flat(600, 0.22, 0.3, 1500)
write(os.path.join(pro, "13-alarm-C-yelp.wav"), yelp)
# D: piezo pulse — the classic security-panel beep-beep-beep, ~3 kHz, cuts through a room.
def pulse(f, on, off, n, g=0.3):
    return cat(*([flat(f, on, g, f) + silence(off)] * n))
write(os.path.join(pro, "14-alarm-D-piezo-pulse.wav"), pulse(2900, 0.16, 0.12, 18))
# E: two alternating tones in fast pulses (hi-lo, but gated) — easier on the ears than C, more urgent than A.
hl = []
for i in range(10):
    hl += flat(1000 if i % 2 == 0 else 1500, 0.22, 0.3, 1000 if i % 2 == 0 else 1500) + silence(0.06)
write(os.path.join(pro, "15-alarm-E-gated-hi-lo.wav"), hl)

# E variants: each changes ONE thing vs E (1000/1500 Hz, 0.22s on, 0.06s off, full-harmonic timbre).
def gated(fa, fb, on, off, n, g=0.3, sine=False):
    out = []
    for i in range(n):
        f = fa if i % 2 == 0 else fb
        out += (sine_flat(f, on, g) if sine else flat(f, on, g, f)) + silence(off)
    return out
def sine_flat(f, dur, g):
    n = int(SR * dur)
    return [math.sin(2 * math.pi * f * i / SR) * g * min(1.0, i / (SR * 0.01), (n - i) / (SR * 0.01)) for i in range(n)]
# E1: lower and less shrill (800/1100).
write(os.path.join(pro, "16-alarm-E1-lower.wav"), gated(800, 1100, 0.22, 0.06, 10))
# E2: slower and rounder (0.35s on, 0.1s off) - less frantic.
write(os.path.join(pro, "17-alarm-E2-slower.wav"), gated(1000, 1500, 0.35, 0.1, 7))
# E3: three-note rising phrase then a pause (repeat) - reads as a pattern, gives the ear a rest.
phrase = cat(flat(800, 0.18, 0.3, 800), silence(0.05), flat(1000, 0.18, 0.3, 1000), silence(0.05), flat(1250, 0.3, 0.3, 1250), silence(0.45))
write(os.path.join(pro, "18-alarm-E3-rising-phrase.wav"), cat(*([phrase] * 4)))
# E4: E with pure sine tones (no harmonics) - smoother, less buzzy.
write(os.path.join(pro, "19-alarm-E4-pure.wav"), gated(1000, 1500, 0.22, 0.06, 10, g=0.35, sine=True))

# ------------------------------------------------- shipped panel sounds ---
# The approved picks, one file per event, played by public/panel.js. The
# countdown sounds are a single beat: panel.js repeats them once a second
# (twice a second near the end). The alarm is alarm E2, looped.
ship = os.path.join(ROOT, "public", "sounds")
write(os.path.join(ship, "key.wav"), note(1000, 0.05, 0.08))
write(os.path.join(ship, "backspace.wav"), note(600, 0.05, 0.08))
write(os.path.join(ship, "arm-confirmed.wav"), cat(note(523, 0.12), note(784, 0.22)))
write(os.path.join(ship, "exit-beep.wav"), note(700, 0.08))
write(os.path.join(ship, "door.wav"), cat(note(659, 0.15), note(523, 0.3)))
write(os.path.join(ship, "armed.wav"), cat(note(784, 0.12), note(523, 0.12), note(392, 0.3)))
write(os.path.join(ship, "arm-refused.wav"), repeat_every(note(330, 0.12), 0.2, 3))
write(os.path.join(ship, "entry-beep.wav"), pair)
write(os.path.join(ship, "disarm.wav"), cat(note(523, 0.09), note(659, 0.09), note(784, 0.3)))
write(os.path.join(ship, "wrong-pin.wav"), cat(note(262, 0.16, 0.14), silence(0.08), note(262, 0.16, 0.14)))
write(os.path.join(ship, "lockout.wav"), repeat_every(note(196, 0.3, 0.16), 0.42, 3))
write(os.path.join(ship, "alarm.wav"), gated(1000, 1500, 0.35, 0.1, 7))

print("wrote", OUT)
