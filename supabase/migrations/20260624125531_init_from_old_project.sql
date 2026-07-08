SET check_function_bodies = false;
DROP EXTENSION IF EXISTS pg_net;
DROP EXTENSION IF EXISTS pg_graphql;
DO $$ BEGIN CREATE ROLE supabase_privileged_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN GRANT supabase_privileged_role TO postgres; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
CREATE SCHEMA ai_config AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA ai_config TO anon;
GRANT USAGE ON SCHEMA ai_config TO authenticated;
GRANT USAGE ON SCHEMA ai_config TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ai_config GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ai_config GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA ai_config GRANT ALL ON TABLES TO service_role;
CREATE TYPE ai_config.algorithm_action_enum AS ENUM ('created', 'updated', 'parameter_changed', 'enabled', 'disabled', 'executed', 'retrained');
CREATE TYPE ai_config.algorithm_status_enum AS ENUM ('active', 'inactive', 'training', 'testing', 'failed');
CREATE TABLE ai_config.algorithm_logs (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, algorithm_id uuid NOT NULL, status ai_config.algorithm_status_enum NOT NULL, action ai_config.algorithm_action_enum NOT NULL, details text, created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE ai_config.algorithm_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_config.algorithm_logs ADD CONSTRAINT algorithm_logs_pkey PRIMARY KEY (id);
GRANT ALL ON ai_config.algorithm_logs TO anon;
GRANT ALL ON ai_config.algorithm_logs TO authenticated;
GRANT ALL ON ai_config.algorithm_logs TO service_role;
CREATE INDEX idx_algorithm_logs_created_at ON ai_config.algorithm_logs (created_at DESC);
CREATE INDEX idx_algorithm_logs_algorithm_id ON ai_config.algorithm_logs (algorithm_id);
CREATE TABLE ai_config.algorithm_parameters (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, algorithm_id uuid NOT NULL, parameter_name character varying(100) NOT NULL, default_value double precision, current_value double precision, description text, created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP, updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP, min_value numeric DEFAULT 0, max_value numeric DEFAULT 1);
ALTER TABLE ai_config.algorithm_parameters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_config.algorithm_parameters ADD CONSTRAINT algorithm_parameters_pkey PRIMARY KEY (id);
ALTER TABLE ai_config.algorithm_parameters ADD CONSTRAINT uq_algorithm_parameter UNIQUE (algorithm_id, parameter_name);
GRANT ALL ON ai_config.algorithm_parameters TO anon;
GRANT ALL ON ai_config.algorithm_parameters TO authenticated;
GRANT ALL ON ai_config.algorithm_parameters TO service_role;
CREATE INDEX idx_algorithm_parameters_algorithm_id ON ai_config.algorithm_parameters (algorithm_id);
CREATE TABLE ai_config.algorithms (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, name character varying(100) NOT NULL, description text, is_active boolean DEFAULT true, created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP, updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE ai_config.algorithms ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_config.algorithms ADD CONSTRAINT algorithms_name_key UNIQUE (name);
ALTER TABLE ai_config.algorithms ADD CONSTRAINT algorithms_pkey PRIMARY KEY (id);
ALTER TABLE ai_config.algorithm_logs ADD CONSTRAINT algorithm_logs_algorithm_id_fkey FOREIGN KEY (algorithm_id) REFERENCES ai_config.algorithms(id) ON DELETE CASCADE;
ALTER TABLE ai_config.algorithm_parameters ADD CONSTRAINT algorithm_parameters_algorithm_id_fkey FOREIGN KEY (algorithm_id) REFERENCES ai_config.algorithms(id) ON DELETE CASCADE;
GRANT ALL ON ai_config.algorithms TO anon;
GRANT ALL ON ai_config.algorithms TO authenticated;
GRANT ALL ON ai_config.algorithms TO service_role;
CREATE EXTENSION postgis WITH SCHEMA extensions;
CREATE EXTENSION vector WITH SCHEMA extensions;
CREATE SCHEMA order_sys AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA order_sys TO anon;
GRANT USAGE ON SCHEMA order_sys TO authenticated;
GRANT USAGE ON SCHEMA order_sys TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA order_sys GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA order_sys GRANT SELECT ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA order_sys GRANT INSERT, SELECT, UPDATE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA order_sys GRANT SELECT, USAGE ON SEQUENCES TO service_role;
CREATE TYPE order_sys.order_status_enum AS ENUM ('pending', 'processing', 'completed', 'cancelled');
CREATE FUNCTION order_sys.get_food_performance(p_vendor_id uuid)
 RETURNS TABLE(food_id uuid, food_name text, place_name text, price numeric, order_count bigint)
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    SELECT
        fi.id,
        fi.name::TEXT,
        p.name::TEXT,
        fi.price,
        COALESCE(COUNT(oi.id), 0)::BIGINT
    FROM order_sys.food_items fi
    JOIN travel.places p ON p.id = fi.place_id
    LEFT JOIN order_sys.order_items oi ON oi.food_item_id = fi.id
    WHERE p.vendor_id = p_vendor_id
    GROUP BY fi.id, fi.name, p.name, fi.price
    ORDER BY COALESCE(COUNT(oi.id), 0) DESC;
END;
$function$;
CREATE FUNCTION order_sys.get_order_detail(p_order_id uuid)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE result JSON;
BEGIN

SELECT json_build_object(
    'order_id', o.id,
    'customer_name', u.full_name,
    'phone', u.phone_number,
    'email', u.email,
    'status', o.status,
    'notes', o.notes,
    'total_amount', o.total_amount,
    'ordered_time', o.ordered_at,

    'foods',
    (
        SELECT json_agg(
            json_build_object(
                'food_name', f.name,
                'quantity', oi.quantity,
                'price', oi.unit_price
            )
        )
        FROM order_sys.order_items oi
        JOIN order_sys.food_items f
        ON f.id = oi.food_item_id
        WHERE oi.order_id = o.id
    )

)
INTO result
FROM order_sys.orders o
JOIN users u
ON u.id = o.tourist_id
WHERE o.id = p_order_id;

RETURN result;

END;
$function$;
CREATE FUNCTION order_sys.get_orders_by_place(p_vendor_id uuid)
 RETURNS TABLE(order_id uuid, ordered_time timestamp without time zone, customer_name text, foods text, total_amount numeric, status text, place_name text)
 LANGUAGE plpgsql
AS $function$
BEGIN

RETURN QUERY
SELECT
    o.id,
    o.ordered_at,
    u.full_name::TEXT,

    COALESCE(STRING_AGG(f.name, ', '), '')::TEXT,

    o.total_amount,
    o.status::TEXT,
    p.name::TEXT

FROM order_sys.orders o

JOIN users u
    ON u.id = o.tourist_id

LEFT JOIN order_sys.order_items oi
    ON oi.order_id = o.id

LEFT JOIN order_sys.food_items f
    ON f.id = oi.food_item_id

LEFT JOIN travel.itinerary_details idt
    ON idt.id = o.itinerary_detail_id

LEFT JOIN travel.places p
    ON p.id = idt.place_id

-- ✅ FIX: lọc theo vendor_id
WHERE p.vendor_id = p_vendor_id

GROUP BY 
    o.id,
    o.ordered_at,
    u.full_name,
    o.total_amount,
    o.status,
    p.name

ORDER BY o.ordered_at DESC;

END;
$function$;
CREATE TABLE order_sys.food_items (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, name character varying(200), description text, price numeric(10,2), place_id uuid, image_url text[] DEFAULT '{}'::text[], category text, is_active boolean DEFAULT true, foody_dish_id text, foody_dish_type_id text);
ALTER TABLE order_sys.food_items ADD CONSTRAINT food_items_pkey PRIMARY KEY (id);
ALTER TABLE order_sys.food_items ADD CONSTRAINT uq_foody_dish_id UNIQUE (foody_dish_id);
GRANT SELECT ON order_sys.food_items TO anon;
GRANT SELECT ON order_sys.food_items TO authenticated;
GRANT ALL ON order_sys.food_items TO service_role;
CREATE TABLE order_sys.order_items (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, quantity integer, unit_price numeric(10,2), total_price numeric(12,2), order_id uuid, food_item_id uuid);
ALTER TABLE order_sys.order_items ADD CONSTRAINT order_items_food_item_id_fkey FOREIGN KEY (food_item_id) REFERENCES order_sys.food_items(id);
ALTER TABLE order_sys.order_items ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);
GRANT SELECT ON order_sys.order_items TO anon;
GRANT SELECT ON order_sys.order_items TO authenticated;
GRANT ALL ON order_sys.order_items TO service_role;
CREATE TABLE order_sys.orders (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, ordered_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP, total_amount numeric(12,2), status order_sys.order_status_enum, notes text, tourist_id uuid, itinerary_detail_id uuid);
ALTER TABLE order_sys.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
ALTER TABLE order_sys.order_items ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES order_sys.orders(id) ON DELETE CASCADE;
GRANT SELECT ON order_sys.orders TO anon;
GRANT SELECT ON order_sys.orders TO authenticated;
GRANT ALL ON order_sys.orders TO service_role;
CREATE EXTENSION pg_trgm WITH SCHEMA public;
CREATE EXTENSION unaccent WITH SCHEMA public;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO service_role;
CREATE FUNCTION public.get_active_users_chart(p_start_date date, p_end_date date, p_interval text)
 RETURNS TABLE(time_label text, users_count integer)
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    WITH date_series AS (
        -- Cơ chế tạo trục thời gian: Sinh ra các mốc (bucket) dựa trên start/end và khoảng chia
        SELECT generate_series(
            p_start_date::timestamp, 
            p_end_date::timestamp, 
            p_interval::interval
        ) AS bucket_time
    )
    SELECT 
        -- Cơ chế định dạng nhãn hiển thị: 
        -- Nếu chia theo tháng thì trả về MM/YYYY, nếu chia theo ngày thì trả về DD/MM
        CASE 
            WHEN p_interval = '1 month' THEN to_char(d.bucket_time, 'MM/YYYY')
            ELSE to_char(d.bucket_time, 'DD/MM')
        END AS time_label,
        COUNT(u.id)::INT AS users_count
    FROM date_series d
    LEFT JOIN public.users u 
        -- Ràng buộc logic nghiệp vụ: Chỉ lấy Business/Tourist, Active, Not Deleted
        ON u.role IN ('TOURIST', 'BUSINESS')
        AND u.is_active = '1'::"bit"
        AND u.is_deleted = '0'::"bit"
        -- Cơ chế khớp dữ liệu: Cắt bỏ phần giờ/phút của created_at để khớp với bucket_time
        AND date_trunc(
            CASE WHEN p_interval = '1 month' THEN 'month' ELSE 'day' END, 
            u.created_at AT TIME ZONE 'UTC'
        ) = d.bucket_time
    GROUP BY d.bucket_time
    ORDER BY d.bucket_time ASC;
END;
$function$;
GRANT ALL ON FUNCTION public.get_active_users_chart(date, date, text) TO anon;
GRANT ALL ON FUNCTION public.get_active_users_chart(date, date, text) TO authenticated;
GRANT ALL ON FUNCTION public.get_active_users_chart(date, date, text) TO service_role;
CREATE FUNCTION public.get_business_profile(user_id_param uuid)
 RETURNS TABLE(full_name text, email text, phone_number text, identity_card text, date_of_birth date, address text, avatar_url text, is_approved boolean, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$BEGIN
    RETURN QUERY
    SELECT 
        u.full_name, 
        u.email, 
        u.phone_number, 
        b.identity_card, 
        u.date_of_birth, -- Chuyển sang lấy từ bảng users
        b.address, 
        u.avatar_url,
        b.is_approved, 
        u.created_at
    FROM public.users u
    JOIN public.businesses b ON u.id = b.id
    WHERE u.id = user_id_param;
END;$function$;
GRANT ALL ON FUNCTION public.get_business_profile(uuid) TO anon;
GRANT ALL ON FUNCTION public.get_business_profile(uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_business_profile(uuid) TO service_role;
CREATE FUNCTION public.get_cities_for_plan_trip(p_keyword text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, name text)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  IF p_keyword IS NOT NULL AND p_keyword <> '' THEN
    RETURN QUERY
      SELECT c.id::uuid, c.name::text
      FROM travel.cities c
      WHERE c.name ILIKE '%' || p_keyword || '%'
      ORDER BY c.name
      LIMIT 20;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT c.id::uuid, c.name::text
    FROM travel.cities c
    WHERE c.id IN (
      '3b9a22b3-293b-5313-97c5-d9b71c30756f',
      'a821f185-9826-568f-a3d2-967f0efd1c9d',
      '8a10b8b8-6875-58e0-9bee-27f67e54376e',
      '340af4ff-0cda-5e1a-8e02-a999acc906f6',
      '2cae585f-0b4d-570c-b649-ee25b6aa1f43',
      '1aa5ed1b-16c1-51f4-a3ba-c25e0ed91ce5',
      '7eedad92-8762-57fd-9584-566b0653b957',
      '477a099d-8dd4-5899-877c-b911a1c7fb8b',
      '477756f3-d73f-55b7-8698-21d64befaf2d',
      'fc51a18f-b4bb-5183-9d81-6a7e03a0ca4a',
      '72785a4f-069f-52b1-ac69-e46d648d4fd4',
      '3cf95641-de1c-5baf-97a7-6f23cd4e72c6',
      '9d697eb4-3bf0-58a8-9f31-e086d59d7c7d',
      'fea5f034-8761-5385-97be-d3ddd4321f28'
    )
    ORDER BY CASE c.id::text
      WHEN '3b9a22b3-293b-5313-97c5-d9b71c30756f' THEN 1
      WHEN 'a821f185-9826-568f-a3d2-967f0efd1c9d' THEN 2
      WHEN '8a10b8b8-6875-58e0-9bee-27f67e54376e' THEN 3
      WHEN '340af4ff-0cda-5e1a-8e02-a999acc906f6' THEN 4
      WHEN '2cae585f-0b4d-570c-b649-ee25b6aa1f43' THEN 5
      WHEN '1aa5ed1b-16c1-51f4-a3ba-c25e0ed91ce5' THEN 6
      WHEN '7eedad92-8762-57fd-9584-566b0653b957' THEN 7
      WHEN '477a099d-8dd4-5899-877c-b911a1c7fb8b' THEN 8
      WHEN '477756f3-d73f-55b7-8698-21d64befaf2d' THEN 9
      WHEN 'fc51a18f-b4bb-5183-9d81-6a7e03a0ca4a' THEN 10
      WHEN '72785a4f-069f-52b1-ac69-e46d648d4fd4' THEN 11
      WHEN '3cf95641-de1c-5baf-97a7-6f23cd4e72c6' THEN 12
      WHEN '9d697eb4-3bf0-58a8-9f31-e086d59d7c7d' THEN 13
      WHEN 'fea5f034-8761-5385-97be-d3ddd4321f28' THEN 14
    END;
END;
$function$;
GRANT ALL ON FUNCTION public.get_cities_for_plan_trip(text) TO anon;
GRANT ALL ON FUNCTION public.get_cities_for_plan_trip(text) TO authenticated;
GRANT ALL ON FUNCTION public.get_cities_for_plan_trip(text) TO service_role;
CREATE FUNCTION public.get_city_favorite_counts()
 RETURNS TABLE(city_id uuid, city_name text, favorite_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT 
    c.id        AS city_id,
    c.name      AS city_name,
    COUNT(fp.place_id) AS favorite_count
  FROM travel.cities c
  LEFT JOIN travel.places p 
    ON p.city_id = c.id 
    AND p.is_approved = true 
    AND p.is_active = true
  LEFT JOIN travel.favorite_places fp 
    ON fp.place_id = p.id
  GROUP BY c.id, c.name
  ORDER BY COUNT(fp.place_id) DESC, c.name ASC
$function$;
GRANT ALL ON FUNCTION public.get_city_favorite_counts() TO anon;
GRANT ALL ON FUNCTION public.get_city_favorite_counts() TO authenticated;
GRANT ALL ON FUNCTION public.get_city_favorite_counts() TO service_role;
CREATE FUNCTION public.get_orders(p_place_id uuid, p_status text DEFAULT 'all'::text, p_restaurant text DEFAULT 'all'::text, p_page integer DEFAULT 1, p_limit integer DEFAULT 10)
 RETURNS TABLE(order_id uuid, place_name text, customer_name text, status text, ordered_time timestamp without time zone, total_amount numeric, total_count bigint)
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    o.order_id,
    o.place_name,
    o.customer_name,
    o.status,
    o.ordered_time,
    o.total_amount,
    COUNT(*) OVER() AS total_count
  FROM orders o
  WHERE o.place_id = p_place_id
    AND (p_status = 'all' OR o.status = p_status)
    AND (p_restaurant = 'all' OR o.place_name = p_restaurant)
  ORDER BY o.ordered_time DESC
  LIMIT p_limit
  OFFSET (p_page - 1) * p_limit;
END;
$function$;
GRANT ALL ON FUNCTION public.get_orders(uuid, text, text, integer, integer) TO anon;
GRANT ALL ON FUNCTION public.get_orders(uuid, text, text, integer, integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_orders(uuid, text, text, integer, integer) TO service_role;
CREATE FUNCTION public.get_place_popularity_stats(p_limit integer DEFAULT 20, p_mode text DEFAULT 'top'::text)
 RETURNS TABLE(place_id uuid, place_name text, visit_count bigint, completed_count bigint, planning_count bigint, ongoing_count bigint, total_count bigint)
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF p_mode NOT IN ('top', 'flop') THEN
    RAISE EXCEPTION 'p_mode phải là ''top'' hoặc ''flop''';
  END IF;

  IF p_mode = 'top' THEN
    RETURN QUERY
    SELECT
      p.id,
      p.name::TEXT,
      COUNT(DISTINCT gv.tourist_id)::BIGINT                                         AS visit_count,
      COUNT(gv.itinerary_detail_id) FILTER (WHERE i.status = 'completed')::BIGINT   AS completed_count,
      COUNT(gv.itinerary_detail_id) FILTER (WHERE i.status = 'pending')::BIGINT     AS planning_count,
      COUNT(gv.itinerary_detail_id) FILTER (WHERE i.status = 'ongoing')::BIGINT     AS ongoing_count,
      COUNT(gv.itinerary_detail_id)::BIGINT                                         AS total_count
    FROM   tracking.geofence_visits  gv
    JOIN   travel.itinerary_details  id  ON id.id = gv.itinerary_detail_id
    JOIN   travel.places             p   ON p.id  = id.place_id
    JOIN   travel.itineraries        i   ON i.id  = gv.itinerary_id
    WHERE  gv.checked_in_at IS NOT NULL
      AND  gv.tourist_id    IS NOT NULL
    GROUP  BY p.id, p.name
    ORDER  BY COUNT(DISTINCT gv.tourist_id) DESC
    LIMIT  p_limit;

  ELSE
    RETURN QUERY
    SELECT
      p.id,
      p.name::TEXT,
      COUNT(DISTINCT gv.tourist_id)::BIGINT,
      COUNT(gv.itinerary_detail_id) FILTER (WHERE i.status = 'completed')::BIGINT,
      COUNT(gv.itinerary_detail_id) FILTER (WHERE i.status = 'pending')::BIGINT,
      COUNT(gv.itinerary_detail_id) FILTER (WHERE i.status = 'ongoing')::BIGINT,
      COUNT(gv.itinerary_detail_id)::BIGINT
    FROM   tracking.geofence_visits  gv
    JOIN   travel.itinerary_details  id  ON id.id = gv.itinerary_detail_id
    JOIN   travel.places             p   ON p.id  = id.place_id
    JOIN   travel.itineraries        i   ON i.id  = gv.itinerary_id
    WHERE  gv.checked_in_at IS NOT NULL
      AND  gv.tourist_id    IS NOT NULL
    GROUP  BY p.id, p.name
    ORDER  BY COUNT(DISTINCT gv.tourist_id) ASC
    LIMIT  p_limit;
  END IF;
END;
$function$;
GRANT ALL ON FUNCTION public.get_place_popularity_stats(integer, text) TO anon;
GRANT ALL ON FUNCTION public.get_place_popularity_stats(integer, text) TO authenticated;
GRANT ALL ON FUNCTION public.get_place_popularity_stats(integer, text) TO service_role;
CREATE FUNCTION public.get_tourist_profile(user_id_param uuid)
 RETURNS TABLE(full_name text, gender text, phone_number text, email text, travel_preferences text[], avatar_url text, created_at timestamp with time zone)
 LANGUAGE plpgsql
AS $function$BEGIN
    RETURN QUERY
    SELECT 
        u.full_name, 
        t.gender, 
        u.phone_number, 
        u.email, 
        t.travel_preferences, 
        u.avatar_url,
        u.created_at
    FROM public.users u
    JOIN public.tourists t ON u.id = t.id
    WHERE u.id = user_id_param;
END;$function$;
GRANT ALL ON FUNCTION public.get_tourist_profile(uuid) TO anon;
GRANT ALL ON FUNCTION public.get_tourist_profile(uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_tourist_profile(uuid) TO service_role;
CREATE FUNCTION public.get_user_detail_by_admin(p_user_id uuid)
 RETURNS TABLE(id uuid, role text, email text, full_name text, phone_number text, date_of_birth date, avatar_url text, is_active bit, is_deleted bit, created_at timestamp with time zone, address text)
 LANGUAGE plpgsql
AS $function$BEGIN
    RETURN QUERY
    SELECT 
        u.id,
        u.role,
        u.email,
        u.full_name,
        u.phone_number,
        u.date_of_birth,
        u.avatar_url,
        u.is_active,
        u.is_deleted,
        u.created_at,
        -- COALESCE sẽ lấy giá trị đầu tiên KHÔNG NULL.
        -- Nếu là BUSINESS, nó lấy b.address. Nếu là TOURIST, nó lấy t.address. Nếu là ADMIN thì trả về NULL.
        COALESCE(b.address) AS address
    FROM public.users u
    -- Nối với bảng businesses (chỉ nối nếu role là BUSINESS)
    LEFT JOIN public.businesses b ON u.id = b.id AND u.role = 'BUSINESS'
    -- Nối với bảng tourists (chỉ nối nếu role là TOURIST)
    LEFT JOIN public.tourists t ON u.id = t.id AND u.role = 'TOURIST'
    WHERE u.id = p_user_id;
END;$function$;
GRANT ALL ON FUNCTION public.get_user_detail_by_admin(uuid) TO anon;
GRANT ALL ON FUNCTION public.get_user_detail_by_admin(uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_user_detail_by_admin(uuid) TO service_role;
CREATE FUNCTION public.get_user_interaction_stats()
 RETURNS TABLE(total_valid_users bigint, no_interaction_users bigint, created_trip_users bigint, completed_trip_users bigint)
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    -- Bước 1: Tính toán thống kê cá nhân cho từng User
    WITH UserTripStats AS (
        SELECT 
            u.id,
            COUNT(i.id)::INT AS total_trips,
            COUNT(i.id) FILTER (WHERE i.status = 'completed')::INT AS completed_trips
        FROM public.users u
        -- Phải dùng LEFT JOIN để giữ lại những User chưa tạo lịch trình nào
        LEFT JOIN travel.itineraries i ON u.id = i.creator_id
        -- Ràng buộc: Chỉ lấy user đang active và chưa bị xóa
        WHERE u.is_active = '1'::"bit" AND u.is_deleted = '0'::"bit" AND u.role = 'TOURIST'
        GROUP BY u.id
    )
    -- Bước 2: Gom nhóm toàn cục để xuất ra 4 con số
    SELECT 
        COUNT(*)::BIGINT AS total_valid_users,
        
        -- Tập 1: Số chuyến đi = 0
        COUNT(*) FILTER (WHERE total_trips = 0)::BIGINT AS no_interaction_users,
        
        -- Tập 2: Có tạo chuyến đi (>0) NHƯNG KHÔNG CÓ chuyến nào completed (=0)
        COUNT(*) FILTER (WHERE total_trips > 0 AND completed_trips = 0)::BIGINT AS created_trip_users,
        
        -- Tập 3: Có ÍT NHẤT 1 chuyến đi completed (>0)
        COUNT(*) FILTER (WHERE completed_trips > 0)::BIGINT AS completed_trip_users
        
    FROM UserTripStats;
END;
$function$;
GRANT ALL ON FUNCTION public.get_user_interaction_stats() TO anon;
GRANT ALL ON FUNCTION public.get_user_interaction_stats() TO authenticated;
GRANT ALL ON FUNCTION public.get_user_interaction_stats() TO service_role;
CREATE FUNCTION public.get_user_statistics()
 RETURNS TABLE(total_users bigint, new_this_month bigint, total_admins bigint)
 LANGUAGE plpgsql
AS $function$BEGIN
    RETURN QUERY
    SELECT 
        -- 1. Đếm tổng user (chỉ đếm những user chưa bị xóa mềm)
        COUNT(*) AS total_users,
        
        -- 2. Đếm user mới trong tháng hiện tại
        COUNT(*) FILTER (
            WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)
        ) AS new_this_month,
        
        -- 3. Đếm số lượng Admin
        COUNT(*) FILTER (
            WHERE role = 'ADMIN'
        ) AS total_admins
        
    FROM public.users
    WHERE is_deleted = '0'; -- Bỏ qua các user đã bị xóa
END;$function$;
GRANT ALL ON FUNCTION public.get_user_statistics() TO anon;
GRANT ALL ON FUNCTION public.get_user_statistics() TO authenticated;
GRANT ALL ON FUNCTION public.get_user_statistics() TO service_role;
CREATE FUNCTION public.get_users_list(page_number integer DEFAULT 1, page_size integer DEFAULT 10, search_text text DEFAULT NULL::text, filter_role text DEFAULT NULL::text, filter_is_active bit DEFAULT NULL::"bit", filter_is_deleted bit DEFAULT NULL::"bit")
 RETURNS TABLE(total_count bigint, id uuid, role text, email text, full_name text, is_active bit, is_deleted bit, created_at timestamp with time zone, avatar_url text)
 LANGUAGE plpgsql
AS $function$
DECLARE
    calc_offset INT;
BEGIN
    -- Tính toán vị trí bắt đầu (Offset)
    calc_offset := (page_number - 1) * page_size;

    RETURN QUERY
    SELECT 
        COUNT(*) OVER() AS total_count,
        u.id,
        u.role,
        u.email,
        u.full_name,
        u.is_active,
        u.is_deleted,
        u.created_at,
        u.avatar_url
    FROM public.users u
    WHERE 
        -- Lọc theo Search (Tìm tương đối ILIKE trên Tên và Email)
        (search_text IS NULL OR u.full_name ILIKE '%' || search_text || '%' OR u.email ILIKE '%' || search_text || '%')
        
        -- Lọc theo Role
        AND (filter_role IS NULL OR u.role = filter_role)
        
        -- Lọc theo Trạng thái hoạt động
        AND (filter_is_active IS NULL OR u.is_active = filter_is_active)
        
        -- Lọc theo Trạng thái xóa mềm
        AND (filter_is_deleted IS NULL OR u.is_deleted = filter_is_deleted)
        
    ORDER BY u.created_at DESC
    LIMIT page_size
    OFFSET calc_offset;
END;
$function$;
GRANT ALL ON FUNCTION public.get_users_list(integer, integer, text, text, bit, bit) TO anon;
GRANT ALL ON FUNCTION public.get_users_list(integer, integer, text, text, bit, bit) TO authenticated;
GRANT ALL ON FUNCTION public.get_users_list(integer, integer, text, text, bit, bit) TO service_role;
CREATE FUNCTION public.handle_new_tourist_registration()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- Kiểm tra xem user mới này có role là TOURIST không (ta sẽ truyền từ code NestJS xuống)
  IF (new.raw_user_meta_data->>'role') = 'TOURIST' THEN
    -- Móc dữ liệu từ metadata và chèn vào bảng tourists
    INSERT INTO public.tourists (id, email, full_name, gender, phone_number)
    VALUES (
      new.id, 
      new.email,
      new.raw_user_meta_data->>'full_name', -- Lưu ý: Key json phải map với NestJS
      new.raw_user_meta_data->>'gender',
      new.raw_user_meta_data->>'phone_number'
    );
  END IF;
  RETURN new;
END;
$function$;
GRANT ALL ON FUNCTION public.handle_new_tourist_registration() TO anon;
GRANT ALL ON FUNCTION public.handle_new_tourist_registration() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_tourist_registration() TO service_role;
CREATE FUNCTION public.handle_new_user_registration()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    user_role TEXT;
    user_status BIT; -- Khai báo thêm biến trạng thái
BEGIN
    -- 1. Lấy role từ metadata
    user_role := COALESCE(new.raw_user_meta_data->>'role', 'TOURIST');
    
    -- 2. Lấy trạng thái từ metadata (Nếu gửi lên 'LOCKED' thì gán '0', còn lại mặc định '1')
    IF new.raw_user_meta_data->>'status' = 'LOCKED' THEN
        user_status := B'0';
    ELSE
        user_status := B'1';
    END IF;

    -- 3. LUÔN LUÔN tạo 1 record ở bảng cha (public.users) trước
    INSERT INTO public.users (id, role, email, full_name, phone_number, avatar_url, is_active)
    VALUES (
        new.id, 
        user_role, 
        new.email,
        COALESCE(new.raw_user_meta_data->>'full_name', 'Unknown User'),
        new.raw_user_meta_data->>'phone_number',
        new.raw_user_meta_data->>'avatar_url',
        user_status -- Chèn thêm trạng thái vào đây
    );

    -- 4. Dựa vào role, rẽ nhánh insert vào các bảng con tương ứng
    CASE user_role
        WHEN 'TOURIST' THEN
            INSERT INTO public.tourists (id, gender)
            VALUES (new.id, new.raw_user_meta_data->>'gender');
            
        WHEN 'BUSINESS' THEN
            INSERT INTO public.businesses (id, address)
            VALUES (new.id, new.raw_user_meta_data->>'address');

        WHEN 'ADMIN' THEN
            NULL; 
            
        ELSE
            RAISE NOTICE 'Role không hợp lệ: %', user_role;
    END CASE;
    
    RETURN new;
END;
$function$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_registration();
GRANT ALL ON FUNCTION public.handle_new_user_registration() TO anon;
GRANT ALL ON FUNCTION public.handle_new_user_registration() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_user_registration() TO service_role;
CREATE FUNCTION public.recommend_places_by_slot(query_embedding extensions.vector, target_city_id uuid, p_slot_type character varying, p_limit integer DEFAULT 20, p_travel_type character varying DEFAULT NULL::character varying)
 RETURNS TABLE(place_id uuid, place_name text, address text, image_url text, category text, type_name text, score double precision)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    p.id                                              AS place_id,
    p.name::text                                      AS place_name,
    p.address::text,
    (p.image_url)[1]                                  AS image_url,
    p.slot_type::text                                 AS category,
    t.name::text                                      AS type_name,
    1 - (p.embedding_256 <=> query_embedding)         AS score
  FROM travel.places p
  JOIN travel.types t ON t.id = p.type_id
  WHERE p.city_id       = target_city_id
    AND p.slot_type     = p_slot_type
    AND p.is_active     = true
    AND p.embedding_256 IS NOT NULL
    AND (
      p_travel_type IS NULL
      OR p_slot_type != 'attraction'
      OR p.travel_type = p_travel_type
      OR p.travel_type IS NULL
    )
  ORDER BY p.embedding_256 <=> query_embedding
  LIMIT p_limit
$function$;
GRANT ALL ON FUNCTION public.recommend_places_by_slot(extensions.vector, uuid, character varying, integer, character varying) TO anon;
GRANT ALL ON FUNCTION public.recommend_places_by_slot(extensions.vector, uuid, character varying, integer, character varying) TO authenticated;
GRANT ALL ON FUNCTION public.recommend_places_by_slot(extensions.vector, uuid, character varying, integer, character varying) TO service_role;
CREATE FUNCTION public.soft_delete_users(p_user_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
AS $function$DECLARE
    v_deleted_count INT;
BEGIN
    UPDATE public.users
    SET 
        is_deleted = '1',
        is_active = '0'  -- Bổ sung: Vô hiệu hóa trạng thái hoạt động của user
    WHERE id = ANY(p_user_ids) 
      AND (is_deleted IS NULL OR is_deleted = '0'); -- Tránh update lại những user đã xóa rồi

    -- Lấy số lượng dòng đã bị ảnh hưởng (đã update thành công)
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    
    RETURN v_deleted_count;
END;$function$;
GRANT ALL ON FUNCTION public.soft_delete_users(uuid[]) TO anon;
GRANT ALL ON FUNCTION public.soft_delete_users(uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.soft_delete_users(uuid[]) TO service_role;
CREATE FUNCTION public.update_business_profile(user_id_param uuid, new_full_name text DEFAULT NULL::text, new_phone_number text DEFAULT NULL::text, new_identity_card text DEFAULT NULL::text, new_dob text DEFAULT NULL::text, new_address text DEFAULT NULL::text, new_avatar_url text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
    -- Cập nhật các trường chung ở bảng users
    UPDATE public.users
    SET 
        full_name = COALESCE(new_full_name, full_name),
        phone_number = COALESCE(new_phone_number, phone_number),
        date_of_birth = COALESCE(new_dob::DATE, date_of_birth),
        avatar_url = COALESCE(new_avatar_url, avatar_url)
    WHERE id = user_id_param;

    -- Cập nhật các trường riêng ở bảng businesses
    UPDATE public.businesses
    SET 
        identity_card = COALESCE(new_identity_card, identity_card),
        address = COALESCE(new_address, address)
    WHERE id = user_id_param;
END;
$function$;
GRANT ALL ON FUNCTION public.update_business_profile(uuid, text, text, text, text, text, text) TO anon;
GRANT ALL ON FUNCTION public.update_business_profile(uuid, text, text, text, text, text, text) TO authenticated;
GRANT ALL ON FUNCTION public.update_business_profile(uuid, text, text, text, text, text, text) TO service_role;
CREATE FUNCTION public.update_tourist_profile(user_id_param uuid, new_full_name text DEFAULT NULL::text, new_gender text DEFAULT NULL::text, new_phone_number text DEFAULT NULL::text, new_email text DEFAULT NULL::text, new_preferences text[] DEFAULT NULL::text[], new_avatar_url text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
    -- Cập nhật các trường chung ở bảng users
    UPDATE public.users
    SET 
        full_name = COALESCE(new_full_name, full_name),
        phone_number = COALESCE(new_phone_number, phone_number),
        -- Lưu ý: Nếu đổi email ở đây, nó chỉ đổi ở schema public. 
        -- Email để đăng nhập ở auth.users vẫn giữ nguyên trừ khi bạn gọi API đổi email của Supabase Auth.
        email = COALESCE(new_email, email), 
        avatar_url = COALESCE(new_avatar_url, avatar_url)
    WHERE id = user_id_param;

    -- Cập nhật các trường riêng ở bảng tourists
    UPDATE public.tourists
    SET 
        gender = COALESCE(new_gender, gender),
        travel_preferences = COALESCE(new_preferences, travel_preferences)
    WHERE id = user_id_param;
END;
$function$;
GRANT ALL ON FUNCTION public.update_tourist_profile(uuid, text, text, text, text, text[], text) TO anon;
GRANT ALL ON FUNCTION public.update_tourist_profile(uuid, text, text, text, text, text[], text) TO authenticated;
GRANT ALL ON FUNCTION public.update_tourist_profile(uuid, text, text, text, text, text[], text) TO service_role;
CREATE FUNCTION public.update_user_active_status(p_user_id uuid, p_is_active bit)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$BEGIN
    UPDATE public.users
    SET is_active = p_is_active
    WHERE id = p_user_id;

    -- Kiểm tra xem có dòng nào thực sự được update không
    IF FOUND THEN
        RETURN TRUE;
    ELSE
        RAISE EXCEPTION 'Không tìm thấy người dùng để cập nhật trạng thái';
    END IF;
END;$function$;
GRANT ALL ON FUNCTION public.update_user_active_status(uuid, bit) TO anon;
GRANT ALL ON FUNCTION public.update_user_active_status(uuid, bit) TO authenticated;
GRANT ALL ON FUNCTION public.update_user_active_status(uuid, bit) TO service_role;
CREATE FUNCTION public.update_user_avatar(p_user_id uuid, p_avatar_url text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE users 
  SET avatar_url = p_avatar_url
  WHERE id = p_user_id;
END;
$function$;
GRANT ALL ON FUNCTION public.update_user_avatar(uuid, text) TO anon;
GRANT ALL ON FUNCTION public.update_user_avatar(uuid, text) TO authenticated;
GRANT ALL ON FUNCTION public.update_user_avatar(uuid, text) TO service_role;
CREATE TABLE public.businesses (id uuid NOT NULL, identity_card text, address text, is_approved boolean DEFAULT false);
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.businesses ADD CONSTRAINT businesses_pkey PRIMARY KEY (id);
GRANT ALL ON public.businesses TO anon;
GRANT ALL ON public.businesses TO authenticated;
GRANT ALL ON public.businesses TO service_role;
CREATE POLICY "Business can update own profile" ON public.businesses FOR UPDATE USING ((auth.uid() = id));
CREATE POLICY "Business can view own profile" ON public.businesses FOR SELECT USING ((auth.uid() = id));
CREATE TABLE public.notifications (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, title text NOT NULL, content text, type character varying(50), is_global boolean DEFAULT false, created_at timestamp with time zone DEFAULT timezone('utc'::text, now()), action_type text, target_type text, metadata jsonb);
ALTER TABLE public.notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
GRANT ALL ON public.notifications TO anon;
GRANT ALL ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
CREATE TABLE public.tourists (id uuid NOT NULL, gender text, travel_preferences text[] DEFAULT '{}'::text[]);
ALTER TABLE public.tourists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tourists ADD CONSTRAINT tourists_pkey PRIMARY KEY (id);
GRANT ALL ON public.tourists TO anon;
GRANT ALL ON public.tourists TO authenticated;
GRANT ALL ON public.tourists TO service_role;
CREATE POLICY "Tourists can update own profile" ON public.tourists FOR UPDATE USING ((auth.uid() = id));
CREATE POLICY "Tourists can view own profile" ON public.tourists FOR SELECT USING ((auth.uid() = id));
CREATE POLICY "Users can update own profile" ON public.tourists FOR UPDATE USING ((auth.uid() = id));
CREATE TABLE public.users (id uuid NOT NULL, role text NOT NULL, email text NOT NULL, full_name text NOT NULL, phone_number text, date_of_birth date, avatar_url text, created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL, is_active bit(1) DEFAULT '1'::"bit", is_deleted bit(1) DEFAULT '0'::"bit");
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE public.users ADD CONSTRAINT users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE order_sys.orders ADD CONSTRAINT fk_order_tourist FOREIGN KEY (tourist_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.businesses ADD CONSTRAINT businesses_id_fkey FOREIGN KEY (id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.tourists ADD CONSTRAINT tourists_id_fkey FOREIGN KEY (id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (role = ANY (ARRAY['TOURIST'::text, 'BUSINESS'::text, 'ADMIN'::text]));
GRANT ALL ON public.users TO anon;
GRANT ALL ON public.users TO authenticated;
GRANT ALL ON public.users TO service_role;
CREATE UNIQUE INDEX unique_active_phone ON public.users (phone_number) WHERE phone_number IS NOT NULL;
CREATE POLICY "Users can update own user record" ON public.users FOR UPDATE USING ((auth.uid() = id));
CREATE POLICY "Users can view own user record" ON public.users FOR SELECT USING ((auth.uid() = id));
CREATE TABLE public.users_notifications (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, user_id uuid NOT NULL, notification_id uuid NOT NULL, is_read boolean DEFAULT false, read_at timestamp with time zone, sent_at timestamp with time zone DEFAULT timezone('utc'::text, now()));
ALTER PUBLICATION supabase_realtime ADD TABLE public.users_notifications;
ALTER TABLE public.users_notifications ADD CONSTRAINT fk_users_notifications_notification FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE CASCADE;
ALTER TABLE public.users_notifications ADD CONSTRAINT fk_users_notifications_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.users_notifications ADD CONSTRAINT users_notifications_pkey PRIMARY KEY (id);
GRANT ALL ON public.users_notifications TO anon;
GRANT ALL ON public.users_notifications TO authenticated;
GRANT ALL ON public.users_notifications TO service_role;
CREATE TABLE public.v_cat_id (id uuid);
GRANT ALL ON public.v_cat_id TO anon;
GRANT ALL ON public.v_cat_id TO authenticated;
GRANT ALL ON public.v_cat_id TO service_role;
CREATE SCHEMA review_ai AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA review_ai TO anon;
GRANT USAGE ON SCHEMA review_ai TO authenticated;
GRANT USAGE ON SCHEMA review_ai TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA review_ai GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA review_ai GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA review_ai GRANT ALL ON ROUTINES TO service_role;
CREATE TYPE review_ai.processing_status_enum AS ENUM ('pending', 'processed');
CREATE TYPE review_ai.review_status_enum AS ENUM ('pending', 'approved', 'violation');
CREATE TYPE review_ai.review_type_enum AS ENUM ('with_content', 'without_content');
CREATE TYPE review_ai.time_label_enum AS ENUM ('short-term', 'long-term', 'amb');
CREATE TYPE review_ai.topic_enum AS ENUM ('traffic', 'weather', 'crowded', 'infrastructure', 'price', 'service', 'other', 'food', 'atmosphere', 'activity');
CREATE TABLE review_ai.itinerary_reviews (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, itinerary_id uuid, tourist_id uuid, rating integer, content text, url_image text[] DEFAULT '{}'::text[], tags text[], created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP, status text DEFAULT 'pending'::text NOT NULL);
ALTER TABLE review_ai.itinerary_reviews ADD CONSTRAINT fk_itinerary_review_tourist FOREIGN KEY (tourist_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE review_ai.itinerary_reviews ADD CONSTRAINT itinerary_reviews_pkey PRIMARY KEY (id);
ALTER TABLE review_ai.itinerary_reviews ADD CONSTRAINT itinerary_reviews_rating_check CHECK (rating >= 1 AND rating <= 5);
GRANT DELETE, INSERT, SELECT, UPDATE ON review_ai.itinerary_reviews TO service_role;
CREATE TABLE review_ai.review_conflicts (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, new_content_id uuid, old_content_id uuid, conflict_score double precision, conflict_topic review_ai.topic_enum, created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE review_ai.review_conflicts ADD CONSTRAINT review_conflicts_pkey PRIMARY KEY (id);
GRANT SELECT ON review_ai.review_conflicts TO anon;
GRANT SELECT ON review_ai.review_conflicts TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON review_ai.review_conflicts TO service_role;
CREATE TABLE review_ai.review_contents (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, review_id uuid, content text, processing_status review_ai.processing_status_enum DEFAULT 'pending'::review_ai.processing_status_enum, time_label review_ai.time_label_enum, expiration_date timestamp without time zone, main_topic review_ai.topic_enum, topic_scores jsonb, sentiment_scores jsonb, error_info jsonb, has_conflict boolean DEFAULT false, is_temporary boolean DEFAULT false, embedding extensions.vector(384));
ALTER TABLE review_ai.review_contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_ai.review_contents ADD CONSTRAINT review_contents_pkey PRIMARY KEY (id);
ALTER TABLE review_ai.review_conflicts ADD CONSTRAINT review_conflicts_new_content_id_fkey FOREIGN KEY (new_content_id) REFERENCES review_ai.review_contents(id);
ALTER TABLE review_ai.review_conflicts ADD CONSTRAINT review_conflicts_old_content_id_fkey FOREIGN KEY (old_content_id) REFERENCES review_ai.review_contents(id);
GRANT SELECT ON review_ai.review_contents TO anon;
GRANT SELECT ON review_ai.review_contents TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON review_ai.review_contents TO service_role;
CREATE POLICY service_role_insert_contents ON review_ai.review_contents FOR INSERT TO authenticated, service_role WITH CHECK (true);
CREATE POLICY service_role_select_contents ON review_ai.review_contents FOR SELECT TO authenticated, service_role USING (true);
CREATE TABLE review_ai.reviews (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, tourist_id uuid, place_id uuid, rating integer, created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP, review_type review_ai.review_type_enum, status review_ai.review_status_enum DEFAULT 'pending'::review_ai.review_status_enum, itinerary_id uuid, provider character varying(100), url_image text[] DEFAULT '{}'::text[], tags text[]);
ALTER TABLE review_ai.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_ai.reviews ADD CONSTRAINT fk_review_tourist FOREIGN KEY (tourist_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE review_ai.reviews ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);
ALTER TABLE review_ai.review_contents ADD CONSTRAINT review_contents_review_id_fkey FOREIGN KEY (review_id) REFERENCES review_ai.reviews(id) ON DELETE CASCADE;
ALTER TABLE review_ai.reviews ADD CONSTRAINT reviews_rating_check CHECK (rating >= 1 AND rating <= 5);
GRANT SELECT ON review_ai.reviews TO anon;
GRANT SELECT ON review_ai.reviews TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON review_ai.reviews TO service_role;
CREATE INDEX idx_reviews_created_at ON review_ai.reviews (created_at DESC);
CREATE INDEX idx_reviews_status ON review_ai.reviews (status);
CREATE POLICY service_role_insert_reviews ON review_ai.reviews FOR INSERT TO authenticated, service_role WITH CHECK (true);
CREATE POLICY service_role_select_reviews ON review_ai.reviews FOR SELECT TO authenticated, service_role USING (true);
CREATE SCHEMA tracking AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA tracking TO anon;
GRANT USAGE ON SCHEMA tracking TO authenticated;
GRANT USAGE ON SCHEMA tracking TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA tracking GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA tracking GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA tracking GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO service_role;
CREATE TYPE tracking.visit_status_enum AS ENUM ('visited', 'skipped', 'not_visited');
CREATE TABLE tracking.geofence_visits (geofence_id uuid NOT NULL, itinerary_detail_id uuid NOT NULL, status tracking.visit_status_enum DEFAULT 'not_visited'::tracking.visit_status_enum, recorded_at timestamp without time zone DEFAULT now(), itinerary_id uuid, tourist_id uuid, track_date date, dwell_seconds integer DEFAULT 0 NOT NULL, dwell_threshold_seconds integer DEFAULT 120 NOT NULL, expected_duration_minutes integer, entered_at timestamp with time zone, exited_at timestamp with time zone, enter_count integer DEFAULT 0 NOT NULL, checked_in_at timestamp with time zone, last_event_type text, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE tracking.geofence_visits ADD CONSTRAINT geofence_visits_pkey PRIMARY KEY (geofence_id, itinerary_detail_id);
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.geofence_visits TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.geofence_visits TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.geofence_visits TO service_role;
CREATE INDEX idx_gv_itin_date ON tracking.geofence_visits (itinerary_id, track_date);
CREATE INDEX idx_gv_checked_in ON tracking.geofence_visits (checked_in_at) WHERE checked_in_at IS NOT NULL;
CREATE INDEX idx_gv_tourist ON tracking.geofence_visits (tourist_id) WHERE tourist_id IS NOT NULL;
CREATE INDEX idx_gv_detail ON tracking.geofence_visits (itinerary_detail_id);
CREATE TABLE tracking.geofences (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, name character varying(100), polygon extensions.geometry(Polygon,4326), created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP, is_active boolean DEFAULT true, place_id uuid, radius_m integer DEFAULT 100 NOT NULL);
ALTER TABLE tracking.geofences ADD CONSTRAINT geofences_pkey PRIMARY KEY (id);
ALTER TABLE tracking.geofence_visits ADD CONSTRAINT geofence_visits_geofence_id_fkey FOREIGN KEY (geofence_id) REFERENCES tracking.geofences(id);
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.geofences TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.geofences TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.geofences TO service_role;
CREATE UNIQUE INDEX uq_geofences_place_id ON tracking.geofences (place_id);
CREATE TABLE tracking.transport_modes (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, name character varying(100), transport_type character varying(100));
ALTER TABLE tracking.transport_modes ADD CONSTRAINT transport_modes_pkey PRIMARY KEY (id);
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.transport_modes TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.transport_modes TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.transport_modes TO service_role;
CREATE TABLE tracking.transport_pricing_rules (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, transport_mode_id uuid, distance_range character varying(100), price numeric(12,2));
ALTER TABLE tracking.transport_pricing_rules ADD CONSTRAINT transport_pricing_rules_pkey PRIMARY KEY (id);
ALTER TABLE tracking.transport_pricing_rules ADD CONSTRAINT transport_pricing_rules_transport_mode_id_fkey FOREIGN KEY (transport_mode_id) REFERENCES tracking.transport_modes(id);
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.transport_pricing_rules TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.transport_pricing_rules TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.transport_pricing_rules TO service_role;
CREATE TABLE tracking.transport_to_destination (transport_mode_id uuid NOT NULL, total_cost numeric(12,2), itinerary_id uuid NOT NULL);
ALTER TABLE tracking.transport_to_destination ADD CONSTRAINT transport_to_destination_pkey PRIMARY KEY (transport_mode_id, itinerary_id);
ALTER TABLE tracking.transport_to_destination ADD CONSTRAINT transport_to_destination_transport_mode_id_fkey FOREIGN KEY (transport_mode_id) REFERENCES tracking.transport_modes(id);
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.transport_to_destination TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.transport_to_destination TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.transport_to_destination TO service_role;
CREATE TABLE tracking.transport_within_city (transport_mode_id uuid NOT NULL, itinerary_detail_id uuid NOT NULL, total_cost numeric(12,2));
ALTER TABLE tracking.transport_within_city ADD CONSTRAINT transport_within_city_pkey PRIMARY KEY (transport_mode_id, itinerary_detail_id);
ALTER TABLE tracking.transport_within_city ADD CONSTRAINT transport_within_city_transport_mode_id_fkey FOREIGN KEY (transport_mode_id) REFERENCES tracking.transport_modes(id);
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.transport_within_city TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.transport_within_city TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON tracking.transport_within_city TO service_role;
CREATE SCHEMA travel AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA travel TO anon;
GRANT USAGE ON SCHEMA travel TO authenticated;
GRANT USAGE ON SCHEMA travel TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA travel GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA travel GRANT SELECT ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA travel GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA travel GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA travel GRANT ALL ON ROUTINES TO service_role;
CREATE TYPE travel.itinerary_status_enum AS ENUM ('ongoing', 'completed', 'pending', 'uncompleted');
CREATE FUNCTION travel.create_full_place_v2(p_name text, p_address text, p_city text, p_lat numeric, p_lng numeric, p_vendor_id uuid, p_categories text[], p_services jsonb DEFAULT '[]'::jsonb, p_menu jsonb DEFAULT '[]'::jsonb, p_images text[] DEFAULT '{}'::text[], p_open_time text DEFAULT '08:00'::text, p_close_time text DEFAULT '22:00'::text, p_description text DEFAULT ''::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'travel', 'order_sys'
AS $function$
DECLARE
    v_place_id   UUID;
    v_city_id    UUID;
    v_cat        TEXT;
    v_cat_id     UUID;
    v_service    JSONB;
    v_service_id UUID;
    v_item       JSONB;
BEGIN

SELECT id INTO v_city_id
FROM travel.cities
WHERE LOWER(TRIM(name)) = LOWER(TRIM(p_city))
LIMIT 1;

IF v_city_id IS NULL THEN
    RAISE EXCEPTION 'City not found: %', p_city;
END IF;

INSERT INTO travel.places(name, address, city_id, latitude, longitude, vendor_id, image_url,open_time, close_time,description, is_approved)
VALUES (p_name, p_address, v_city_id, p_lat, p_lng, p_vendor_id, p_images,p_open_time::time, p_close_time::time,p_description, null)
RETURNING id INTO v_place_id;

IF p_categories IS NOT NULL AND array_length(p_categories, 1) > 0 THEN
    FOREACH v_cat IN ARRAY p_categories LOOP
        SELECT id INTO v_cat_id
        FROM travel.categories
        WHERE LOWER(TRIM(name)) = LOWER(TRIM(v_cat))
        LIMIT 1;

        IF v_cat_id IS NOT NULL THEN
            INSERT INTO travel.place_categories(place_id, category_id)
            VALUES (v_place_id, v_cat_id)
            ON CONFLICT DO NOTHING;
        ELSE
            RAISE EXCEPTION 'Category not found: %', v_cat;
        END IF;
    END LOOP;
END IF;

IF p_services IS NOT NULL AND jsonb_array_length(p_services) > 0 THEN
    FOR v_service IN SELECT * FROM jsonb_array_elements(p_services) LOOP
        SELECT id INTO v_service_id
        FROM travel.services
        WHERE LOWER(TRIM(name)) = LOWER(TRIM(v_service->>'name'))
        LIMIT 1;

        IF v_service_id IS NULL THEN
            INSERT INTO travel.services(name, description)
            VALUES (v_service->>'name', v_service->>'description')
            RETURNING id INTO v_service_id;
        END IF;

        INSERT INTO travel.place_services(place_id, service_id)
        VALUES (v_place_id, v_service_id)
        ON CONFLICT DO NOTHING;
    END LOOP;
END IF;

IF p_menu IS NOT NULL AND jsonb_array_length(p_menu) > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_menu) LOOP
        INSERT INTO order_sys.food_items(name, description, price, place_id)
        VALUES (
            v_item->>'name',
            v_item->>'description',
            (v_item->>'price')::NUMERIC,
            v_place_id
        );
    END LOOP;
END IF;

RETURN v_place_id;
END;
$function$;
GRANT ALL ON FUNCTION travel.create_full_place_v2(text, text, text, numeric, numeric, uuid, text[], jsonb, jsonb, text[], text, text, text) TO service_role;
CREATE FUNCTION travel.create_full_place(p_name text, p_address text, p_city text, p_lat numeric, p_lng numeric, p_vendor_id uuid, p_categories text[], p_services jsonb DEFAULT '[]'::jsonb, p_menu jsonb DEFAULT '[]'::jsonb, p_images text[] DEFAULT '{}'::text[], p_open_time text DEFAULT '08:00'::text, p_close_time text DEFAULT '22:00'::text, p_description text DEFAULT ''::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'travel', 'order_sys'
AS $function$
DECLARE
    v_place_id   UUID;
    v_city_id    UUID;
    v_cat        TEXT;
    v_cat_id     UUID;
    v_service    JSONB;
    v_service_id UUID;
    v_item       JSONB;
BEGIN

SELECT id INTO v_city_id
FROM travel.cities
WHERE LOWER(TRIM(name)) = LOWER(TRIM(p_city))
LIMIT 1;

IF v_city_id IS NULL THEN
    RAISE EXCEPTION 'City not found: %', p_city;
END IF;

INSERT INTO travel.places(name, address, city_id, latitude, longitude, vendor_id, image_url,open_time, close_time,description, is_approved)
VALUES (p_name, p_address, v_city_id, p_lat, p_lng, p_vendor_id, p_images,p_open_time::time, p_close_time::time,p_description, null)
RETURNING id INTO v_place_id;

IF p_categories IS NOT NULL AND array_length(p_categories, 1) > 0 THEN
    FOREACH v_cat IN ARRAY p_categories LOOP
        SELECT id INTO v_cat_id
        FROM travel.categories
        WHERE LOWER(TRIM(name)) = LOWER(TRIM(v_cat))
        LIMIT 1;

        IF v_cat_id IS NOT NULL THEN
            INSERT INTO travel.place_categories(place_id, category_id)
            VALUES (v_place_id, v_cat_id)
            ON CONFLICT DO NOTHING;
        ELSE
            RAISE EXCEPTION 'Category not found: %', v_cat;
        END IF;
    END LOOP;
END IF;

IF p_services IS NOT NULL AND jsonb_array_length(p_services) > 0 THEN
    FOR v_service IN SELECT * FROM jsonb_array_elements(p_services) LOOP
        SELECT id INTO v_service_id
        FROM travel.services
        WHERE LOWER(TRIM(name)) = LOWER(TRIM(v_service->>'name'))
        LIMIT 1;

        IF v_service_id IS NULL THEN
            INSERT INTO travel.services(name, description)
            VALUES (v_service->>'name', v_service->>'description')
            RETURNING id INTO v_service_id;
        END IF;

        INSERT INTO travel.place_services(place_id, service_id)
        VALUES (v_place_id, v_service_id)
        ON CONFLICT DO NOTHING;
    END LOOP;
END IF;

IF p_menu IS NOT NULL AND jsonb_array_length(p_menu) > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_menu) LOOP
        INSERT INTO order_sys.food_items(name, description, price, place_id)
        VALUES (
            v_item->>'name',
            v_item->>'description',
            (v_item->>'price')::NUMERIC,
            v_place_id
        );
    END LOOP;
END IF;

RETURN v_place_id;
END;
$function$;
GRANT ALL ON FUNCTION travel.create_full_place(text, text, text, numeric, numeric, uuid, text[], jsonb, jsonb, text[], text, text, text) TO service_role;
CREATE FUNCTION travel.create_place_full(p_name text, p_address text, p_city text, p_lat numeric, p_lng numeric, p_categories text[], p_services text[] DEFAULT '{}'::text[], p_menu jsonb DEFAULT 'null'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_place_id UUID;
    v_cat TEXT;
    v_cat_id UUID;
    v_service TEXT;
    v_service_id UUID;
BEGIN

INSERT INTO travel.places(
    name, address, city, latitude, longitude, vendor_id, is_approved
)
VALUES (
    p_name, p_address, p_city, p_lat, p_lng, auth.uid(), false
)
RETURNING id INTO v_place_id;

FOREACH v_cat IN ARRAY p_categories
LOOP
    SELECT id INTO v_cat_id
    FROM travel.categories
    WHERE LOWER(name) = LOWER(v_cat)
    LIMIT 1;

    IF v_cat_id IS NOT NULL THEN
        INSERT INTO travel.place_categories(place_id, category_id)
        VALUES (v_place_id, v_cat_id);
    END IF;
END LOOP;

FOREACH v_service IN ARRAY p_services
LOOP
    SELECT id INTO v_service_id
    FROM travel.services
    WHERE LOWER(name) = LOWER(v_service)
    LIMIT 1;

    IF v_service_id IS NOT NULL THEN
        INSERT INTO travel.place_services(place_id, service_id)
        VALUES (v_place_id, v_service_id);
    END IF;
END LOOP;

IF p_menu IS NOT NULL AND p_menu != 'null' THEN
    INSERT INTO travel.menus(place_id, items)
    VALUES (v_place_id, p_menu);
END IF;

RETURN v_place_id;

END;
$function$;
GRANT ALL ON FUNCTION travel.create_place_full(text, text, text, numeric, numeric, text[], text[], jsonb) TO service_role;
CREATE FUNCTION travel.get_business_dashboard(p_vendor_id uuid)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE result JSON;
BEGIN

SELECT json_build_object(

    'total_places',
    (
        SELECT COUNT(*)
        FROM travel.places
        WHERE vendor_id = p_vendor_id
    ),

    'total_orders',
    (
        SELECT COUNT(*)
        FROM order_sys.orders o
        JOIN travel.itinerary_details d
        ON d.id = o.itinerary_detail_id
        JOIN travel.places p
        ON p.id = d.place_id
        WHERE p.vendor_id = p_vendor_id and o.status <> 'completed'
    ),

    'total_food_items',
    (
        SELECT COUNT(*)
        FROM order_sys.food_items f
        JOIN travel.places p
        ON p.id = f.place_id
        WHERE p.vendor_id = p_vendor_id
    ),

    'average_rating',
    (
        SELECT COALESCE(AVG(average_rating),0)
        FROM travel.places
        WHERE vendor_id = p_vendor_id
    )

)
INTO result;

RETURN result;

END;
$function$;
GRANT ALL ON FUNCTION travel.get_business_dashboard(uuid) TO service_role;
CREATE FUNCTION travel.get_my_itineraries(p_user_id uuid, p_query text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE result JSON;
BEGIN
  WITH user_itineraries AS (
    SELECT *
    FROM travel.itineraries
    WHERE creator_id = p_user_id
  ),
  filtered_itineraries AS (
    SELECT *
    FROM user_itineraries
    WHERE
      NULLIF(BTRIM(p_query), '') IS NULL
      OR description ILIKE '%' || BTRIM(p_query) || '%'
  )
  SELECT json_build_object(
    'stats', (
      SELECT json_build_object(
        'total', COUNT(*),
        'completed', COUNT(*) FILTER (WHERE status = 'completed'),
        'upcoming', COUNT(*) FILTER (WHERE status = 'ongoing'),
        'draft', COUNT(*) FILTER (WHERE status IS NULL)
      )
      FROM user_itineraries
    ),
    'itineraries', COALESCE((
      SELECT json_agg(json_build_object(
        'id', i.id,
        'description', i.description,
        'destination', i.destination,
        'start_date', i.start_date,
        'end_date', i.end_date,
        'status', i.status,
        'days', (i.end_date - i.start_date),
        'estimated_cost', i.estimated_cost,
        'total_locations', metrics.total_locs,
        'visited_locations', metrics.visited_locs,
        'progress', CASE
          WHEN i.status = 'completed' THEN 100
          ELSE COALESCE(
            ROUND(100.0 * metrics.visited_locs / NULLIF(metrics.total_locs, 0))::int,
            0
          )
        END,
        'place_images', ARRAY(
          SELECT p.image_url[1]
          FROM travel.itinerary_details d
          JOIN travel.places p ON p.id = d.place_id
          WHERE d.itinerary_id = i.id
            AND array_length(p.image_url, 1) > 0
            AND p.slot_type IS DISTINCT FROM 'accommodation'
          ORDER BY d.sequence_order
          LIMIT 5
        ),
        'rating', ir.rating
      ))
      FROM filtered_itineraries i
      CROSS JOIN LATERAL (
        SELECT
          COUNT(*) AS total_locs,
          COUNT(DISTINCT gv.itinerary_detail_id) AS visited_locs
        FROM travel.itinerary_details d
        LEFT JOIN tracking.geofence_visits gv
          ON gv.itinerary_detail_id = d.id
          AND gv.itinerary_id = i.id
          AND gv.status = 'visited'
        WHERE d.itinerary_id = i.id
      ) metrics
      LEFT JOIN LATERAL (
        SELECT rating
        FROM review_ai.itinerary_reviews
        WHERE itinerary_id = i.id
          AND tourist_id = p_user_id
        LIMIT 1
      ) ir ON true
    ), '[]'::json)
  )
  INTO result;

  RETURN result;
END;
$function$;
GRANT ALL ON FUNCTION travel.get_my_itineraries(uuid, text) TO service_role;
CREATE FUNCTION travel.get_place_detail(p_place_id uuid)
 RETURNS TABLE(place_id uuid, place_name text, address text, city text, latitude numeric, longitude numeric, open_time time without time zone, close_time time without time zone, description text, status text, rating numeric, category text)
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    SELECT
        p.id,
        p.name::TEXT,
        p.address::TEXT,
        ci.name::TEXT,
        p.latitude,
        p.longitude,
        p.open_time,
        p.close_time,
        p.description::TEXT,
        CASE
            WHEN p.is_approved THEN 'Đã duyệt'
            ELSE 'Đang chờ'
        END::TEXT,
        p.average_rating,
        c.name::TEXT
    FROM travel.places p
    LEFT JOIN travel.place_categories pc
        ON pc.place_id = p.id
    LEFT JOIN travel.categories c
        ON c.id = pc.category_id
    JOIN travel.cities ci on ci.id = p.city_id
    WHERE p.id = p_place_id;
END;
$function$;
GRANT ALL ON FUNCTION travel.get_place_detail(uuid) TO service_role;
CREATE FUNCTION travel.get_place_services_and_menu(p_place_id uuid)
 RETURNS TABLE(service_name text, food_id uuid, food_name text, description text, price numeric)
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    SELECT
        s.name::TEXT,
        f.id,
        f.name::TEXT,
        f.description::TEXT,
        f.price
    FROM travel.places p
    LEFT JOIN travel.place_services ps
        ON ps.place_id = p.id
    LEFT JOIN travel.services s
        ON s.id = ps.service_id
    LEFT JOIN order_sys.food_items f
        ON f.place_id = p.id
    WHERE p.id = p_place_id;
END;
$function$;
GRANT ALL ON FUNCTION travel.get_place_services_and_menu(uuid) TO service_role;
CREATE FUNCTION travel.get_places_by_filter(p_city text, p_category text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
BEGIN

IF LOWER(p_category) = 'itinerary' THEN

    RETURN (
        SELECT jsonb_agg(it)
        FROM travel.itineraries it
        WHERE 
            (
                unaccent(it.destination) ILIKE '%' || unaccent(p_city) || '%'
                OR similarity(unaccent(it.destination), unaccent(p_city)) > 0.3
            )
            AND it.status = 'completed'
    );

ELSE

    RETURN (
        SELECT jsonb_agg(p)
        FROM travel.places p
        JOIN travel.place_categories pc ON pc.place_id = p.id
        JOIN travel.categories c ON c.id = pc.category_id
        JOIN travel.cities ci ON ci.id = p.city_id
        WHERE 
            (
                unaccent(ci.name) ILIKE '%' || unaccent(p_city) || '%'
                OR similarity(unaccent(ci.name), unaccent(p_city)) > 0.3
            )
        AND LOWER(c.name) = LOWER(p_category)
    );

END IF;

END;
$function$;
GRANT ALL ON FUNCTION travel.get_places_by_filter(text, text) TO service_role;
CREATE FUNCTION travel.get_places_by_vendor(p_vendor_id uuid)
 RETURNS TABLE(place_id uuid, place_name text, address text, city text, category text, status text, rating numeric)
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    SELECT 
        p.id,
        p.name::TEXT,
        p.address::TEXT,
        p.city::TEXT,
        c.name::TEXT,
        CASE 
            WHEN p.is_approved = true THEN 'Đã duyệt'
            ELSE 'Đang chờ'
        END::TEXT,
        p.average_rating
    FROM travel.places p
    LEFT JOIN travel.place_categories pc 
        ON pc.place_id = p.id
    LEFT JOIN travel.categories c 
        ON c.id = pc.category_id
    WHERE p.vendor_id = p_vendor_id
    ORDER BY p.registered_date DESC;
END;
$function$;
GRANT ALL ON FUNCTION travel.get_places_by_vendor(uuid) TO anon;
GRANT ALL ON FUNCTION travel.get_places_by_vendor(uuid) TO authenticated;
GRANT ALL ON FUNCTION travel.get_places_by_vendor(uuid) TO service_role;
CREATE FUNCTION travel.immutable_unaccent(txt text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
  select public.unaccent(lower(txt));
$function$;
GRANT ALL ON FUNCTION travel.immutable_unaccent(text) TO service_role;
CREATE FUNCTION travel.search_autocomplete(p_query text, p_limit integer DEFAULT 20)
 RETURNS TABLE(id uuid, name text, type text, image text, city text, rating double precision, score double precision)
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
    nq         text := travel.immutable_unaccent(coalesce(trim(p_query), ''));
    prefix_pat text;   -- 'nq%'  : khớp đầu chuỗi (luôn tính boost + dùng cho query ngắn)
    place_pat  text;   -- mẫu khớp cho PLACE: prefix nếu < 3 ký tự, infix nếu >= 3
    city_pat   text;   -- cities ít dòng → luôn infix
begin
    if nq = '' then
        return;
    end if;

    prefix_pat := nq || '%';
    city_pat   := '%' || nq || '%';
    -- < 3 ký tự: trigram không index được chuỗi ngắn → dùng prefix (btree).
    -- >= 3 ký tự: infix '%q%' dùng GIN trigram.
    place_pat  := case when length(nq) < 3 then prefix_pat else city_pat end;

    -- Dùng EXECUTE để mẫu LIKE là HẰNG trong câu lệnh → planner chắc chắn chọn index
    -- (trong plpgsql, mẫu là biến thường khiến planner bỏ qua index trigram).
    return query execute format($q$
        select t.id, t.name, t.type, t.image, t.city, t.rating, t.score
        from (
            -- ===== CITY (bảng nhỏ, ưu tiên hiển thị trên) =====
            select
                c.id,
                c.name::text                          as name,
                'city'::text                          as type,
                ''::text                              as image,
                c.name::text                          as city,
                0::float                              as rating,
                (case when travel.immutable_unaccent(c.name) like %L then 100 else 50 end)::float as score
            from travel.cities c
            where travel.immutable_unaccent(c.name) like %L

            union all

            -- ===== PLACE (lọc approved/active, kèm ảnh + thành phố) =====
            select
                p.id,
                p.name::text                          as name,
                'place'::text                         as type,
                coalesce(p.image_url[1], '')          as image,
                coalesce(ci.name, '')::text           as city,
                coalesce(p.average_rating, 0)::float  as rating,
                (
                    (case when travel.immutable_unaccent(p.name) like %L then 3 else 0 end)
                    + least(coalesce(p.average_rating, 0) / 5.0, 1)
                )::float                              as score
            from travel.places p
            left join travel.cities ci on ci.id = p.city_id
            where p.is_approved
              and p.is_active
              and travel.immutable_unaccent(p.name) like %L
        ) t
        order by t.score desc
        limit %s
    $q$, prefix_pat, city_pat, prefix_pat, place_pat, greatest(p_limit, 1));
end;
$function$;
GRANT ALL ON FUNCTION travel.search_autocomplete(text, integer) TO service_role;
CREATE FUNCTION travel.search_places_advanced(p_query text)
 RETURNS TABLE(id uuid, name text, address text, city text, rating numeric, type text, score double precision)
 LANGUAGE plpgsql
AS $function$
BEGIN

RETURN QUERY

-- ===== PLACE =====
SELECT 
    p.id,
    p.name::TEXT,
    p.address::TEXT,
    p.city::TEXT,
    p.average_rating,
    'place',
    
    -- scoring
    (
        similarity(unaccent(p.name), unaccent(p_query)) * 2 +
        similarity(unaccent(p.city), unaccent(p_query)) +
        (p.average_rating / 5)
    ) AS score

FROM travel.places p
WHERE
    unaccent(p.name) ILIKE '%' || unaccent(p_query) || '%'
    OR similarity(unaccent(p.name), unaccent(p_query)) > 0.3
    OR unaccent(p.city) ILIKE '%' || unaccent(p_query) || '%'

UNION

-- ===== CITY =====
SELECT 
    NULL,
    p.city::TEXT,
    ''::TEXT,
    p.city::TEXT,
    0,
    'city',
    
    similarity(unaccent(p.city), unaccent(p_query)) + 1

FROM travel.places p
WHERE similarity(unaccent(p.city), unaccent(p_query)) > 0.3

GROUP BY p.city

ORDER BY score DESC
LIMIT 10;

END;
$function$;
GRANT ALL ON FUNCTION travel.search_places_advanced(text) TO service_role;
CREATE FUNCTION travel.vi_normalize(txt text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE STRICT
AS $function$
  select lower(
    translate(
      txt,
      'àáạảãâầấậẩẫăằắặẳẵÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴèéẹẻẽêềếệểễÈÉẸẺẼÊỀẾỆỂỄìíịỉĩÌÍỊỈĨòóọỏõôồốộổỗơờớợởỡÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠùúụủũưừứựửữÙÚỤỦŨƯỪỨỰỬỮỳýỵỷỹỲÝỴỶỸđĐ',
      'aaaaaaaaaaaaaaaaaAAAAAAAAAAAAAAAAAeeeeeeeeeeeEEEEEEEEEEEiiiiiIIIIIoooooooooooooooooOOOOOOOOOOOOOOOOOuuuuuuuuuuuUUUUUUUUUUUyyyyyYYYYYdD'
    )
  );
$function$;
GRANT ALL ON FUNCTION travel.vi_normalize(text) TO service_role;
CREATE TABLE travel.activity_logs (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, tourist_id uuid, action_type character varying(50), created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP, place_id uuid);
ALTER TABLE travel.activity_logs ADD CONSTRAINT activity_logs_pkey PRIMARY KEY (id);
ALTER TABLE travel.activity_logs ADD CONSTRAINT fk_activity_tourist FOREIGN KEY (tourist_id) REFERENCES public.users(id) ON DELETE CASCADE;
GRANT SELECT ON travel.activity_logs TO anon;
GRANT SELECT ON travel.activity_logs TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON travel.activity_logs TO service_role;
CREATE TABLE travel.categories (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, name character varying(100) NOT NULL);
ALTER TABLE travel.categories ADD CONSTRAINT categories_pkey PRIMARY KEY (id);
GRANT SELECT ON travel.categories TO anon;
GRANT SELECT ON travel.categories TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON travel.categories TO service_role;
CREATE TABLE travel.cities (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, name character varying(100) NOT NULL);
ALTER TABLE travel.cities ADD CONSTRAINT cities_pkey PRIMARY KEY (id);
GRANT SELECT ON travel.cities TO anon;
GRANT SELECT ON travel.cities TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON travel.cities TO service_role;
CREATE TABLE travel.favorite_itineraries (tourist_id uuid NOT NULL, itinerary_id uuid NOT NULL, added_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE travel.favorite_itineraries ADD CONSTRAINT favorite_itineraries_pkey PRIMARY KEY (tourist_id, itinerary_id);
ALTER TABLE travel.favorite_itineraries ADD CONSTRAINT fk_fav_itinerary_tourist FOREIGN KEY (tourist_id) REFERENCES public.users(id) ON DELETE CASCADE;
GRANT SELECT ON travel.favorite_itineraries TO anon;
GRANT SELECT ON travel.favorite_itineraries TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON travel.favorite_itineraries TO service_role;
CREATE TABLE travel.favorite_places (tourist_id uuid NOT NULL, place_id uuid NOT NULL, added_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE travel.favorite_places ADD CONSTRAINT favorite_places_pkey PRIMARY KEY (tourist_id, place_id);
ALTER TABLE travel.favorite_places ADD CONSTRAINT fk_favorite_tourist FOREIGN KEY (tourist_id) REFERENCES public.users(id) ON DELETE CASCADE;
GRANT SELECT ON travel.favorite_places TO anon;
GRANT SELECT ON travel.favorite_places TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON travel.favorite_places TO service_role;
CREATE TABLE travel.itineraries (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, creator_id uuid, description character varying(255), start_date date, end_date date, estimated_cost numeric(12,2), status travel.itinerary_status_enum, departure_point character varying(255), destination character varying(255), created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP, actual_cost numeric(12,2), is_public boolean DEFAULT false, adult_count integer DEFAULT 1, children_count integer DEFAULT 0, tracking_active boolean DEFAULT false NOT NULL, trip_intent text);
ALTER TABLE travel.itineraries ADD CONSTRAINT fk_itinerary_creator FOREIGN KEY (creator_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE travel.itineraries ADD CONSTRAINT itineraries_pkey PRIMARY KEY (id);
ALTER TABLE review_ai.itinerary_reviews ADD CONSTRAINT itinerary_reviews_itinerary_id_fkey FOREIGN KEY (itinerary_id) REFERENCES travel.itineraries(id) ON DELETE CASCADE;
ALTER TABLE review_ai.reviews ADD CONSTRAINT reviews_itinerary_id_fkey FOREIGN KEY (itinerary_id) REFERENCES travel.itineraries(id);
ALTER TABLE tracking.geofence_visits ADD CONSTRAINT geofence_visits_itinerary_id_fkey FOREIGN KEY (itinerary_id) REFERENCES travel.itineraries(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE tracking.transport_to_destination ADD CONSTRAINT fk_transport_itinerary FOREIGN KEY (itinerary_id) REFERENCES travel.itineraries(id);
ALTER TABLE travel.favorite_itineraries ADD CONSTRAINT favorite_itineraries_itinerary_id_fkey FOREIGN KEY (itinerary_id) REFERENCES travel.itineraries(id);
GRANT SELECT ON travel.itineraries TO anon;
GRANT SELECT ON travel.itineraries TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON travel.itineraries TO service_role;
CREATE INDEX idx_itineraries_tracking_active ON travel.itineraries (tracking_active) WHERE tracking_active = true;
CREATE TABLE travel.itinerary_details (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, itinerary_id uuid, place_id uuid, visit_date date, arrival_time time without time zone, departure_time time without time zone, notes text, estimated_cost numeric(12,2), transport_cost numeric(12,2), actual_cost numeric(12,2), cost_updated_at timestamp without time zone, is_locked boolean DEFAULT false, duration_minutes integer DEFAULT 60, sequence_order integer, user_notes text, locked_arrive_time time without time zone);
ALTER TABLE travel.itinerary_details ADD CONSTRAINT itinerary_details_itinerary_id_fkey FOREIGN KEY (itinerary_id) REFERENCES travel.itineraries(id) ON DELETE CASCADE;
ALTER TABLE travel.itinerary_details ADD CONSTRAINT itinerary_details_pkey PRIMARY KEY (id);
ALTER TABLE order_sys.orders ADD CONSTRAINT orders_itinerary_detail_id_fkey FOREIGN KEY (itinerary_detail_id) REFERENCES travel.itinerary_details(id);
ALTER TABLE tracking.geofence_visits ADD CONSTRAINT geofence_visits_itinerary_detail_id_fkey FOREIGN KEY (itinerary_detail_id) REFERENCES travel.itinerary_details(id);
ALTER TABLE tracking.transport_within_city ADD CONSTRAINT transport_within_city_itinerary_detail_id_fkey FOREIGN KEY (itinerary_detail_id) REFERENCES travel.itinerary_details(id);
GRANT SELECT ON travel.itinerary_details TO anon;
GRANT SELECT ON travel.itinerary_details TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON travel.itinerary_details TO service_role;
CREATE INDEX idx_itinerary_details_itinerary_id ON travel.itinerary_details (itinerary_id);
CREATE TABLE travel.itinerary_members (tourist_id uuid NOT NULL, itinerary_id uuid NOT NULL, added_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE travel.itinerary_members ADD CONSTRAINT fk_member_tourist FOREIGN KEY (tourist_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE travel.itinerary_members ADD CONSTRAINT itinerary_members_itinerary_id_fkey FOREIGN KEY (itinerary_id) REFERENCES travel.itineraries(id);
ALTER TABLE travel.itinerary_members ADD CONSTRAINT itinerary_members_pkey PRIMARY KEY (tourist_id, itinerary_id);
GRANT SELECT ON travel.itinerary_members TO anon;
GRANT SELECT ON travel.itinerary_members TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON travel.itinerary_members TO service_role;
CREATE TABLE travel.place_services (place_id uuid NOT NULL, service_id uuid NOT NULL);
ALTER TABLE travel.place_services ADD CONSTRAINT place_services_pkey PRIMARY KEY (place_id, service_id);
GRANT SELECT ON travel.place_services TO anon;
GRANT SELECT ON travel.place_services TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON travel.place_services TO service_role;
CREATE TABLE travel.place_tags (place_id uuid NOT NULL, tag_id uuid NOT NULL);
ALTER TABLE travel.place_tags ADD CONSTRAINT place_tags_pkey PRIMARY KEY (place_id, tag_id);
GRANT SELECT ON travel.place_tags TO anon;
GRANT SELECT ON travel.place_tags TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON travel.place_tags TO service_role;
CREATE TABLE travel.places (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, name character varying(100) NOT NULL, longitude numeric(10,6), latitude numeric(10,6), address character varying(200), is_approved boolean DEFAULT false, average_rating numeric(3,2) DEFAULT 0, review_count integer DEFAULT 0, open_time time without time zone, close_time time without time zone, description text, is_active boolean DEFAULT true, registered_date date DEFAULT CURRENT_DATE, vendor_id uuid, image_url text[] DEFAULT '{}'::text[], updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP, city_id uuid, source_id character varying, source character varying, type_id uuid, vibes text[], place_url text, district_old character varying(100), visit_duration integer, open_hour_compressed text, travel_type character varying(100), embedding_256 extensions.vector(256), slot_type character varying(50));
ALTER TABLE travel.places ADD CONSTRAINT fk_places_city FOREIGN KEY (city_id) REFERENCES travel.cities(id);
ALTER TABLE travel.places ADD CONSTRAINT fk_places_vendor FOREIGN KEY (vendor_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE travel.places ADD CONSTRAINT places_pkey PRIMARY KEY (id);
ALTER TABLE order_sys.food_items ADD CONSTRAINT food_items_place_id_fkey FOREIGN KEY (place_id) REFERENCES travel.places(id);
ALTER TABLE review_ai.reviews ADD CONSTRAINT reviews_place_id_fkey FOREIGN KEY (place_id) REFERENCES travel.places(id);
ALTER TABLE tracking.geofences ADD CONSTRAINT geofences_place_id_fkey FOREIGN KEY (place_id) REFERENCES travel.places(id) ON DELETE CASCADE;
ALTER TABLE travel.activity_logs ADD CONSTRAINT activity_logs_place_id_fkey FOREIGN KEY (place_id) REFERENCES travel.places(id);
ALTER TABLE travel.favorite_places ADD CONSTRAINT favorite_places_place_id_fkey FOREIGN KEY (place_id) REFERENCES travel.places(id);
ALTER TABLE travel.itinerary_details ADD CONSTRAINT itinerary_details_place_id_fkey FOREIGN KEY (place_id) REFERENCES travel.places(id);
ALTER TABLE travel.place_services ADD CONSTRAINT place_services_place_id_fkey FOREIGN KEY (place_id) REFERENCES travel.places(id);
ALTER TABLE travel.place_tags ADD CONSTRAINT place_tags_place_id_fkey FOREIGN KEY (place_id) REFERENCES travel.places(id) ON DELETE CASCADE;
ALTER TABLE travel.places ADD CONSTRAINT uq_places_source UNIQUE (source, source_id);
GRANT SELECT ON travel.places TO anon;
GRANT SELECT ON travel.places TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON travel.places TO service_role;
CREATE INDEX idx_places_name_unaccent_trgm ON travel.places USING gin (travel.immutable_unaccent(name::text) public.gin_trgm_ops);
CREATE INDEX idx_places_name_unaccent_prefix ON travel.places (travel.immutable_unaccent(name::text) text_pattern_ops);
CREATE INDEX idx_places_type_rating ON travel.places (type_id, average_rating DESC NULLS LAST, review_count DESC NULLS LAST) WHERE is_approved = true AND is_active = true;
CREATE INDEX idx_places_rating_active ON travel.places (average_rating DESC NULLS LAST, review_count DESC NULLS LAST) WHERE is_approved = true AND is_active = true;
CREATE INDEX idx_places_city_id ON travel.places (city_id) WHERE is_approved = true AND is_active = true;
CREATE INDEX idx_places_active_approved ON travel.places (is_approved, is_active);
CREATE INDEX idx_places_city_slot ON travel.places (city_id, slot_type);
CREATE INDEX idx_places_slot_type ON travel.places (slot_type);
CREATE INDEX places_embedding_256_hnsw_idx ON travel.places USING hnsw (embedding_256 extensions.vector_cosine_ops);
CREATE TABLE travel.services (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, name text, price numeric(10,2));
ALTER TABLE travel.services ADD CONSTRAINT services_pkey PRIMARY KEY (id);
ALTER TABLE travel.place_services ADD CONSTRAINT place_services_service_id_fkey FOREIGN KEY (service_id) REFERENCES travel.services(id);
GRANT SELECT ON travel.services TO anon;
GRANT SELECT ON travel.services TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON travel.services TO service_role;
CREATE TABLE travel.tags (id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL, name character varying(100) NOT NULL);
ALTER TABLE travel.tags ADD CONSTRAINT tags_pkey PRIMARY KEY (id);
ALTER TABLE travel.place_tags ADD CONSTRAINT place_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES travel.tags(id) ON DELETE CASCADE;
GRANT SELECT ON travel.tags TO anon;
GRANT SELECT ON travel.tags TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON travel.tags TO service_role;
CREATE TABLE travel.types (id uuid DEFAULT gen_random_uuid() NOT NULL, name character varying(255) NOT NULL, category_id uuid NOT NULL);
ALTER TABLE travel.types ADD CONSTRAINT fk_types_category FOREIGN KEY (category_id) REFERENCES travel.categories(id) ON DELETE RESTRICT;
ALTER TABLE travel.types ADD CONSTRAINT types_pkey PRIMARY KEY (id);
ALTER TABLE travel.places ADD CONSTRAINT fk_places_type FOREIGN KEY (type_id) REFERENCES travel.types(id) ON DELETE RESTRICT;
GRANT SELECT ON travel.types TO anon;
GRANT SELECT ON travel.types TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON travel.types TO service_role;
CREATE INDEX idx_types_category_id ON travel.types (category_id);
