-- Seed data for a brand-new database. Run once, after schema.sql, as part
-- of apply-schema.sh (see FarmHand's deploy/selfhost for the equivalent
-- self-hosted bring-up flow this project will mirror).

-- Kentucky is the only verified state_rent_regulations row at launch
-- (Chris's properties). KRS 383.565: late fees capped at 10% of monthly
-- rent, and can't be charged until rent is 5+ days late. ACH convenience
-- fees passed to the tenant have no specific Kentucky statute against
-- them, provided they're disclosed in the lease (see docs/domain-model.md
-- for the reasoning and the "not legal advice, verify before expanding to
-- a new state" caveat that applies to every row in this table).
insert into state_rent_regulations
  (state_code, max_late_fee_type, max_late_fee_value, min_grace_days,
   tenant_paid_processing_fee_allowed, source_citation, last_verified_at)
values
  ('KY', 'percent', 10, 5, true, 'KRS 383.565', current_date);
