-- Run this once in the Supabase SQL editor before enabling Kitchen Realtime.
-- The application still performs the initial authenticated GET /orders request.

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kitchen_users_read_own_outlet_orders" ON public.orders;
CREATE POLICY "kitchen_users_read_own_outlet_orders"
ON public.orders
FOR SELECT
TO authenticated
USING (
  restaurant_id = NULLIF((SELECT auth.jwt() ->> 'outlet_id'), '')::integer
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
  END IF;
END $$;
