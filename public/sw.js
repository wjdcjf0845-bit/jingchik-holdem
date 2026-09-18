// 징칡홀덤 서비스워커 — "홈 화면에 추가"(PWA) 설치 요건을 만족시키고,
// 아이콘·사운드 같은 정적 파일만 캐시해 재실행을 빠르게 한다.
//
// ⚠️ 게임 화면(index.html)과 소켓 통신은 절대 캐시하지 않는다.
//    캐시된 옛 화면으로 접속하면 배포된 서버와 규칙이 어긋나 버그처럼 보인다.
const CACHE = 'jingchik-v1';
const ASSETS = [
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/icon-180.png',
    '/manifest.json'
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;          // 외부 CDN·폰트는 건드리지 않음
    if (url.pathname.startsWith('/socket.io/')) return;        // 실시간 통신 제외
    // 정적 자산만 캐시 우선, 나머지(HTML 포함)는 항상 네트워크
    // 🎨 skins: 카드 뒷면/아바타 이미지 — 한 번 받으면 바뀌지 않으니 캐시해서 모바일 데이터를 아낀다
    const cacheable = /^\/(icons|sounds|skins)\//.test(url.pathname) || url.pathname === '/manifest.json';
    if (!cacheable) return;
    e.respondWith(
        caches.match(req).then(hit => hit || fetch(req).then(res => {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
            return res;
        }).catch(() => hit))
    );
});
