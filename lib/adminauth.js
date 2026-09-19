// 🔐 관리자 인증 — 세션 토큰 서명/검증 + 로그인 시도 제한.
//
// 비밀번호가 4자리 숫자면 경우의 수가 1만 개뿐이라 무차별 대입이 현실적인 공격이 된다.
// 그래서 토큰 검증뿐 아니라 "실패 횟수 제한"을 같은 모듈에 두고 반드시 함께 쓴다.
//
// 비교는 전부 상수시간으로 한다. 일반 === 비교는 앞자리부터 틀리는 순간 반환해서
// 응답 시간 차이로 한 글자씩 맞춰볼 여지를 준다.

const crypto = require('crypto');

function sign(secret, payload) {
    return crypto.createHmac('sha256', String(secret)).update(String(payload)).digest('base64url');
}

// 길이가 다르면 timingSafeEqual 이 예외를 던지므로 먼저 거른다.
// 길이 노출은 어쩔 수 없지만 내용 비교는 상수시간으로 유지된다.
function safeEqual(a, b) {
    const x = Buffer.from(String(a == null ? '' : a), 'utf8');
    const y = Buffer.from(String(b == null ? '' : b), 'utf8');
    if (x.length !== y.length) return false;
    try { return crypto.timingSafeEqual(x, y); } catch (e) { return false; }
}

// 토큰 = "만료시각.서명". 서버 비밀키를 모르면 만료시각을 늘려 쓸 수 없다.
function makeToken(secret, expAt) {
    const p = String(Math.floor(expAt));
    return p + '.' + sign(secret, p);
}

function verifyToken(secret, token, now) {
    const at = Number.isFinite(now) ? now : Date.now();
    if (typeof token !== 'string' || !token || token.length > 300) return false;
    const i = token.indexOf('.');
    if (i <= 0) return false;
    const p = token.slice(0, i);
    const sig = token.slice(i + 1);
    if (!/^\d{1,15}$/.test(p)) return false;
    const exp = Number(p);
    if (!Number.isFinite(exp) || exp <= at) return false;
    return safeEqual(sig, sign(secret, p));
}

// 같은 IP 에서 연속 실패하면 잠시 막는다. 성공하면 즉시 풀린다.
class FailLimiter {
    constructor(max, windowMs) {
        this.max = Number.isFinite(max) && max > 0 ? max : 8;
        this.windowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 15 * 60 * 1000;
        this.hits = new Map(); // key → 실패 시각 배열
    }
    _fresh(key, now) {
        const arr = (this.hits.get(key) || []).filter(t => now - t < this.windowMs);
        if (arr.length) this.hits.set(key, arr); else this.hits.delete(key);
        return arr;
    }
    fail(key, now) {
        const at = Number.isFinite(now) ? now : Date.now();
        const k = String(key || '?');
        const arr = this._fresh(k, at);
        arr.push(at);
        this.hits.set(k, arr);
        return arr.length;
    }
    blocked(key, now) {
        const at = Number.isFinite(now) ? now : Date.now();
        return this._fresh(String(key || '?'), at).length >= this.max;
    }
    // 차단이 풀릴 때까지 남은 시간(ms). 안 막혀 있으면 0.
    retryAfterMs(key, now) {
        const at = Number.isFinite(now) ? now : Date.now();
        const arr = this._fresh(String(key || '?'), at);
        if (arr.length < this.max) return 0;
        return Math.max(0, this.windowMs - (at - arr[arr.length - this.max]));
    }
    reset(key) { this.hits.delete(String(key || '?')); }
}

// 쿠키 헤더 한 줄을 객체로. 외부 의존성을 더하지 않으려고 직접 짠다.
function parseCookies(header) {
    const out = {};
    if (typeof header !== 'string' || !header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i <= 0) continue;
        const k = part.slice(0, i).trim();
        if (!k) continue;
        let v = part.slice(i + 1).trim();
        try { v = decodeURIComponent(v); } catch (e) { /* 잘못된 인코딩은 원문 그대로 */ }
        out[k] = v;
    }
    return out;
}

module.exports = { sign, safeEqual, makeToken, verifyToken, FailLimiter, parseCookies };
