/*
  Warnings:

  - Added the required column `initialPrompt` to the `conversations` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."conversations" ADD COLUMN     "initialPrompt" TEXT NOT NULL;
