"use client";
import { useEffect, useRef, useState } from "react";
import type { StudioCase } from "@/lib/studio-schema";
import type { PlanConfirmation } from "./plan-confirmation";
import { jsonBody, studioFetch } from "./shared";
import {
  PlanConfirmationJournal,
  planConfirmationBrowserLock,
  planConfirmationBrowserStorage,
  planConfirmationRecoveryKey,
  planConfirmationRecoveryMessage,
  type PlanConfirmationReceipt,
} from "./plan-confirmation-recovery";

function journal(caseId: string) {
  return new PlanConfirmationJournal(
    caseId,
    planConfirmationBrowserStorage(),
    planConfirmationBrowserLock,
    (command) =>
      studioFetch<unknown>(
        `/api/studio/cases/${caseId}`,
        command ? { method: "PATCH", ...jsonBody(command) } : undefined,
      ),
  );
}
export function usePlanConfirmation(
  company: StudioCase,
  onBusyChange: (message: string) => void,
  onAccepted: (next: StudioCase) => void,
) {
  const [pending, setPending] = useState<PlanConfirmationReceipt | null>(null);
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  const flight = useRef(false),
    mounted = useRef(true);
  const current = useRef(company);
  const callbacks = useRef({ onBusyChange, onAccepted });
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
            setReadError(planConfirmationRecoveryMessage(error));
          }
        });
    };
    const changed = (event: StorageEvent) => {
      if (event.key !== null && event.key !== planConfirmationRecoveryKey(company.id)) return;
      try {
        if (event.storageArea !== planConfirmationBrowserStorage()) return;
        read();
      } catch (error) {
        setReady(false);
        setReadError(planConfirmationRecoveryMessage(error));
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
  async function perform(request?: PlanConfirmation) {
    if (flight.current || !ready || (request ? !!pending : !pending)) return;
    flight.current = true;
    setWorking(true);
    setError("");
    callbacks.current.onBusyChange(
      request
        ? "원고 검토 완료를 보관하고 있습니다"
        : "원고 검토 완료 저장 상태를 확인하고 있습니다",
    );
    const expected = pending;
    try {
      const next = request
        ? await journal(company.id).save(
            request,
            () => current.current,
            (record) => {
              if (mounted.current) setPending(record);
            },
          )
        : await journal(company.id).recover(expected!, () => current.current);
      if (mounted.current) {
        setPending(null);
        setError("");
        callbacks.current.onAccepted(next);
      }
    } catch (error) {
      if (mounted.current) setError(planConfirmationRecoveryMessage(error));
      // A failed write/readback may still have left an identity. Never send again blindly.
      try {
        const record = await journal(company.id).read();
        if (mounted.current) setPending((original) => original ?? record);
      } catch (readError) {
        if (mounted.current) {
          setReady(false);
          setReadError(planConfirmationRecoveryMessage(readError));
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
    save: (request: PlanConfirmation) => perform(request),
    inspect: () => perform(),
    reread: () => {
      if (!flight.current) {
        setError("");
        setReadAttempt((n) => n + 1);
      }
    },
  };
}
