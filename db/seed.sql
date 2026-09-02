-- Seed data for a brand-new database. Run once, after schema.sql, as part
-- of apply-schema.sh.

-- Kentucky is the only state_rent_regulations row at launch.
--
-- Deliberately records NO late-fee cap, because Kentucky has none at the
-- state level: the test is judicial reasonableness, not a statutory
-- percentage. The URLTA sections (KRS 383.505-383.715) are local-option —
-- binding only where a city or county adopted them by ordinance
-- (Louisville, Lexington, Covington, Newport among others) — and they set
-- no late-fee cap either.
--
-- An earlier version of this file asserted a 10%-of-rent cap with a
-- 5-day minimum grace, citing KRS 383.565. That was wrong, taken from a
-- secondary summary rather than the statute, and enforce_late_fee_limits
-- would have rejected a real signed Kentucky lease ($25 after 5 days plus
-- $5/day) as illegal. See db/migrations/005_late_fee_accrual.sql.
--
-- Note the granularity problem this exposes and does not solve: this
-- table is keyed by state, while Kentucky's rules are set per
-- municipality. Revisit before onboarding a landlord in a jurisdiction
-- with a local cap.
--
-- NOT LEGAL ADVICE. Every row here needs confirming with counsel before
-- it governs a real lease.
insert into state_rent_regulations
  (state_code, max_late_fee_type, max_late_fee_value, min_grace_days,
   tenant_paid_processing_fee_allowed, source_citation, last_verified_at)
values
  ('KY', 'none', null, 0, true,
   'No statewide statutory cap on late fees; reasonableness is a judicial standard. '
   || 'URLTA (KRS 383.505-383.715) is local-option and adopted only by some '
   || 'jurisdictions; it sets no late-fee cap. No known prohibition on passing payment '
   || 'processing fees to tenants, provided the charge is disclosed in the lease. '
   || 'NOT LEGAL ADVICE - confirm with counsel.',
   current_date);
