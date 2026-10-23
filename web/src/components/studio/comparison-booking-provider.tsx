"use client";
import { createContext, useContext, useState, useSyncExternalStore } from "react";
import { createBookingClient } from "@/lib/studio-comparison-booking-client";
const Context = createContext<ReturnType<typeof createBookingClient> | null>(null);
export function ComparisonBookingProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() =>
    createBookingClient(
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
export function useComparisonBooking() {
  const client = useContext(Context);
  if (!client) throw Error("BOOKING_PROVIDER_REQUIRED");
  return {
    client,
    state: useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot),
  };
}
