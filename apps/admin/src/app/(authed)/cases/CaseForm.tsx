"use client";

import Link from "next/link";
import { useActionState } from "react";
import { STATUS_LABEL, STATUS_OPTIONS } from "@/lib/case-status";
import type { CaseStatus } from "@mvp/db";
import type { CaseFormState } from "./actions";

type Props = {
  action: (prev: CaseFormState, formData: FormData) => Promise<CaseFormState>;
  initial?: {
    name: string;
    sponsor: string;
    genre: string | null;
    startDate: Date | null;
    endDate: Date | null;
    status: CaseStatus;
    memo: string | null;
  };
  submitLabel?: string;
};

function toDateInput(d: Date | null | undefined) {
  if (!d) return "";
  // JST 日付を返す (input[type=date] は YYYY-MM-DD 期待)
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export default function CaseForm({ action, initial, submitLabel = "保存" }: Props) {
  const [state, formAction, pending] = useActionState<CaseFormState, FormData>(action, undefined);

  return (
    <form action={formAction} className="space-y-5 bg-white border border-gray-200 rounded p-6">
      <div>
        <Label required>案件名</Label>
        <input
          name="name"
          defaultValue={initial?.name}
          required
          maxLength={120}
          className="input"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div>
          <Label required>スポンサー</Label>
          <input
            name="sponsor"
            defaultValue={initial?.sponsor}
            required
            maxLength={120}
            className="input"
          />
        </div>
        <div>
          <Label>ジャンル</Label>
          <input
            name="genre"
            defaultValue={initial?.genre ?? ""}
            maxLength={80}
            className="input"
            placeholder="例: 広告メディア / 食品 / SaaS"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div>
          <Label>開始日</Label>
          <input
            name="startDate"
            type="date"
            defaultValue={toDateInput(initial?.startDate)}
            className="input"
          />
        </div>
        <div>
          <Label>終了日</Label>
          <input
            name="endDate"
            type="date"
            defaultValue={toDateInput(initial?.endDate)}
            className="input"
          />
        </div>
        <div>
          <Label required>ステータス</Label>
          <select name="status" defaultValue={initial?.status ?? "PREPARING"} className="input">
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <Label>担当者メモ</Label>
        <textarea
          name="memo"
          defaultValue={initial?.memo ?? ""}
          rows={4}
          maxLength={2000}
          className="input resize-y"
        />
      </div>

      {state?.error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {state.error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="px-4 py-2 bg-[#1e5ab4] text-white rounded hover:bg-[#17498f] disabled:opacity-60"
        >
          {pending ? "保存中..." : submitLabel}
        </button>
        <Link
          href="/cases"
          className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50 text-gray-700"
        >
          キャンセル
        </Link>
      </div>

      <style>{`
        .input {
          width: 100%;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          padding: 8px 10px;
          outline: none;
        }
        .input:focus {
          border-color: #1e5ab4;
        }
      `}</style>
    </form>
  );
}

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-sm font-medium text-gray-700 mb-1">
      {children}
      {required && (
        <span className="ml-2 inline-block text-[10px] px-1.5 py-0.5 rounded bg-red-600 text-white align-middle">
          必須
        </span>
      )}
    </label>
  );
}
