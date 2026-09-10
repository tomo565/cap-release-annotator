-- キャップのリリース窓アノテーション用テーブル。
-- Supabase の SQL Editor に貼って一度だけ実行する。
--
-- 設計の要点:
--   ・(video_id, frame_index) を一意にする。同じコマを何度打ち直しても行は増えず、上書きになる。
--     複数の端末から同じコマを打っても矛盾しない。
--   ・confirmed_by_human が true の行だけを最終正解として書き出す。
--     既定を false にしてあるので、人が押していない行が正解に混ざることはない。
--   ・x が null の行は「完全に隠れていて位置が分からない」。位置の評価から外し、件数だけ数える。

create table if not exists cap_annotations (
  id            bigint generated always as identity primary key,
  video_id      text    not null,          -- 例 20260905/161044
  frame_index   int     not null,          -- 元動画のコマ番号
  release_offset int    not null,          -- リリースからの差。-3 〜 +10
  x             double precision,          -- 元画像 1080x1920 での中心。隠れているときは null
  y             double precision,
  bbox_w        double precision,          -- 任意。指定しなければ null
  bbox_h        double precision,
  visibility    text    not null default '見える',   -- 見える / 一部隠れ / 完全に隠れ / 判断できない
  confirmed_by_human boolean not null default false,
  annotator     text,                      -- 端末を跨いで誰が打ったか分かるように
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (video_id, frame_index)
);

create index if not exists cap_annotations_video_idx on cap_annotations (video_id, frame_index);

-- 上書きのたびに updated_at を進める。created_at は最初の値を保つ。
create or replace function cap_annotations_touch() returns trigger as $$
begin
  new.updated_at := now();
  new.created_at := coalesce(old.created_at, new.created_at, now());
  return new;
end $$ language plpgsql;

drop trigger if exists cap_annotations_touch_trg on cap_annotations;
create trigger cap_annotations_touch_trg
  before update on cap_annotations
  for each row execute function cap_annotations_touch();

-- 行レベルセキュリティ。anon キーは公開されるので、この表だけに読み書きを限る。
alter table cap_annotations enable row level security;

drop policy if exists cap_anno_read  on cap_annotations;
drop policy if exists cap_anno_write on cap_annotations;
drop policy if exists cap_anno_edit  on cap_annotations;

create policy cap_anno_read  on cap_annotations for select using (true);
create policy cap_anno_write on cap_annotations for insert with check (true);
create policy cap_anno_edit  on cap_annotations for update using (true) with check (true);

-- 削除は許さない。打ち終えた正解を事故で消さないため。
-- 消す必要が出たら、この SQL Editor から手で消す。
