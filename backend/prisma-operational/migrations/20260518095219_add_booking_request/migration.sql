-- CreateTable
CREATE TABLE "BookingRequest" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "patientPhone" TEXT NOT NULL,
    "doctorName" TEXT NOT NULL,
    "appointmentDate" TEXT NOT NULL,
    "slotTime" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "responsePayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_bookingRequestId_key" ON "BookingRequest"("bookingRequestId");

-- CreateIndex
CREATE INDEX "BookingRequest_sessionId_idx" ON "BookingRequest"("sessionId");
