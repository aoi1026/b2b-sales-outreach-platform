import Breadcrumbs from "@/components/Breadcrumbs";
import CaseForm from "../CaseForm";
import { createCaseAction } from "../actions";

export default function NewCasePage() {
  return (
    <div className="max-w-3xl">
      <Breadcrumbs
        items={[
          { label: "TOP", href: "/home" },
          { label: "案件一覧", href: "/cases" },
          { label: "新規案件" },
        ]}
      />
      <h1 className="text-2xl font-bold mb-6">案件登録</h1>
      <CaseForm action={createCaseAction} />
    </div>
  );
}
