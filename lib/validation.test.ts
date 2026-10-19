import { describe, expect, it } from "vitest";
import { MAX_JSON_BODY_BYTES, armBodySchema, pinBodySchema, readSmallJsonBody } from "./validation";

describe("pinBodySchema", () => {
  it("accepts exactly 4 digits", () => {
    expect(pinBodySchema.safeParse({ pin: "0042" }).success).toBe(true);
  });

  it.each(["123", "12345", "12a4", " 1234", "１２３４", 1234, undefined])("rejects %j", (pin) => {
    expect(pinBodySchema.safeParse({ pin }).success).toBe(false);
  });
});

describe("armBodySchema", () => {
  it("takes an optional boolean force flag", () => {
    expect(armBodySchema.safeParse({ pin: "1234" }).success).toBe(true);
    expect(armBodySchema.safeParse({ pin: "1234", force: true }).success).toBe(true);
    expect(armBodySchema.safeParse({ pin: "1234", force: "yes" }).success).toBe(false);
  });
});

describe("readSmallJsonBody", () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/disarm", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

  it("parses a small JSON body", async () => {
    expect(await readSmallJsonBody(post('{"pin":"1234"}'))).toEqual({ pin: "1234" });
  });

  it("returns null for malformed JSON", async () => {
    expect(await readSmallJsonBody(post("{nope"))).toBeNull();
  });

  it("refuses a body over the cap, by header or by length", async () => {
    expect(await readSmallJsonBody(post("{}", { "content-length": String(MAX_JSON_BODY_BYTES + 1) }))).toBeNull();
    expect(await readSmallJsonBody(post(JSON.stringify({ pin: "x".repeat(MAX_JSON_BODY_BYTES) })))).toBeNull();
  });
});
