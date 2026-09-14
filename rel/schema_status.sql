-- リリース表に「状態」を持たせる。除外と、位置合わせ（リリース付近の場所だけ先に決める）を記録する。
-- Supabase の SQL Editor に貼って一度だけ実行する。
--
-- 状態:
--   located   … 人が動画全体から投球を探し、リリース付近のコマと手の位置を打った。
--               この位置を中心に原寸の切り出しを作ってから、リリースのコマを選ぶ。
--   confirmed … 人がリリースのコマを確定した（これまでの行はすべてこれ）。
--   excluded  … 使えない投球。理由を必ず残す。リリースのコマは持たない。
--
-- 既存の行（relcheck 5本、timing45 3本）はすべて status = confirmed になる。中身は変わらない。

alter table cap_release_marks alter column release_frame_human drop not null;

alter table cap_release_marks add column if not exists status           text not null default 'confirmed';
alter table cap_release_marks add column if not exists exclusion_reason text;
alter table cap_release_marks add column if not exists exclusion_note   text;
alter table cap_release_marks add column if not exists locate_frame     int;
alter table cap_release_marks add column if not exists locate_x         double precision;
alter table cap_release_marks add column if not exists locate_y         double precision;

alter table cap_release_marks drop constraint if exists cap_relmark_status;
alter table cap_release_marks add constraint cap_relmark_status
  check (status in ('located', 'confirmed', 'excluded'));

alter table cap_release_marks drop constraint if exists cap_relmark_reason;
alter table cap_release_marks add constraint cap_relmark_reason
  check (exclusion_reason is null or exclusion_reason in
         ('release_not_visible', 'video_cut_before_release', 'severe_occlusion', 'other'));

-- 状態と中身の食い違いを表の側で拒否する
alter table cap_release_marks drop constraint if exists cap_relmark_confirmed_has_frame;
alter table cap_release_marks add constraint cap_relmark_confirmed_has_frame
  check (status <> 'confirmed' or release_frame_human is not null);

alter table cap_release_marks drop constraint if exists cap_relmark_excluded_has_reason;
alter table cap_release_marks add constraint cap_relmark_excluded_has_reason
  check (status <> 'excluded' or (exclusion_reason is not null and release_frame_human is null));

alter table cap_release_marks drop constraint if exists cap_relmark_located_has_point;
alter table cap_release_marks add constraint cap_relmark_located_has_point
  check (status <> 'located' or (locate_frame is not null and locate_x is not null and locate_y is not null));

-- 20260905/154900 を除外として記録する（人の判断: 手からキャップが離れる瞬間が映像内に確認できない）
insert into cap_release_marks
  (video_id, set_name, release_frame_human, release_confirmed_by_human,
   status, exclusion_reason, exclusion_note, annotator)
values
  ('20260905/154900', 'timing45', null, false,
   'excluded', 'release_not_visible',
   '手からキャップが離れる瞬間が映像内に確認できない。人手で正しいリリースのコマを定義できない（2026-09-14 利用者の判断）',
   'tomozo')
on conflict (video_id, set_name) do update set
  release_frame_human = null,
  release_confirmed_by_human = false,
  status = excluded.status,
  exclusion_reason = excluded.exclusion_reason,
  exclusion_note = excluded.exclusion_note,
  annotator = excluded.annotator;

-- 確認用
select video_id, set_name, status, release_frame_human, exclusion_reason
from cap_release_marks
order by set_name, video_id;
