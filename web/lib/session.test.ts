import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module keeps the token and the in-flight refresh in memory, so each test imports a
// fresh copy.
async function freshSession() {
  vi.resetModules();
  return import("./session");
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const urlOf = (call: Parameters<typeof fetch>) => String(call[0]);
const authOf = (call: Parameters<typeof fetch>) =>
  (call[1]?.headers as Record<string, string> | undefined)?.authorization;

describe("session", () => {
  it("sends one refresh however many callers ask at once", async () => {
    const session = await freshSession();
    fetchMock.mockImplementation(async () => json(200, { accessToken: "a1" }));

    const tokens = await Promise.all([
      session.refreshAccessToken(),
      session.refreshAccessToken(),
      session.currentAccessToken(),
    ]);

    expect(tokens).toEqual(["a1", "a1", "a1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.useSession.getState().status).toBe("signed_in");
  });

  it("refreshes once on a 401 and retries the call with the new token", async () => {
    const session = await freshSession();
    fetchMock
      .mockResolvedValueOnce(json(200, { accessToken: "old" })) // restore on load
      .mockResolvedValueOnce(json(401, { error: "token_expired" }))
      .mockResolvedValueOnce(json(200, { accessToken: "new" }))
      .mockResolvedValueOnce(json(200, { email: "a@example.com" }));
    await session.restoreSession();

    const me = await session.apiFetch<{ email: string }>("/me", { auth: true });

    expect(me.email).toBe("a@example.com");
    const calls = fetchMock.mock.calls;
    expect(calls.map(urlOf)).toEqual([
      "http://localhost:3000/session/refresh",
      "http://localhost:3000/me",
      "http://localhost:3000/session/refresh",
      "http://localhost:3000/me",
    ]);
    expect([authOf(calls[1]!), authOf(calls[3]!)]).toEqual(["Bearer old", "Bearer new"]);
  });

  it("is signed out when the refresh cookie is missing or spent", async () => {
    const session = await freshSession();
    // A later call tries the cookie again, since another tab may have logged in since.
    fetchMock.mockImplementation(async () => json(401, { error: "invalid_refresh_token" }));

    await session.restoreSession();

    expect(session.useSession.getState().status).toBe("signed_out");
    await expect(session.apiFetch("/me", { auth: true })).rejects.toMatchObject({
      code: "signed_out",
    });
  });

  it("reports the API as unreachable rather than signing the user out", async () => {
    const session = await freshSession();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await session.restoreSession();

    expect(session.useSession.getState().status).toBe("unreachable");
  });

  it("stays signed in when logging out fails", async () => {
    const session = await freshSession();
    fetchMock
      .mockResolvedValueOnce(json(200, { accessToken: "a1" }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    await session.restoreSession();

    await expect(session.logOut()).rejects.toThrow();

    expect(session.useSession.getState().status).toBe("signed_in");
  });
});
