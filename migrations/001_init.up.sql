CREATE TABLE menu_items (
  id    INTEGER PRIMARY KEY,
  name  TEXT    NOT NULL,
  price REAL    CHECK (price > 0)            -- thousands of dong: 45.5 = 45,500 đ
                                             -- (nullable since 2025: a half-done cleanup)
);

CREATE TABLE orders (
  id         INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE order_items (
  order_id     INTEGER NOT NULL REFERENCES orders(id),
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  qty          INTEGER NOT NULL CHECK (qty > 0),
  unit_price   REAL    NOT NULL               -- price at the time of the order, same unit
);
