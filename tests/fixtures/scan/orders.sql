-- orders スキーマ。このファイルのコメント内の SQL は拾わない
-- DELETE FROM ghost_sql ;
CREATE TABLE IF NOT EXISTS orders (
  id bigserial PRIMARY KEY
);

CREATE TABLE public.audit_log (
  payload text
);

INSERT INTO orders (id) VALUES (1);

SELECT o.id FROM public.orders o JOIN public.audit_log a ON a.payload = o.id::text;
