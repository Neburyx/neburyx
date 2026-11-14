-- The stored plans are gone with the old Ask path. A run no longer names a plan, so its column and its foreign key go too; the rows of ask_runs stay.
ALTER TABLE ask_runs DROP CONSTRAINT ask_runs_plan_known;
ALTER TABLE ask_runs DROP COLUMN plan_id;
DROP TABLE ask_plans;
