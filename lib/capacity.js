// 🚦 서버 정원과 입장 대기열 (순수 로직)
//   무료 서버는 CPU 가 작아서 동시 접속이 늘면 전원이 느려진다. 정원을 넘는 사람은 줄을 세우고,
//   자리가 나면 먼저 온 순서대로 들여보낸다. 이미 게임 중인 사람의 재접속은 정원과 무관하게 받는다.
//   max <= 0 이면 제한 없음.
const HOLD_MS = 20000;   // 차례가 온 사람에게 자리를 맡아 두는 시간 — 그 안에 다시 로그인 요청이 와야 한다

class Capacity {
    constructor(max) {
        this.max = Capacity.clamp(max);
        this.queue = [];              // [{ nick, socketId, since }]
        this.held = new Map();        // nick → 만료 시각 (차례가 와서 자리를 맡아 둔 사람)
    }
    static clamp(n) { n = Math.floor(Number(n)); return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 0; }
    setMax(n) { this.max = Capacity.clamp(n); return this.max; }

    _prune(now) { this.held.forEach((exp, nick) => { if (exp <= now) this.held.delete(nick); }); }
    // 지금 차지된 자리 수 = 접속 중인 사람 + 자리를 맡아 둔 사람(아직 안 들어온)
    used(online, now) {
        this._prune(now);
        let n = online.size;
        this.held.forEach((exp, nick) => { if (!online.has(nick)) n++; });
        return n;
    }
    // 바로 들어와도 되는가
    //   online: 접속 중인 닉네임 Set · inGame: 진행 중인 방에 자리가 있는 사람(재접속)
    canEnter(nick, online, now, inGame) {
        if (this.max <= 0) return true;
        if (inGame || online.has(nick)) return true;                 // 재접속 · 같은 계정의 다른 기기
        this._prune(now);
        if (this.held.has(nick)) return true;                        // 차례가 와서 자리를 맡아 둔 사람
        if (this.queue.length && this.queue[0].nick !== nick) return false;   // 줄이 있으면 새치기 금지
        return this.used(online, now) < this.max;
    }
    // 들어왔다 — 맡아 둔 자리와 대기열에서 지운다
    entered(nick) { this.held.delete(nick); this.queue = this.queue.filter(q => q.nick !== nick); }
    // 줄을 선다. 이미 서 있으면 자리(순서)는 그대로 두고 소켓만 바꾼다. 반환: 내 순서(1부터)
    enqueue(nick, socketId, now) {
        const i = this.queue.findIndex(q => q.nick === nick);
        if (i >= 0) { this.queue[i].socketId = socketId; return i + 1; }
        this.queue.push({ nick, socketId, since: now || Date.now() });
        return this.queue.length;
    }
    leave(socketId) { const before = this.queue.length; this.queue = this.queue.filter(q => q.socketId !== socketId); return before !== this.queue.length; }
    position(nick) { const i = this.queue.findIndex(q => q.nick === nick); return i < 0 ? 0 : i + 1; }
    // 빈자리만큼 앞에서부터 꺼내 자리를 맡아 준다. 반환: 들여보낼 사람들 [{ nick, socketId }]
    drain(online, now) {
        const out = [];
        if (this.max <= 0) { out.push(...this.queue); this.queue = []; out.forEach(q => this.held.set(q.nick, now + HOLD_MS)); return out; }
        while (this.queue.length && this.used(online, now) < this.max) {
            const q = this.queue.shift();
            this.held.set(q.nick, now + HOLD_MS);
            out.push(q);
        }
        return out;
    }
    view(online, now) { return { max: this.max, online: online.size, used: this.used(online, now), waiting: this.queue.map(q => ({ nick: q.nick, since: q.since })) }; }
}

module.exports = { Capacity, HOLD_MS };
