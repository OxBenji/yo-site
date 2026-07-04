-- Run this in Supabase SQL Editor to create the 3 missing tables + RPC
-- Tables that already exist: counters, yo_wall, tg_yo_log, say_yo()

-- ============================================================
-- 1. tg_yos — per-user yo counts from Telegram (bot + leaderboard)
-- ============================================================
create table if not exists tg_yos (
  user_id      bigint primary key,
  username     text,
  display_name text,
  yo_count     integer default 0,
  last_yo_at   timestamptz default now()
);

alter table tg_yos enable row level security;

create policy "public read tg_yos" on tg_yos
  for select using (true);

create index if not exists idx_tg_yos_count on tg_yos (yo_count desc);

-- RPC: increment a user's yo count
create or replace function say_tg_yo(
  p_user_id bigint,
  p_username text default null,
  p_display_name text default null
) returns integer language sql security definer as $$
  insert into tg_yos (user_id, username, display_name, yo_count, last_yo_at)
  values (p_user_id, p_username, p_display_name, 1, now())
  on conflict (user_id) do update
    set yo_count     = tg_yos.yo_count + 1,
        username     = coalesce(excluded.username, tg_yos.username),
        display_name = coalesce(excluded.display_name, tg_yos.display_name),
        last_yo_at   = now()
  returning yo_count;
$$;

-- ============================================================
-- 2. app_config — key-value store (CA, feature flags, etc.)
-- ============================================================
create table if not exists app_config (
  key   text primary key,
  value text
);

alter table app_config enable row level security;

create policy "public read config" on app_config
  for select using (true);

-- ============================================================
-- 3. raid_drops — tweet link tracker
-- ============================================================
create table if not exists raid_drops (
  id         bigserial primary key,
  user_id    bigint not null,
  username   text,
  tweet_url  text not null unique,
  created_at timestamptz default now()
);

alter table raid_drops enable row level security;

create policy "public read raids" on raid_drops
  for select using (true);

create index if not exists idx_raid_drops_created on raid_drops (created_at desc);

-- ============================================================
-- 4. yo_gallery — get yo'd results (small thumbnails for bg wall)
-- ============================================================
create table if not exists yo_gallery (
  id         bigserial primary key,
  thumb      text not null,
  created_at timestamptz default now()
);

alter table yo_gallery enable row level security;
create policy "public read gallery" on yo_gallery for select using (true);
create policy "anon insert gallery" on yo_gallery for insert with check (true);
create index if not exists idx_yo_gallery_created on yo_gallery (created_at desc);

-- ============================================================
-- 5. top_raiders RPC — efficient raiders query (avoids full table scan)
-- ============================================================
create or replace function top_raiders(lim integer default 10)
returns table(user_id bigint, username text, days_active bigint)
language sql stable security definer as $$
  select
    l.user_id,
    max(l.username) as username,
    count(distinct l.created_at::date) as days_active
  from tg_yo_log l
  group by l.user_id
  order by days_active desc
  limit lim;
$$;
