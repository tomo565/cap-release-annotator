-- relcheck / timing45 の位置GTを入れる表。既存の cap_annotations とは完全に分ける。
-- Supabase の SQL Editor に貼って一度だけ実行する。
--
-- なぜ分けるか:
--   cap_annotations は (video_id, frame_index) で上書きする。relcheck で train/val の
--   3本（184242 / 184943 / 154828）を打ち直すと、凍結済みの train/val 正解を上書きしてしまう。
--   新しい表は (video_id, set_name, frame_index) を一意にし、set ごとに独立させる。

create table if not exists cap_release_positions (
  id                 bigint generated always as identity primary key,
  video_id           text    not null,
  set_name           text    not null,
  frame_index        int     not null,
  release_offset     int     not null,
  x                  double precision,
  y                  double precision,
  bbox_w             double precision,
  bbox_h             double precision,
  visibility         text    not null default '見える',
  confirmed_by_human boolean not null default false,
  annotator          text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (video_id, set_name, frame_index),
  -- 完全に隠れは座標を持たない。画面側でも消しているが、表の側でも拒否する。
  constraint cap_relpos_occluded_no_xy
    check (visibility <> '完全に隠れ' or (x is null and y is null)),
  -- 消費済み test 19本は保存させない（保存時の二重検査）。
  constraint cap_relpos_no_test
    check (split_part(video_id, '/', 2) not in (
      '184258','184307','184442','184917','184956','185159','185349','185402',
      '154622','154629','154640','154649','154711','154804','154815','154849',
      '160931','161044','161103'))
);

create index if not exists cap_relpos_set_idx on cap_release_positions (set_name, video_id, frame_index);

drop trigger if exists cap_relpos_touch_trg on cap_release_positions;
create trigger cap_relpos_touch_trg
  before update on cap_release_positions
  for each row execute function cap_release_touch();

alter table cap_release_positions enable row level security;
drop policy if exists cap_relpos_read  on cap_release_positions;
drop policy if exists cap_relpos_write on cap_release_positions;
drop policy if exists cap_relpos_edit  on cap_release_positions;
create policy cap_relpos_read  on cap_release_positions for select using (true);
create policy cap_relpos_write on cap_release_positions for insert with check (true);
create policy cap_relpos_edit  on cap_release_positions for update using (true) with check (true);
-- 削除は許さない。

-- リリース表にも test 禁止を入れる。
alter table cap_release_marks drop constraint if exists cap_relmark_no_test;
alter table cap_release_marks add constraint cap_relmark_no_test
  check (split_part(video_id, '/', 2) not in (
    '184258','184307','184442','184917','184956','185159','185349','185402',
    '154622','154629','154640','154649','154711','154804','154815','154849',
    '160931','161044','161103'));

-- 旧画面が cap_annotations に書いてしまった relcheck の行（2026-09-14時点で 154754 の
-- 887・888 コマの下書き2行だけ）を新しい表へ移し、cap_annotations から取り除く。
-- set_name が入っている行は新画面が書いた物だけで、train/val と test の正解には set_name が無い。
insert into cap_release_positions
  (video_id, set_name, frame_index, release_offset, x, y, bbox_w, bbox_h,
   visibility, confirmed_by_human, annotator, created_at, updated_at)
select video_id, set_name, frame_index, release_offset, x, y, bbox_w, bbox_h,
       visibility, confirmed_by_human, annotator, created_at, updated_at
from cap_annotations
where set_name is not null
on conflict (video_id, set_name, frame_index) do nothing;

delete from cap_annotations where set_name is not null;

-- 確認用。移した行数と、cap_annotations に set_name 付きの行が残っていないこと。
select 'moved_to_new_table' as check, count(*) from cap_release_positions
union all
select 'left_in_cap_annotations', count(*) from cap_annotations where set_name is not null;
