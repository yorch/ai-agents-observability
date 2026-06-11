-- AlterTable
ALTER TABLE "users" ALTER COLUMN "github_login" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "github_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN "password_hash" TEXT;
