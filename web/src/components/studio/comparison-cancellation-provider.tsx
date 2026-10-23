"use client";
import { createContext, useContext, useState, useSyncExternalStore } from "react";
import { createCancellationClient } from "@/lib/studio-comparison-cancellation-client";
const Context = createContext<ReturnType<typeof createCancellationClient> | null>(null);
export function ComparisonCancellationProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() =>
    createCancellationClient(
      {
        getItem: (key) => window.sessionStorage.getItem(key),
        setItem: (key, value) => window.sessionStorage.setItem(key, value),
        removeItem: (key) => window.sessionStorage.removeItem(key),
      },
      (...args) => window.fetch(...args),
    ),
  );
  return <Context.Provider value={client}>{children}</Context.Provider>;
}
export function useComparisonCancellation() {
  const client = useContext(Context);
  if (!client) throw Error("CANCELLATION_PROVIDER_REQUIRED");
  return {
    client,
    state: useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot),
  };
}
