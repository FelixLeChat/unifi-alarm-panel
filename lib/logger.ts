import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Defense in depth: nothing currently logs these, but a future call site
  // that does (e.g. logging a request object) shouldn't leak PINs/secrets.
  redact: {
    paths: [
      "pin",
      "code",
      "*.pin",
      "*.code",
      'req.headers."x-admin-token"',
      'req.headers."x-alarm-secret"',
      '*.headers."x-admin-token"',
      '*.headers."x-alarm-secret"',
    ],
    censor: "[redacted]",
  },
});
