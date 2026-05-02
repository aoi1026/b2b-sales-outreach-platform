import Papa from "papaparse";
import iconv from "iconv-lite";

export type Encoding = "UTF-8" | "Shift_JIS";

export type CsvRow = Record<string, string>;

export type ParseResult = {
  encoding: Encoding;
  headers: string[];
  rows: CsvRow[];
  parseErrors: { row: number; message: string }[];
};

export type FieldKey = "name" | "formUrl" | "siteUrl" | "email" | "industry";

export const REQUIRED_FIELDS: FieldKey[] = ["name", "formUrl"];
export const ALL_FIELDS: FieldKey[] = ["name", "formUrl", "siteUrl", "email", "industry"];

export const FIELD_LABELS: Record<FieldKey, string> = {
  name: "会社名",
  formUrl: "問い合わせフォームURL",
  siteUrl: "サイトURL",
  email: "メールアドレス",
  industry: "業種",
};

export type FieldMapping = Partial<Record<FieldKey, string>>;

export type ImportRow = {
  name: string;
  formUrl: string;
  siteUrl: string | null;
  email: string | null;
  industry: string | null;
};

export type ValidationResult = {
  valid: ImportRow[];
  errors: { row: number; message: string; raw: CsvRow }[];
};

export function detectEncoding(buffer: Buffer): Encoding {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return "UTF-8";
  } catch {
    return "Shift_JIS";
  }
}

export function decodeCsv(buffer: Buffer): { encoding: Encoding; text: string } {
  const encoding = detectEncoding(buffer);
  const text =
    encoding === "UTF-8"
      ? buffer.toString("utf-8").replace(/^\uFEFF/, "")
      : iconv.decode(buffer, "shift_jis");
  return { encoding, text };
}

export function parseCsv(buffer: Buffer): ParseResult {
  const { encoding, text } = decodeCsv(buffer);
  const result = Papa.parse<CsvRow>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  return {
    encoding,
    headers: (result.meta.fields ?? []).filter((h) => h.length > 0),
    rows: result.data,
    parseErrors: (result.errors ?? []).map((e) => ({
      row: typeof e.row === "number" ? e.row + 2 : -1,
      message: e.message,
    })),
  };
}

export function autoDetectMapping(headers: string[]): FieldMapping {
  const candidates = headers.map((h) => ({ original: h, key: h.toLowerCase().trim() }));
  const find = (patterns: RegExp[]) =>
    candidates.find(({ key }) => patterns.some((p) => p.test(key)))?.original;

  return {
    name: find([/会社名/, /^company$/, /company[_\s]?name/, /^name$/, /社名/]),
    formUrl: find([
      /form[_\s]?url/,
      /問い?合わ?せ.*フォーム/,
      /フォーム.*url/,
      /contact[_\s]?url/,
      /inquiry[_\s]?url/,
    ]),
    siteUrl: find([/site[_\s]?url/, /ホームページ/, /web[_\s]?site/, /^url$/, /サイト.*url/]),
    email: find([/^e[_\s\-]?mail$/, /メールアドレス/, /^メール$/, /mail[_\s]?address/]),
    industry: find([/業種/, /^industry$/, /ジャンル/]),
  };
}

export function validateRows(rows: CsvRow[], mapping: FieldMapping): ValidationResult {
  if (!mapping.name || !mapping.formUrl) {
    throw new Error("必須項目（会社名・問い合わせフォームURL）のマッピングが不足しています。");
  }

  const valid: ImportRow[] = [];
  const errors: ValidationResult["errors"] = [];

  rows.forEach((row, i) => {
    const lineNo = i + 2;
    const name = (row[mapping.name!] ?? "").trim();
    const formUrl = (row[mapping.formUrl!] ?? "").trim();

    if (!name) {
      errors.push({ row: lineNo, message: "会社名が空です。", raw: row });
      return;
    }
    if (!formUrl) {
      errors.push({ row: lineNo, message: "問い合わせフォームURLが空です。", raw: row });
      return;
    }
    if (!/^https?:\/\//i.test(formUrl)) {
      errors.push({ row: lineNo, message: "URLが http(s) で始まっていません。", raw: row });
      return;
    }

    valid.push({
      name,
      formUrl,
      siteUrl: mapping.siteUrl ? (row[mapping.siteUrl] ?? "").trim() || null : null,
      email: mapping.email ? (row[mapping.email] ?? "").trim() || null : null,
      industry: mapping.industry ? (row[mapping.industry] ?? "").trim() || null : null,
    });
  });

  return { valid, errors };
}

export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
