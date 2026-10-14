import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/upload-actions", () => ({ stageUploadAction: vi.fn() }));
const { safeAction, transportError } = await import("@/lib/safe-action");

describe("A form request that fails in transport shows a message instead of crashing the page", () => {
  it("explains a page left open across a deploy, a network drop, and anything else", () => {
    expect(transportError(new Error("An unexpected response was received from the server."))).toMatch(/updated while this page was open.*Nothing was saved/);
    expect(transportError(new TypeError("Failed to fetch"))).toMatch(/Could not reach the server/);
    expect(transportError(new Error("boom"))).toMatch(/boom.*Nothing was saved/);
  });

  it("returns the action's own result, turns a thrown transport error into an error result, and lets Next's redirect through", async () => {
    expect(await safeAction(async () => ({ ok: true as const, message: "Saved" }))()).toEqual({ ok: true, message: "Saved" });
    const failed = await safeAction(async () => { throw new Error("An unexpected response was received from the server."); })();
    expect(failed).toMatchObject({ ok: false, error: expect.stringMatching(/Reload the page/) });
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/x;307;" });
    await expect(safeAction(async () => { throw redirect; })()).rejects.toBe(redirect);
  });
});
