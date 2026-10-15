-- Two holds racing for the same slot: exactly one insert lands, the other re-reads the count
-- and the balance (src/lib/credits/ledger.ts placeHold). Nulls stay distinct, so non-hold
-- rows are unaffected.
create unique index credit_ledger_user_hold_slot_idx
    on public.credit_ledger (user_id, hold_slot);
