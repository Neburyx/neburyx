CREATE FUNCTION public.applied_migrations() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT name FROM public.kysely_migration ORDER BY name $$;

REVOKE ALL ON FUNCTION public.applied_migrations() FROM PUBLIC;
