-- the list of a person's named views across their investigations pages by the time a view was made and its id, newest first
CREATE INDEX saved_views_named_created ON saved_views (created_at DESC, id DESC) WHERE kind = 'named';
