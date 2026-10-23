"use client";
import { useEffect, useState } from "react";
import type { StudioCase } from "@/lib/studio-schema";
import {
  resolveGuidedProcedureDeadlines,
  type GuidedProcedureDeadlines,
} from "@/lib/studio-guided-procedure-deadlines";

export function useGuidedProcedureDeadlines(company: StudioCase) {
  const [result, setResult] = useState<GuidedProcedureDeadlines>();
  useEffect(() => {
    let active = true;
    void resolveGuidedProcedureDeadlines(company).then((resolved) => {
      if (active) setResult(resolved);
    });
    return () => {
      active = false;
    };
  }, [company]);
  return result?.company === company && result.revision === company.revision ? result : undefined;
}
