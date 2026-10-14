ALTER TABLE menu_items ADD COLUMN price_vnd INTEGER CHECK (price_vnd > 0);
