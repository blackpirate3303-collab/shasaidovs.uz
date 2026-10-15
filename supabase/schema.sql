-- Shasaidovs: базовая схема Supabase
-- Выполните целиком в Supabase Dashboard → SQL Editor → New query → Run.
-- ВАЖНО: роль user назначается автоматически. Не создавайте публичную политику,
-- которая разрешает пользователю менять собственное поле profiles.role.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Пользователь' check (char_length(display_name) between 1 and 80),
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  minutes integer not null default 30 check (minutes between 1 and 1440),
  portions integer not null default 2 check (portions between 1 and 100),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.menus (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  menu_date date not null,
  meal_type text not null check (meal_type in ('Завтрак','Обед','Ужин')),
  recipe_id uuid references public.recipes(id) on delete set null,
  custom_name text check (custom_name is null or char_length(custom_name) <= 120),
  created_at timestamptz not null default now(),
  constraint menus_one_slot_per_day unique (user_id, menu_date, meal_type),
  constraint menus_recipe_or_custom check (
    (recipe_id is not null and (custom_name is null or btrim(custom_name) = ''))
    or (recipe_id is null and custom_name is not null and btrim(custom_name) <> '')
  )
);

create index if not exists menus_user_date_idx on public.menus(user_id, menu_date);
create index if not exists recipes_created_at_idx on public.recipes(created_at desc);

-- Создание профиля после регистрации. Роль берётся только из безопасного значения user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), 'Пользователь'),
    'user'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.recipes enable row level security;
alter table public.menus enable row level security;

-- Небольшая функция-проверка роли. Security definer и пустой search_path снижают риск подмены объектов.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin'
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Профиль: пользователь читает свой, админ читает все. Обновлять разрешено только display_name.
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin" on public.profiles
for select to authenticated
using (id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "profiles_update_own_name" on public.profiles;
create policy "profiles_update_own_name" on public.profiles
for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()) and role = 'user');

-- Рецепты видны всем вошедшим; создавать/изменять/удалять может только админ.
drop policy if exists "recipes_select_authenticated" on public.recipes;
create policy "recipes_select_authenticated" on public.recipes
for select to authenticated using (true);

drop policy if exists "recipes_admin_insert" on public.recipes;
create policy "recipes_admin_insert" on public.recipes
for insert to authenticated with check ((select public.is_admin()));

drop policy if exists "recipes_admin_update" on public.recipes;
create policy "recipes_admin_update" on public.recipes
for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "recipes_admin_delete" on public.recipes;
create policy "recipes_admin_delete" on public.recipes
for delete to authenticated using ((select public.is_admin()));

-- Пользователь имеет доступ только к своим строкам меню; админ может читать/управлять всеми.
drop policy if exists "menus_select_own_or_admin" on public.menus;
create policy "menus_select_own_or_admin" on public.menus
for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "menus_insert_own" on public.menus;
create policy "menus_insert_own" on public.menus
for insert to authenticated with check (user_id = (select auth.uid()) and (recipe_id is null or exists(select 1 from public.recipes r where r.id=recipe_id)));

drop policy if exists "menus_update_own_or_admin" on public.menus;
create policy "menus_update_own_or_admin" on public.menus
for update to authenticated
using (user_id = (select auth.uid()) or (select public.is_admin()))
with check (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "menus_delete_own_or_admin" on public.menus;
create policy "menus_delete_own_or_admin" on public.menus
for delete to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));

-- RPC: только админ может получать список пользователей с почтой из auth.users.
create or replace function public.admin_list_users()
returns table (id uuid, email text, display_name text, role text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin privileges required';
  end if;
  return query
    select u.id, u.email::text, p.display_name, p.role, u.created_at
    from auth.users u
    left join public.profiles p on p.id = u.id
    order by u.created_at desc;
end;
$$;
revoke all on function public.admin_list_users() from public;
grant execute on function public.admin_list_users() to authenticated;

-- RPC: смена роли только администратором. Нельзя снять роль с самого себя этой функцией.
create or replace function public.admin_set_user_role(target_user_id uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin privileges required';
  end if;
  if new_role not in ('user','admin') then
    raise exception 'Invalid role';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'You cannot change your own role';
  end if;
  update public.profiles set role = new_role where id = target_user_id;
  if not found then raise exception 'User profile not found'; end if;
end;
$$;
revoke all on function public.admin_set_user_role(uuid,text) from public;
grant execute on function public.admin_set_user_role(uuid,text) to authenticated;

-- Убедитесь, что в Supabase API включены таблицы public.profiles, public.recipes, public.menus.
