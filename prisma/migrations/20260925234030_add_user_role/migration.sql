-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Interview" (
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
    "joinCode" TEXT NOT NULL DEFAULT '',
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
INSERT INTO "new_Interview" ("allowCandidateScreenShare", "candidateEmail", "candidateKey", "candidateName", "createdAt", "currentQuestionId", "difficulty", "durationMinutes", "elapsedMs", "endedAt", "id", "interviewerName", "lastActivity", "liveSince", "ownerId", "plannedQuestions", "position", "reportStatus", "review", "roomName", "settings", "skills", "startedAt", "status") SELECT "allowCandidateScreenShare", "candidateEmail", "candidateKey", "candidateName", "createdAt", "currentQuestionId", "difficulty", "durationMinutes", "elapsedMs", "endedAt", "id", "interviewerName", "lastActivity", "liveSince", "ownerId", "plannedQuestions", "position", "reportStatus", "review", "roomName", "settings", "skills", "startedAt", "status" FROM "Interview";
DROP TABLE "Interview";
ALTER TABLE "new_Interview" RENAME TO "Interview";
CREATE UNIQUE INDEX "Interview_roomName_key" ON "Interview"("roomName");
CREATE INDEX "Interview_ownerId_idx" ON "Interview"("ownerId");
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'interviewer',
    "passwordHash" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("createdAt", "email", "id", "name", "passwordHash", "salt") SELECT "createdAt", "email", "id", "name", "passwordHash", "salt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
