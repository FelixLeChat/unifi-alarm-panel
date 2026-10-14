import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("lets a type-scale size replace a component's own size", () => {
    expect(cn("text-sm font-mono", "text-eyebrow-s")).toBe("font-mono text-eyebrow-s");
    expect(cn("text-base", "text-title-xs")).toBe("text-title-xs");
  });

  it("keeps a size and a colour side by side", () => {
    expect(cn("text-sm text-muted-foreground", "text-body-xs")).toBe("text-muted-foreground text-body-xs");
    expect(cn("text-body-xs", "text-foreground")).toBe("text-body-xs text-foreground");
  });

  it("still merges plain Tailwind conflicts", () => {
    expect(cn("px-3 py-1", "px-4")).toBe("py-1 px-4");
  });
});
