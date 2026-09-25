-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "tokenHash" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Interview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomName" TEXT NOT NULL,
    "ownerId" TEXT,
    "status" TEXT NOT NULL,
    "candidateName" TEXT NOT NULL,
    "candidateEmail" TEXT,
    "interviewerName" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "allowCandidateScreenShare" BOOLEAN NOT NULL,
    "skills" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "plannedQuestions" TEXT NOT NULL,
    "candidateKey" TEXT NOT NULL,
    "settings" TEXT NOT NULL,
    "review" TEXT NOT NULL,
    "reportStatus" TEXT NOT NULL,
    "currentQuestionId" TEXT,
    "elapsedMs" INTEGER NOT NULL DEFAULT 0,
    "liveSince" DATETIME,
    "createdAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "lastActivity" DATETIME NOT NULL,
    CONSTRAINT "Interview_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Participant" (
    "keyHash" TEXT NOT NULL PRIMARY KEY,
    "interviewId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "Participant_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "interviewId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "expectedAnswer" TEXT NOT NULL,
    "expectedConcepts" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "skills" TEXT NOT NULL,
    "scoringCriteria" TEXT NOT NULL,
    "rubricSource" TEXT NOT NULL,
    "plannedQuestionId" TEXT,
    "status" TEXT NOT NULL,
    "evaluationError" TEXT,
    "askedAt" DATETIME NOT NULL,
    "answerStartedAt" DATETIME,
    "answeredAt" DATETIME,
    CONSTRAINT "Question_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Answer" (
    "questionId" TEXT NOT NULL PRIMARY KEY,
    "interviewId" TEXT NOT NULL,
    "originalTranscript" TEXT NOT NULL,
    "editedTranscript" TEXT,
    "editedBy" TEXT,
    "editedAt" DATETIME,
    "lowConfidence" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Answer_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TranscriptSegment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "interviewId" TEXT NOT NULL,
    "questionId" TEXT,
    "speaker" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "source" TEXT NOT NULL,
    "avgLogprob" REAL,
    "noSpeechProb" REAL,
    "lowConfidence" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "TranscriptSegment_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "interviewId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "correctness" INTEGER NOT NULL,
    "completeness" INTEGER NOT NULL,
    "relevance" INTEGER NOT NULL,
    "technicalDepth" INTEGER NOT NULL,
    "clarity" INTEGER NOT NULL,
    "coveredConcepts" TEXT NOT NULL,
    "missingConcepts" TEXT NOT NULL,
    "factualErrors" TEXT NOT NULL,
    "strengths" TEXT NOT NULL,
    "improvements" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "followUpQuestion" TEXT,
    "evaluator" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "answerSource" TEXT NOT NULL,
    "answerText" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "Evaluation_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScoreOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "interviewId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "aiScore" INTEGER NOT NULL,
    "finalScore" INTEGER,
    "reason" TEXT NOT NULL,
    "overriddenBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "ScoreOverride_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InterviewerNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "interviewId" TEXT NOT NULL,
    "questionId" TEXT,
    "text" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InterviewerNote_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "interviewId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    CONSTRAINT "ChatMessage_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FinalReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "interviewId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "generatedAt" DATETIME NOT NULL,
    CONSTRAINT "FinalReport_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Interview_roomName_key" ON "Interview"("roomName");

-- CreateIndex
CREATE INDEX "Interview_ownerId_idx" ON "Interview"("ownerId");

-- CreateIndex
CREATE INDEX "Participant_interviewId_idx" ON "Participant"("interviewId");

-- CreateIndex
CREATE UNIQUE INDEX "Question_interviewId_index_key" ON "Question"("interviewId", "index");

-- CreateIndex
CREATE INDEX "Answer_interviewId_idx" ON "Answer"("interviewId");

-- CreateIndex
CREATE INDEX "TranscriptSegment_interviewId_timestamp_idx" ON "TranscriptSegment"("interviewId", "timestamp");

-- CreateIndex
CREATE INDEX "Evaluation_interviewId_questionId_createdAt_idx" ON "Evaluation"("interviewId", "questionId", "createdAt");

-- CreateIndex
CREATE INDEX "ScoreOverride_interviewId_questionId_idx" ON "ScoreOverride"("interviewId", "questionId");

-- CreateIndex
CREATE INDEX "InterviewerNote_interviewId_idx" ON "InterviewerNote"("interviewId");

-- CreateIndex
CREATE INDEX "ChatMessage_interviewId_timestamp_idx" ON "ChatMessage"("interviewId", "timestamp");

-- CreateIndex
CREATE INDEX "FinalReport_interviewId_generatedAt_idx" ON "FinalReport"("interviewId", "generatedAt");

