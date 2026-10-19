import { describe, expect, it } from "vitest";
import { armBodySchema, pinBodySchema } from "./validation";

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
