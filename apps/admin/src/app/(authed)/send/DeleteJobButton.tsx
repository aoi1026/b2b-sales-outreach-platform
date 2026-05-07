"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteJobAction } from "./actions";

type Props = {
  jobId: string;
  label?: string;
  className?: string;
  redirectTo?: string;
};

export default function DeleteJobButton({
  jobId,
  label = "削除",
  className,
  redirectTo,
}: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const onClick = () => {
    if (!confirm("このジョブを削除しますか？\n送信結果も含めて完全に削除されます。")) return;
    start(async () => {
      const res = await deleteJobAction(jobId);
      if (res && "error" in res && res.error) {
        alert(res.error);
        return;
      }
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className={
        className ??
        "px-2 py-1 border border-red-300 text-red-700 rounded hover:bg-red-50 text-xs disabled:opacity-50"
      }
    >
      {pending ? "削除中..." : label}
    </button>
  );
}
