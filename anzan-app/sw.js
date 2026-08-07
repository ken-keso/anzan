/* あんざんチャレンジ - Service Worker
   ホスティングして https(or localhost) で開いたときのみ有効になります。
   file:// で直接開いた場合は index.html 側で登録をスキップします。 */
const CACHE_NAME = "anzan-v0.6";
const ASSETS = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./users.js",
  "./manifest.json",
  "./icon.png",
  "./icon-192.png",
  "./icon-512.png"
];

// 運用中に書き換えられうる外部ファイルは「ネットワーク優先」にする。
// これらをキャッシュ優先にすると、ファイルを編集してもService Worker
// が古い内容を返し続けてしまい、変更が反映されなくなるため。
const NETWORK_FIRST = ["config.js", "users.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  const isNetworkFirst = NETWORK_FIRST.some((name) => url.pathname.endsWith(name));

  if (isNetworkFirst) {
    // ネットワーク優先: まず最新を取りに行き、失敗時のみキャッシュを使う
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }


  // ページ遷移（アドレスバー直打ち・PWA起動など）は、オフライン時に
  // index.html へフォールバックさせる。これにより、キャッシュされていない
  // URLでオフライン起動しても白画面にならず、アプリの入口は必ず表示できる。
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() =>
          caches.match(event.request).then((cached) => cached || caches.match("./index.html"))
        )
    );
    return;
  }


  // それ以外のアプリ本体ファイルはキャッシュ優先（オフライン動作・高速表示のため）
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request)
          .then((res) => {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            return res;
          })
          .catch(() => cached)
      );
    })
  );
});
