"use client";

import { useState, useMemo, useTransition } from "react";
import Link from "next/link";
import { createDeliveryJobAction } from "../actions";

type Case = {
  id: string;
  name: string;
  linkedListIds: string[];
  linkedMessageTemplateIds: string[];
  linkedSenderTemplateIds: string[];
};
type ListOption = { id: string; name: string; companyCount: number };
type MsgOption = { id: string; name: string; subject: string };
type SenderOption = { id: string; name: string; companyName: string; personName: string };

const MAX_COMPANIES = 220;

export default function NewJobClient({
  cases,
  lists,
  msgTemplates,
  senderTemplates,
}: {
  cases: Case[];
  lists: ListOption[];
  msgTemplates: MsgOption[];
  senderTemplates: SenderOption[];
}) {
  const [caseId, setCaseId] = useState("");
  const [listId, setListId] = useState("");
  const [messageTemplateId, setMessageTemplateId] = useState("");
  const [senderTemplateId, setSenderTemplateId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, startSubmit] = useTransition();

  const selectedCase = useMemo(() => cases.find((c) => c.id === caseId), [cases, caseId]);

  const recommendedLists = useMemo(() => {
    if (!selectedCase) return lists;
    const linked = lists.filter((l) => selectedCase.linkedListIds.includes(l.id));
    return linked.length > 0 ? linked : lists;
  }, [lists, selectedCase]);

  const recommendedMsgs = useMemo(() => {
    if (!selectedCase) return msgTemplates;
    const linked = msgTemplates.filter((t) =>
      selectedCase.linkedMessageTemplateIds.includes(t.id),
    );
    return linked.length > 0 ? linked : msgTemplates;
  }, [msgTemplates, selectedCase]);

  const selectedList = lists.find((l) => l.id === listId);
  const selectedMsg = msgTemplates.find((t) => t.id === messageTemplateId);
  const selectedSender = senderTemplates.find((s) => s.id === senderTemplateId);

  const canSubmit =
    !isSubmitting &&
    !!caseId &&
    !!listId &&
    !!messageTemplateId &&
    !!selectedList &&
    selectedList.companyCount > 0 &&
    selectedList.companyCount <= MAX_COMPANIES;

  const handleSubmit = (formData: FormData) => {
    if (isSubmitting) return;
    setError(null);
    startSubmit(async () => {
      try {
        await createDeliveryJobAction(formData);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  };

  return (
    <form action={handleSubmit} className="space-y-6 max-w-3xl">
      <section className="bg-white border border-gray-200 rounded p-5">
        <h2 className="text-sm font-semibold text-gray-600 mb-3">■ STEP 1. 案件選択</h2>
        <select
          name="caseId"
          value={caseId}
          onChange={(e) => setCaseId(e.target.value)}
          required
          className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
        >
          <option value="">（案件を選択）</option>
          {cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {cases.length === 0 && (
          <p className="text-xs text-red-600 mt-2">
            送信対象の案件がありません。準備中または配信中の案件を作成してください。
          </p>
        )}
      </section>

      <section className="bg-white border border-gray-200 rounded p-5">
        <h2 className="text-sm font-semibold text-gray-600 mb-3">■ STEP 2. リスト選択</h2>
        <select
          name="listId"
          value={listId}
          onChange={(e) => setListId(e.target.value)}
          required
          className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
          disabled={!caseId}
        >
          <option value="">（リストを選択）</option>
          {recommendedLists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.companyCount} 件)
            </option>
          ))}
        </select>
        {selectedList && selectedList.companyCount > MAX_COMPANIES && (
          <p className="text-xs text-red-600 mt-2">
            このリストは {selectedList.companyCount} 件あり、1ジョブ上限 {MAX_COMPANIES}{" "}
            件を超えています。
          </p>
        )}
        {selectedList && selectedList.companyCount === 0 && (
          <p className="text-xs text-red-600 mt-2">
            このリストには企業が登録されていません。
          </p>
        )}
      </section>

      <section className="bg-white border border-gray-200 rounded p-5">
        <h2 className="text-sm font-semibold text-gray-600 mb-3">■ STEP 3. テンプレート選択</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">送信文章テンプレート *</label>
            <select
              name="messageTemplateId"
              value={messageTemplateId}
              onChange={(e) => setMessageTemplateId(e.target.value)}
              required
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
              disabled={!caseId}
            >
              <option value="">（選択）</option>
              {recommendedMsgs.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              送信元テンプレート (任意 / 差出人情報)
            </label>
            <select
              name="senderTemplateId"
              value={senderTemplateId}
              onChange={(e) => setSenderTemplateId(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
            >
              <option value="">（指定しない）</option>
              {senderTemplates.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.personName} / {s.companyName})
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {selectedList && selectedMsg && (
        <section className="bg-gray-50 border border-gray-200 rounded p-5">
          <h2 className="text-sm font-semibold text-gray-600 mb-3">■ STEP 4. 確認</h2>
          <dl className="grid grid-cols-[150px_1fr] gap-y-2 text-sm">
            <dt className="text-gray-500">送信先企業数</dt>
            <dd className="font-semibold">{selectedList.companyCount} 件</dd>
            <dt className="text-gray-500">件名</dt>
            <dd>{selectedMsg.subject}</dd>
            <dt className="text-gray-500">送信元</dt>
            <dd>
              {selectedSender
                ? `${selectedSender.companyName} / ${selectedSender.personName}`
                : "（差出人情報なし — 空欄送信）"}
            </dd>
          </dl>
          <p className="text-[11px] text-gray-500 mt-3">
            ※ 成功率は対象サイトの仕様・入力制限等により変動します (目安 80〜85%)。
            BL該当先は送信直前に自動除外されます。
          </p>
        </section>
      )}

      <section className="bg-white border border-gray-200 rounded p-5">
        <h2 className="text-sm font-semibold text-gray-600 mb-3">■ メモ (任意)</h2>
        <input
          type="text"
          name="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
          placeholder="例: 2026年4月第1週配信"
          className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
        />
      </section>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={!canSubmit}
          aria-busy={isSubmitting}
          className="px-5 py-2 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] disabled:opacity-50 text-sm"
        >
          {isSubmitting ? "作成中..." : "承認して実行"}
        </button>
        <Link
          href="/send"
          className="px-5 py-2 rounded border border-gray-300 hover:bg-gray-50 text-sm"
        >
          キャンセル
        </Link>
      </div>
    </form>
  );
}
