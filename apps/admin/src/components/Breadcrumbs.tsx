import Link from "next/link";

export type Crumb = { label: string; href?: string };

export default function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="text-sm text-gray-500 mb-4" aria-label="Breadcrumb">
      <ol className="flex items-center gap-1 flex-wrap">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className="flex items-center gap-1">
              {item.href && !last ? (
                <Link href={item.href} className="hover:text-[#1e5ab4]">
                  {item.label}
                </Link>
              ) : (
                <span className={last ? "text-gray-800 font-medium" : ""}>{item.label}</span>
              )}
              {!last && <span className="mx-1 text-gray-300">›</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
