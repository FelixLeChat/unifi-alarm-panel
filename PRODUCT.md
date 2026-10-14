# Product

## Users

The people who use one site (an office, a shop, a home), and the people who administer its alarm. Users know their own PIN and nothing else about the system. Admins know UniFi and the site's layout.

## What they do here

Users: leave and arm the system with one tap at the door panel, come back and disarm it with their PIN (a duress PIN disarms the same way and must look identical).

Admins: set up the console connection and alert channels, see whether the system is armed, check which doors are open, read the audit log and sensor events, add and revoke PINs, change entry and exit delays, classify sensors (delayed, instant, ignored), look at a camera when a sensor trips.

## Where and when

The panel (`/panel`) is a wall-mounted tablet, always on, glanced at and tapped in seconds, often by someone leaving in a hurry. The admin UI (`/admin`) is a desktop browser, opened when an alarm fires or when someone gets or loses access.

## Constraints

English. LAN only: no cloud services, no telemetry, the kiosk never calls out. The panel supports iOS 12 and old Safari, so it stays plain CSS and one script, with no React or Tailwind. PINs are never shown or logged, and a duress PIN is never distinguishable in the UI, an API response, the sounds or the audit log.

## Evidence

None. The interface shows live state from the server and the audit log. It carries no metrics, customer names or marketing claims.
