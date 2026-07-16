-- Create travel_routes table to hold distance and configurations for city-to-city rides
CREATE TABLE IF NOT EXISTS public.travel_routes (
    id SERIAL PRIMARY KEY,
    from_city TEXT NOT NULL,
    to_city TEXT NOT NULL,
    distance_km NUMERIC NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_route UNIQUE (from_city, to_city)
);

-- Enable RLS on travel_routes
ALTER TABLE IF EXISTS public.travel_routes ENABLE ROW LEVEL SECURITY;

-- Select policy for all users (anon & authenticated)
DROP POLICY IF EXISTS "Public Read Travel Routes" ON public.travel_routes;
CREATE POLICY "Public Read Travel Routes" ON public.travel_routes
    FOR SELECT TO anon, authenticated
    USING (true);

-- Allow admins to manage travel_routes via service_role or API bypass (which uses service role key internally)
DROP POLICY IF EXISTS "Admin Manage Travel Routes" ON public.travel_routes;
CREATE POLICY "Admin Manage Travel Routes" ON public.travel_routes
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- Grant permissions
GRANT SELECT ON public.travel_routes TO anon, authenticated;
GRANT ALL ON public.travel_routes TO service_role;

-- Insert price per kilometer if not already existing
INSERT INTO public.system_settings (key, value)
VALUES ('travel_price_per_km', '1000')
ON CONFLICT (key) DO NOTHING;

-- Populate default routes with distance_km based on standard prices divided by 1000 SDG/km
INSERT INTO public.travel_routes (from_city, to_city, distance_km) VALUES
('الخرطوم', 'مدني', 25),
('مدني', 'الخرطوم', 25),
('الخرطوم', 'القضارف', 35),
('القضارف', 'الخرطوم', 35),
('الخرطوم', 'كسلا', 40),
('كسلا', 'الخرطوم', 40),
('الخرطوم', 'شندي', 15),
('شندي', 'الخرطوم', 15),
('الخرطوم', 'الدامر', 20),
('الدامر', 'الخرطوم', 20),
('الخرطوم', 'عطبرة', 18),
('عطبرة', 'الخرطوم', 18),
('عطبرة', 'الدبة', 10),
('الدبة', 'عطبرة', 10),
('عطبرة', 'دنقلا', 25),
('دنقلا', 'عطبرة', 25),
('بورتسودان', 'كسلا', 45),
('كسلا', 'بورتسودان', 45),
('بورتسودان', 'عطبرة', 35),
('عطبرة', 'بورتسودان', 35),
('بورتسودان', 'الخرطوم', 50),
('الخرطوم', 'بورتسودان', 50),
('كسلا', 'القضارف', 20),
('القضارف', 'كسلا', 20),
('كسلا', 'مدني', 30),
('مدني', 'كسلا', 30),
('مدني', 'القضارف', 15),
('القضارف', 'مدني', 15),
('مدني', 'سنار', 12),
('سنار', 'مدني', 12),
('مدني', 'سنجة', 10),
('سنجة', 'مدني', 10),
('مدني', 'الدمازين', 25),
('الدمازين', 'مدني', 25),
('الخرطوم', 'كوستي', 22),
('كوستي', 'الخرطوم', 22),
('الخرطوم', 'الدبة', 30),
('الدبة', 'الخرطوم', 30),
('الخرطوم', 'دنقلا', 40),
('دنقلا', 'الخرطوم', 40),
('عطبرة', 'ابوحمد', 8),
('ابوحمد', 'عطبرة', 8),
('بورتسودان', 'سنكات', 15),
('سنكات', 'بورتسودان', 15),
('الخرطوم', 'الحصاحيصا', 12),
('الحصاحيصا', 'الخرطوم', 12),
('كسلا', 'عطبرة', 28),
('عطبرة', 'كسلا', 28),
('الخرطوم', 'الأبيض', 30),
('الأبيض', 'الخرطوم', 30),
('بورتسودان', 'القضارف', 40),
('القضارف', 'بورتسودان', 40)
ON CONFLICT (from_city, to_city) DO NOTHING;
