"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

type Item = {
  href: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  milestone?: string;
};
type Group = { title?: string; items: Item[] };

const iconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const Icons = {
  home: (
    <svg {...iconProps}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />
    </svg>
  ),
  case: (
    <svg {...iconProps}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <path d="M3 13h18" />
    </svg>
  ),
  send: (
    <svg {...iconProps}>
      <path d="M22 2 11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  ),
  log: (
    <svg {...iconProps}>
      <path d="M4 5h16M4 10h16M4 15h10M4 20h10" />
    </svg>
  ),
  docText: (
    <svg {...iconProps}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  ),
  user: (
    <svg {...iconProps}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  ),
  block: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </svg>
  ),
  upload: (
    <svg {...iconProps}>
      <path d="M12 3v13" />
      <path d="M7 8l5-5 5 5" />
      <path d="M4 21h16" />
    </svg>
  ),
  list: (
    <svg {...iconProps}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 4v16" />
    </svg>
  ),
  cog: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  ),
};

const groups: Group[] = [
  {
    items: [
      { href: "/home", label: "ホーム", icon: Icons.home },
      { href: "/cases", label: "案件", icon: Icons.case },
    ],
  },
  {
    title: "フォーム送信",
    items: [
      { href: "/send", label: "自動送信", icon: Icons.send },
      { href: "/send/log", label: "自動送信ログ", icon: Icons.log },
      { href: "/templates/message", label: "送信文章テンプレート", icon: Icons.docText },
      { href: "/templates/sender", label: "送信元テンプレート", icon: Icons.user },
      { href: "/exclusions", label: "送信除外設定", icon: Icons.block },
    ],
  },
  {
    title: "会社情報",
    items: [
      { href: "/lists/import", label: "リスト取込", icon: Icons.upload },
      { href: "/lists", label: "保存済みリスト", icon: Icons.list },
    ],
  },
  {
    title: "その他",
    items: [{ href: "/settings", label: "設定", icon: Icons.cog }],
  },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-60 shrink-0 bg-[#1f2a34] text-gray-100 min-h-screen flex flex-col">
      <div className="h-16 flex items-center justify-center border-b border-white/10">
        <span className="text-xl font-bold tracking-widest">SALES Studio</span>
      </div>

      <nav className="flex-1 py-4 text-sm">
        {groups.map((g, gi) => (
          <div key={gi} className="mb-4">
            {g.title && (
              <div className="px-5 py-2 text-[11px] uppercase tracking-widest text-gray-400">
                {g.title}
              </div>
            )}
            <ul>
              {g.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const base = "block px-5 py-2.5 transition-colors";
                if (item.disabled) {
                  return (
                    <li key={item.href}>
                      <span
                        className={`${base} text-gray-500 cursor-not-allowed flex items-center justify-between`}
                        aria-disabled="true"
                        title={`${item.milestone ?? "MS3"}以降で実装予定`}
                      >
                        <span className="flex items-center gap-2.5">
                          <span className="inline-flex w-[18px] h-[18px] shrink-0 opacity-60">
                            {item.icon}
                          </span>
                          {item.label}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-300">
                          {item.milestone ?? "予定"}
                        </span>
                      </span>
                    </li>
                  );
                }
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`${base} flex items-center gap-2.5 ${
                        active
                          ? "bg-[#2b3a48] text-white border-l-4 border-[#1e5ab4] pl-4"
                          : "text-gray-200 hover:bg-white/5"
                      }`}
                    >
                      <span className="inline-flex w-[18px] h-[18px] shrink-0">{item.icon}</span>
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="p-4 text-[11px] text-gray-500 border-t border-white/10">
        © 2026 営業支援システム MVP
      </div>
    </aside>
  );
}
