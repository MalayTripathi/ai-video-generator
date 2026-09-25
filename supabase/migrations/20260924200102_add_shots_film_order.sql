-- The Storyboard's picture order, separate from the script's order_index. Null means
-- "follow the script": every Storyboard read uses coalesce(film_order, order_index), so
-- film_order shares order_index's index space. The Storyboard never writes order_index.
ALTER TABLE "public"."shots"
    ADD COLUMN "film_order" integer;
