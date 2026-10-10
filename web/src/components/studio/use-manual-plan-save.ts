"use client";
import { useEffect, useRef, useState } from "react";
import type { StudioCase } from "@/lib/studio-schema";
import type { ManualPlanSave } from "./manual-plan-save";
import { jsonBody, studioFetch } from "./shared";
import {
  ManualPlanJournal,
  manualPlanBrowserLock,
  manualPlanBrowserStorage,
  manualPlanRecoveryKey,
  manualPlanRecoveryMessage,
  type ManualPlanReceipt,
} from "./manual-plan-recovery";

function journal(caseId: string) {
  return new ManualPlanJournal(
    caseId,
    manualPlanBrowserStorage(),
    manualPlanBrowserLock,
    (command) =>
      studioFetch<unknown>(
        `/api/studio/cases/${caseId}`,
        command ? { method: "PATCH", ...jsonBody(command) } : undefined,
      ),
  );
}
export function useManualPlanSave(
  company: StudioCase,
  onBusyChange: (message: string) => void,
  onAccepted: (next: StudioCase, ownEdit: boolean) => void,
) {
  const [pending, setPending] = useState<ManualPlanReceipt | null>(null);
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  const flight = useRef(false),
    mounted = useRef(true);
  const current = useRef(company);
  const callbacks = useRef({ onBusyChange, onAccepted });
  const own = useRef<ManualPlanReceipt | null>(null);
  useEffect(() => {
    current.current = company;
    callbacks.current = { onBusyChange, onAccepted };
  }, [company, onBusyChange, onAccepted]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (working) return;
    let cancelled = false,
      generation = 0;
    const read = () => {
      const started = ++generation;
      setReady(false);
      void Promise.resolve()
        .then(() => journal(company.id).read())
        .then((record) => {
          if (!cancelled && started === generation) {
            setPending((original) => original ?? record);
            setReady(true);
            setReadError("");
          }
        })
        .catch((error) => {
          if (!cancelled && started === generation) {
            setReady(false);
            setReadError(manualPlanRecoveryMessage(error));
          }
        });
    };
    const changed = (event: StorageEvent) => {
      if (event.key !== null && event.key !== manualPlanRecoveryKey(company.id)) return;
      try {
        if (event.storageArea !== manualPlanBrowserStorage()) return;
        read();
      } catch (error) {
        setReady(false);
        setReadError(manualPlanRecoveryMessage(error));
      }
    };
    window.addEventListener("storage", changed);
    void Promise.resolve().then(() => {
      if (!cancelled) read();
    });
    return () => {
      cancelled = true;
      window.removeEventListener("storage", changed);
    };
  }, [company.id, working, readAttempt]);
  async function perform(request?: ManualPlanSave) {
    if (flight.current || !ready || (request ? !!pending : !pending)) return;
    flight.current = true;
    setWorking(true);
    setError("");
    callbacks.current.onBusyChange(
      request ? "수정본을 보관하고 있습니다" : "수정본 저장 상태를 확인하고 있습니다",
    );
    const expected = pending;
    try {
      const next = request
        ? await journal(company.id).save(
            request,
            () => current.current,
            (record) => {
              own.current = record;
              if (mounted.current) setPending(record);
            },
          )
        : await journal(company.id).recover(expected!, () => current.current);
      if (mounted.current) {
        const ownEdit = !!request || JSON.stringify(own.current) === JSON.stringify(expected);
        setPending(null);
        setError("");
        own.current = null;
        callbacks.current.onAccepted(next, ownEdit);
      }
    } catch (error) {
      if (mounted.current) setError(manualPlanRecoveryMessage(error));
      // A failed write/readback may still have left an identity. Never send again blindly.
      try {
        const record = await journal(company.id).read();
        if (mounted.current) setPending((original) => original ?? record);
      } catch (readError) {
        if (mounted.current) {
          setReady(false);
          setReadError(manualPlanRecoveryMessage(readError));
        }
      }
    } finally {
      flight.current = false;
      if (mounted.current) {
        setWorking(false);
        callbacks.current.onBusyChange("");
      }
    }
  }
  return {
    pending,
    ready,
    working,
    error: readError || error,
    save: (request: ManualPlanSave) => perform(request),
    inspect: () => perform(),
    reread: () => {
      if (!flight.current) {
        setError("");
        setReadAttempt((n) => n + 1);
      }
    },
  };
}
