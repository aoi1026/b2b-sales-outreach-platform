"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  parseCsv,
  autoDetectMapping,
  validateRows,
  extractDomain,
  type Encoding,
  type FieldMapping,
  type ImportRow,
  type CsvRow,
} from "@/lib/csv";

const BL_KEYWORDS = [
  "営業お断り",
  "営業不要",
  "セールスお断り",
  "勧誘お断り",
  "営業連絡ご遠慮",
  "営業メールお断り",
];

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type ParseActionResult =
  | {
      ok: true;
      encoding: Encoding;
      headers: string[];
      preview: CsvRow[];
      totalRows: number;
      mapping: FieldMapping;
    }
  | { ok: false; error: string };

export async function parseCsvAction(formData: FormData): Promise<ParseActionResult> {
  const user = await requireUser();
  if (!user) return { ok: false, error: "セッションが切れました。再ログインしてください。" };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "CSVファイルを選択してください。" };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: "ファイルサイズが大きすぎます (10MB以下)。" };
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const parsed = parseCsv(buffer);
    if (parsed.headers.length === 0) {
      return { ok: false, error: "ヘッダ行を検出できませんでした。" };
    }
    return {
      ok: true,
      encoding: parsed.encoding,
      headers: parsed.headers,
      preview: parsed.rows,
      totalRows: parsed.rows.length,
      mapping: autoDetectMapping(parsed.headers),
    };
  } catch (e) {
    return { ok: false, error: `CSV解析エラー: ${(e as Error).message}` };
  }
}

export type ImportActionResult =
  | {
      ok: true;
      listId: string;
      listName: string;
      imported: number;
      dupSkipped: number;
      blSkipped: number;
      validationErrors: { row: number; message: string }[];
    }
  | { ok: false; error: string };

export async function importListAction(formData: FormData): Promise<ImportActionResult> {
  const user = await requireUser();
  if (!user) return { ok: false, error: "セッションが切れました。再ログインしてください。" };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "CSVファイルが無効です。" };
  }

  const listName = formData.get("listName")?.toString().trim() ?? "";
  if (!listName) return { ok: false, error: "リスト名を入力してください。" };
  if (listName.length > 120)
    return { ok: false, error: "リスト名は120文字以内で入力してください。" };

  const description = formData.get("description")?.toString().trim() || null;

  let mapping: FieldMapping;
  try {
    mapping = JSON.parse(formData.get("mapping")?.toString() || "{}");
  } catch {
    return { ok: false, error: "マッピング情報が不正です。" };
  }
  if (!mapping.name || !mapping.formUrl) {
    return {
      ok: false,
      error: "必須項目（会社名・問い合わせフォームURL）のマッピングを指定してください。",
    };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = parseCsv(buffer);
  const { valid, errors: validationErrors } = validateRows(parsed.rows, mapping);

  const seenDomains = new Set<string>();
  const seenNames = new Set<string>();
  const deduped: ImportRow[] = [];
  let dupSkipped = 0;
  for (const row of valid) {
    const domain = extractDomain(row.formUrl);
    if ((domain && seenDomains.has(domain)) || seenNames.has(row.name)) {
      dupSkipped++;
      continue;
    }
    if (domain) seenDomains.add(domain);
    seenNames.add(row.name);
    deduped.push(row);
  }

  const blEntries = await prisma.blacklistEntry.findMany();
  const blDomains = new Set(
    blEntries.filter((e) => e.type === "DOMAIN").map((e) => e.value.toLowerCase()),
  );
  const blNames = new Set(
    blEntries.filter((e) => e.type === "COMPANY_NAME").map((e) => e.value),
  );

  const afterBl: ImportRow[] = [];
  const keywordHits: { name: string; keyword: string }[] = [];
  let blSkipped = 0;
  for (const row of deduped) {
    const domain = extractDomain(row.formUrl);
    if (domain && blDomains.has(domain)) {
      blSkipped++;
      continue;
    }
    if (blNames.has(row.name)) {
      blSkipped++;
      continue;
    }
    const hitKeyword = BL_KEYWORDS.find((kw) => row.name.includes(kw));
    if (hitKeyword) {
      keywordHits.push({ name: row.name, keyword: hitKeyword });
      blSkipped++;
      continue;
    }
    afterBl.push(row);
  }

  const list = await prisma.$transaction(async (tx) => {
    const created = await tx.list.create({
      data: { name: listName, description },
    });
    if (afterBl.length > 0) {
      await tx.company.createMany({
        data: afterBl.map((r) => ({ ...r, listId: created.id })),
      });
    }
    for (const hit of keywordHits) {
      await tx.blacklistEntry.upsert({
        where: { type_value: { type: "COMPANY_NAME", value: hit.name } },
        update: {},
        create: {
          type: "COMPANY_NAME",
          value: hit.name,
          reason: `取込時自動追加（キーワード「${hit.keyword}」検出）`,
          source: "AUTO_KEYWORD",
        },
      });
    }
    return created;
  });

  revalidatePath("/lists");
  return {
    ok: true,
    listId: list.id,
    listName: list.name,
    imported: afterBl.length,
    dupSkipped,
    blSkipped,
    validationErrors: validationErrors.slice(0, 50).map((e) => ({ row: e.row, message: e.message })),
  };
}
