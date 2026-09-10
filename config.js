// Supabase の接続先。ここの2つだけ書き換えれば、どの端末でも設定なしで使える。
// 値は Supabase の Project Settings → API から取る。
//   url     … Project URL           例 https://abcdefghijk.supabase.co
//   anonKey … anon public のキー（長い文字列）
//
// anon キーは公開されて構わない種類のキーで、schema.sql の行レベルセキュリティで
// cap_annotations 表の読み書きだけに制限してある。service_role のキーは絶対に置かないこと。
//
// 空のままでも動く。その場合は画面の最初に入力欄が出て、端末ごとに一度だけ貼れば済む。
window.CAPANNO_CONFIG = {
  url: '',
  anonKey: ''
};
