-- AlterTable
ALTER TABLE "JobSchedule" ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "JobSchedule" ADD COLUMN "needsReviewReason" TEXT;
