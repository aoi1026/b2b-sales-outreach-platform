-- CreateEnum
CREATE TYPE "BlacklistType" AS ENUM ('DOMAIN', 'COMPANY_NAME');

-- CreateEnum
CREATE TYPE "BlacklistSource" AS ENUM ('MANUAL', 'AUTO_KEYWORD');

-- CreateTable
CREATE TABLE "lists" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "form_url" TEXT NOT NULL,
    "site_url" TEXT,
    "email" TEXT,
    "industry" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sender_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "person_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "postal_code" TEXT,
    "address" TEXT,
    "url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sender_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blacklist_entries" (
    "id" TEXT NOT NULL,
    "type" "BlacklistType" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "source" "BlacklistSource" NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blacklist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_lists" (
    "case_id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_lists_pkey" PRIMARY KEY ("case_id","list_id")
);

-- CreateTable
CREATE TABLE "case_templates" (
    "case_id" TEXT NOT NULL,
    "message_template_id" TEXT NOT NULL,
    "sender_template_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_templates_pkey" PRIMARY KEY ("case_id","message_template_id")
);

-- CreateIndex
CREATE INDEX "companies_list_id_idx" ON "companies"("list_id");

-- CreateIndex
CREATE INDEX "blacklist_entries_type_idx" ON "blacklist_entries"("type");

-- CreateIndex
CREATE UNIQUE INDEX "blacklist_entries_type_value_key" ON "blacklist_entries"("type", "value");

-- CreateIndex
CREATE INDEX "case_lists_list_id_idx" ON "case_lists"("list_id");

-- CreateIndex
CREATE INDEX "case_templates_message_template_id_idx" ON "case_templates"("message_template_id");

-- CreateIndex
CREATE INDEX "case_templates_sender_template_id_idx" ON "case_templates"("sender_template_id");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_lists" ADD CONSTRAINT "case_lists_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_lists" ADD CONSTRAINT "case_lists_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_templates" ADD CONSTRAINT "case_templates_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_templates" ADD CONSTRAINT "case_templates_message_template_id_fkey" FOREIGN KEY ("message_template_id") REFERENCES "message_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_templates" ADD CONSTRAINT "case_templates_sender_template_id_fkey" FOREIGN KEY ("sender_template_id") REFERENCES "sender_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
