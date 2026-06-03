import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// 送信結果 (DeliveryResult) に保存された全画面スクリーンショット (PNG) を返す。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;
  const row = await prisma.deliveryResult.findUnique({
    where: { id },
    select: { screenshot: true },
  });

  if (!row?.screenshot) return new Response("Not Found", { status: 404 });

  const bytes = new Uint8Array(row.screenshot);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
