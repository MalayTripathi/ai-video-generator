-- Mirrors VIDEO_RESOLUTIONS (src/lib/config/enums.ts).
ALTER TABLE "public"."projects"
    ADD COLUMN "video_resolution" "text" NOT NULL DEFAULT '480p',
    ADD CONSTRAINT "projects_video_resolution_check" CHECK ("video_resolution" IN ('480p', '720p', '1080p'));
