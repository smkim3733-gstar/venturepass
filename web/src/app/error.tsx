"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg py-24 text-center">
      <h1 className="text-xl font-bold">화면을 불러오지 못했습니다</h1>
      <p className="mt-3 text-sm text-muted-foreground">잠시 후 다시 시도해 주세요.</p>
      <Button className="mt-6" onClick={reset}>
        다시 시도
      </Button>
    </div>
  );
}
