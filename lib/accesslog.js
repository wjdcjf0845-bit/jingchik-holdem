// 📋 접속 기록 — 누가 언제 어디서 들어왔는지 남기는 링버퍼.
//
// 파일 입출력은 여기서 하지 않는다(server.js 담당). 순수 로직만 두어야
// 단위 테스트로 상한·정리·집계를 검증할 수 있기 때문이다.
//
// ⚠️ 기록에는 IP 가 들어간다. 개인정보이므로 무한정 쌓지 않는다 —
//    건수 상한(max)과 보관 기간(maxAgeMs) 둘 다 걸어 오래된 건 스스로 지워진다.

const TYPES = ['login', 'logout', 'fail', 'join', 'admin', 'adminfail', 'etc'];

const TYPE_LABEL = {
    login: '로그인',
    logout: '접속 종료',
    fail: '로그인 실패',
    join: '방 입장',
    admin: '관리자 로그인',
    adminfail: '관리자 로그인 실패',
    etc: '기타'
};

// 제어문자를 빼고 길이를 자른다. 화면에 그대로 찍히는 값이라 이상한 게 섞이면 안 된다.
function clean(v, max) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

// ::ffff:1.2.3.4 처럼 IPv4-mapped 로 오는 걸 사람이 읽는 형태로 바꾼다.
// x-forwarded-for 는 "실제IP, 프록시1, 프록시2" 형태라 맨 앞만 쓴다.
function normIp(v) {
    let s = clean(v, 200).split(',')[0].trim();
    if (s.startsWith('::ffff:')) s = s.slice(7);
    if (s === '::1') s = '127.0.0.1';
    return s.slice(0, 45);
}

// User-Agent 원문은 200자가 넘어 표를 못 읽게 만들고, 굳이 통째로 보관할 이유도 없다.
// 기록하는 순간 "어떤 기기/브라우저"만 남긴다.
function shortUA(ua) {
    const s = String(ua || '');
    if (!s) return '';
    const os = /Android/i.test(s) ? 'Android'
        : /iPhone|iPad|iPod|iOS/i.test(s) ? 'iOS'
        : /Windows/i.test(s) ? 'Windows'
        : /Macintosh|Mac OS/i.test(s) ? 'Mac'
        : /Linux/i.test(s) ? 'Linux' : '기타';
    // ⚠️ 순서가 중요하다. Edge 도 Chrome 도 UA 에 Safari 를 달고 다니므로 좁은 것부터 본다.
    const br = /Edg\//i.test(s) ? 'Edge'
        : /SamsungBrowser/i.test(s) ? 'Samsung'
        : /KAKAOTALK/i.test(s) ? '카카오톡'
        : /FBAN|FBAV|Instagram/i.test(s) ? '인앱'
        : /Chrome\//i.test(s) ? 'Chrome'
        : /Firefox\//i.test(s) ? 'Firefox'
        : /Safari\//i.test(s) ? 'Safari'
        : /node|axios|curl|python/i.test(s) ? '스크립트' : '';
    return br ? os + ' · ' + br : os;
}

const DAY = 24 * 60 * 60 * 1000;

class AccessLog {
    constructor(opts) {
        const o = opts || {};
        this.max = Number.isFinite(o.max) && o.max > 0 ? Math.floor(o.max) : 3000;
        this.maxAgeMs = Number.isFinite(o.maxAgeMs) ? o.maxAgeMs : 60 * DAY;
        this.events = [];
        this.dirty = false;
    }

    push(ev, now) {
        const at = Number.isFinite(now) ? now : Date.now();
        const e = ev || {};
        const t = Number.isFinite(Number(e.t)) && Number(e.t) > 0 ? Number(e.t) : at;
        const row = {
            t,
            type: TYPES.includes(e.type) ? e.type : 'etc',
            nick: clean(e.nick, 24),
            ip: normIp(e.ip),
            ua: clean(e.ua, 120),
            detail: clean(e.detail, 60)
        };
        this.events.push(row);
        this.prune(at);
        this.dirty = true;
        return row;
    }

    // 오래된 것부터 버린다. 건수 상한과 보관 기간을 둘 다 적용.
    prune(now) {
        const at = Number.isFinite(now) ? now : Date.now();
        if (this.maxAgeMs > 0) {
            const cut = at - this.maxAgeMs;
            if (this.events.length && this.events[0].t < cut) {
                this.events = this.events.filter(e => e.t >= cut);
            }
        }
        if (this.events.length > this.max) {
            this.events = this.events.slice(this.events.length - this.max);
        }
    }

    // 최신순으로 돌려준다 (화면에서 위가 최신이어야 읽기 편하다)
    list(opts) {
        const o = opts || {};
        const limit = Math.max(1, Math.min(1000, Number(o.limit) || 200));
        const nick = o.nick ? String(o.nick).toLowerCase() : '';
        const ip = o.ip ? String(o.ip) : '';
        const type = TYPES.includes(o.type) ? o.type : '';
        const since = Number.isFinite(Number(o.since)) ? Number(o.since) : 0;

        const out = [];
        for (let i = this.events.length - 1; i >= 0 && out.length < limit; i--) {
            const e = this.events[i];
            if (type && e.type !== type) continue;
            if (since && e.t < since) continue;
            if (nick && !e.nick.toLowerCase().includes(nick)) continue;
            if (ip && !e.ip.includes(ip)) continue;
            out.push(e);
        }
        return out;
    }

    summary(now) {
        const at = Number.isFinite(now) ? now : Date.now();
        const dayAgo = at - DAY;
        const weekAgo = at - 7 * DAY;
        const byType = {};
        let today = 0, week = 0, fails = 0;
        const nicksToday = new Set(), ipsToday = new Set();
        for (const e of this.events) {
            byType[e.type] = (byType[e.type] || 0) + 1;
            if (e.t >= dayAgo) {
                today++;
                if (e.type === 'login' && e.nick) nicksToday.add(e.nick);
                if (e.ip) ipsToday.add(e.ip);
                if (e.type === 'fail' || e.type === 'adminfail') fails++;
            }
            if (e.t >= weekAgo) week++;
        }
        return {
            total: this.events.length,
            today, week,
            uniqueNicks24h: nicksToday.size,
            uniqueIps24h: ipsToday.size,
            fails24h: fails,
            byType,
            oldest: this.events.length ? this.events[0].t : null
        };
    }

    toJSON() { return this.events; }

    // 저장된 배열을 되읽는다. 손상/변조된 항목은 push 가 알아서 정규화한다.
    load(arr, now) {
        if (!Array.isArray(arr)) return this;
        this.events = [];
        for (const e of arr) {
            if (e && typeof e === 'object') this.push(e, now);
        }
        this.dirty = false;
        return this;
    }
}

module.exports = { AccessLog, TYPES, TYPE_LABEL, normIp, shortUA };
