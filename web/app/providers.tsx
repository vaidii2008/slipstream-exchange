"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { restoreSession, useSession } from "@/lib/session";

export function Providers({ children }: { children: React.ReactNode }) {
  // One client per browser tab, created on first render rather than at module load, so a
  // server render never shares a cache between visitors.
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } }),
  );

  useEffect(() => {
    void restoreSession();
  }, []);

  // The next user to sign in on this tab must not see the last one's orders, even briefly.
  useEffect(
    () =>
      useSession.subscribe((state) => {
        if (state.status === "signed_out") {
          queryClient.removeQueries({ queryKey: ["account"] });
        }
      }),
    [queryClient],
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
