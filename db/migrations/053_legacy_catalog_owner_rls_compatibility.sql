-- 053: restore the documented table-owner compatibility posture for the
-- legacy application catalogs while retaining tenant RLS for every non-owner.
--
-- Migration 046 records that the general application connection currently
-- owns these tables and reaches some authentication/bootstrap paths before an
-- app.builder_id GUC exists. Migration 052 forced RLS on the same catalogs as
-- defense in depth for the dedicated budget-control runtime, but that also
-- subjected the legacy owner path to policies that intentionally return no
-- rows before tenant context is established.
--
-- The dedicated budget-control login remains a NOBYPASSRLS non-owner, and its
-- production attestation rejects ownership of all protected relations. RLS
-- therefore remains effective for that login even though these four legacy
-- catalogs are no longer FORCEd. The nine authoritative/control tables remain
-- FORCE ROW LEVEL SECURITY without exception.

ALTER TABLE public.builders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builders NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rules NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.cost_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_sources NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.custom_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_pricing NO FORCE ROW LEVEL SECURITY;
