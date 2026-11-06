// The browser side of a session, and every call to the API.
//
// The access token lives only in this module's memory, never in localStorage, where any
// script that ends up on the page could read it. A reload therefore starts with no token, and
// the first thing the app does is trade the refresh cookie for a new one. That cookie is
// httpOnly, so no script can read it either; only the browser sends it, and only to
// /session on the API.
//
// The API rotates the refresh token on every use and treats a second use of the same one as
// theft, revoking the whole family. So two refreshes must never race with the same cookie:
// within a tab they share one in-flight request, and across tabs they take turns under a Web
// Lock, so the second one sends the cookie the first one just received.

import { create } from "zustand";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export type SessionStatus = "checking" | "signed_in" | "signed_out" | "unreachable";

export const useSession = create<{ status: SessionStatus }>(() => ({ status: "checking" }));

export type FieldIssue = { field: string; message: string };

// A non-2xx answer from the API, carrying its error code ("invalid_credentials").
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: FieldIssue[];

  constructor(status: number, code: string, message: string, issues: FieldIssue[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

type ErrorBody = { error?: string; message?: string; issues?: FieldIssue[] };

async function apiError(response: Response): Promise<ApiError> {
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // Not JSON, for example a proxy's HTML error page; the status alone says enough.
  }
  const code = body.error ?? "http_error";
  return new ApiError(response.status, code, body.message ?? code, body.issues);
}

let accessToken: string | undefined;
let refreshing: Promise<string | undefined> | undefined;

function signIn(token: string): void {
  accessToken = token;
  useSession.setState({ status: "signed_in" });
}

function signOut(): void {
  accessToken = undefined;
  useSession.setState({ status: "signed_out" });
}

const REFRESH_LOCK = "slipstream:refresh";

async function acrossTabs<T>(work: () => Promise<T>): Promise<T> {
  // Web Locks are in every current browser; without them, a tab still refreshes alone.
  if (typeof navigator === "undefined" || navigator.locks === undefined) {
    return work();
  }
  // Typed as a promise of the callback's promise; awaiting it gives the value, as at runtime.
  return await navigator.locks.request(REFRESH_LOCK, work);
}

async function requestRefresh(): Promise<string | undefined> {
  const response = await fetch(`${API_URL}/session/refresh`, {
    method: "POST",
    credentials: "include",
  });
  if (response.status === 401) {
    signOut();
    return undefined;
  }
  if (!response.ok) {
    throw await apiError(response);
  }
  const { accessToken: token } = (await response.json()) as { accessToken: string };
  signIn(token);
  return token;
}

// A new access token from the refresh cookie, or undefined if there is no session. Callers
// that arrive while a refresh is running get that refresh's result.
export function refreshAccessToken(): Promise<string | undefined> {
  refreshing ??= acrossTabs(requestRefresh).finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

// Run once when the app loads: is there a session behind the cookie?
export async function restoreSession(): Promise<void> {
  try {
    await refreshAccessToken();
  } catch {
    useSession.setState({ status: "unreachable" });
  }
}

// The token to use now, refreshing only if there is none in memory.
export async function currentAccessToken(): Promise<string | undefined> {
  return accessToken ?? refreshAccessToken();
}

type CallOptions = {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  // Send the access token, and on a 401 refresh it once and retry.
  auth?: boolean;
};

export async function apiFetch<T>(
  path: string,
  { method = "GET", body, auth = false }: CallOptions = {},
): Promise<T> {
  const send = (token: string | undefined) =>
    fetch(`${API_URL}${path}`, {
      method,
      credentials: "include",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let token = auth ? await currentAccessToken() : undefined;
  if (auth && token === undefined) {
    throw new ApiError(401, "signed_out", "log in to do this");
  }
  let response = await send(token);

  // The API checks the token before doing anything else, so retrying after a 401 cannot
  // repeat a side effect. If another call refreshed meanwhile, its token is used as is.
  if (auth && response.status === 401) {
    token = accessToken !== token ? accessToken : await refreshAccessToken();
    if (token === undefined) {
      throw new ApiError(401, "signed_out", "your session ended, log in again");
    }
    response = await send(token);
  }

  if (!response.ok) {
    throw await apiError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function logIn(email: string, password: string): Promise<void> {
  const { accessToken: token } = await apiFetch<{ accessToken: string }>("/login", {
    method: "POST",
    body: { email, password },
  });
  signIn(token);
}

export async function register(email: string, password: string): Promise<void> {
  await apiFetch("/register", { method: "POST", body: { email, password } });
  await logIn(email, password);
}

// Signed out only once the API has revoked the session: if the call fails, the cookie still
// works and a reload would sign the user straight back in, so the caller shows the error.
export async function logOut(): Promise<void> {
  await apiFetch("/session/logout", { method: "POST" });
  signOut();
}
