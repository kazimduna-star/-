-- MB CHAT: выполните целиком в Supabase → SQL Editor → Run

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  mb_id text unique not null,
  username text not null,
  avatar_url text,
  last_seen timestamptz default now(),
  created_at timestamptz default now()
);

create table public.messages (
  id bigint generated always as identity primary key,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  read_at timestamptz,
  check (sender_id <> receiver_id)
);
create index on public.messages (sender_id, created_at);
create index on public.messages (receiver_id, created_at);

-- Автоматическое создание профиля и уникального ID (MB + 6 цифр)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare new_id text;
begin
  loop
    new_id := 'MB' || lpad((floor(random() * 900000) + 100000)::int::text, 6, '0');
    exit when not exists (select 1 from public.profiles where mb_id = new_id);
  end loop;
  insert into public.profiles (id, mb_id, username)
  values (new.id, new_id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'username'), ''), 'User ' || new_id));
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- RLS
alter table public.profiles enable row level security;
alter table public.messages enable row level security;

create policy "profiles_read" on public.profiles
  for select to authenticated using (true);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "messages_read_own" on public.messages
  for select to authenticated
  using (sender_id = auth.uid() or receiver_id = auth.uid());
create policy "messages_send" on public.messages
  for insert to authenticated with check (sender_id = auth.uid());
create policy "messages_mark" on public.messages
  for update to authenticated
  using (receiver_id = auth.uid()) with check (receiver_id = auth.uid());

-- Менять можно только разрешённые поля
revoke update on public.profiles from authenticated;
grant update (username, avatar_url, last_seen) on public.profiles to authenticated;
revoke update on public.messages from authenticated;
grant update (delivered_at, read_at) on public.messages to authenticated;

-- Realtime
alter publication supabase_realtime add table public.messages;

-- Аватары
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatars_read" on storage.objects
  for select using (bucket_id = 'avatars');
create policy "avatars_write_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
