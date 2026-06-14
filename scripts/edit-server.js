/*
 * edit-server.js
 * 生成AIニュースHTMLを「ローカルで開いたときだけ編集機能つきで配信する」静的サーバー。
 *
 * 仕組み:
 *  - 通常の静的ファイルサーバーとして動くが、.html を返す瞬間だけ </body> 直前に
 *      <script src="/_assets/news-editor/news-editor.js" defer></script>
 *    をメモリ上で差し込んで返す。ディスク上のHTMLは一切書き換えない。
 *  - そのため各ニュースHTMLに <script> を手で書く必要がなく、新規HTMLも自動で編集可能になる。
 *  - 本番(Vercel等)はこのサーバーを通さない通常の静的配信なので、まったく影響しない。
 *
 * 使い方:
 *    node scripts/edit-server.js          # http://localhost:8000 で配信
 *    node scripts/edit-server.js 3000     # ポート指定
 *  Chrome/Edge で http://localhost:8000/genai-news/.../xxx.html を開く。
 *  右下の編集ボタンから編集 → 保存(File System Access APIで元ファイルへ上書き)。
 *
 * 依存パッケージ無し(Node標準モジュールのみ)。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// プロジェクトルート(このファイルの1つ上)
const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2], 10) || 8000;

// 注入する1行(ルート絶対パスなので階層に依存しない)
const INJECT_TAG =
  '<script src="/_assets/news-editor/news-editor.js" defer></script>';

// 拡張子 → Content-Type
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// パストラバーサル対策: ROOT配下に解決されるパスのみ許可
function resolveSafe(pathname) {
  const decoded = decodeURIComponent(pathname);
  const resolved = path.normalize(path.join(ROOT, decoded));
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    return null;
  }
  return resolved;
}

// </body> 直前(無ければ末尾)に編集スクリプトを差し込む
function injectEditor(html) {
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) return html + '\n' + INJECT_TAG + '\n';
  return html.slice(0, idx) + INJECT_TAG + '\n' + html.slice(idx);
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    // 編集中の確認用途なのでキャッシュさせない
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  let filePath = resolveSafe(pathname);

  if (!filePath) {
    return send(res, 403, 'text/plain; charset=utf-8', '403 Forbidden');
  }

  // ディレクトリなら index.html を探す
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    stat = null;
  }
  if (stat && stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      return send(res, 404, 'text/plain; charset=utf-8', '404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';

    if (ext === '.html') {
      const injected = injectEditor(data.toString('utf-8'));
      return send(res, 200, type, injected);
    }
    return send(res, 200, type, data);
  });
});

server.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ニュース編集サーバー起動');
  console.log('  http://localhost:' + PORT + '/');
  console.log('  (.html は配信時に編集スクリプトを自動注入)');
  console.log('  停止: Ctrl+C');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
