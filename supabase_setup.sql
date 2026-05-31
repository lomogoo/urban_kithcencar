-- ============================================================
-- アーバンネット キッチンカー スケジュール — Supabase セットアップ
-- Supabase ダッシュボード → SQL Editor で下記をそのまま実行してください。
-- ============================================================

-- 1) 出店者テーブル
create table if not exists public.vendors (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  created_at  timestamptz not null default now()
);

-- 2) 出店日テーブル（1日あたり同一出店者は1件まで）
create table if not exists public.openings (
  id            bigint generated always as identity primary key,
  opening_date  date not null,
  vendor_id     bigint not null references public.vendors(id) on delete cascade,
  fee_free      boolean not null default false,  -- その出店者・その日を出店料無料にする（無料募集日）
  sales         integer,                          -- 売上実績（円）。未入力はNULL
  created_at    timestamptz not null default now(),
  unique (opening_date, vendor_id)
);
create index if not exists openings_date_idx on public.openings (opening_date);

-- 既存の openings テーブルがある場合のカラム追加（再実行しても安全）
alter table public.openings
  add column if not exists fee_free boolean not null default false,
  add column if not exists sales    integer;

-- 3) 休日テーブル（任意の日を「出店なし」に指定）
create table if not exists public.holidays (
  id            bigint generated always as identity primary key,
  holiday_date  date not null unique,
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Row Level Security
-- 認証なしの社内向けアプリのため、anon（publishable key）に
-- 読み書きを許可します。公開範囲を絞りたい場合は
-- ポリシーを調整してください。
-- ------------------------------------------------------------
alter table public.vendors  enable row level security;
alter table public.openings enable row level security;
alter table public.holidays enable row level security;

-- vendors
drop policy if exists vendors_all on public.vendors;
create policy vendors_all on public.vendors
  for all to anon using (true) with check (true);

-- openings
drop policy if exists openings_all on public.openings;
create policy openings_all on public.openings
  for all to anon using (true) with check (true);

-- holidays
drop policy if exists holidays_all on public.holidays;
create policy holidays_all on public.holidays
  for all to anon using (true) with check (true);

-- ------------------------------------------------------------
-- 初期出店者（アプリ初回起動時にも自動投入されますが、
-- 手動で入れておきたい場合は下記を実行してください）
-- ------------------------------------------------------------
insert into public.vendors (name) values
  ('Novel café'),
  ('FoodieGent'),
  ('プヨ'),
  ('チキンとポテトのお店ポテタロさん'),
  ('つむKITCHEN'),
  ('移動販売VEC'),
  ('HOT MEAL  3*SUN*'),
  ('珈琲バルSTRAY CAT'),
  ('あんだんち＋')
on conflict (name) do nothing;
