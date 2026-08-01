/* あんざんチャレンジ - Service Worker
   ホスティングして https(or localhost) で開いたときのみ有効になります。
   file:// で直接開いた場合は index.html 側で登録をスキップします。 */
const CACHE_NAME = "anzan-cache-v4";
const ASSETS = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./users.json"
];

// 運用中に書き換えられうる外部ファイルは「ネットワーク優先」にする。
// これらをキャッシュ優先にすると、ファイルを編集してもService Worker
// が古い内容を返し続けてしまい、変更が反映されなくなるため。
const NETWORK_FIRST = ["config.js", "users.json"];

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
