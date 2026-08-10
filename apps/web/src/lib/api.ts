/** Thin fetch wrapper: base URL + JWT header + normalized error messages. */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function wsUrl(token: string): string {
  return `${API_URL.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
}

const TOKEN_KEY = "fs_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  const token = opts.token !== undefined ? opts.token : getToken();
  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      setToken(null);
      if (!window.location.pathname.startsWith("/login")) window.location.assign("/login");
    }
    throw new ApiError(
      res.status,
      json?.error?.code ?? "ERROR",
      json?.error?.message ?? `Request failed (${res.status})`,
    );
  }
  return json as T;
}
