import Link from "next/link";
import { Button } from "@/components/ui/button";
export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg py-24 text-center">
      <p className="text-sm font-semibold text-primary">404</p>
      <h1 className="mt-4 text-2xl font-bold">페이지를 찾을 수 없습니다</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        주소를 확인하거나 워크스페이스로 돌아가세요.
      </p>
      <Button asChild className="mt-8">
        <Link href="/">한눈에 보기로 이동</Link>
      </Button>
    </div>
  );
}
