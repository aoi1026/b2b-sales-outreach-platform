"use client";

import Link from "next/link";
import { useState, useTransition, useRef } from "react";
import {
  ALL_FIELDS,
  FIELD_LABELS,
  REQUIRED_FIELDS,
  type FieldKey,
  type FieldMapping,
} from "@/lib/csv";
import {
  parseCsvAction,
  importListAction,
  type ParseActionResult,
  type ImportActionResult,
} from "./actions";

export default function ImportClient() {
  const [file, setFile] = useState<File | null>(null);
  const [parseResult, setParseResult] = useState<Extract<ParseActionResult, { ok: true }> | null>(
    null,
  );
  const [mapping, setMapping] = useState<FieldMapping>({});
  const [listName, setListName] = useState("");
  const [description, setDescription] = useState("");
  const [importResult, setImportResult] = useState<Extract<ImportActionResult, { ok: true }> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isParsing, startParse] = useTransition();
  const [isImporting, startImport] = useTransition();
  const [previewPage, setPreviewPage] = useState(1);
  const previewPageSize = 10;
  const inputRef = useRef<HTMLInputElement>(null);

  const resetAll = () => {
    setFile(null);
    setParseResult(null);
    setMapping({});
    setListName("");
    setDescription("");
    setImportResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleParse = () => {
    if (!file) {
      setError("CSVファイルを選択してください。");
      return;
    }
    setError(null);
    setImportResult(null);
    const fd = new FormData();
    fd.append("file", file);
    startParse(async () => {
      const res = await parseCsvAction(fd);
      if (!res.ok) {
        setError(res.error);
        setParseResult(null);
      } else {
        setParseResult(res);
        setMapping(res.mapping);
        setPreviewPage(1);
      }
    });
  };

  const handleImport = () => {
    if (!file || !parseResult) return;
    setError(null);
    if (!listName.trim()) {
      setError("リスト名を入力してください。");
      return;
    }
    if (!mapping.name || !mapping.formUrl) {
      setError("必須項目（会社名・問い合わせフォームURL）のマッピングを指定してください。");
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("listName", listName);
    fd.append("description", description);
    fd.append("mapping", JSON.stringify(mapping));
    startImport(async () => {
      const res = await importListAction(fd);
      if (!res.ok) setError(res.error);
      else setImportResult(res);
    });
  };

  if (importResult) {
    return (
      <div className="bg-white border border-gray-200 rounded p-6">
        <h2 className="text-lg font-semibold mb-4">取込結果</h2>
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <ResultStat label="リスト名" value={importResult.listName} />
          <ResultStat label="取込成功" value={`${importResult.imported} 件`} accent="green" />
          <ResultStat label="重複除外" value={`${importResult.dupSkipped} 件`} accent="gray" />
          <ResultStat label="BL除外" value={`${importResult.blSkipped} 件`} accent="orange" />
        </dl>

        {importResult.validationErrors.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-red-700 mb-2">
              バリデーションエラー ({importResult.validationErrors.length}件)
            </h3>
            <div className="max-h-60 overflow-auto border border-red-200 rounded">
              <table className="w-full text-xs">
                <thead className="bg-red-50 text-red-800">
                  <tr>
                    <th className="px-3 py-1.5 text-left w-16">行</th>
                    <th className="px-3 py-1.5 text-left">エラー</th>
                  </tr>
                </thead>
                <tbody>
                  {importResult.validationErrors.map((e, i) => (
                    <tr key={i} className="border-t border-red-100">
                      <td className="px-3 py-1.5">{e.row}</td>
                      <td className="px-3 py-1.5">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="flex gap-3">
          <Link
            href={`/lists`}
            className="px-3 py-1.5 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] text-sm"
          >
            リスト一覧へ
          </Link>
          <button
            type="button"
            onClick={resetAll}
            className="px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 text-sm"
          >
            続けて別のCSVを取込
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="bg-white border border-gray-200 rounded p-6">
        <h2 className="text-sm font-semibold text-gray-600 mb-3">■ STEP 1. CSVファイル選択</h2>
        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setParseResult(null);
              setError(null);
            }}
            className="text-sm"
          />
          <button
            type="button"
            onClick={handleParse}
            disabled={!file || isParsing}
            className="px-3 py-1.5 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] disabled:opacity-50 text-sm"
          >
            {isParsing ? "解析中..." : "解析"}
          </button>
          {file && (
            <span className="text-xs text-gray-500">
              {file.name} ({(file.size / 1024).toFixed(1)} KB)
            </span>
          )}
        </div>
        <p className="text-[11px] text-gray-500 mt-2">
          UTF-8 / Shift_JIS に対応。必須項目: 会社名・問い合わせフォームURL。最大 10MB。
        </p>
      </section>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">
          {error}
        </div>
      )}

      {parseResult && (
        <>
          <section className="bg-white border border-gray-200 rounded p-6">
            <h2 className="text-sm font-semibold text-gray-600 mb-3">■ STEP 2. 項目マッピング</h2>
            <div className="text-xs text-gray-500 mb-3">
              検出エンコーディング: <b>{parseResult.encoding}</b> / 総行数:{" "}
              <b>{parseResult.totalRows}</b> 行 / ヘッダ: {parseResult.headers.length} 列
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {ALL_FIELDS.map((key) => (
                <MappingRow
                  key={key}
                  fieldKey={key}
                  headers={parseResult.headers}
                  value={mapping[key] ?? ""}
                  onChange={(v) =>
                    setMapping((m) => ({ ...m, [key]: v || undefined }))
                  }
                />
              ))}
            </div>
            <details className="mt-4" open>
              <summary className="text-xs text-gray-600 cursor-pointer">
                プレビュー (全 {parseResult.preview.length} 行)
              </summary>
              {(() => {
                const total = parseResult.preview.length;
                const totalPages = Math.max(1, Math.ceil(total / previewPageSize));
                const page = Math.min(previewPage, totalPages);
                const start = (page - 1) * previewPageSize;
                const end = Math.min(start + previewPageSize, total);
                const pageRows = parseResult.preview.slice(start, end);
                return (
                  <>
                    <div className="mt-2 overflow-auto border border-gray-200 rounded">
                      <table className="text-xs w-full">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-2 py-1 text-left w-12 text-gray-500">#</th>
                            {parseResult.headers.map((h) => (
                              <th key={h} className="px-2 py-1 text-left">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {pageRows.map((r, i) => (
                            <tr key={start + i} className="border-t border-gray-100">
                              <td className="px-2 py-1 text-gray-400">{start + i + 2}</td>
                              {parseResult.headers.map((h) => (
                                <td key={h} className="px-2 py-1">{r[h] ?? ""}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-gray-600">
                      <span>
                        {total === 0 ? "0 / 0" : `${start + 1}–${end} / ${total} 行`}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setPreviewPage(1)}
                          disabled={page <= 1}
                          className="px-2 py-0.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40"
                        >
                          « 最初
                        </button>
                        <button
                          type="button"
                          onClick={() => setPreviewPage((p) => Math.max(1, p - 1))}
                          disabled={page <= 1}
                          className="px-2 py-0.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40"
                        >
                          ‹ 前へ
                        </button>
                        <span className="px-2">
                          {page} / {totalPages}
                        </span>
                        <button
                          type="button"
                          onClick={() => setPreviewPage((p) => Math.min(totalPages, p + 1))}
                          disabled={page >= totalPages}
                          className="px-2 py-0.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40"
                        >
                          次へ ›
                        </button>
                        <button
                          type="button"
                          onClick={() => setPreviewPage(totalPages)}
                          disabled={page >= totalPages}
                          className="px-2 py-0.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-40"
                        >
                          最後 »
                        </button>
                      </div>
                    </div>
                  </>
                );
              })()}
            </details>
          </section>

          <section className="bg-white border border-gray-200 rounded p-6">
            <h2 className="text-sm font-semibold text-gray-600 mb-3">■ STEP 3. リスト情報</h2>
            <div className="space-y-3 max-w-xl">
              <div>
                <label className="block text-sm mb-1">
                  リスト名 <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={listName}
                  onChange={(e) => setListName(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
                  maxLength={120}
                  placeholder="例: 2026年4月 地方自治体リスト"
                />
              </div>
              <div>
                <label className="block text-sm mb-1">説明 (任意)</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
                  maxLength={500}
                />
              </div>
            </div>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={handleImport}
                disabled={isImporting}
                className="px-4 py-2 rounded bg-[#1e5ab4] text-white hover:bg-[#17498f] disabled:opacity-50 text-sm"
              >
                {isImporting ? "取込中..." : "取込実行"}
              </button>
              <button
                type="button"
                onClick={resetAll}
                className="px-4 py-2 rounded border border-gray-300 hover:bg-gray-50 text-sm"
              >
                キャンセル
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function MappingRow({
  fieldKey,
  headers,
  value,
  onChange,
}: {
  fieldKey: FieldKey;
  headers: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const required = REQUIRED_FIELDS.includes(fieldKey);
  return (
    <div className="flex items-center gap-3">
      <label className="w-40 text-sm shrink-0">
        {FIELD_LABELS[fieldKey]}
        {required && <span className="text-red-600 ml-1">*</span>}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm"
      >
        <option value="">（選択しない）</option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </div>
  );
}

function ResultStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "green" | "gray" | "orange";
}) {
  const colorMap = {
    green: "text-green-700",
    gray: "text-gray-600",
    orange: "text-orange-700",
  };
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={`mt-1 text-lg font-semibold ${accent ? colorMap[accent] : ""}`}>{value}</dd>
    </div>
  );
}
