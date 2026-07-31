// 🎉 징칠 파티 게임 엔진 — 청첩장 모임용 종합 게임 플랫폼
// 포커(기본 네임스페이스)와 완전 분리된 /party 네임스페이스로 동작.
// 호스트(TV) 1대가 진행을 제어하고, 참가자는 폰으로 QR 접속.
//
// 게임 모듈 인터페이스 (lib/party/games/*.js):
//   {
//     id, name, emoji, desc,
//     rounds(room)                       -> 총 라운드 수(선택, 표시용)
//     create(room, ctx)                  -> gs (게임 상태 객체 생성 + 초기 phase 세팅)
//     hostView(room, gs)                 -> TV에 그릴 뷰 객체 { screen, ... }
//     playerView(room, gs, player)       -> 해당 폰에 그릴 뷰 객체 { screen, ... }
//     action(room, gs, player, msg, ctx) -> 폰에서 온 입력 처리 (gs 변형)
//     advance(room, gs, ctx)             -> 호스트 '다음' 클릭 시 내부 상태머신 진행
//     onDeadline(room, gs, ctx)          -> gs.deadline 만료 시 호출(선택)
//   }
// ctx 헬퍼: { award(pid,pts), broadcast(), finish(), now(), everyoneAnswered(fn) }

const crypto = require('crypto');

const GAMES = [
    require('./games/music'),
    require('./games/draw'),
    require('./games/reaction'),
    require('./games/dodge'),
    require('./games/typing'),
    require('./games/auction'),
];
const GAME_BY_ID = Object.fromEntries(GAMES.map(g => [g.id, g]));

// 헷갈리는 문자(0/O/1/I) 제외한 방코드
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(existing) {
    for (let tries = 0; tries < 50; tries++) {
        let c = '';
        for (let i = 0; i < 4; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
        if (!existing.has(c)) return c;
    }
    return 'PARTY';
}

const NICK_OK = /^[가-힣a-zA-Z0-9_ ]{1,12}$/;
function cleanNick(raw) {
    const s = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 12);
    return NICK_OK.test(s) ? s : null;
}

// 아바타 색상 팔레트 (닉네임 해시로 배정)
const AVATAR_COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899','#f43f5e','#84cc16','#06b6d4','#a855f7'];

module.exports = function mountParty(io, app) {
    const nsp = io.of('/party');
    const rooms = new Map(); // code -> room

    // ── 라우팅: /party (TV), /party/play (폰) ──
    const path = require('path');
    const PUB = path.join(__dirname, '..', '..', 'public', 'party');
    app.get('/party', (req, res) => res.sendFile(path.join(PUB, 'host.html')));
    app.get('/party/play', (req, res) => res.sendFile(path.join(PUB, 'play.html')));

    // QR 코드(SVG) — 참가 URL을 담아 TV에 표시
    let QRCode = null;
    try { QRCode = require('qrcode'); } catch (e) { console.warn('⚠️ qrcode 모듈 없음 — QR 비활성'); }
    app.get('/party/qr', async (req, res) => {
        const data = String(req.query.d || '').slice(0, 300);
        if (!QRCode || !data) return res.status(404).end();
        try {
            const svg = await QRCode.toString(data, { type: 'svg', margin: 1,
                color: { dark: '#111827', light: '#ffffff' }, errorCorrectionLevel: 'M' });
            res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
        } catch (e) { res.status(500).end(); }
    });

    // ── 방 생성/파괴 ──
    function createRoom(hostSocketId) {
        const code = makeCode(rooms);
        const room = {
            code,
            hostSocketId,
            createdAt: Date.now(),
            players: new Map(),   // pid -> player
            order: [],            // 안정적 표시 순서
            phase: 'lobby',       // lobby | game | scoreboard | final
            game: null,           // 현재 게임 모듈
            gs: null,             // 현재 게임 상태
            gameIndex: 0,         // 진행한 게임 수
            emptySince: null,     // 아무도 없게 된 시각 (재접속 유예 판단용)
            _timer: null,
        };
        rooms.set(code, room);
        return room;
    }
    function destroyRoom(room) {
        if (!room) return;
        if (room._timer) clearInterval(room._timer);
        rooms.delete(room.code);
    }

    function colorFor(nick) {
        const h = crypto.createHash('md5').update(nick).digest();
        return AVATAR_COLORS[h[0] % AVATAR_COLORS.length];
    }

    // ── ctx: 게임 모듈에 넘겨줄 헬퍼 ──
    function makeCtx(room) {
        return {
            now: () => Date.now(),
            award(pid, pts) {
                const p = room.players.get(pid);
                if (p) { p.score += pts; p.lastGain = pts; }
            },
            players() {
                return room.order.map(id => room.players.get(id)).filter(Boolean);
            },
            connectedPlayers() {
                return this.players().filter(p => p.connected);
            },
            // '전원 응답했나?' 판정용 — 게임 시작 후 들어온 사람은 기다리지 않는다.
            // (늦게 들어온 한 명 때문에 자동 진행이 막혀 제한시간까지 멈춰 있던 문제)
            awaitedPlayers() {
                const t = room.gameStartedAt || 0;
                return this.players().filter(p => p.connected && p.joinedAt <= t);
            },
            broadcast: () => broadcast(room),
            finish: () => endGame(room),
        };
    }

    // 게임 소개(브리핑) 정보 — 규칙은 각 게임 모듈의 rules 필드에서 가져온다
    function gameInfo(g) {
        return { id: g.id, name: g.name, emoji: g.emoji, desc: g.desc, rules: g.rules || null };
    }

    // ── 상태 브로드캐스트 ──
    function playerPublic(p) {
        return { id: p.id, nick: p.nick, color: p.color, score: p.score, connected: p.connected };
    }
    function leaderboard(room) {
        return room.order.map(id => room.players.get(id)).filter(Boolean)
            .slice().sort((a, b) => b.score - a.score)
            .map((p, i) => ({ rank: i + 1, ...playerPublic(p) }));
    }

    // hostOnly=true: 매초 카운트다운 갱신 등에서 TV에만 전송(폰 입력창 초기화 방지)
    function broadcast(room, hostOnly) {
        // TV(호스트) 뷰
        let hostView;
        if (room.phase === 'briefing' && room.game) {
            hostView = { screen: 'briefing', game: gameInfo(room.game) };
        } else if (room.phase === 'game' && room.game) {
            hostView = { screen: 'game', gameId: room.game.id, gameName: room.game.name,
                         emoji: room.game.emoji, view: room.game.hostView(room, room.gs) };
        } else if (room.phase === 'scoreboard') {
            hostView = { screen: 'scoreboard', board: leaderboard(room),
                         lastGame: room.game ? room.game.name : null,
                         hasNext: room.gameIndex < 999, gameIndex: room.gameIndex };
        } else if (room.phase === 'final') {
            hostView = { screen: 'final', board: leaderboard(room) };
        } else {
            // 대기방에도 현재 점수 순위를 표시 (누가 1등인지 바로 보이게)
            hostView = { screen: 'lobby', code: room.code,
                         players: leaderboard(room),
                         showScores: room.gameIndex > 0,
                         gameIndex: room.gameIndex,
                         games: GAMES.map((g, i) => ({ id: g.id, name: g.name, emoji: g.emoji, desc: g.desc, done: i < room.gameIndex })) };
        }
        hostView.code = room.code;
        hostView.playerCount = room.order.filter(id => room.players.get(id)?.connected).length;
        const hs = nsp.sockets.get(room.hostSocketId);
        if (hs) hs.emit('host:view', hostView);

        if (hostOnly) return; // 카운트다운 갱신은 TV만 — 폰은 상태 변화 시에만 갱신

        // 각 폰 개인 뷰
        for (const p of room.players.values()) {
            if (!p.connected || !p.socketId) continue;
            const sock = nsp.sockets.get(p.socketId);
            // 🩹 유령 상태 자가 복구: '연결됨'인데 소켓이 없으면 실제로는 끊긴 것.
            //    그대로 두면 '전원 응답 대기'가 영영 안 끝나 게임이 멈춘다.
            if (!sock) { p.connected = false; p.socketId = null; continue; }
            sock.emit('player:view', playerViewFor(room, p));
        }
    }

    // 한 명에게 보낼 뷰 (브로드캐스트 / 개별 동기화 공용)
    function playerViewFor(room, p) {
        if (room.phase === 'briefing' && room.game) {
            return { screen: 'briefing', game: gameInfo(room.game) };
        }
        if (room.phase === 'game' && room.game) {
            return { screen: 'game', gameId: room.game.id, view: room.game.playerView(room, room.gs, p) };
        }
        if (room.phase === 'scoreboard' || room.phase === 'final') {
            const board = leaderboard(room);
            const me = board.find(b => b.id === p.id);
            return { screen: room.phase, myRank: me ? me.rank : null, myScore: p.score,
                     total: board.length, final: room.phase === 'final' };
        }
        const board = leaderboard(room);
        const me = board.find(b => b.id === p.id);
        const top = board[0];
        return { screen: 'lobby', nick: p.nick, color: p.color, score: p.score, code: room.code,
                 myRank: me ? me.rank : null, total: board.length,
                 showScores: room.gameIndex > 0,
                 leader: (top && room.gameIndex > 0) ? { nick: top.nick, score: top.score } : null };
    }

    // ── 게임 시작/종료 ──
    function startGame(room, gameId) {
        const g = GAME_BY_ID[gameId];
        if (!g) return;
        if (room._timer) { clearInterval(room._timer); room._timer = null; }
        room.game = g;
        room.phase = 'game';
        room.gameStartedAt = Date.now();
        const ctx = makeCtx(room);
        for (const p of room.players.values()) p.lastGain = 0;
        room.gs = g.create(room, ctx);
        // 데드라인 감시 타이머 (실시간 게임은 자체 프레임 주기를 요구할 수 있다)
        room._timer = setInterval(() => tickRoom(room), g.tickMs || 250);
        broadcast(room);
    }
    function endGame(room) {
        if (room._timer) { clearInterval(room._timer); room._timer = null; }
        room.gameIndex++;
        room.phase = 'scoreboard';
        broadcast(room);
    }
    function tickRoom(room) {
        if (room.phase !== 'game' || !room.game || !room.gs) return;
        const gs = room.gs;
        // 실시간 게임: 매 프레임 시뮬레이션 후 TV로만 화면 전송 (브로드캐스트 우회)
        if (room.game.onTick) {
            try {
                room.game.onTick(room, gs, makeCtx(room), (ev, d) => {
                    const hs = nsp.sockets.get(room.hostSocketId);
                    if (hs) hs.emit(ev, d);
                });
            } catch (e) { console.error('onTick 오류:', e && e.message); }
        }
        if (gs.deadline && Date.now() >= gs.deadline) {
            gs.deadline = 0;
            const ctx = makeCtx(room);
            if (room.game.onDeadline) room.game.onDeadline(room, gs, ctx);
            broadcast(room);
        } else if (gs._pushClock) {
            // 남은 시간 실시간 표시가 필요한 게임: 1초마다 가볍게 재전송
            const sec = Math.ceil((gs.deadline - Date.now()) / 1000);
            if (sec !== gs._lastSec) { gs._lastSec = sec; broadcast(room, true); } // TV만 갱신
        }
    }

    // ── 소켓 핸들링 ──
    nsp.on('connection', (socket) => {
        let boundRoom = null;   // 이 소켓이 속한 방
        let role = null;        // 'host' | 'player'
        let pid = null;

        // 호스트: 방 생성
        socket.on('host:create', () => {
            const room = createRoom(socket.id);
            boundRoom = room; role = 'host';
            socket.join('h:' + room.code);
            socket.emit('host:created', { code: room.code });
            broadcast(room);
        });

        // 호스트: 기존 방 재접속 (새로고침 대비)
        socket.on('host:resume', ({ code }) => {
            const room = rooms.get(String(code || '').toUpperCase());
            if (!room) { socket.emit('host:gone'); return; }
            room.hostSocketId = socket.id;
            boundRoom = room; role = 'host';
            socket.join('h:' + room.code);
            socket.emit('host:created', { code: room.code });
            broadcast(room);
        });

        // 호스트: 게임 선택 → 먼저 규칙 설명(브리핑) 화면을 띄운다
        socket.on('host:pickGame', ({ gameId }) => {
            if (role !== 'host' || !boundRoom) return;
            if (boundRoom.phase === 'game') return; // 진행 중엔 무시
            const g = GAME_BY_ID[gameId];
            if (!g) return;
            if (boundRoom._timer) { clearInterval(boundRoom._timer); boundRoom._timer = null; }
            boundRoom.game = g;
            boundRoom.gs = null;
            boundRoom.phase = 'briefing';
            broadcast(boundRoom);
        });

        // 호스트: 진행 (브리핑 → 게임 시작 / 게임 내 다음 단계)
        socket.on('host:advance', () => {
            if (role !== 'host' || !boundRoom) return;
            const room = boundRoom;
            // ⚠️ 연타 방어: 버튼을 두 번 누르면 화면을 통째로 건너뛴다.
            //    (예: '게임 시작'을 두 번 → 노래를 틀지도 않았는데 제한시간이 시작됨)
            const now = Date.now();
            if (room._lastAdvanceAt && now - room._lastAdvanceAt < 400) return;
            room._lastAdvanceAt = now;
            if (room.phase === 'briefing' && room.game) {
                startGame(room, room.game.id);   // 설명을 다 읽고 시작
                return;
            }
            if (room.phase === 'game' && room.game) {
                const ctx = makeCtx(room);
                room.game.advance(room, room.gs, ctx);
                broadcast(room);
            }
        });

        // 호스트: 진행 중인 게임을 즉시 끝내고 점수판으로 (지금까지 점수는 유지)
        socket.on('host:endGame', () => {
            if (role !== 'host' || !boundRoom) return;
            if (boundRoom.phase === 'game') endGame(boundRoom);
            else if (boundRoom.phase === 'briefing') {   // 아직 시작 전이면 그냥 로비로
                boundRoom.phase = 'lobby'; boundRoom.game = null; boundRoom.gs = null;
                broadcast(boundRoom);
            }
        });

        // 호스트: 점수판에서 다음 게임 고르기 화면(로비형)으로
        socket.on('host:toLobby', () => {
            if (role !== 'host' || !boundRoom) return;
            boundRoom.phase = 'lobby';
            boundRoom.game = null; boundRoom.gs = null;
            broadcast(boundRoom);
        });

        // 호스트: 최종 결과
        socket.on('host:final', () => {
            if (role !== 'host' || !boundRoom) return;
            if (boundRoom._timer) { clearInterval(boundRoom._timer); boundRoom._timer = null; }
            boundRoom.phase = 'final';
            broadcast(boundRoom);
        });

        // 호스트: 참가자 강퇴
        socket.on('host:kick', ({ targetPid }) => {
            if (role !== 'host' || !boundRoom) return;
            const room = boundRoom;
            const p = room.players.get(targetPid);
            if (!p) return;
            if (p.socketId) { const s = nsp.sockets.get(p.socketId); if (s) s.emit('player:kicked'); }
            room.players.delete(targetPid);
            room.order = room.order.filter(id => id !== targetPid);
            // 이탈과 동일하게 게임에 알린다 (그리던 사람을 강퇴하면 그 라운드를 정리)
            if (room.phase === 'game' && room.game && room.game.onPlayerLeave) {
                try { room.game.onPlayerLeave(room, room.gs, p, makeCtx(room)); } catch (e) {}
            }
            broadcast(room);
        });

        // 플레이어: 참가 / 재접속
        socket.on('player:join', ({ code, nick, pid: savedPid }, ack) => {
            code = String(code || '').toUpperCase().trim();
            const room = rooms.get(code);
            if (!room) { if (ack) ack({ ok: false, err: '방을 찾을 수 없어요 (코드 확인)' }); return; }

            // 재접속: 저장된 pid가 이 방에 있으면 복구
            if (savedPid && room.players.has(savedPid)) {
                const p = room.players.get(savedPid);
                p.socketId = socket.id; p.connected = true;
                boundRoom = room; role = 'player'; pid = p.id;
                socket.join('p:' + room.code);
                if (ack) ack({ ok: true, pid: p.id, nick: p.nick, code: room.code });
                broadcast(room);
                return;
            }

            const clean = cleanNick(nick);
            if (!clean) { if (ack) ack({ ok: false, err: '닉네임은 1~12자 (한/영/숫자)' }); return; }
            // 중복 닉 방지
            for (const p of room.players.values()) {
                if (p.nick.toLowerCase() === clean.toLowerCase() && p.connected) {
                    if (ack) ack({ ok: false, err: '이미 쓰는 닉네임이에요' }); return;
                }
            }
            const newPid = crypto.randomBytes(8).toString('hex');
            const player = { id: newPid, nick: clean, color: colorFor(clean),
                             socketId: socket.id, connected: true, score: 0, lastGain: 0, joinedAt: Date.now() };
            room.players.set(newPid, player);
            room.order.push(newPid);
            boundRoom = room; role = 'player'; pid = newPid;
            socket.join('p:' + room.code);
            if (ack) ack({ ok: true, pid: newPid, nick: clean, code: room.code });
            broadcast(room);
        });

        // 🔄 현재 화면 다시 받기 — 업데이트를 놓쳤을 때 새로고침 없이 회복
        //    (폰 잠금·절전으로 소켓이 멈췄다 깨어난 경우 등)
        socket.on('player:sync', () => {
            if (role !== 'player' || !boundRoom || pid == null) return;
            const p = boundRoom.players.get(pid);
            if (!p) return;
            if (p.socketId !== socket.id) { p.socketId = socket.id; p.connected = true; }
            socket.emit('player:view', playerViewFor(boundRoom, p));
        });
        socket.on('host:sync', () => {
            if (role !== 'host' || !boundRoom) return;
            boundRoom.hostSocketId = socket.id;
            broadcast(boundRoom, true);   // TV 뷰만 다시 전송
        });

        // 🎮 실시간 조작 입력 (총알 피하기 등) — 브로드캐스트를 타지 않는 초경량 경로.
        //    초당 20회 × 12명이 전체 뷰 재생성을 유발하면 서버가 버티지 못한다.
        socket.on('player:pad', (data) => {
            if (role !== 'player' || !boundRoom || pid == null) return;
            const room = boundRoom;
            if (room.phase !== 'game' || !room.game || !room.game.onPad) return;
            const p = room.players.get(pid);
            if (!p) return;
            room.game.onPad(room, room.gs, p, data || {});
        });

        // 플레이어: 실시간 드로잉 스트로크 (전체 브로드캐스트 우회 — TV로만 저지연 중계)
        socket.on('player:draw', (data) => {
            if (role !== 'player' || !boundRoom || pid == null) return;
            const room = boundRoom;
            if (room.phase !== 'game' || !room.game || !room.game.onDraw) return;
            const p = room.players.get(pid);
            if (!p) return;
            room.game.onDraw(room, room.gs, p, data || {}, (ev, d) => {
                const hs = nsp.sockets.get(room.hostSocketId);
                if (hs) hs.emit(ev, d);
            });
        });

        // 플레이어: 게임 입력
        socket.on('player:act', (msg) => {
            if (role !== 'player' || !boundRoom || pid == null) return;
            const room = boundRoom;
            if (room.phase !== 'game' || !room.game) return;
            const p = room.players.get(pid);
            if (!p) return;
            const ctx = makeCtx(room);
            room.game.action(room, room.gs, p, msg || {}, ctx);
            broadcast(room);
        });

        socket.on('disconnect', () => {
            if (!boundRoom) return;
            const room = boundRoom;
            if (role === 'player' && pid != null) {
                const p = room.players.get(pid);
                // ⚠️ 경합 방지: 이미 새 소켓으로 재접속했다면(다른 socketId) 끊김 처리하면 안 된다.
                //    (옛 소켓의 disconnect가 늦게 도착해 멀쩡한 사람을 '끊김'으로 만들고
                //     브로드캐스트에서 제외시켜 화면이 안 넘어가던 버그)
                if (p && p.socketId === socket.id) {
                    p.connected = false; p.socketId = null;
                    // 진행 중인 게임에 알린다 (예: 그리던 사람이 나가면 그 라운드를 정리)
                    if (room.phase === 'game' && room.game && room.game.onPlayerLeave) {
                        try { room.game.onPlayerLeave(room, room.gs, p, makeCtx(room)); } catch (e) {}
                    }
                    broadcast(room);
                }
            } else if (role === 'host') {
                // 호스트 이탈: 방은 유지(새로고침 복구 대비). 빈 방 청소는 아래 인터벌이 담당.
            }
        });
    });

    // 빈 방 청소 — 아무도 없거나 오래된 방 정리
    setInterval(() => {
        const now = Date.now();
        for (const room of Array.from(rooms.values())) {
            const humans = Array.from(room.players.values()).filter(p => p.connected).length;
            const hostAlive = !!nsp.sockets.get(room.hostSocketId);
            const stale = now - room.createdAt > 8 * 60 * 60 * 1000; // 8시간
            // ⚠️ 와이파이가 잠깐 끊겨 모두 동시에 떨어져도 방이 사라지지 않도록 유예시간을 둔다.
            //    (즉시 파괴하면 재접속할 방 자체가 없어져 전원이 고립됨)
            if (!hostAlive && humans === 0) {
                if (!room.emptySince) room.emptySince = now;
            } else {
                room.emptySince = null;
            }
            const emptyTooLong = room.emptySince && (now - room.emptySince > 10 * 60 * 1000); // 10분
            if (emptyTooLong || stale) destroyRoom(room);
        }
    }, 60 * 1000);

    console.log('🎉 [징칠 파티 게임] /party 마운트 완료 — 게임', GAMES.length, '종');
    return { rooms };
};
