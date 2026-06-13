import type PgBoss from "pg-boss";
import { getBoss, QUEUE_DELIVERY, stopBoss } from "./queue.ts";
import { processDeliveryJob } from "./job-processor.ts";
import { closeBrowser } from "./form-submitter.ts";
import type { DeliveryJobPayload } from "./types.ts";
import { PrismaClient } from "../../../packages/db/generated/prisma/index.js";

const prisma = new PrismaClient();

// 起動時の孤児ジョブ復旧:
// retryLimit:0 のため、ワーカー再起動/クラッシュで処理途中だったジョブは pg-boss から
// 再配信されず status=RUNNING のまま放置される。単一ワーカー構成では起動直後に処理中の
// ジョブは存在しないので、RUNNING のジョブは「孤児」とみなして再投入する。
// (PENDING はキュー投入直後の正常待機と区別できないため対象外。job-processor 側は
//  既に SUCCESS/FAILED/SKIPPED の会社をスキップするので二重送信は起きない。)
async function recoverOrphanedJobs(boss: PgBoss): Promise<void> {
  try {
    const orphans = await prisma.deliveryJob.findMany({
      where: { status: "RUNNING", cancelRequested: false },
      select: { id: true },
    });
    for (const j of orphans) {
      await boss.send(
        QUEUE_DELIVERY,
        { jobId: j.id },
        { expireInHours: 4, retryLimit: 0 },
      );
      console.log(`[worker] re-enqueued orphaned RUNNING job ${j.id}`);
    }
    if (orphans.length > 0) {
      console.log(`[worker] recovered ${orphans.length} orphaned job(s)`);
    }
  } catch (e) {
    console.warn("[worker] orphan recovery failed:", (e as Error).message);
  }
}

async function main() {
  console.log("[worker] starting...");
  const boss = await getBoss();

  await boss.work<DeliveryJobPayload>(QUEUE_DELIVERY, async (jobs) => {
    for (const job of jobs) {
      try {
        console.log(`[worker] received ${QUEUE_DELIVERY} job ${job.id}`);
        await processDeliveryJob(job.data);
      } catch (e) {
        console.error(`[worker] job ${job.id} error:`, e);
        throw e;
      }
    }
  });

  console.log(`[worker] ready, listening on queue "${QUEUE_DELIVERY}"`);

  // ワーカー再起動で取り残された RUNNING ジョブを自動復旧する (handler 登録後に実行)。
  await recoverOrphanedJobs(boss);
}

async function shutdown() {
  console.log("[worker] shutdown...");
  await closeBrowser().catch(() => null);
  await stopBoss().catch(() => null);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
