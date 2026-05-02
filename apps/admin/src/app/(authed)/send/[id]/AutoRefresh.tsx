"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AutoRefresh({
  intervalMs = 5000,
  enabled,
}: {
  intervalMs?: number;
  enabled: boolean;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, router]);
  return null;
}
