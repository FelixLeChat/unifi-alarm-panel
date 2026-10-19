import { describe, expect, it } from "vitest";
import { safeEqual } from "./safe-equal";

describe("safeEqual", () => {
  it("matches identical strings", () => {
    expect(safeEqual("secret", "secret")).toBe(true);
    expect(safeEqual("", "")).toBe(true);
  });

  it("rejects different strings, including a prefix or a different length", () => {
    expect(safeEqual("secret", "secreT")).toBe(false);
    expect(safeEqual("secret", "secre")).toBe(false);
    expect(safeEqual("secret", "secret ")).toBe(false);
  });

  it("compares bytes, not code points", () => {
    expect(safeEqual("é", "é")).toBe(true);
    expect(safeEqual("é", "é")).toBe(false);
  });
});
