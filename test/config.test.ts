import { describe, expect, it } from "vitest";
import { shouldRefreshStoredToken } from "../src/config.js";

describe("token config", () => {
  it("refreshes stored device-login tokens near expiry", () => {
    const now = Date.parse("2026-05-28T12:00:00.000Z");

    expect(
      shouldRefreshStoredToken(
        {
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: "2026-05-28T12:04:59.000Z",
        },
        now,
      ),
    ).toBe(true);
    expect(
      shouldRefreshStoredToken(
        {
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: "2026-05-28T12:06:00.000Z",
        },
        now,
      ),
    ).toBe(false);
    expect(
      shouldRefreshStoredToken(
        {
          accessToken: "access",
          refreshToken: "refresh",
        },
        now,
      ),
    ).toBe(true);
  });

  it("does not refresh stored manual tokens without a refresh token", () => {
    expect(
      shouldRefreshStoredToken({
        accessToken: "api-key",
        expiresAt: "2026-05-28T12:00:00.000Z",
      }),
    ).toBe(false);
  });
});
