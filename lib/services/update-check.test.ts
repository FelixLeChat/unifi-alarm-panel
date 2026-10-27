import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

import { readFileSync } from "node:fs";

const readFileSyncMock = readFileSync as unknown as ReturnType<typeof vi.fn>;

describe("checkForUpdate", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    readFileSyncMock.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete globalThis.__uapUpdateStatus;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fsError(code: string): NodeJS.ErrnoException {
    const err = new Error(code) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  }

  it("checks anonymously when the github-token file is missing", async () => {
    readFileSyncMock.mockImplementation(() => {
      throw fsError("ENOENT");
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ tag_name: "v1.0.0", published_at: "2026-01-01T00:00:00Z" }],
    });
    const { checkForUpdate, getUpdateStatus } = await import("./update-check");
    await checkForUpdate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
    const status = getUpdateStatus();
    expect(status.error).toBeNull();
    expect(status.latestVersion).toBe("v1.0.0");
  });

  // A file that exists but isn't readable by the service's user (e.g. left
  // root:root while the service runs as `uap` — see deploy/bootstrap.sh)
  // looks identical to "missing" from readFileSync's boolean success/failure,
  // but is a totally different fix (chown, not provisioning). Surface it
  // distinctly instead of the generic "no GitHub token" message, which sent
  // a real debugging session down the wrong path.
  it("surfaces a distinct error when the token file exists but isn't readable", async () => {
    readFileSyncMock.mockImplementation(() => {
      throw fsError("EACCES");
    });
    const { checkForUpdate, getUpdateStatus } = await import("./update-check");
    await checkForUpdate();
    expect(fetchMock).not.toHaveBeenCalled();
    const status = getUpdateStatus();
    expect(status.error).toContain("can't read");
    expect(status.error).toContain("EACCES");
    expect(status.error).not.toContain("no GitHub token");
  });

  it("flags updateAvailable when the latest release tag differs from the running version", async () => {
    readFileSyncMock.mockImplementation((path: string) =>
      String(path).includes("github-token") ? "gh-token" : "v1.0.0",
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ tag_name: "v1.1.0", published_at: "2026-01-01T00:00:00Z" }],
    });
    const { checkForUpdate, getUpdateStatus } = await import("./update-check");
    await checkForUpdate();
    const status = getUpdateStatus();
    expect(status.latestVersion).toBe("v1.1.0");
    expect(status.updateAvailable).toBe(true);
  });

  /**
   * GitHub's releases list endpoint does not reliably return newest-first —
   * confirmed against the real repo: with rc.9/rc.10/rc.11 all published,
   * `releases?per_page=1` returned rc.9 (published earliest of the three)
   * as element 0. This mocks that exact shape of out-of-order response and
   * asserts the fix (compare published_at explicitly) picks rc.11, not
   * whatever the API happened to put first.
   */
  it("picks the release with the latest published_at, not whichever the API lists first", async () => {
    readFileSyncMock.mockImplementation((path: string) =>
      String(path).includes("github-token") ? "gh-token" : "v1.0.0-rc.9",
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { tag_name: "v1.0.0-rc.9", published_at: "2026-09-02T15:57:06Z" },
        { tag_name: "v1.0.0-rc.8", published_at: "2026-09-02T14:42:08Z" },
        { tag_name: "v1.0.0-rc.7", published_at: "2026-09-02T13:27:43Z" },
        { tag_name: "v1.0.0-rc.11", published_at: "2026-09-02T18:00:34Z" },
        { tag_name: "v1.0.0-rc.10", published_at: "2026-09-02T16:51:10Z" },
      ],
    });
    const { checkForUpdate, getUpdateStatus } = await import("./update-check");
    await checkForUpdate();
    const status = getUpdateStatus();
    expect(status.latestVersion).toBe("v1.0.0-rc.11");
    expect(status.updateAvailable).toBe(true);
  });

  it("records an error and leaves updateAvailable false on a failed API call", async () => {
    readFileSyncMock.mockReturnValue("gh-token");
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const { checkForUpdate, getUpdateStatus } = await import("./update-check");
    await checkForUpdate();
    const status = getUpdateStatus();
    expect(status.error).not.toBeNull();
    expect(status.updateAvailable).toBe(false);
  });

  /**
   * instrumentation.ts (the scheduler caller) and a route handler (the
   * status reader) end up in separate Turbopack/webpack bundles, so a
   * plain module-scoped variable gives each its own copy — status written
   * by one is invisible to the other. Simulate that split with
   * vi.resetModules() between the write and the read to prove the
   * globalThis-backed status survives it. See the matching test in
   * connectivity-watchdog.test.ts.
   */
  it("survives a fresh module import, simulating instrumentation.ts's separate bundle", async () => {
    readFileSyncMock.mockImplementation((path: string) =>
      String(path).includes("github-token") ? "gh-token" : "v1.0.0",
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ tag_name: "v1.1.0", published_at: "2026-01-01T00:00:00Z" }],
    });
    const writer = await import("./update-check");
    await writer.checkForUpdate();

    vi.resetModules();
    const reader = await import("./update-check");
    expect(reader.getUpdateStatus().latestVersion).toBe("v1.1.0");
  });
});
