-- ============================================================================
-- Duet Database Schema — Username/Password Auth (No OTP/Phone)
-- ============================================================================
-- Apply this entire file in the Supabase SQL editor. It is safe to re-run.
-- The Node server connects with the service_role key. RLS is enabled and the
-- anon/authenticated roles have no table or function access.
-- ============================================================================

-- Users ---------------------------------------------------------------------

create table if not exists public.users (
  id               uuid primary key default gen_random_uuid(),
  username         text not null unique,
  password_hash    text not null,
  display_name     text,
  avatar_color     smallint not null default 0,
  presence_visible boolean not null default true,
  presence_online  boolean not null default false,
  last_seen_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Sessions ------------------------------------------------------------------

create table if not exists public.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  token_hash   text not null unique,
  user_agent   text,
  ip           text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null
);

-- Conversations -------------------------------------------------------------

create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  last_message_at timestamptz
);

create table if not exists public.conversation_participants (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz,
  primary key (conversation_id, user_id)
);

-- Messages ------------------------------------------------------------------

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id       uuid not null references public.users(id) on delete cascade,
  type            text not null check (type in ('text', 'image', 'video', 'session')),
  ciphertext      text,
  envelope        jsonb,
  media_id        uuid,
  media_meta      jsonb,
  client_id       text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  read_at         timestamptz,
  edited_at       timestamptz,
  deleted_at      timestamptz
);

create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc, id desc);
create unique index if not exists messages_conversation_client_idx
  on public.messages (conversation_id, client_id);

-- Invites -------------------------------------------------------------------

create table if not exists public.invites (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text not null unique,
  created_by   uuid not null references public.users(id) on delete cascade,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  redeemed_by  uuid references public.users(id) on delete set null,
  redeemed_at  timestamptz
);

-- Keys (X3DH prekey bundles) ------------------------------------------------
-- `signed_prekey` is a small JSON object: { id, publicKey, signature, createdAt }
-- One-time prekeys live in their own table so they can be consumed atomically.

create table if not exists public.key_bundles (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  device_id    text not null,
  identity_key text not null,
  signed_prekey jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, device_id)
);

create table if not exists public.one_time_prekeys (
  id         bigserial primary key,
  user_id    uuid not null references public.users(id) on delete cascade,
  device_id  text not null,
  prekey_id  integer not null,
  public_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, device_id, prekey_id)
);

create index if not exists one_time_prekeys_user_idx
  on public.one_time_prekeys (user_id, created_at asc);

-- Encrypted media -----------------------------------------------------------

create table if not exists public.media (
  id              uuid primary key,
  uploader_id     uuid not null references public.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  storage_path    text not null unique,
  size_bytes      bigint not null default 0,
  mime_hint       text,
  created_at      timestamptz not null default now()
);

-- Push subscriptions --------------------------------------------------------

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  endpoint   text not null,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

-- Connection requests -------------------------------------------------------

create table if not exists public.connection_requests (
  id            uuid primary key default gen_random_uuid(),
  from_user_id  uuid not null references public.users(id) on delete cascade,
  to_user_id    uuid not null references public.users(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,
  unique (from_user_id, to_user_id)
);

-- Events (for SSE realtime) -------------------------------------------------

create table if not exists public.events (
  id         bigserial primary key,
  user_id    uuid not null references public.users(id) on delete cascade,
  kind       text not null,
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists events_user_created_idx
  on public.events (user_id, created_at desc);

-- Vault backup (encrypted keystore) -----------------------------------------

create table if not exists public.vault_backups (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  device_id     text not null,
  recovery_salt text not null,
  wrapped_mk    text not null,
  keystore_blob text not null,
  key_version   integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, device_id)
);

-- Rate limiting -------------------------------------------------------------

create table if not exists public.rate_limit_hits (
  id         bigserial primary key,
  bucket     text not null,
  key        text not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_bucket_key_created_idx
  on public.rate_limit_hits (bucket, key, created_at);

-- Diagnostics ---------------------------------------------------------------

create table if not exists public.diagnostics (
  id         bigserial primary key,
  user_id    uuid not null references public.users(id) on delete cascade,
  build      text,
  event      text not null,
  fields     jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists diagnostics_user_created_idx
  on public.diagnostics (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RPC Functions
-- ---------------------------------------------------------------------------

-- Consume a one-time prekey atomically.
create or replace function public.duet_consume_prekey(p_user_id uuid)
returns table (device_id text, prekey_id integer, public_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.one_time_prekeys;
begin
  select * into v_row
    from public.one_time_prekeys
   where user_id = p_user_id
   order by created_at asc, id asc
   limit 1
   for update skip locked;

  if not found then
    return;
  end if;

  delete from public.one_time_prekeys where id = v_row.id;

  return query select v_row.device_id, v_row.prekey_id, v_row.public_key;
end;
$$;

-- List conversations for a user (with peer data and unread counts).
create or replace function public.duet_list_conversations(p_user uuid)
returns table (
  conversation_id uuid,
  peer_id uuid,
  peer_display_name text,
  peer_avatar_color smallint,
  peer_last_seen_at timestamptz,
  peer_presence_visible boolean,
  peer_online boolean,
  last_message_at timestamptz,
  unread_count int,
  last_message_type text,
  last_message_sender_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id as conversation_id,
    peer.user_id as peer_id,
    u.display_name as peer_display_name,
    u.avatar_color as peer_avatar_color,
    u.last_seen_at as peer_last_seen_at,
    u.presence_visible as peer_presence_visible,
    (coalesce(u.presence_online, false)
      and u.last_seen_at is not null
      and u.last_seen_at > now() - interval '65 seconds') as peer_online,
    c.last_message_at,
    coalesce((
      select count(*)::int
        from public.messages m
       where m.conversation_id = c.id
         and m.sender_id <> p_user
         and m.read_at is null
         and m.deleted_at is null
         and m.type <> 'session'
    ), 0) as unread_count,
    lm.type as last_message_type,
    lm.sender_id as last_message_sender_id
  from public.conversation_participants mine
  join public.conversations c on c.id = mine.conversation_id
  join public.conversation_participants peer
    on peer.conversation_id = c.id and peer.user_id <> p_user
  join public.users u on u.id = peer.user_id
  left join lateral (
    select m.type, m.sender_id
      from public.messages m
     where m.conversation_id = c.id
       and m.deleted_at is null
     order by m.created_at desc, m.id desc
     limit 1
  ) lm on true
  where mine.user_id = p_user
  order by coalesce(c.last_message_at, c.created_at) desc;
$$;

-- Peer IDs for a user (used for presence and key notifications).
create or replace function public.duet_peer_ids(p_user uuid)
returns table (peer_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select distinct other.user_id
    from public.conversation_participants mine
    join public.conversation_participants other
      on other.conversation_id = mine.conversation_id
     and other.user_id <> p_user
   where mine.user_id = p_user;
$$;

-- Rate limiting.
create or replace function public.duet_rate_limit(
  p_bucket text,
  p_key text,
  p_window_seconds int,
  p_limit int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count bigint;
  v_oldest timestamptz;
  v_retry int;
begin
  delete from public.rate_limit_hits
   where created_at < now() - make_interval(secs => p_window_seconds);

  select count(*), min(created_at) into v_count, v_oldest
    from public.rate_limit_hits
   where bucket = p_bucket and key = p_key;

  if v_count >= p_limit then
    v_retry := greatest(1, ceil(extract(epoch from
      (v_oldest + make_interval(secs => p_window_seconds) - now())))::int);
    return jsonb_build_object('allowed', false, 'retryAfter', v_retry);
  end if;

  insert into public.rate_limit_hits(bucket, key) values (p_bucket, p_key);
  return jsonb_build_object('allowed', true, 'remaining', p_limit - v_count - 1);
end;
$$;

-- Find a conversation between two users.
create or replace function public.duet_conversation_between(p_user1 uuid, p_user2 uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.id
    from public.conversation_participants p1
    join public.conversation_participants p2
      on p2.conversation_id = p1.conversation_id
     and p2.user_id = p_user2
    join public.conversations c on c.id = p1.conversation_id
   where p1.user_id = p_user1
   limit 1;
$$;

-- Accept a connection request (creates the conversation if needed).
create or replace function public.duet_accept_connection(p_request_id uuid, p_user uuid)
returns table (conversation_id uuid, peer_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from uuid;
  v_conv uuid;
begin
  update public.connection_requests
     set status = 'accepted', responded_at = now()
   where id = p_request_id
     and to_user_id = p_user
     and status = 'pending'
   returning from_user_id into v_from;

  if not found then
    return;
  end if;

  v_conv := public.duet_conversation_between(p_user, v_from);
  if v_conv is null then
    insert into public.conversations default values
    returning id into v_conv;
    insert into public.conversation_participants (conversation_id, user_id)
    values (v_conv, p_user), (v_conv, v_from);
  end if;

  return query select v_conv, v_from;
end;
$$;

-- Redeem an invite token.
create or replace function public.duet_redeem_invite(p_token_hash text, p_user uuid)
returns table (conversation_id uuid, peer_id uuid, peer_display_name text, peer_avatar_color smallint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invites;
  v_creator uuid;
  v_conv uuid;
  v_name text;
  v_color smallint;
begin
  select * into v_invite
    from public.invites
   where token_hash = p_token_hash
     and expires_at > now()
     and redeemed_by is null
   for update;

  if not found then
    return;
  end if;

  -- An invite must connect two different people.
  if v_invite.created_by = p_user then
    return;
  end if;

  v_creator := v_invite.created_by;

  v_conv := public.duet_conversation_between(p_user, v_creator);
  if v_conv is null then
    insert into public.conversations default values
    returning id into v_conv;
    insert into public.conversation_participants (conversation_id, user_id)
    values (v_conv, p_user), (v_conv, v_creator);
  end if;

  update public.invites
     set redeemed_by = p_user, redeemed_at = now()
   where id = v_invite.id;

  select u.display_name, u.avatar_color
    into v_name, v_color
    from public.users u
   where u.id = v_creator;

  return query select v_conv, v_creator, v_name, v_color;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security (lock down every table)
-- ---------------------------------------------------------------------------

alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.messages enable row level security;
alter table public.invites enable row level security;
alter table public.key_bundles enable row level security;
alter table public.one_time_prekeys enable row level security;
alter table public.media enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.connection_requests enable row level security;
alter table public.events enable row level security;
alter table public.vault_backups enable row level security;
alter table public.rate_limit_hits enable row level security;
alter table public.diagnostics enable row level security;

-- Revoke all access from client roles and from PUBLIC. Only the server's
-- service_role is used. Revoking PUBLIC matters for functions, which Postgres
-- grants EXECUTE to PUBLIC by default.
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Storage bucket for encrypted media
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('duet-media', 'duet-media', false)
on conflict (id) do nothing;

-- Media objects are private; the Node server proxies downloads with service_role.
drop policy if exists "duet_service_role_all" on storage.objects;
create policy "duet_service_role_all" on storage.objects
  for all to service_role using (true) with check (true);
