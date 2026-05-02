"use client";

import { useRouter } from "next/navigation";

export default function Header({ userName }: { userName: string }) {
  const router = useRouter();

  async function onLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6">
      <div className="text-sm text-gray-500">
        <span className="inline-block px-3 py-1 rounded bg-gray-100 border border-gray-200">MVP</span>
      </div>
      <div className="flex items-center gap-4 text-sm">
        <span className="font-semibold">{userName}</span>
        <span className="text-gray-500">でログイン中</span>
        <button
          onClick={onLogout}
          className="px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 text-gray-700"
        >
          ログアウト
        </button>
      </div>
    </header>
  );
}
