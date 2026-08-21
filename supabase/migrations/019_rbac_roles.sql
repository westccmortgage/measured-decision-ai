-- Room for the roles this platform will need, added before anything depends on
-- them. New enum values cannot be used in the transaction that creates them, so
-- this file adds the values and nothing else.
--
-- project_manager  : runs one project end to end; not an organization admin
-- external_reviewer: a named outsider — a lender, an insurer, an expert — who
--                    must be able to read a project and record a decision on it
--                    without gaining any access to the organization around it
--
-- Nothing is granted to either role yet. They exist so that granting them later
-- is a policy change rather than a migration of every table.
alter type public.studio_role add value if not exists 'project_manager';
alter type public.studio_role add value if not exists 'external_reviewer';
