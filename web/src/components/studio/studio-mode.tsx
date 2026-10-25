"use client";

import { createContext, useContext, type ReactNode } from "react";

/** True on the shared web service, where PC-only features (벤처인, OCR, ZIP, quality) are off. */
const ServerModeContext = createContext(false);

export function StudioModeProvider({
  serverMode,
  children,
}: {
  serverMode: boolean;
  children: ReactNode;
}) {
  return <ServerModeContext.Provider value={serverMode}>{children}</ServerModeContext.Provider>;
}

export function useServerMode() {
  return useContext(ServerModeContext);
}

/** Shown where a PC-only feature would otherwise be. */
export function PcOnlyNotice({ feature }: { feature: string }) {
  return (
    <p className="rounded-xl border bg-muted/30 p-4 text-sm leading-6 text-muted-foreground">
      {feature}은(는) 이 PC 앱에서만 제공합니다. 웹 서비스에서는 자료·계획서·진행 관리를 이용해
      주세요.
    </p>
  );
}
