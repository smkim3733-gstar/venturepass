"use client";
import { createContext, useContext, useRef, useState } from "react";
import { createComparisonReviewRetainer } from "@/lib/studio-public-claim-comparison-review-retainer";
import { createComparisonReviewScreen } from "@/lib/studio-public-claim-comparison-review-screen";
type Screen = ReturnType<typeof createComparisonReviewScreen>;
const Context = createContext<{ screen: Screen | null; open(): void } | null>(null);
/** One root-owned reader across company changes/navigation. Never replaced on uncertain cleanup. */
export function StoredComparisonProvider({ children }: { children: React.ReactNode }) {
  const held = useRef<Screen | null>(null),
    [screen, setScreen] = useState<Screen | null>(null);
  function open() {
    if (held.current) return;
    held.current = createComparisonReviewScreen(createComparisonReviewRetainer());
    setScreen(held.current);
  }
  return <Context.Provider value={{ screen, open }}>{children}</Context.Provider>;
}
export function useStoredComparison() {
  const value = useContext(Context);
  if (!value) throw Error("STORED_COMPARISON_PROVIDER_MISSING");
  return value;
}
