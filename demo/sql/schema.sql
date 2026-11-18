-- 注文 DB のスキーマ
CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  customer_id bigint NOT NULL,
  amount numeric NOT NULL,
  status text NOT NULL
);

CREATE TABLE order_drafts (
  id bigserial PRIMARY KEY,
  token text UNIQUE NOT NULL
);

CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  order_id bigint REFERENCES orders (id),
  channel text NOT NULL
);
