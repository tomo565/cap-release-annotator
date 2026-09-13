-- リリース選択の結果を入れる表。位置GTの表とは分ける。
-- Supabase の SQL Editor に貼って一度だけ実行する。
--
-- なぜ分けるか:
--   リリース時刻は「1投球に1つ」、位置GTは「1コマに1つ」で粒度が違う。
--   混ぜると、どちらが欠けているのかが分からなくなる。
--
-- 位置GTは既存の cap_annotations をそのまま使う。保存形式を変えないので、
-- スマホで途中まで打って iPad で続けても問題ない。

create table if not exists cap_release_marks (
  id                  bigint generated always as identity primary key,
  video_id            text    not null,          -- 例 20260905/154754
  set_name            text    not null,          -- 例 timing45 / relcheck
  release_frame_human int     not null,          -- 人が選んだリリースのコマ
  release_confirmed_by_human boolean not null default false,
  expanded            boolean not null default false,  -- 表示範囲を広げたか
  seconds_spent       int,                       -- 1投球にかかった秒数（UI比較用）
  ui_mode             text,                      -- mobile / tablet
  annotator           text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (video_id, set_name)
);

create index if not exists cap_release_marks_set_idx on cap_release_marks (set_name, video_id);

create or replace function cap_release_touch() returns trigger as $$
begin
  new.updated_at := now();
  new.created_at := coalesce(old.created_at, new.created_at, now());
  return new;
end $$ language plpgsql;

drop trigger if exists cap_release_touch_trg on cap_release_marks;
create trigger cap_release_touch_trg
  before update on cap_release_marks
  for each row execute function cap_release_touch();

alter table cap_release_marks enable row level security;

drop policy if exists cap_rel_read  on cap_release_marks;
drop policy if exists cap_rel_write on cap_release_marks;
drop policy if exists cap_rel_edit  on cap_release_marks;

create policy cap_rel_read  on cap_release_marks for select using (true);
create policy cap_rel_write on cap_release_marks for insert with check (true);
create policy cap_rel_edit  on cap_release_marks for update using (true) with check (true);

-- 削除は許さない。打ち終えた正解を事故で消さないため。

-- 位置GT側（cap_annotations）に set 名の列を足す。既存行には timing45 以外が入る想定はないので
-- 既定値を空にしておく。既存データの意味は変わらない。
alter table cap_annotations add column if not exists set_name text;
create index if not exists cap_annotations_set_idx on cap_annotations (set_name);
