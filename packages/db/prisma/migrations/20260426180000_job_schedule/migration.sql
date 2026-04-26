-- CreateTable
CREATE TABLE "JobSchedule" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "cronPattern" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER,
    "retryOverride" JSONB,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobSchedule_pkey" PRIMARY KEY ("id")
);
