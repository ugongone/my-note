/*
 * news-editor.js
 * 生成AIニュース週報HTMLを「ブラウザ上で直接編集 → 元ファイルへ上書き保存」するための
 * 自己完結スクリプト。週報HTMLの </body> 直前に
 *   <script src="../../_assets/news-editor/news-editor.js" defer></script>
 * を1行入れて読み込む。
 *
 * 仕様:
 *  - ローカル(file:// / localhost / 127.0.0.1)でのみ起動。本番(Vercel等)では即終了し何もしない。
 *  - 編集操作: ①カード/箇条書きの並べ替え ②要素の削除 ③テキストのインライン編集
 *  - 保存: File System Access API で表示中のファイル自身へ上書き(Chrome/Edge)。
 *  - 注入UIはすべて data-news-editor 付き。保存時にクローンから除去するため元HTMLを汚さない。
 */
(function () {
  'use strict';

  // ── ホスト名ガード: 本番では何もしない ───────────────────────────
  var isLocal =
    location.protocol === 'file:' ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1';
  if (!isLocal) return;

  // 編集対象とみなすテキスト要素
  var TEXT_SEL = 'h1,h2,h3,h4,h5,h6,p,li,a,span,td,th,blockquote,strong,em';
  // 削除/並べ替えの単位(カード・箇条書き)
  var CARD_SEL = 'section#news .mb-6';

  var editing = false;
  var sortables = [];
  var undoStack = [];

  function pushUndo(fn) { undoStack.push(fn); }

  // 注入した <i data-lucide> を lucide でSVG描画(週報HTMLは lucide を読み込み済み)
  function renderIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  // ── スタイル注入 ─────────────────────────────────────────────
  function injectStyle() {
    if (document.getElementById('ne-style')) return;
    var css = ''
      + '#ne-toolbar{position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;gap:8px;'
      + "font-family:'Inter','Noto Sans JP',sans-serif;}"
      + '#ne-toolbar button{cursor:pointer;border:none;border-radius:9999px;padding:10px 16px;'
      + 'font-size:14px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.15);'
      + 'display:inline-flex;align-items:center;gap:5px;}'
      + '#ne-toolbar button svg{width:16px;height:16px;}'
      + '#ne-toggle{background:#2563eb;color:#fff;}'
      + '#ne-toolbar .ne-ctrl{display:none;}'
      + 'body.ne-on #ne-toolbar .ne-ctrl{display:inline-flex;}'
      + 'body.ne-on #ne-toolbar #ne-toggle{display:none;}'
      + '#ne-save{background:#16a34a;color:#fff;}'
      + '#ne-undo{background:#fff;color:#334155;border:1px solid #e2e8f0!important;}'
      + '#ne-exit{background:#ef4444;color:#fff;}'
      + '.ne-item{position:relative!important;outline:1px dashed transparent;outline-offset:2px;}'
      + 'body.ne-on .ne-item{outline-color:#cbd5e1;}'
      + '.ne-handle,.ne-del{position:absolute;z-index:50;width:22px;height:22px;border-radius:6px;'
      + 'display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;'
      + 'transition:opacity .12s;user-select:none;padding:0;}'
      + '.ne-handle svg,.ne-del svg{width:14px;height:14px;}'
      + '.ne-item:hover>.ne-handle,.ne-item:hover>.ne-del{opacity:1;}'
      + '.ne-handle{left:-28px;top:2px;background:#e2e8f0;color:#475569;cursor:grab;border:none;}'
      + '.ne-del{right:-28px;top:2px;background:#fee2e2;color:#dc2626;border:1px solid #fecaca;}'
      + '.ne-editing{outline:2px solid #2563eb!important;background:#eff6ff;}'
      + '#ne-banner{position:fixed;left:16px;bottom:16px;z-index:99999;background:#1e293b;color:#fff;'
      + "padding:8px 14px;border-radius:8px;font-size:13px;font-family:'Inter','Noto Sans JP',sans-serif;display:none;}"
      + 'body.ne-on #ne-banner{display:block;}'
      + '.ne-toast{position:fixed;left:50%;bottom:80px;transform:translateX(-50%);background:#16a34a;'
      + 'color:#fff;padding:10px 18px;border-radius:8px;z-index:100000;font-size:14px;'
      + 'box-shadow:0 4px 12px rgba(0,0,0,.2);}';
    var s = document.createElement('style');
    s.id = 'ne-style';
    s.setAttribute('data-news-editor', '');
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── ツールバー(✏️編集 / 💾保存 / ↩元に戻す / ✕終了) ──────────────
  function injectToolbar() {
    if (document.getElementById('ne-toolbar')) return;
    var bar = document.createElement('div');
    bar.id = 'ne-toolbar';
    bar.setAttribute('data-news-editor', '');
    bar.innerHTML =
      '<button id="ne-toggle" data-news-editor><i data-lucide="pencil"></i>編集</button>' +
      '<button id="ne-undo" class="ne-ctrl" data-news-editor title="元に戻す(Ctrl+Z)"><i data-lucide="undo-2"></i></button>' +
      '<button id="ne-save" class="ne-ctrl" data-news-editor><i data-lucide="save"></i>保存</button>' +
      '<button id="ne-exit" class="ne-ctrl" data-news-editor><i data-lucide="x"></i>終了</button>';
    document.body.appendChild(bar);
    renderIcons();

    var banner = document.createElement('div');
    banner.id = 'ne-banner';
    banner.setAttribute('data-news-editor', '');
    banner.textContent = '編集モード: カードをドラッグで並べ替え / ×で削除 / テキストをクリックで編集';
    document.body.appendChild(banner);

    document.getElementById('ne-toggle').addEventListener('click', enterEdit);
    document.getElementById('ne-exit').addEventListener('click', exitEdit);
    document.getElementById('ne-undo').addEventListener('click', function () {
      var fn = undoStack.pop(); if (fn) fn();
    });
    document.getElementById('ne-save').addEventListener('click', save);
  }

  // ── SortableJS を編集時のみ動的ロード ──────────────────────────
  function loadSortable() {
    if (window.Sortable) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js';
      s.setAttribute('data-news-editor', '');
      s.onload = res;
      s.onerror = function () { rej(new Error('SortableJS load failed')); };
      document.head.appendChild(s);
    });
  }

  // 削除ボタン・ドラッグハンドルを各アイテムに付与
  function decorate(el) {
    if (el.classList.contains('ne-item')) return;
    el.classList.add('ne-item');

    var handle = document.createElement('span');
    handle.className = 'ne-handle';
    handle.setAttribute('data-news-editor', '');
    handle.title = 'ドラッグで移動';
    handle.innerHTML = '<i data-lucide="grip-vertical"></i>';

    var del = document.createElement('button');
    del.className = 'ne-del';
    del.setAttribute('data-news-editor', '');
    del.title = '削除';
    del.innerHTML = '<i data-lucide="trash-2"></i>';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      var parent = el.parentNode, next = el.nextSibling;
      el.remove();
      pushUndo(function () { parent.insertBefore(el, next); });
    });

    el.insertBefore(handle, el.firstChild);
    el.appendChild(del);
  }

  // 並べ替えコンテナを構築
  function buildSortables() {
    var containers = [];
    var seen = [];
    function add(c, sel) {
      if (!c || seen.indexOf(c) !== -1) return;
      seen.push(c);
      containers.push({ el: c, sel: sel });
    }
    // ニュースカード: 各 .mb-6 の親をコンテナに
    document.querySelectorAll(CARD_SEL).forEach(function (card) {
      add(card.parentElement, '.mb-6');
    });
    // 箇条書き
    document.querySelectorAll('ul,ol').forEach(function (list) {
      if (list.querySelector(':scope > li')) add(list, ':scope > li');
    });

    containers.forEach(function (c) {
      // 直下のアイテムだけ装飾
      c.el.querySelectorAll(c.sel).forEach(function (item) {
        if (item.parentElement === c.el) decorate(item);
      });
      var draggable = c.sel === ':scope > li' ? 'li' : c.sel;
      var moveCtx = null;
      var sortable = window.Sortable.create(c.el, {
        draggable: draggable,
        handle: '.ne-handle',
        animation: 150,
        onStart: function (evt) {
          moveCtx = { el: evt.item, prev: evt.item.previousElementSibling, parent: evt.item.parentElement };
        },
        onEnd: function (evt) {
          var ctx = moveCtx; moveCtx = null;
          if (!ctx) return;
          if (evt.item.previousElementSibling === ctx.prev) return; // 実移動なし
          pushUndo(function () {
            if (ctx.prev) ctx.prev.after(ctx.el); else ctx.parent.prepend(ctx.el);
          });
        }
      });
      sortables.push(sortable);
    });
  }

  // ── インライン編集 ───────────────────────────────────────────
  function makeEditable(el) {
    if (el.isContentEditable) return;
    var old = el.innerHTML;
    el.setAttribute('contenteditable', 'true');
    el.classList.add('ne-editing');
    el.focus();
    var finish = function () {
      el.removeAttribute('contenteditable');
      el.classList.remove('ne-editing');
      el.removeEventListener('blur', finish);
      if (el.innerHTML !== old) {
        var changed = old;
        pushUndo(function () { el.innerHTML = changed; });
      }
    };
    el.addEventListener('blur', finish);
  }

  function onClickCapture(e) {
    if (!editing) return;
    if (e.target.closest('[data-news-editor]')) return; // 自前UIは無視
    var link = e.target.closest('a');
    if (link) e.preventDefault();                       // 編集中はリンク遷移しない
    var el = e.target.closest(TEXT_SEL);
    if (el && !el.isContentEditable) makeEditable(el);
  }

  function onKeydown(e) {
    if (!editing) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      var fn = undoStack.pop(); if (fn) fn();
    }
  }

  // ── 編集モード ON/OFF ────────────────────────────────────────
  function enterEdit() {
    loadSortable().then(function () {
      editing = true;
      document.body.classList.add('ne-on');
      buildSortables();
      renderIcons();
      document.addEventListener('click', onClickCapture, true);
      document.addEventListener('keydown', onKeydown, true);
    }).catch(function (err) {
      alert('並べ替え機能(SortableJS)の読み込みに失敗しました: ' + err.message);
    });
  }

  function stripDecorations(root) {
    // ライブDOMから編集装飾を除去(ツールバー/バナーは残す)
    root.querySelectorAll('.ne-handle, .ne-del').forEach(function (n) { n.remove(); });
    root.querySelectorAll('[contenteditable]').forEach(function (n) { n.removeAttribute('contenteditable'); });
    root.querySelectorAll('.ne-item, .ne-editing').forEach(function (n) {
      n.classList.remove('ne-item'); n.classList.remove('ne-editing');
    });
  }

  function exitEdit() {
    editing = false;
    document.removeEventListener('click', onClickCapture, true);
    document.removeEventListener('keydown', onKeydown, true);
    sortables.forEach(function (s) { try { s.destroy(); } catch (e) {} });
    sortables = [];
    undoStack = [];
    stripDecorations(document);
    document.body.classList.remove('ne-on');
  }

  // ── 保存用にクリーンなHTML文字列を生成 ──────────────────────────
  function serializeClean() {
    var clone = document.documentElement.cloneNode(true);
    // 注入ノード(ツールバー/バナー/style/SortableJS script/ハンドル/×)を全削除
    clone.querySelectorAll('[data-news-editor]').forEach(function (n) { n.remove(); });
    // 編集用の属性を除去
    clone.querySelectorAll('[contenteditable]').forEach(function (n) { n.removeAttribute('contenteditable'); });
    clone.querySelectorAll('[draggable]').forEach(function (n) { n.removeAttribute('draggable'); });
    // 編集/Sortable由来のクラスを除去
    var junk = ['ne-item', 'ne-editing', 'ne-on', 'sortable-chosen', 'sortable-ghost', 'sortable-drag', 'sortable-fallback'];
    clone.querySelectorAll('*').forEach(function (n) {
      if (!n.classList || n.classList.length === 0) return;
      junk.forEach(function (c) { n.classList.remove(c); });
      if (n.classList.length === 0 && n.getAttribute('class') !== null) n.removeAttribute('class');
    });
    return '<!DOCTYPE html>\n' + clone.outerHTML + '\n';
  }

  // ── IndexedDB: ディレクトリハンドル永続化 ─────────────────────
  // 「別名で保存」ダイアログを毎回出さないため、最初に一度フォルダを選んで
  // そのディレクトリハンドルを保持し、以後は元ファイルを直接上書きする。
  function openDB() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('news-editor', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('handles'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (res) {
        var req = db.transaction('handles', 'readonly').objectStore('handles').get(key);
        req.onsuccess = function () { res(req.result || null); };
        req.onerror = function () { res(null); };
      });
    });
  }
  function idbPut(key, val) {
    return openDB().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(val, key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { res(); };
      });
    });
  }
  function idbDelete(key) {
    return openDB().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').delete(key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { res(); };
      });
    });
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'ne-toast';
    t.setAttribute('data-news-editor', '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2000);
  }

  // フォルダ選択(初回のみダイアログ)。以後は保存済みハンドルを権限再取得して使う。
  function pickDir() {
    return window.showDirectoryPicker({ id: 'news-editor-root', mode: 'readwrite' })
      .then(function (d) { return idbPut('dirHandle', d).then(function () { return d; }); });
  }
  function getDirHandle() {
    return idbGet('dirHandle').then(function (dir) {
      if (!dir) return pickDir();
      return dir.queryPermission({ mode: 'readwrite' }).then(function (p) {
        if (p === 'granted') return dir;
        return dir.requestPermission({ mode: 'readwrite' }).then(function (p2) {
          return p2 === 'granted' ? dir : pickDir(); // 拒否されたら選び直し
        });
      });
    });
  }
  // 選んだフォルダ配下で、現在のファイルを総当りで探してハンドルを得る。
  // 配信方法(URLのルートがどこか)に依存しないよう、URLパスの「末尾サフィックス」を
  // 順に試し、最初に解決できたものを上書き対象とする。
  //   例) URL=/genai-news/20260531/02-x.html
  //       選んだフォルダ=learning-note → genai-news/20260531/02-x.html で解決
  //       選んだフォルダ=genai-news   → 20260531/02-x.html で解決
  //       選んだフォルダ=20260531     → 02-x.html で解決
  function resolveFileUnderDir(dir, segments) {
    function tryFrom(start) {
      if (start >= segments.length) {
        var e = new Error('not found'); e.name = 'NotFoundError'; return Promise.reject(e);
      }
      var parts = segments.slice(start);
      var fname = parts[parts.length - 1];
      var dirs = parts.slice(0, -1);
      var p = Promise.resolve(dir);
      dirs.forEach(function (seg) {
        p = p.then(function (d) { return d.getDirectoryHandle(seg); });
      });
      return p.then(function (d) { return d.getFileHandle(fname); })
        .catch(function (err) {
          // このサフィックスでは見つからない → 1つ内側のサフィックスを試す
          if (err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')) {
            return tryFrom(start + 1);
          }
          throw err;
        });
    }
    return tryFrom(0);
  }

  function save() {
    if (!window.showDirectoryPicker) {
      alert('保存にはFile System Access API対応ブラウザ(Chrome / Edge)が必要です。');
      return;
    }
    var html = serializeClean();
    var segments = decodeURIComponent(location.pathname).split('/').filter(Boolean);
    getDirHandle().then(function (dir) {
      if (!dir) return null;
      return resolveFileUnderDir(dir, segments);
    }).then(function (handle) {
      if (!handle) return; // キャンセル
      return handle.createWritable().then(function (w) {
        return w.write(html).then(function () { return w.close(); });
      }).then(function () { toast('保存しました'); });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return; // ユーザーがキャンセル
      // 選んだフォルダ配下にこのファイルが無い → 誤選択。ハンドルを破棄して選び直しを促す
      if (err && err.name === 'NotFoundError') {
        idbDelete('dirHandle').then(function () {
          alert('選んだフォルダの中にこのファイルが見つかりませんでした。\n選択をリセットしたので、もう一度「保存」を押して、リポジトリ直下 learning-note（または genai-news）フォルダを選び直してください。');
        });
        return;
      }
      alert('保存に失敗しました: ' + (err && err.message ? err.message : err));
    });
  }

  // ── 起動 ────────────────────────────────────────────────────
  function init() {
    injectStyle();
    injectToolbar();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
