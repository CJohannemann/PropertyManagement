-- Prorated first-period rent.
--
-- The reference case is Chris's real lease: $1,200/month, rent due on the
-- 1st, term starting 25 July 2025. July 25-31 is 7 days of a 31-day
-- period, so 1200 x 7/31 = 270.97. (His paper lease says $270.00, which
-- is the same calculation rounded down — the app offers the exact figure
-- and lets it be edited, since leases legitimately round.)

select assert(prorated_first_period('2025-07-25', 1, 1200) = 270.97,
  'July 25 start, due 1st, $1200: expected 270.97, got '
  || prorated_first_period('2025-07-25', 1, 1200));

-- Starting on the due day owes a whole period, which generate_rent_charges
-- bills as ordinary rent. Prorating too would bill that period twice.
select assert(prorated_first_period('2026-01-01', 1, 1200) = 0,
  'starting on the due day should prorate to zero');

-- Month length is respected rather than assuming 30 days: one day of
-- February is worth more than one day of July for the same rent.
select assert(prorated_first_period('2026-02-28', 1, 1200) = round(1200 * 1.0 / 28, 2),
  'February 28 start in a 28-day period should be one days rent of 28');
select assert(prorated_first_period('2026-07-31', 1, 1200) = round(1200 * 1.0 / 31, 2),
  'July 31 start in a 31-day period should be one days rent of 31');
select assert(prorated_first_period('2026-02-28', 1, 1200)
            > prorated_first_period('2026-07-31', 1, 1200),
  'a single day of a short month is worth more than a day of a long one');

-- The period runs between due days, not between calendar months. Rent due
-- on the 15th and a term starting the 20th owes 20 Jan - 14 Feb.
select assert(prorated_first_period('2026-01-20', 15, 3100) = round(3100 * 26.0 / 31, 2),
  'due on the 15th, starting the 20th: 26 days of a 31-day period, got '
  || prorated_first_period('2026-01-20', 15, 3100));

-- Starting the day after the due day owes almost the whole period.
select assert(prorated_first_period('2026-01-02', 1, 1200) = round(1200 * 30.0 / 31, 2),
  'starting the day after the due day owes all but one day');

-- Starting the day before the next due day owes exactly one day.
select assert(prorated_first_period('2026-01-31', 1, 1200) = round(1200 * 1.0 / 31, 2),
  'starting the last day of the period owes one day');

-- Leap years: February 2028 has 29 days, and the divisor must follow.
select assert(prorated_first_period('2028-02-15', 1, 1160) = round(1160 * 15.0 / 29, 2),
  'February 2028 is a 29-day period');

-- Nulls in, null out — the form calls this before every field is filled.
select assert(prorated_first_period(null, 1, 1200) is null, 'null start date yields null');
select assert(prorated_first_period('2026-01-15', null, 1200) is null, 'null due day yields null');
select assert(prorated_first_period('2026-01-15', 1, null) is null, 'null rent yields null');

-- Never more than a full period, whatever the inputs.
select assert(prorated_first_period('2026-03-05', 1, 1200) < 1200,
  'a partial period is always less than full rent');

select assert(true, 'proration tests completed');
