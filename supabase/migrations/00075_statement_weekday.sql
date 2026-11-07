-- 00075 - Repair: statement_weekday for employer_pay_profiles.
-- Migration 00074 was edited in place by commit aa49f3fe (2026-11-06 3:37 PM EST)
-- minutes AFTER 00074 had already been applied live from its original text, so
-- the statement_weekday column it added on paper never reached the live
-- database (probe 2026-11-06 6:40 PM EST: column count 0). The v59 code
-- selects this column by name (pay summary, pay-terms settings). This
-- migration adds exactly that column, identical in type and check to the
-- line aa49f3fe added to 00074. ADDITIVE and nullable: null = visibly UNSET
-- (no statement day shown). 00074 is never edited again.

alter table employer_pay_profiles
  add column statement_weekday smallint
    constraint employer_pay_profiles_statement_valid check (statement_weekday is null or (statement_weekday between 0 and 6));
