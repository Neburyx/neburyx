CREATE FUNCTION public.applied_preview_migrations() RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF to_regclass('public.kysely_migration_ee') IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE 'SELECT name::text FROM public.kysely_migration_ee ORDER BY name';
END
$$;

REVOKE ALL ON FUNCTION public.applied_preview_migrations() FROM PUBLIC;
