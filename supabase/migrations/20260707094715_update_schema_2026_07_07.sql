revoke delete on table "tracking"."transport_modes" from "anon";

revoke insert on table "tracking"."transport_modes" from "anon";

revoke select on table "tracking"."transport_modes" from "anon";

revoke update on table "tracking"."transport_modes" from "anon";

revoke delete on table "tracking"."transport_modes" from "authenticated";

revoke insert on table "tracking"."transport_modes" from "authenticated";

revoke select on table "tracking"."transport_modes" from "authenticated";

revoke update on table "tracking"."transport_modes" from "authenticated";

revoke delete on table "tracking"."transport_modes" from "service_role";

revoke insert on table "tracking"."transport_modes" from "service_role";

revoke select on table "tracking"."transport_modes" from "service_role";

revoke update on table "tracking"."transport_modes" from "service_role";

revoke delete on table "tracking"."transport_pricing_rules" from "anon";

revoke insert on table "tracking"."transport_pricing_rules" from "anon";

revoke select on table "tracking"."transport_pricing_rules" from "anon";

revoke update on table "tracking"."transport_pricing_rules" from "anon";

revoke delete on table "tracking"."transport_pricing_rules" from "authenticated";

revoke insert on table "tracking"."transport_pricing_rules" from "authenticated";

revoke select on table "tracking"."transport_pricing_rules" from "authenticated";

revoke update on table "tracking"."transport_pricing_rules" from "authenticated";

revoke delete on table "tracking"."transport_pricing_rules" from "service_role";

revoke insert on table "tracking"."transport_pricing_rules" from "service_role";

revoke select on table "tracking"."transport_pricing_rules" from "service_role";

revoke update on table "tracking"."transport_pricing_rules" from "service_role";

revoke delete on table "tracking"."transport_to_destination" from "anon";

revoke insert on table "tracking"."transport_to_destination" from "anon";

revoke select on table "tracking"."transport_to_destination" from "anon";

revoke update on table "tracking"."transport_to_destination" from "anon";

revoke delete on table "tracking"."transport_to_destination" from "authenticated";

revoke insert on table "tracking"."transport_to_destination" from "authenticated";

revoke select on table "tracking"."transport_to_destination" from "authenticated";

revoke update on table "tracking"."transport_to_destination" from "authenticated";

revoke delete on table "tracking"."transport_to_destination" from "service_role";

revoke insert on table "tracking"."transport_to_destination" from "service_role";

revoke select on table "tracking"."transport_to_destination" from "service_role";

revoke update on table "tracking"."transport_to_destination" from "service_role";

revoke delete on table "tracking"."transport_within_city" from "anon";

revoke insert on table "tracking"."transport_within_city" from "anon";

revoke select on table "tracking"."transport_within_city" from "anon";

revoke update on table "tracking"."transport_within_city" from "anon";

revoke delete on table "tracking"."transport_within_city" from "authenticated";

revoke insert on table "tracking"."transport_within_city" from "authenticated";

revoke select on table "tracking"."transport_within_city" from "authenticated";

revoke update on table "tracking"."transport_within_city" from "authenticated";

revoke delete on table "tracking"."transport_within_city" from "service_role";

revoke insert on table "tracking"."transport_within_city" from "service_role";

revoke select on table "tracking"."transport_within_city" from "service_role";

revoke update on table "tracking"."transport_within_city" from "service_role";

revoke select on table "travel"."place_tags" from "anon";

revoke select on table "travel"."place_tags" from "authenticated";

revoke delete on table "travel"."place_tags" from "service_role";

revoke insert on table "travel"."place_tags" from "service_role";

revoke select on table "travel"."place_tags" from "service_role";

revoke update on table "travel"."place_tags" from "service_role";

revoke select on table "travel"."tags" from "anon";

revoke select on table "travel"."tags" from "authenticated";

revoke delete on table "travel"."tags" from "service_role";

revoke insert on table "travel"."tags" from "service_role";

revoke select on table "travel"."tags" from "service_role";

revoke update on table "travel"."tags" from "service_role";

alter table "tracking"."transport_pricing_rules" drop constraint "transport_pricing_rules_transport_mode_id_fkey";

alter table "tracking"."transport_to_destination" drop constraint "fk_transport_itinerary";

alter table "tracking"."transport_to_destination" drop constraint "transport_to_destination_transport_mode_id_fkey";

alter table "tracking"."transport_within_city" drop constraint "transport_within_city_itinerary_detail_id_fkey";

alter table "tracking"."transport_within_city" drop constraint "transport_within_city_transport_mode_id_fkey";

alter table "travel"."place_tags" drop constraint "place_tags_place_id_fkey";

alter table "travel"."place_tags" drop constraint "place_tags_tag_id_fkey";

alter table "review_ai"."reviews" drop constraint "reviews_place_id_fkey";

alter table "travel"."itinerary_details" drop constraint "itinerary_details_place_id_fkey";

alter table "travel"."itinerary_members" drop constraint "itinerary_members_itinerary_id_fkey";

alter table "tracking"."transport_modes" drop constraint "transport_modes_pkey";

alter table "tracking"."transport_pricing_rules" drop constraint "transport_pricing_rules_pkey";

alter table "tracking"."transport_to_destination" drop constraint "transport_to_destination_pkey";

alter table "tracking"."transport_within_city" drop constraint "transport_within_city_pkey";

alter table "travel"."place_tags" drop constraint "place_tags_pkey";

alter table "travel"."tags" drop constraint "tags_pkey";

drop index if exists "tracking"."transport_modes_pkey";

drop index if exists "tracking"."transport_pricing_rules_pkey";

drop index if exists "tracking"."transport_to_destination_pkey";

drop index if exists "tracking"."transport_within_city_pkey";

drop index if exists "travel"."place_tags_pkey";

drop index if exists "travel"."tags_pkey";

drop table "tracking"."transport_modes";

drop table "tracking"."transport_pricing_rules";

drop table "tracking"."transport_to_destination";

drop table "tracking"."transport_within_city";

drop table "travel"."place_tags";

drop table "travel"."tags";

alter table "review_ai"."reviews" alter column "status" drop default;

alter type "review_ai"."review_status_enum" rename to "review_status_enum__old_version_to_be_dropped";

create type "review_ai"."review_status_enum" as enum ('pending', 'approved', 'violation', 'hidden');

alter type "review_ai"."topic_enum" rename to "topic_enum__old_version_to_be_dropped";

create type "review_ai"."topic_enum" as enum ('traffic', 'weather', 'crowd', 'service', 'price', 'food', 'cleanliness', 'infra', 'activity', 'atmosphere', 'other');


  create table "ai_config"."algorithm_schedules" (
    "id" uuid not null default gen_random_uuid(),
    "algorithm_id" uuid not null,
    "is_enabled" boolean not null default false,
    "frequency" character varying(16) not null default 'daily'::character varying,
    "run_time" time without time zone not null default '02:00:00'::time without time zone,
    "run_day" integer not null default 1,
    "timezone" character varying(64) not null default 'Asia/Ho_Chi_Minh'::character varying,
    "last_run_at" timestamp with time zone,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );



  create table "order_sys"."hotel_rooms" (
    "id" uuid not null,
    "place_id" uuid not null,
    "name" text not null,
    "price" numeric(12,2) not null,
    "quantity" integer not null
      );



  create table "travel"."distance_matrix" (
    "origin_place_id" uuid not null,
    "destination_place_id" uuid not null,
    "travel_mode" character varying(20) not null default 'DRIVING'::character varying,
    "distance_meters" integer not null,
    "duration_seconds" integer not null,
    "updated_at" timestamp without time zone not null default now()
      );


alter table "travel"."distance_matrix" enable row level security;

alter table "review_ai"."review_conflicts" alter column conflict_topic type "review_ai"."topic_enum" using conflict_topic::text::"review_ai"."topic_enum";

alter table "review_ai"."review_contents" alter column main_topic type "review_ai"."topic_enum" using main_topic::text::"review_ai"."topic_enum";

alter table "review_ai"."reviews" alter column status type "review_ai"."review_status_enum" using status::text::"review_ai"."review_status_enum";

alter table "review_ai"."reviews" alter column "status" set default 'pending'::review_ai.review_status_enum;

drop type "review_ai"."review_status_enum__old_version_to_be_dropped";

drop type "review_ai"."topic_enum__old_version_to_be_dropped";

alter table "order_sys"."orders" add column "auto_complete_at" timestamp with time zone;

alter table "order_sys"."orders" add column "confirmed_at" timestamp with time zone;

alter table "order_sys"."orders" add column "place_id" uuid;

alter table "public"."users" add column "fcm_token" text;

alter table "review_ai"."itinerary_reviews" add column "violation_reason" text;

alter table "review_ai"."reviews" add column "violation_reason" text;

alter table "travel"."cities" add column "image_url" text;

alter table "travel"."itineraries" add column "daily_end_time" time without time zone default '22:00:00'::time without time zone;

alter table "travel"."itineraries" add column "daily_start_time" time without time zone default '07:00:00'::time without time zone;

alter table "travel"."itineraries" add column "travel_mode" character varying(20) not null default 'DRIVING'::character varying;

alter table "travel"."itinerary_details" add column "detail_type" character varying(20) not null default 'ACTIVITY'::character varying;

alter table "travel"."itinerary_details" add column "travel_distance_km" numeric(10,3) default 0;

alter table "travel"."itinerary_details" add column "travel_minutes" integer default 0;

alter table "travel"."itinerary_details" alter column "transport_cost" set default 0;

alter table "travel"."places" add column "best_time" text;

alter table "travel"."places" add column "email" character varying(255);

alter table "travel"."places" add column "estimated_preparation_time" integer;

alter table "travel"."places" add column "is_deleted" boolean not null default false;

alter table "travel"."places" add column "phone" text;

alter table "travel"."places" add column "price" integer;

alter table "travel"."places" add column "price_inferred" boolean;

CREATE UNIQUE INDEX algorithm_schedules_algorithm_unique ON ai_config.algorithm_schedules USING btree (algorithm_id);

CREATE UNIQUE INDEX algorithm_schedules_pkey ON ai_config.algorithm_schedules USING btree (id);

CREATE INDEX idx_algorithm_schedules_algorithm_id ON ai_config.algorithm_schedules USING btree (algorithm_id);

CREATE INDEX idx_algorithm_schedules_enabled ON ai_config.algorithm_schedules USING btree (is_enabled);

CREATE UNIQUE INDEX hotel_rooms_pkey ON order_sys.hotel_rooms USING btree (id);

CREATE INDEX idx_hotel_rooms_place_id ON order_sys.hotel_rooms USING btree (place_id);

CREATE INDEX idx_review_contents_review_id ON review_ai.review_contents USING btree (review_id);

CREATE INDEX idx_reviews_place_approved ON review_ai.reviews USING btree (place_id) WHERE ((status = 'approved'::review_ai.review_status_enum) AND (rating IS NOT NULL));

CREATE INDEX idx_reviews_place_status_rating ON review_ai.reviews USING btree (place_id, status, rating);

CREATE UNIQUE INDEX distance_matrix_pkey ON travel.distance_matrix USING btree (origin_place_id, destination_place_id, travel_mode);

CREATE INDEX idx_distance_matrix_destination ON travel.distance_matrix USING btree (destination_place_id);

CREATE INDEX idx_distance_matrix_origin ON travel.distance_matrix USING btree (origin_place_id);

CREATE INDEX idx_distance_matrix_updated_at ON travel.distance_matrix USING btree (updated_at);

CREATE INDEX idx_itinerary_details_itinerary_sequence ON travel.itinerary_details USING btree (itinerary_id, visit_date, sequence_order);

CREATE INDEX idx_itinerary_details_itinerary_type ON travel.itinerary_details USING btree (itinerary_id, detail_type);

CREATE INDEX idx_places_rating_reviews ON travel.places USING btree (average_rating DESC NULLS LAST, review_count DESC NULLS LAST);

alter table "ai_config"."algorithm_schedules" add constraint "algorithm_schedules_pkey" PRIMARY KEY using index "algorithm_schedules_pkey";

alter table "order_sys"."hotel_rooms" add constraint "hotel_rooms_pkey" PRIMARY KEY using index "hotel_rooms_pkey";

alter table "travel"."distance_matrix" add constraint "distance_matrix_pkey" PRIMARY KEY using index "distance_matrix_pkey";

alter table "ai_config"."algorithm_schedules" add constraint "algorithm_schedules_algorithm_id_fkey" FOREIGN KEY (algorithm_id) REFERENCES ai_config.algorithms(id) ON DELETE CASCADE not valid;

alter table "ai_config"."algorithm_schedules" validate constraint "algorithm_schedules_algorithm_id_fkey";

alter table "ai_config"."algorithm_schedules" add constraint "algorithm_schedules_algorithm_unique" UNIQUE using index "algorithm_schedules_algorithm_unique";

alter table "ai_config"."algorithm_schedules" add constraint "algorithm_schedules_frequency_check" CHECK (((frequency)::text = ANY ((ARRAY['daily'::character varying, 'weekly'::character varying, 'monthly'::character varying])::text[]))) not valid;

alter table "ai_config"."algorithm_schedules" validate constraint "algorithm_schedules_frequency_check";

alter table "ai_config"."algorithm_schedules" add constraint "algorithm_schedules_run_day_check" CHECK (((run_day >= 0) AND (run_day <= 31))) not valid;

alter table "ai_config"."algorithm_schedules" validate constraint "algorithm_schedules_run_day_check";

alter table "order_sys"."hotel_rooms" add constraint "hotel_rooms_place_id_fkey" FOREIGN KEY (place_id) REFERENCES travel.places(id) ON DELETE CASCADE not valid;

alter table "order_sys"."hotel_rooms" validate constraint "hotel_rooms_place_id_fkey";

alter table "order_sys"."hotel_rooms" add constraint "hotel_rooms_price_check" CHECK ((price >= (0)::numeric)) not valid;

alter table "order_sys"."hotel_rooms" validate constraint "hotel_rooms_price_check";

alter table "order_sys"."hotel_rooms" add constraint "hotel_rooms_quantity_check" CHECK ((quantity > 0)) not valid;

alter table "order_sys"."hotel_rooms" validate constraint "hotel_rooms_quantity_check";

alter table "travel"."distance_matrix" add constraint "distance_matrix_destination_fkey" FOREIGN KEY (destination_place_id) REFERENCES travel.places(id) ON DELETE CASCADE not valid;

alter table "travel"."distance_matrix" validate constraint "distance_matrix_destination_fkey";

alter table "travel"."distance_matrix" add constraint "distance_matrix_distinct_places_check" CHECK ((origin_place_id <> destination_place_id)) not valid;

alter table "travel"."distance_matrix" validate constraint "distance_matrix_distinct_places_check";

alter table "travel"."distance_matrix" add constraint "distance_matrix_origin_fkey" FOREIGN KEY (origin_place_id) REFERENCES travel.places(id) ON DELETE CASCADE not valid;

alter table "travel"."distance_matrix" validate constraint "distance_matrix_origin_fkey";

alter table "travel"."distance_matrix" add constraint "distance_matrix_positive_check" CHECK (((distance_meters >= 0) AND (duration_seconds >= 0))) not valid;

alter table "travel"."distance_matrix" validate constraint "distance_matrix_positive_check";

alter table "travel"."itineraries" add constraint "itineraries_travel_mode_check" CHECK (((travel_mode)::text = ANY ((ARRAY['DRIVING'::character varying, 'MOTORBIKE'::character varying])::text[]))) not valid;

alter table "travel"."itineraries" validate constraint "itineraries_travel_mode_check";

alter table "travel"."itinerary_details" add constraint "itinerary_details_detail_type_check" CHECK (((detail_type)::text = ANY ((ARRAY['HOTEL'::character varying, 'ACTIVITY'::character varying])::text[]))) not valid;

alter table "travel"."itinerary_details" validate constraint "itinerary_details_detail_type_check";

alter table "travel"."places" add constraint "places_estimated_preparation_time_check" CHECK (((estimated_preparation_time IS NULL) OR ((estimated_preparation_time >= 1) AND (estimated_preparation_time <= 480)))) not valid;

alter table "travel"."places" validate constraint "places_estimated_preparation_time_check";

alter table "review_ai"."reviews" add constraint "reviews_place_id_fkey" FOREIGN KEY (place_id) REFERENCES travel.places(id) ON DELETE CASCADE not valid;

alter table "review_ai"."reviews" validate constraint "reviews_place_id_fkey";

alter table "travel"."itinerary_details" add constraint "itinerary_details_place_id_fkey" FOREIGN KEY (place_id) REFERENCES travel.places(id) ON DELETE CASCADE not valid;

alter table "travel"."itinerary_details" validate constraint "itinerary_details_place_id_fkey";

alter table "travel"."itinerary_members" add constraint "itinerary_members_itinerary_id_fkey" FOREIGN KEY (itinerary_id) REFERENCES travel.itineraries(id) ON DELETE CASCADE not valid;

alter table "travel"."itinerary_members" validate constraint "itinerary_members_itinerary_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.get_cities_for_plan_trip()
 RETURNS TABLE(id uuid, name text)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT id, name FROM travel.cities ORDER BY name ASC;
$function$
;

CREATE OR REPLACE FUNCTION public.get_cities_for_plan_trip(p_keyword text DEFAULT NULL::text)
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
$function$
;

CREATE OR REPLACE FUNCTION travel.update_place_rating_stats()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    target_place_id UUID;
BEGIN
    target_place_id := COALESCE(NEW.place_id, OLD.place_id);

    IF target_place_id IS NULL THEN
        RETURN NULL;
    END IF;

    UPDATE travel.places
    SET
        average_rating = COALESCE((
            SELECT ROUND(AVG(r.rating)::numeric, 1)
            FROM review_ai.reviews r
            WHERE r.place_id = target_place_id
              AND r.rating IS NOT NULL
              AND r.status = 'approved'
        ), 0),
        review_count = COALESCE((
            SELECT COUNT(*)::integer
            FROM review_ai.reviews r
            WHERE r.place_id = target_place_id
              AND r.status = 'approved'
        ), 0),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = target_place_id;

    RETURN NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_cities_for_plan_trip(p_keyword text DEFAULT NULL::text, p_destination_only boolean DEFAULT false)
 RETURNS TABLE(id uuid, name text)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  -- Không có keyword: trả về danh sách 17 tỉnh/thành app đang hỗ trợ, theo thứ tự ưu
  -- tiên cố định. Dùng chung cho cả gợi ý ban đầu của "điểm khởi hành" lẫn danh sách
  -- đầy đủ của "điểm đến" (vì điểm đến bị giới hạn đúng trong danh sách này).
  IF p_keyword IS NULL OR p_keyword = '' THEN
    RETURN QUERY
      SELECT c.id, c.name::text
      FROM travel.cities c
      JOIN (VALUES
        ('a821f185-9826-568f-a3d2-967f0efd1c9d'::uuid, 1),  -- Hà Nội
        ('3b9a22b3-293b-5313-97c5-d9b71c30756f'::uuid, 2),  -- Hồ Chí Minh
        ('1aa5ed1b-16c1-51f4-a3ba-c25e0ed91ce5'::uuid, 3),  -- Khánh Hòa
        ('8a10b8b8-6875-58e0-9bee-27f67e54376e'::uuid, 4),  -- Đà Nẵng
        ('340af4ff-0cda-5e1a-8e02-a999acc906f6'::uuid, 5),  -- Lâm Đồng
        ('3cf95641-de1c-5baf-97a7-6f23cd4e72c6'::uuid, 6),  -- Cần Thơ
        ('fc51a18f-b4bb-5183-9d81-6a7e03a0ca4a'::uuid, 7),  -- Vũng Tàu
        ('477756f3-d73f-55b7-8698-21d64befaf2d'::uuid, 8),  -- Quảng Nam
        ('477a099d-8dd4-5899-877c-b911a1c7fb8b'::uuid, 9),  -- Huế
        ('9ff5279d-422e-5192-af82-12b7d154a736'::uuid, 10), -- Bình Dương
        ('c4626942-6b84-5d47-bf7f-239bc3ece44c'::uuid, 11), -- Đồng Nai
        ('8dfd58c0-e0a9-5169-8c71-fdbc2633c971'::uuid, 12), -- Kiên Giang
        ('7eedad92-8762-57fd-9584-566b0653b957'::uuid, 13), -- Quảng Ninh
        ('9d697eb4-3bf0-58a8-9f31-e086d59d7c7d'::uuid, 14), -- Bình Thuận
        ('87685562-e744-53cc-a324-2a65540348a6'::uuid, 15), -- Hải Phòng
        ('49dd4ebd-8d34-5130-a01c-bdc8ea17101e'::uuid, 16), -- Nghệ An
        ('5874b9ef-ea1e-556b-917f-2b2b0f89d98d'::uuid, 17)  -- Phú Yên
      ) AS supported(city_id, sort_order) ON supported.city_id = c.id
      ORDER BY supported.sort_order;
    RETURN;
  END IF;

  -- Có keyword nhưng bị giới hạn điểm đến: chỉ tìm trong 17 tỉnh/thành hỗ trợ.
  IF p_destination_only THEN
    RETURN QUERY
      SELECT c.id, c.name::text
      FROM travel.cities c
      JOIN (VALUES
        ('a821f185-9826-568f-a3d2-967f0efd1c9d'::uuid, 1),
        ('3b9a22b3-293b-5313-97c5-d9b71c30756f'::uuid, 2),
        ('1aa5ed1b-16c1-51f4-a3ba-c25e0ed91ce5'::uuid, 3),
        ('8a10b8b8-6875-58e0-9bee-27f67e54376e'::uuid, 4),
        ('340af4ff-0cda-5e1a-8e02-a999acc906f6'::uuid, 5),
        ('3cf95641-de1c-5baf-97a7-6f23cd4e72c6'::uuid, 6),
        ('fc51a18f-b4bb-5183-9d81-6a7e03a0ca4a'::uuid, 7),
        ('477756f3-d73f-55b7-8698-21d64befaf2d'::uuid, 8),
        ('477a099d-8dd4-5899-877c-b911a1c7fb8b'::uuid, 9),
        ('9ff5279d-422e-5192-af82-12b7d154a736'::uuid, 10),
        ('c4626942-6b84-5d47-bf7f-239bc3ece44c'::uuid, 11),
        ('8dfd58c0-e0a9-5169-8c71-fdbc2633c971'::uuid, 12),
        ('7eedad92-8762-57fd-9584-566b0653b957'::uuid, 13),
        ('9d697eb4-3bf0-58a8-9f31-e086d59d7c7d'::uuid, 14),
        ('87685562-e744-53cc-a324-2a65540348a6'::uuid, 15),
        ('49dd4ebd-8d34-5130-a01c-bdc8ea17101e'::uuid, 16),
        ('5874b9ef-ea1e-556b-917f-2b2b0f89d98d'::uuid, 17)
      ) AS supported(city_id, sort_order) ON supported.city_id = c.id
      WHERE c.name ILIKE '%' || p_keyword || '%'
      ORDER BY supported.sort_order;
    RETURN;
  END IF;

  -- Điểm khởi hành: có keyword, tìm kiếm tự do trên toàn bộ travel.cities.
  RETURN QUERY
    SELECT c.id, c.name::text
    FROM travel.cities c
    WHERE c.name ILIKE '%' || p_keyword || '%'
    ORDER BY c.name
    LIMIT 20;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_place_popularity_stats(p_limit integer DEFAULT 20, p_mode text DEFAULT 'top'::text, p_category_name text DEFAULT NULL::text)
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
    WHERE  gv.status       = 'visited'
      AND  gv.tourist_id    IS NOT NULL
      AND  (
        p_category_name IS NULL
        OR p.type_id IN (
          SELECT t.id
          FROM   travel.types t
          JOIN   travel.categories c ON c.id = t.category_id
          WHERE  c.name = p_category_name
        )
      )
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
    WHERE  gv.status       = 'visited'
      AND  gv.tourist_id    IS NOT NULL
      AND  (
        p_category_name IS NULL
        OR p.type_id IN (
          SELECT t.id
          FROM   travel.types t
          JOIN   travel.categories c ON c.id = t.category_id
          WHERE  c.name = p_category_name
        )
      )
    GROUP  BY p.id, p.name
    ORDER  BY COUNT(DISTINCT gv.tourist_id) ASC
    LIMIT  p_limit;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.recommend_places_by_slot(query_embedding extensions.vector, target_city_id uuid, p_slot_type character varying, p_limit integer DEFAULT 20, p_travel_type character varying DEFAULT NULL::character varying)
 RETURNS TABLE(place_id uuid, place_name text, address text, image_url text, category text, type_name text, score double precision)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    p.id                                              AS place_id,
    p.name::text                                      AS place_name,
    p.address::text,
    (p.image_url)[1]                                  AS image_url,
    t.slot_type::text                                 AS category,
    t.name::text                                      AS type_name,
    1 - (p.embedding_256 <=> query_embedding)         AS score
  FROM travel.places p
  JOIN travel.types t ON t.id = p.type_id
  WHERE p.city_id       = target_city_id
    AND t.slot_type     = p_slot_type
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
$function$
;

CREATE OR REPLACE FUNCTION travel.search_autocomplete(p_query text, p_limit integer DEFAULT 20)
 RETURNS TABLE(id uuid, name text, type text, image text, city text, rating double precision, score double precision)
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
    nq         text := travel.immutable_unaccent(coalesce(trim(p_query), ''));
    prefix_pat text;   -- 'nq%'  : khớp đầu chuỗi (tính boost + dùng cho query ngắn)
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

    -- Dùng EXECUTE để mẫu LIKE là HẰNG trong câu lệnh → planner chắc chắn chọn index.
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
                0::bigint                             as review_count,
                (case when travel.immutable_unaccent(c.name) like %L then 100 else 50 end)::float as score
            from travel.cities c
            where travel.immutable_unaccent(c.name) like %L

            union all

            -- ===== PLACE: rank = prefix boost + Bayesian(rating, review_count)/5 =====
            select
                p.id,
                p.name::text                          as name,
                'place'::text                         as type,
                coalesce(p.image_url[1], '')          as image,
                coalesce(ci.name, '')::text           as city,
                coalesce(p.average_rating, 0)::float  as rating,
                coalesce(p.review_count, 0)::bigint   as review_count,
                (
                    (case when travel.immutable_unaccent(p.name) like %L then 3 else 0 end)
                    + (case
                         when coalesce(p.review_count, 0) = 0
                              and coalesce(p.average_rating, 0) = 0 then 0
                         else (
                             (coalesce(p.review_count, 0)::float
                                / (coalesce(p.review_count, 0) + 10))
                               * coalesce(p.average_rating, 0)
                             + (10.0 / (coalesce(p.review_count, 0) + 10)) * 3.0
                         ) / 5.0
                       end)
                )::float                              as score
            from travel.places p
            left join travel.cities ci on ci.id = p.city_id
            where p.is_approved
              and p.is_active
              and travel.immutable_unaccent(p.name) like %L
        ) t
        order by t.score desc, t.rating desc, t.review_count desc
        limit %s
    $q$, prefix_pat, city_pat, prefix_pat, place_pat, greatest(p_limit, 1));
end;
$function$
;

grant delete on table "ai_config"."algorithm_schedules" to "anon";

grant insert on table "ai_config"."algorithm_schedules" to "anon";

grant references on table "ai_config"."algorithm_schedules" to "anon";

grant select on table "ai_config"."algorithm_schedules" to "anon";

grant trigger on table "ai_config"."algorithm_schedules" to "anon";

grant truncate on table "ai_config"."algorithm_schedules" to "anon";

grant update on table "ai_config"."algorithm_schedules" to "anon";

grant delete on table "ai_config"."algorithm_schedules" to "authenticated";

grant insert on table "ai_config"."algorithm_schedules" to "authenticated";

grant references on table "ai_config"."algorithm_schedules" to "authenticated";

grant select on table "ai_config"."algorithm_schedules" to "authenticated";

grant trigger on table "ai_config"."algorithm_schedules" to "authenticated";

grant truncate on table "ai_config"."algorithm_schedules" to "authenticated";

grant update on table "ai_config"."algorithm_schedules" to "authenticated";

grant delete on table "ai_config"."algorithm_schedules" to "service_role";

grant insert on table "ai_config"."algorithm_schedules" to "service_role";

grant references on table "ai_config"."algorithm_schedules" to "service_role";

grant select on table "ai_config"."algorithm_schedules" to "service_role";

grant trigger on table "ai_config"."algorithm_schedules" to "service_role";

grant truncate on table "ai_config"."algorithm_schedules" to "service_role";

grant update on table "ai_config"."algorithm_schedules" to "service_role";

grant select on table "order_sys"."hotel_rooms" to "anon";

grant select on table "order_sys"."hotel_rooms" to "authenticated";

grant insert on table "order_sys"."hotel_rooms" to "service_role";

grant select on table "order_sys"."hotel_rooms" to "service_role";

grant update on table "order_sys"."hotel_rooms" to "service_role";

grant select on table "travel"."distance_matrix" to "anon";

grant select on table "travel"."distance_matrix" to "authenticated";

grant delete on table "travel"."distance_matrix" to "service_role";

grant insert on table "travel"."distance_matrix" to "service_role";

grant select on table "travel"."distance_matrix" to "service_role";

grant update on table "travel"."distance_matrix" to "service_role";

CREATE TRIGGER trg_update_place_rating_stats AFTER DELETE OR UPDATE ON review_ai.reviews FOR EACH ROW EXECUTE FUNCTION travel.update_place_rating_stats();


