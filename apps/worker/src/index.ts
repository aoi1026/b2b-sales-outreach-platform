import { getBoss, QUEUE_DELIVERY, stopBoss } from "./queue.ts";
import { processDeliveryJob } from "./job-processor.ts";
import { closeBrowser } from "./form-submitter.ts";
import type { DeliveryJobPayload } from "./types.ts";

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
