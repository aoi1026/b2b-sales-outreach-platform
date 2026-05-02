import type { DeliveryJobStatus, DeliveryResultStatus } from "@mvp/db";

export const JOB_STATUS_LABEL: Record<DeliveryJobStatus, string> = {
  PENDING: "待機中",
  RUNNING: "実行中",
  PAUSED: "一時停止",
  DONE: "完了",
  FAILED: "失敗",
  CANCELLED: "キャンセル",
};

export const JOB_STATUS_BADGE: Record<DeliveryJobStatus, string> = {
  PENDING: "bg-gray-100 text-gray-700",
  RUNNING: "bg-blue-100 text-blue-700",
  PAUSED: "bg-yellow-100 text-yellow-800",
  DONE: "bg-green-100 text-green-700",
  FAILED: "bg-red-100 text-red-700",
  CANCELLED: "bg-gray-200 text-gray-600",
};

export const RESULT_STATUS_LABEL: Record<DeliveryResultStatus, string> = {
  PENDING: "待機",
  RUNNING: "送信中",
  SUCCESS: "成功",
  FAILED: "失敗",
  SKIPPED: "スキップ",
};

export const RESULT_STATUS_BADGE: Record<DeliveryResultStatus, string> = {
  PENDING: "bg-gray-100 text-gray-600",
  RUNNING: "bg-blue-100 text-blue-700",
  SUCCESS: "bg-green-100 text-green-700",
  FAILED: "bg-red-100 text-red-700",
  SKIPPED: "bg-gray-200 text-gray-600",
};
