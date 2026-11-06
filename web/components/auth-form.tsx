"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, logIn, register } from "@/lib/session";

const MESSAGES: Record<string, string> = {
  invalid_credentials: "That email and password do not match an account.",
  email_already_registered: "An account with that email already exists. Log in instead.",
};

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    const issue = error.issues[0];
    if (issue !== undefined) {
      return `${issue.field}: ${issue.message}`;
    }
    return MESSAGES[error.code] ?? error.message;
  }
  return "Could not reach the exchange. Is the API running?";
}

// The login and register pages differ only in which call they make and where they link.
export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  async function submit(form: FormData) {
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    setPending(true);
    setError(undefined);
    try {
      await (mode === "login" ? logIn : register)(email, password);
      router.push("/");
    } catch (caught) {
      setError(describe(caught));
      setPending(false);
    }
  }

  const title = mode === "login" ? "Log in" : "Create an account";
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form action={submit} className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={mode === "register" ? 8 : undefined}
            required
          />
        </div>
        {error === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Working…" : title}
        </Button>
        <p className="text-sm text-muted-foreground">
          {mode === "login" ? (
            <>
              No account?{" "}
              <Link href="/register" className="underline">
                Register
              </Link>
            </>
          ) : (
            <>
              Have an account?{" "}
              <Link href="/login" className="underline">
                Log in
              </Link>
            </>
          )}
        </p>
      </form>
    </main>
  );
}
