# UniFi Alarm Panel

A self-hosted alarm panel for UniFi Protect: a PIN keypad on a wall tablet, entry and exit delays, per-person PINs, a duress PIN, an audit log, and alerts to Slack, ntfy, Telegram or Signal. No monitoring subscription and no cloud service: everything runs on your LAN.

**Arming.** Tap Arm, the exit delay counts down, the panel arms.

![Tap Arm, the exit delay counts down, the panel arms](screenshots/panel-arming.gif)

**Entry delay.** A door opens while armed, the countdown runs, a PIN disarms.

![A door opens while armed, the entry delay counts down, a PIN disarms](screenshots/panel-entry-delay.gif)

**Alarm.** A sensor trips, the alarm sounds, a PIN silences and disarms.

![A sensor trips, the alarm sounds, a PIN silences and disarms](screenshots/panel-alarm.gif)

## Start here

- **[Install](INSTALL.md):** Docker Compose, one command on Proxmox VE, or systemd on a bare box.
- **[Configuration](CONFIGURATION.md):** settings, alert channels and routing, upgrade notes.
- **[UniFi integration](UNIFI.md):** how sensor events, arm state and cameras connect.
- **[Operations](OPERATIONS.md)** and the **[runbook](RUNBOOK.md):** backups, the audit log, and what to do when it alarms.

## The one design decision to understand first

Arming lives on this server, not in UniFi. UniFi's Alarm Manager is an event source and camera layer that webhooks every sensor trip to this app, which owns the armed state, the PINs, the audit log and the alert logic. See [UniFi integration](UNIFI.md).

[Source and issues on GitHub](https://github.com/FelixLeChat/unifi-alarm-panel){ .md-button }
