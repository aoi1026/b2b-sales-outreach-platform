import Breadcrumbs from "@/components/Breadcrumbs";
import SenderTemplateForm from "../SenderTemplateForm";

export const dynamic = "force-dynamic";

export default function NewSenderTemplatePage() {
  return (
    <div>
      <Breadcrumbs
        items={[
          { label: "TOP", href: "/home" },
          { label: "送信元テンプレート", href: "/templates/sender" },
          { label: "新規作成" },
        ]}
      />
      <h1 className="text-2xl font-bold mb-6">送信元テンプレート 新規作成</h1>
      <SenderTemplateForm mode="create" />
    </div>
  );
}
