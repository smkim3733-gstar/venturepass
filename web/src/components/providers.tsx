"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ComparisonReviewExampleProvider } from "@/components/studio/comparison-review-example-provider";
import { StoredComparisonProvider } from "@/components/studio/stored-comparison-provider";
import { ComparisonExecutionProvider } from "@/components/studio/comparison-execution-provider";
import { ComparisonBookingProvider } from "@/components/studio/comparison-booking-provider";
import { ComparisonCancellationProvider } from "@/components/studio/comparison-cancellation-provider";
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
      <ComparisonReviewExampleProvider>
        <StoredComparisonProvider>
          <ComparisonExecutionProvider>
            <ComparisonBookingProvider>
              <ComparisonCancellationProvider>
                <TooltipProvider>{children}</TooltipProvider>
              </ComparisonCancellationProvider>
            </ComparisonBookingProvider>
          </ComparisonExecutionProvider>
        </StoredComparisonProvider>
      </ComparisonReviewExampleProvider>
      <Toaster position="top-center" theme="light" richColors />
    </QueryClientProvider>
  );
}
