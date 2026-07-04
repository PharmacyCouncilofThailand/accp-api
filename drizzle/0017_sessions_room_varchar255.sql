-- 0017: Expand sessions.room from varchar(100) to varchar(255)

ALTER TABLE "sessions" ALTER COLUMN "room" TYPE varchar(255);
