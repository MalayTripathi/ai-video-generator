ALTER TABLE "public"."usage" ADD COLUMN "quoted_cost" numeric(12,6);

COMMENT ON COLUMN "public"."usage"."quoted_cost" IS
    'The pre-flight reservation, written once by reserveUsage and never updated by settleUsage. estimated_cost starts equal to it and is overwritten on settle with the measured cost, so (estimated_cost - quoted_cost) is the calibration delta for the input-token estimate and the allowance ceiling.';
