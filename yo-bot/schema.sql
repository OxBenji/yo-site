-- Run this in your Supabase SQL editor (supabase.com -> project -> SQL Editor)

-- Table: stores per-user yo counts from Telegram
create table if not exists tg_yos (
  user_id   bigint primary key,
  username  text,
  display_name text,
  yo_count  integer default 0,
  last_yo_at timestamptz default now()
);

-- RPC: increment a user's yo count (called by the bot)
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

-- Allow the leaderboard page to read (anon key)
alter table tg_yos enable row level security;

create policy "public read" on tg_yos
  for select using (true);

-- Index for leaderboard queries
create index if not exists idx_tg_yos_count on tg_yos (yo_count desc);

-- Log table: one row per yo (for time-based stats)
create table if not exists tg_yo_log (
  id         bigserial primary key,
  user_id    bigint not null,
  username   text,
  created_at timestamptz default now()
);

alter table tg_yo_log enable row level security;
create policy "public read log" on tg_yo_log for select using (true);
create index if not exists idx_tg_yo_log_created on tg_yo_log (created_at desc);
create index if not exists idx_tg_yo_log_user_created on tg_yo_log (user_id, created_at desc);

-- ============================================================
-- Global counter (shared between site + bot)
-- ============================================================
create table if not exists counters (
  id    text primary key,
  value bigint default 0
);

-- seed the yo counter row
insert into counters (id, value) values ('yo', 0)
  on conflict (id) do nothing;

alter table counters enable row level security;
create policy "public read counters" on counters for select using (true);

-- ============================================================
-- Yo wall (site shows recent yo handles)
-- ============================================================
create table if not exists yo_wall (
  id         bigserial primary key,
  handle     text,
  created_at timestamptz default now()
);

alter table yo_wall enable row level security;
create policy "public read wall" on yo_wall for select using (true);
-- allow anon inserts from the website
create policy "anon insert wall" on yo_wall for insert with check (true);

create index if not exists idx_yo_wall_created on yo_wall (created_at desc);

-- ============================================================
-- say_yo RPC — called from both site and bot
-- increments global counter, logs to wall, returns new count
-- ============================================================
create or replace function say_yo(p_handle text default null)
returns bigint language plpgsql security definer as $$
declare
  new_val bigint;
begin
  update counters set value = value + 1 where id = 'yo' returning value into new_val;
  insert into yo_wall (handle) values (p_handle);
  return new_val;
end;
$$;

-- ============================================================
-- App config (stores CA + other key-value settings)
-- ============================================================
create table if not exists app_config (
  key   text primary key,
  value text
);

alter table app_config enable row level security;
create policy "public read config" on app_config for select using (true);

-- ============================================================
-- Raid drops (tweet link tracker)
-- ============================================================
create table if not exists raid_drops (
  id         bigserial primary key,
  user_id    bigint not null,
  username   text,
  tweet_url  text not null unique,
  created_at timestamptz default now()
);

alter table raid_drops enable row level security;
create policy "public read raids" on raid_drops for select using (true);
create index if not exists idx_raid_drops_created on raid_drops (created_at desc);
