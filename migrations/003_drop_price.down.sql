ALTER TABLE menu_items ADD COLUMN price REAL CHECK (price > 0);
