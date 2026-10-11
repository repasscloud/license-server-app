-- Stripe products are created and managed in Stripe (name, description, images) and linked to
-- offers by ID; the server never creates or renames them. Each checkout records the product it
-- was opened against, so relinking an offer cannot quarantine sessions that are already open.

ALTER TABLE checkouts ADD COLUMN stripe_product_id text;

UPDATE checkouts c SET stripe_product_id = m.stripe_product_id
FROM stripe_product_mappings m
WHERE m.offer_id = c.offer_id AND c.stripe_checkout_session_id IS NOT NULL AND c.stripe_product_id IS NULL;
