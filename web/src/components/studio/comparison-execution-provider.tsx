"use client";
import { createContext, useContext, useState, useSyncExternalStore } from "react";
import { createComparisonExecutionClient } from "@/lib/studio-comparison-execution-client";
const Context = createContext<ReturnType<typeof createComparisonExecutionClient> | null>(null);
export function ComparisonExecutionProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() =>
    createComparisonExecutionClient(
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
export function useComparisonExecution() {
  const client = useContext(Context);
  if (!client) throw Error("COMPARISON_EXECUTION_PROVIDER_REQUIRED");
  return {
    client,
    state: useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot),
  };
}
