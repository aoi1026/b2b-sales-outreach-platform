"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function WelcomeToast({ userName }: { userName: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (params.get("welcome") !== "1") return;
    setVisible(true);

    // Remove ?welcome=1 from URL without re-navigating
    const url = new URL(window.location.href);
    url.searchParams.delete("welcome");
    router.replace(url.pathname + (url.search || ""), { scroll: false });

    const dismiss = setTimeout(() => startLeave(), 4000);
    return () => clearTimeout(dismiss);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startLeave() {
    setLeaving(true);
    setTimeout(() => setVisible(false), 400);
  }

  if (!visible) return null;

  return (
    <div
      className={`fixed top-5 left-1/2 -translate-x-1/2 z-50 transition-all duration-400 ${
        leaving ? "opacity-0 -translate-y-4" : "opacity-100 translate-y-0"
      }`}
    >
      <div className="relative flex items-center gap-3 px-6 py-4 rounded-2xl shadow-2xl text-white min-w-[300px] overflow-hidden"
        style={{
          background: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 30%, #ec4899 65%, #f59e0b 100%)",
        }}
      >
        {/* animated shimmer overlay */}
        <div className="absolute inset-0 opacity-20"
          style={{
            background: "linear-gradient(90deg, transparent 0%, white 50%, transparent 100%)",
            animation: "shimmer 2s infinite",
            backgroundSize: "200% 100%",
          }}
        />
        <span className="text-2xl select-none">🎉</span>
        <div className="relative">
          <p className="font-bold text-base leading-tight">ようこそ、{userName} さん！</p>
          <p className="text-white/80 text-xs mt-0.5">SALES Studio へログインしました</p>
        </div>
        <button
          onClick={startLeave}
          className="relative ml-auto text-white/70 hover:text-white text-lg leading-none"
          aria-label="閉じる"
        >
          ×
        </button>
        {/* progress bar */}
        <div className="absolute bottom-0 left-0 h-1 rounded-b-2xl bg-white/40"
          style={{ animation: "shrink 4s linear forwards" }}
        />
      </div>
      <style>{`
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes shrink {
          from { width: 100%; }
          to { width: 0%; }
        }
      `}</style>
    </div>
  );
}
