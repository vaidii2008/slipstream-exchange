"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { apiFetch, logOut, useSession } from "@/lib/session";

type Me = { id: string; email: string };

export function SessionMenu() {
  const status = useSession((state) => state.status);
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<Me>("/me", { auth: true }),
    enabled: status === "signed_in",
  });
  const logout = useMutation({ mutationFn: logOut });

  if (status === "checking") {
    return <span className="text-sm text-muted-foreground">Checking session…</span>;
  }
  if (status === "unreachable") {
    return <span className="text-sm text-destructive">API unreachable</span>;
  }
  if (status === "signed_out") {
    return (
      <nav className="flex items-center gap-3 text-sm">
        <Link href="/login" className="underline">
          Log in
        </Link>
        <Link href="/register" className="underline">
          Register
        </Link>
      </nav>
    );
  }
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-muted-foreground">{me.data?.email ?? "…"}</span>
      {logout.isError ? <span className="text-destructive">Log out failed, try again</span> : null}
      <Button
        variant="outline"
        size="sm"
        disabled={logout.isPending}
        onClick={() => logout.mutate()}
      >
        Log out
      </Button>
    </div>
  );
}
