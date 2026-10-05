CREATE TABLE orders (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  customer_name TEXT NOT NULL CHECK (btrim(customer_name) <> ''),
  customer_email TEXT NOT NULL CHECK (btrim(customer_email) <> ''),
  customer_phone TEXT NOT NULL CHECK (btrim(customer_phone) <> ''),
  shipping_address TEXT NOT NULL CHECK (btrim(shipping_address) <> ''),
  shipping_zip_code TEXT NOT NULL CHECK (btrim(shipping_zip_code) <> ''),
  shipping_city TEXT NOT NULL CHECK (btrim(shipping_city) <> ''),
  shipping_country TEXT NOT NULL CHECK (btrim(shipping_country) <> ''),
  payment_method TEXT NOT NULL CHECK (payment_method = 'cash'),
  currency TEXT NOT NULL CHECK (currency = 'EUR'),
  subtotal_cents BIGINT NOT NULL CHECK (subtotal_cents BETWEEN 0 AND 9007199254740991),
  net_subtotal_cents BIGINT NOT NULL CHECK (net_subtotal_cents BETWEEN 0 AND 9007199254740991),
  vat_cents BIGINT NOT NULL CHECK (vat_cents BETWEEN 0 AND 9007199254740991),
  shipping_cents BIGINT NOT NULL CHECK (shipping_cents BETWEEN 0 AND 9007199254740991),
  total_cents BIGINT NOT NULL CHECK (total_cents BETWEEN 0 AND 9007199254740991),
  items JSONB NOT NULL CHECK (
    CASE WHEN jsonb_typeof(items) = 'array'
      THEN jsonb_array_length(items) > 0
      ELSE FALSE
    END
  ),
  CONSTRAINT orders_subtotal_check CHECK (net_subtotal_cents + vat_cents = subtotal_cents),
  CONSTRAINT orders_total_check CHECK (subtotal_cents + shipping_cents = total_cents)
);
