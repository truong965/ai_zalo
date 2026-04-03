-- CreateEnum
CREATE TYPE "AiFeatureType" AS ENUM ('TRANSLATION', 'SUMMARY', 'ASK', 'AGENT');

-- CreateTable
CREATE TABLE "ai_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "feature_type" "AiFeatureType" NOT NULL,
    "title" VARCHAR(255),
    "context_snapshot" JSONB NOT NULL,
    "last_message_id_synced" VARCHAR(50),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" BIGSERIAL NOT NULL,
    "session_id" UUID NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_ai_sessions_user_feature_created_at" ON "ai_sessions"("user_id", "feature_type", "created_at");

-- CreateIndex
CREATE INDEX "idx_ai_sessions_user_conversation_feature" ON "ai_sessions"("user_id", "conversation_id", "feature_type");

-- CreateIndex
CREATE INDEX "idx_ai_sessions_expires_at" ON "ai_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "idx_ai_sessions_is_active" ON "ai_sessions"("is_active");

-- CreateIndex
CREATE INDEX "idx_ai_messages_session_created_at" ON "ai_messages"("session_id", "created_at");

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
