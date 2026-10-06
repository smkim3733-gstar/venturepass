"use client";

import { createContext, useContext, useRef, useState } from "react";
import { createComparisonReviewRetainer } from "@/lib/studio-public-claim-comparison-review-retainer";
import { createComparisonReviewScreen } from "@/lib/studio-public-claim-comparison-review-screen";

type Owner = Readonly<{ retainer: ReturnType<typeof createComparisonReviewRetainer>;
  screen: ReturnType<typeof createComparisonReviewScreen> }>;
const Context = createContext<{ owner: Owner | null; open(): void } | null>(null);

/** Root-scoped strong reference for the one synthetic example. Created only by
 * an explicit event; never replaced after close, even if a receipt is unknown.
 * Route/StrictMode cleanup must not close it. Full reload durability is not provided. */
export function ComparisonReviewExampleProvider({ children }: { children: React.ReactNode }) {
  const held = useRef<Owner | null>(null);
  const [owner, setOwner] = useState<Owner | null>(null);
  function open() {
    if (held.current) return;
    const retainer = createComparisonReviewRetainer();
    const screen = createComparisonReviewScreen(retainer);
    held.current = Object.freeze({ retainer, screen });
    setOwner(held.current);
  }
  return <Context.Provider value={{ owner, open }}>{children}</Context.Provider>;
}
export function useComparisonReviewExample() {
  const value = useContext(Context);
  if (!value) throw Error("EXAMPLE_PROVIDER_MISSING");
  return value;
}
