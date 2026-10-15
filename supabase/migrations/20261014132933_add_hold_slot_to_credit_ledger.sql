-- A hold's race slot: 1 + the number of the user's holds when it was placed. The slot, not
-- the dedupe key, serializes concurrent holds (see the unique index that follows); the
-- dedupe key is 'hold:{attempt id}', so a retried hold on one attempt dedupes. Null on every
-- other row and on holds placed before this column existed (their keys are 'hold:{n}').
alter table "public"."credit_ledger"
    add column "hold_slot" integer;
