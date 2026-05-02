import Breadcrumbs from "@/components/Breadcrumbs";
import { getCharPresets } from "@/lib/settings";
import MessageTemplateForm from "../MessageTemplateForm";

export const dynamic = "force-dynamic";

export default async function NewMessageTemplatePage() {
  const charPresets = await getCharPresets();
  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "TOP", href: "/home" },
          { label: "送信文章テンプレート", href: "/templates/message" },
          { label: "新規作成" },
        ]}
      />
      <h1 className="text-2xl font-bold mb-6">送信文章テンプレート 新規作成</h1>
      <MessageTemplateForm mode="create" charPresets={charPresets} />
    </div>
  );
}
