import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { bucketOf, BUCKET_LABEL } from "@/lib/delivery-stats";
import { fmtJstDate, fmtJstDateTime } from "@/lib/date-jst";
import type { DeliveryResultStatus } from "@mvp/db";

export const dynamic = "force-dynamic";

function buildWhere(sp: URLSearchParams) {
  const where: Record<string, unknown> = {};
  const caseId = sp.get("caseId");
  const bucket = sp.get("bucket");
  const from = sp.get("from");
  const to = sp.get("to");

  if (caseId) where["job"] = { caseId };
  if (from || to) {
    where["attemptedAt"] = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to + "T23:59:59") } : {}),
    };
  }
  if (bucket) {
    switch (bucket) {
      case "SUCCESS":
        where["status"] = "SUCCESS" as DeliveryResultStatus;
        break;
      case "REJECTED":
        where["status"] = "SKIPPED";
        where["errorType"] = "BLACKLISTED";
        break;
      case "FORM_MISSING":
        where["status"] = "FAILED";
        where["errorType"] = { in: ["FORM_NOT_FOUND", "FIELD_MISMATCH"] };
        break;
      case "FAILED":
        where["status"] = "FAILED";
        where["errorType"] = { notIn: ["FORM_NOT_FOUND", "FIELD_MISMATCH"] };
        break;
    }
  }
  return where;
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const where = buildWhere(url.searchParams);

  const rows = await prisma.deliveryResult.findMany({
    where,
    orderBy: { attemptedAt: "desc" },
    include: {
      job: { include: { case: true, list: true, messageTemplate: true } },
      company: true,
    },
    take: 10000,
  });

  const header = [
    "受信時刻 (JST)",
    "案件",
    "リスト",
    "テンプレ",
    "会社名",
    "フォームURL",
    "分類",
    "ステータス",
    "エラー種別",
    "エラーメッセージ",
    "試行回数",
    "HTTP",
  ];
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body =
    "﻿" +
    [
      header.join(","),
      ...rows.map((r) =>
        [
          fmtJstDateTime(r.attemptedAt),
          r.job.case.name,
          r.job.list.name,
          r.job.messageTemplate.name,
          r.company.name,
          r.company.formUrl,
          BUCKET_LABEL[bucketOf(r.status, r.errorType)],
          r.status,
          r.errorType ?? "",
          r.errorMessage ?? "",
          r.attempts,
          r.httpStatus ?? "",
        ]
          .map(escape)
          .join(","),
      ),
    ].join("\n");

  const filename = `delivery-results-${fmtJstDate(new Date())}.csv`;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
