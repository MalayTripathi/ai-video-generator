-- derive_camera: the camera re-derivation route's operation (C3 prompt 3). Only `usage`
-- ever gets a row with this value - there is deliberately no `generations` row for it
-- (see CLAUDE.md: the terminal-'succeeded' problem, deferred to C4's OPERATION_POLICY).
-- generations_operation_check is NOT widened - no writer will ever insert a generations
-- row with this operation, and widening it would misleadingly imply otherwise.
ALTER TABLE "public"."usage" DROP CONSTRAINT "usage_operation_check";
ALTER TABLE "public"."usage" ADD CONSTRAINT "usage_operation_check"
    CHECK ("operation" IN ('generate_shots', 'agent_turn', 'voiceover', 'background_music',
                            'write_prompts', 'generate_image', 'generate_clip', 'merge',
                            'derive_camera'));
