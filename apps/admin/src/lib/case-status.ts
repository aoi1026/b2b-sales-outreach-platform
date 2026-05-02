import type { CaseStatus } from "@mvp/db";

export const STATUS_LABEL: Record<CaseStatus, string> = {
  PREPARING: "準備中",
  RUNNING: "配信中",
  COMPLETED: "完了",
  STOPPED: "停止",
};

export const STATUS_BADGE: Record<CaseStatus, string> = {
  PREPARING: "bg-gray-100 text-gray-700 border border-gray-300",
  RUNNING: "bg-blue-50 text-blue-700 border border-blue-300",
  COMPLETED: "bg-green-50 text-green-700 border border-green-300",
  STOPPED: "bg-red-50 text-red-700 border border-red-300",
};

export const STATUS_OPTIONS: CaseStatus[] = ["PREPARING", "RUNNING", "COMPLETED", "STOPPED"];
