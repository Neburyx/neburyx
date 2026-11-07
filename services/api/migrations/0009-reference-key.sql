ALTER TABLE deployment ADD COLUMN reference_key bytea CONSTRAINT deployment_reference_key_length CHECK (reference_key IS NULL OR octet_length(reference_key) = 32);

CREATE FUNCTION deployment_reference_key_is_set_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reference_key IS NOT NULL AND NEW.reference_key IS DISTINCT FROM OLD.reference_key THEN
    RAISE EXCEPTION 'the reference key is set once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER deployment_reference_key_once BEFORE UPDATE ON deployment FOR EACH ROW EXECUTE FUNCTION deployment_reference_key_is_set_once();
