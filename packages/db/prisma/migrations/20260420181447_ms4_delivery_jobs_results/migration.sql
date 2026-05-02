-- CreateEnum
CREATE TYPE "DeliveryJobStatus" AS ENUM ('PENDING', 'RUNNING', 'PAUSED', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryResultStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "DeliveryErrorType" AS ENUM ('TIMEOUT', 'FORM_NOT_FOUND', 'FIELD_MISMATCH', 'SUBMIT_FAILED', 'VALIDATION_ERROR', 'BLACKLISTED', 'NETWORK_ERROR', 'UNKNOWN');

-- CreateTable
CREATE TABLE "delivery_jobs" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "message_template_id" TEXT NOT NULL,
    "sender_template_id" TEXT,
    "status" "DeliveryJobStatus" NOT NULL DEFAULT 'PENDING',
    "planned_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "pause_requested" BOOLEAN NOT NULL DEFAULT false,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "delivery_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_results" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "status" "DeliveryResultStatus" NOT NULL DEFAULT 'PENDING',
    "error_type" "DeliveryErrorType",
    "error_message" TEXT,
    "http_status" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "attempted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_jobs_case_id_idx" ON "delivery_jobs"("case_id");

-- CreateIndex
CREATE INDEX "delivery_jobs_status_idx" ON "delivery_jobs"("status");

-- CreateIndex
CREATE INDEX "delivery_results_job_id_idx" ON "delivery_results"("job_id");

-- CreateIndex
CREATE INDEX "delivery_results_status_idx" ON "delivery_results"("status");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_results_job_id_company_id_key" ON "delivery_results"("job_id", "company_id");

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_message_template_id_fkey" FOREIGN KEY ("message_template_id") REFERENCES "message_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_sender_template_id_fkey" FOREIGN KEY ("sender_template_id") REFERENCES "sender_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_results" ADD CONSTRAINT "delivery_results_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "delivery_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_results" ADD CONSTRAINT "delivery_results_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
