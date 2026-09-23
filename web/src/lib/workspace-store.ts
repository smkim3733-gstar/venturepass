"use client";

import { useEffect, useSyncExternalStore } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { applicationSchema, EVIDENCE_ITEMS, type ApplicationProfile } from "@/lib/application";

type WorkspaceState = {
  profile: ApplicationProfile | null;
  checkedEvidence: string[];
  saveProfile: (profile: ApplicationProfile) => void;
  toggleEvidence: (id: string) => void;
  resetWorkspace: () => void;
};

let hydrationFinished = false;
let hydrationProblem: string | null = null;
const hydrationListeners = new Set<() => void>();
const subscribeToHydration = (callback: () => void) => {
  hydrationListeners.add(callback);
  return () => {
    hydrationListeners.delete(callback);
  };
};

function finishHydration(error?: unknown) {
  hydrationFinished = true;
  hydrationProblem = error
    ? "저장된 기록을 불러오지 못했습니다. 이 브라우저의 저장 설정을 확인하거나 기업 정보를 다시 입력해 주세요."
    : null;
  hydrationListeners.forEach((callback) => callback());
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => {
      // localStorage writes are synchronous and atomic. Restore the in-memory
      // state too when a write fails so the screen cannot imply a successful save.
      const commit = (change: Partial<Pick<WorkspaceState, "profile" | "checkedEvidence">>) => {
        const previous = get();
        try {
          set(change);
        } catch (error) {
          try {
            set({ profile: previous.profile, checkedEvidence: previous.checkedEvidence });
          } catch {
            // Zustand updates memory before persisting, so memory is restored
            // even when the browser also rejects this rollback write.
          }
          throw error;
        }
        if (hydrationProblem) finishHydration();
      };
      return {
        profile: null,
        checkedEvidence: [],
        saveProfile: (profile) => {
          const validated = applicationSchema.parse(profile);
          const changed = JSON.stringify(get().profile) !== JSON.stringify(validated);
          commit({ profile: validated, ...(changed ? { checkedEvidence: [] } : {}) });
        },
        toggleEvidence: (id) => {
          if (!get().profile || !EVIDENCE_ITEMS.some((item) => item.id === id)) return;
          const state = get();
          commit({
            checkedEvidence: state.checkedEvidence.includes(id)
              ? state.checkedEvidence.filter((value) => value !== id)
              : [...state.checkedEvidence, id],
          });
        },
        resetWorkspace: () => {
          commit({ profile: null, checkedEvidence: [] });
        },
      };
    },
    {
      name: "venture-growth-workspace-v1",
      version: 1,
      storage: createJSONStorage(() => ({
        getItem: (name) => localStorage.getItem(name),
        setItem: (name, value) => localStorage.setItem(name, value),
        removeItem: (name) => localStorage.removeItem(name),
      })),
      skipHydration: true,
      onRehydrateStorage: () => (_state, error) => finishHydration(error),
      partialize: (state) => ({ profile: state.profile, checkedEvidence: state.checkedEvidence }),
      merge: (persisted, current) => {
        if (!persisted || typeof persisted !== "object") return current;
        const saved = persisted as { profile?: unknown; checkedEvidence?: unknown };
        const parsed = applicationSchema.safeParse(saved.profile);
        const validIds = new Set(EVIDENCE_ITEMS.map((item) => item.id));
        return {
          ...current,
          profile: parsed.success ? parsed.data : null,
          checkedEvidence:
            parsed.success && Array.isArray(saved.checkedEvidence)
              ? [
                  ...new Set(
                    saved.checkedEvidence.filter(
                      (id): id is string => typeof id === "string" && validIds.has(id),
                    ),
                  ),
                ]
              : [],
        };
      },
    },
  ),
);

/** Use before showing saved client data to keep the server and first client render equal. */
export function useWorkspaceHydrated() {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => hydrationFinished,
    () => false,
  );
  useEffect(() => {
    if (!hydrationFinished) {
      Promise.resolve(useWorkspaceStore.persist.rehydrate()).catch(finishHydration);
    }
  }, []);
  return hydrated;
}

export function useWorkspaceHydrationProblem() {
  return useSyncExternalStore(
    subscribeToHydration,
    () => hydrationProblem,
    () => null,
  );
}
