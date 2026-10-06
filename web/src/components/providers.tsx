"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ComparisonReviewExampleProvider } from "@/components/studio/comparison-review-example-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <ComparisonReviewExampleProvider><TooltipProvider>{children}</TooltipProvider></ComparisonReviewExampleProvider>
      <Toaster position="top-center" theme="light" richColors />
    </QueryClientProvider>
  );
}
