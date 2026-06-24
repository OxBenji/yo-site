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
