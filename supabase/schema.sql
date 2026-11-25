-- Duet schema for Supabase. Paste into  Dashboard → SQL Editor → New query → Run.
-- Safe to re-run. The server talks to these tables with the SERVICE ROLE key only.
-- Row Level Security is ON with no policies, so the public anon/authenticated keys can read and write nothing.

grant usage on schema public to service_role;

create or replace function duet_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['duet_users','duet_sessions','duet_otp_codes','duet_invites','duet_conversations',
                           'duet_connection_requests','duet_media','duet_push_subscriptions','duet_prekeys','duet_meta']
  loop
    execute format('create table if not exists public.%I (id text primary key, data jsonb not null, updated_at timestamptz not null default now())', t);
  end loop;
end $$;

-- messages: ciphertext is opaque inside data; real columns exist for the two indexes the product needs
create table if not exists public.duet_messages (
  id              text primary key,
  data            jsonb  not null,
  conversation_id text   not null,
  created_at      bigint not null,
  client_id       text   not null,
  sender_id       text   not null,
  updated_at      timestamptz not null default now()
);
create index if not exists duet_messages_page_idx on public.duet_messages (conversation_id, created_at desc, id desc);
create unique index if not exists duet_messages_client_uidx on public.duet_messages (conversation_id, client_id);

do $$
declare t text;
begin
  foreach t in array array['duet_users','duet_sessions','duet_otp_codes','duet_invites','duet_conversations',
                           'duet_connection_requests','duet_media','duet_push_subscriptions','duet_prekeys','duet_meta','duet_messages']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant all on public.%I to service_role', t);   -- new Supabase projects do not grant this automatically
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function duet_touch()', t || '_touch', t);
  end loop;
end $$;

create index if not exists duet_sessions_expiry_idx on public.duet_sessions ((data->>'expiresAt'));
