# Signal alerts

Alerts can go to Signal through [bbernhard/signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api), a small container that wraps `signal-cli`. It runs on your network. The app talks to it over HTTP and never to Signal directly, so no Signal host is added to the outbound list.

The container has no login of its own. Anyone who can reach it can send as your number. Keep it on the compose network or the host's loopback, never on a published LAN port.

## Run the container

With the bundled compose file, the service sits behind the `signal` profile and is off by default:

```bash
docker compose --profile signal up -d
```

It listens on `http://signal-cli:8080` inside the compose network (use that as the API URL) and on `127.0.0.1:8080` on the host. Its keys live in the `signal-cli` volume, so recreating the container keeps the number.

Without compose:

```bash
docker run -d --name signal-cli --restart=always -p 127.0.0.1:8080:8080 \
  -v signal-cli:/home/.local/share/signal-cli -e MODE=json-rpc bbernhard/signal-cli-rest-api
```

Then check it answers: `curl http://127.0.0.1:8080/v1/about` returns the version and `"mode":"json-rpc"`.

## Link or register a number

Use a number that is not your own personal one if you can: alerts then arrive from a sender your phone shows as a separate contact.

**Link as a second device** (a number already on a phone):

1. Open `http://127.0.0.1:8080/v1/qrcodelink?device_name=alarm-panel` in a browser on the host (over an SSH tunnel if the host is remote).
2. In Signal on the phone, open Settings > Linked devices, tap +, and scan the code.

**Register a number that can receive an SMS or call:**

1. Solve a captcha at `https://signalcaptchas.org/registration/generate.html`, copy the `signalcaptcha://` link.
2. `curl -X POST http://127.0.0.1:8080/v1/register/+15145550100 -H 'content-type: application/json' -d '{"captcha":"<the link without signalcaptcha://>"}'`
3. `curl -X POST http://127.0.0.1:8080/v1/register/+15145550100/verify/<code>` with the code Signal sends.

Check it: `curl http://127.0.0.1:8080/v1/accounts` lists the number. Linking by QR code worked without a restart in testing. If sending still answers `Specified account does not exist` right after linking, restart the container.

## Configure the app

Settings > Notifications > Signal:

- **API URL:** `http://signal-cli:8080` with the bundled compose file, otherwise where the container is reachable from the app.
- **Sender number:** the number you linked or registered, in international format (`+15145550100`).
- **Recipients:** comma-separated numbers (`+15145550101`) or group ids. List group ids with `curl http://127.0.0.1:8080/v1/groups/+15145550100` and use the `id` field, which starts with `group.`.

"Send test alert" sends one message through the container and says why it failed if it can't. First boot can also seed these from `SIGNAL_API_URL`, `SIGNAL_NUMBER` and `SIGNAL_RECIPIENTS`.

A snapshot goes as an attachment on the same message. If the container refuses it, the text goes out alone.
