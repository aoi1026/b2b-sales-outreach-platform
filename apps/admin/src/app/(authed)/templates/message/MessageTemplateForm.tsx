"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  createMessageTemplateAction,
  updateMessageTemplateAction,
} from "./actions";

type Props = {
  mode: "create" | "edit";
  charPresets: number[];
  defaults?: { id: string; name: string; subject: string; body: string };
};

const SAMPLE = { "会社名": "株式会社サンプル", "担当者名": "山田 太郎" };

function applyVars(text: string): string {
  return text
    .replace(/\{\{\s*会社名\s*\}\}/g, SAMPLE["会社名"])
    .replace(/\{\{\s*担当者名\s*\}\}/g, SAMPLE["担当者名"]);
}

export default function MessageTemplateForm({ mode, charPresets, defaults }: Props) {
  const router = useRouter();
  const [name, setName] = useState(defaults?.name ?? "");
  const [subject, setSubject] = useState(defaults?.subject ?? "");
  const [body, setBody] = useState(defaults?.body ?? "");
  const [preset, setPreset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const len = body.length;
  const over = preset !== null && len > preset;

  const handleSubmit = () => {
    setError(null);
    const fd = new FormData();
    fd.append("name", name);
    fd.append("subject", subject);
    fd.append("body", body);
    startSave(async () => {
      const res =
        mode === "create"
          ? await createMessageTemplateAction(fd)
          : await updateMessageTemplateAction(defaults!.id, fd);
      if (res && res.error) setError(res.error);
      else if (mode === "edit") router.refresh();
    });
  };

  const insertVar = (v: string) => {
    const token = `{{${v}}}`;
    const ta = bodyRef.current;
    const start = ta?.selectionStart ?? body.length;
    const end = ta?.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    if (preset !== null && next.length > preset) return;
    setBody(next);
    requestAnimationFrame(() => {
      const el = bodyRef.current;
      if (!el) return;
      const pos = start + token.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <section className="bg-white border border-gray-200 rounded p-5 space-y-4">
        <div>
          <label className="block text-sm mb-1">
            テンプレート名 <span className="text-red-600">*</span>
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm mb-1">
            件名 <span className="text-red-600">*</span>
          </label>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm">
              本文 <span className="text-red-600">*</span>
            </label>
            <div className="flex items-center gap-1 text-xs">
              <span className="text-gray-500 mr-1">変数挿入:</span>
              <button
                type="button"
                onClick={() => insertVar("会社名")}
                className="px-2 py-0.5 border border-gray-300 rounded hover:bg-gray-50"
              >
                {"{{会社名}}"}
              </button>
              <button
                type="button"
                onClick={() => insertVar("担当者名")}
                className="px-2 py-0.5 border border-gray-300 rounded hover:bg-gray-50"
              >
                {"{{担当者名}}"}
              </button>
            </div>
          </div>
          <textarea
            ref={bodyRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            maxLength={preset ?? 10000}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono"
          />
          <div className="mt-2 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="text-gray-500">文字数プリセット:</span>
              <button
                type="button"
                onClick={() => setPreset(null)}
                className={`px-2 py-0.5 rounded border ${
                  preset === null ? "bg-gray-100 border-gray-400" : "border-gray-300"
                }`}
              >
                無制限
              </button>
              {charPresets.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPreset(p)}
                  className={`px-2 py-0.5 rounded border ${
                    preset === p ? "bg-gray-100 border-gray-400" : "border-gray-300"
                  }`}
                >
                  {p}字
                </button>
              ))}
            </div>
            <div className={over ? "text-red-600 font-semibold" : "text-gray-600"}>
              {len} 文字{preset !== null && ` / ${preset}`}
              {over && " (超過)"}
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSaving}
            className="px-4 py-2 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] disabled:opacity-50 text-sm"
          >
            {isSaving ? "保存中..." : mode === "create" ? "作成" : "保存"}
          </button>
          <Link
            href="/templates/message"
            className="px-4 py-2 rounded border border-gray-300 hover:bg-gray-50 text-sm"
          >
            キャンセル
          </Link>
        </div>
      </section>

      <section className="bg-gray-50 border border-gray-200 rounded p-5">
        <h3 className="text-sm font-semibold text-gray-600 mb-3">
          ■ プレビュー (サンプル値で変数展開)
        </h3>
        <div className="bg-white border border-gray-200 rounded p-4 text-sm">
          <div className="text-xs text-gray-500 mb-1">件名</div>
          <div className="mb-4 font-medium">{applyVars(subject) || "—"}</div>
          <div className="text-xs text-gray-500 mb-1">本文</div>
          <div className="whitespace-pre-wrap text-gray-800">
            {applyVars(body) || "—"}
          </div>
        </div>
        <div className="mt-3 text-[11px] text-gray-500">
          サンプル: {"{{会社名}}"} → {SAMPLE["会社名"]} / {"{{担当者名}}"} →{" "}
          {SAMPLE["担当者名"]}
        </div>
      </section>
    </div>
  );
}
