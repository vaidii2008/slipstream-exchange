"use client";

import { useEffect } from "react";
import { marketSocket, useConnection } from "@/lib/socket";

const LABELS = { connecting: "Connecting", open: "Live", reconnecting: "Reconnecting" } as const;

export function ConnectionStatus() {
  const status = useConnection((state) => state.status);

  useEffect(() => {
    marketSocket();
  }, []);

  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
      <span
        className={`size-2 rounded-full ${status === "open" ? "bg-emerald-500" : "animate-pulse bg-amber-500"}`}
      />
      {LABELS[status]}
    </span>
  );
}
