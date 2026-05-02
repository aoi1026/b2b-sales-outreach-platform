import Breadcrumbs from "@/components/Breadcrumbs";
import ImportClient from "./ImportClient";

export const dynamic = "force-dynamic";

export default function ListImportPage() {
  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "TOP", href: "/home" },
          { label: "保存済みリスト", href: "/lists" },
          { label: "リスト取込" },
        ]}
      />
      <h1 className="text-2xl font-bold mb-2">リスト取込</h1>
      <p className="text-sm text-gray-600 mb-6">
        CSV ファイルから会社リストを取り込みます。重複・ブラックリスト該当行は自動的に除外されます。
      </p>
      <ImportClient />
    </div>
  );
}
