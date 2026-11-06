"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { restoreSession } from "@/lib/session";

export function Providers({ children }: { children: React.ReactNode }) {
  // One client per browser tab, created on first render rather than at module load, so a
  // server render never shares a cache between visitors.
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } }),
  );

  useEffect(() => {
    void restoreSession();
  }, []);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
