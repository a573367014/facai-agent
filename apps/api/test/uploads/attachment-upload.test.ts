import { describe, expect, it, vi } from "vitest";
import { waitForUploadResponseDelay } from "../../src/uploads/attachment-upload.js";

describe("attachment upload helpers", () => {
  it("waits for the configured upload response delay", async () => {
    vi.useFakeTimers();
    let settled = false;

    const delayPromise = waitForUploadResponseDelay(1500).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await delayPromise;
    expect(settled).toBe(true);

    vi.useRealTimers();
  });

  it("skips waiting when upload response delay is not positive", async () => {
    await expect(waitForUploadResponseDelay(0)).resolves.toBeUndefined();
    await expect(waitForUploadResponseDelay(-1)).resolves.toBeUndefined();
  });
});
