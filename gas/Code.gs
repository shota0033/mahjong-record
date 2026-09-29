// 麻雀成績 クラウドバックアップ（Google Apps Script）
// 1. TOKEN を好きな合言葉に書き換える（アプリの設定画面にも同じものを入れる）
// 2. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
//    実行ユーザー: 自分 / アクセスできるユーザー: 全員
// 3. 発行された URL（.../exec）をアプリの設定画面に貼り付ける

const TOKEN = 'ここを好きな合言葉に変更';
const FOLDER_NAME = '麻雀成績バックアップ';

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) return json({ ok: false, error: '合言葉が違います' });
    const data = body.data;
    if (!data || !Array.isArray(data.sessions)) return json({ ok: false, error: 'データ形式エラー' });
    if (data.sessions.length === 0) return json({ ok: false, error: '空データは保存しません' });

    const text = JSON.stringify(data);
    const folder = getFolder();
    writeFile(folder, 'latest.json', text);
    // 日ごとの履歴（同じ日は上書き）
    const day = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    writeFile(folder, 'backup-' + day + '.json', text);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  if ((e.parameter.token || '') !== TOKEN) return json({ ok: false, error: '合言葉が違います' });
  const files = getFolder().getFilesByName('latest.json');
  if (!files.hasNext()) return json({ ok: false, error: 'バックアップがありません' });
  return json({ ok: true, data: JSON.parse(files.next().getBlob().getDataAsString()) });
}

function getFolder() {
  const it = DriveApp.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
}

function writeFile(folder, name, text) {
  const it = folder.getFilesByName(name);
  if (it.hasNext()) it.next().setContent(text);
  else folder.createFile(name, text, MimeType.PLAIN_TEXT);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
