// 🧵 승률 계산을 따로 도는 스레드에 맡긴다 — 사람 결정의 정밀 계산(4000번 · 0.1~0.2초)이 게임 진행(본 스레드)을 멈추지 않게.
//    스레드는 처음 부를 때 하나 만들고, 요청은 차례로 처리한다. 스레드가 죽으면 다음 요청 때 다시 만든다.
//    request() 는 시간 안에 못 끝나면 null — 부르는 쪽은 예전처럼 본 스레드에서 500번으로 계산한다.
const path = require('path');
let worker = null, seq = 0;
const waiting = new Map();

function ensure() {
    if (worker) return worker;
    const { Worker } = require('worker_threads');
    worker = new Worker(`
        const { parentPort, workerData } = require('worker_threads');
        const { mcEquity } = require(workerData.lib);
        parentPort.on('message', m => { let v = null; try { v = mcEquity(m.args); } catch (e) {} parentPort.postMessage({ id: m.id, v }); });
    `, { eval: true, workerData: { lib: path.join(__dirname, 'equitymc.js') } });
    worker.unref();
    worker.on('message', m => { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); clearTimeout(w.t); w.res(m.v); } });
    const dead = () => { worker = null; waiting.forEach(w => { clearTimeout(w.t); w.res(null); }); waiting.clear(); };
    worker.on('error', dead); worker.on('exit', dead);
    return worker;
}

function request(args, timeoutMs = 2000) {
    return new Promise(res => {
        let w;
        try { w = ensure(); } catch (e) { return res(null); }
        const id = ++seq;
        waiting.set(id, { res, t: setTimeout(() => { waiting.delete(id); res(null); }, timeoutMs) });
        w.postMessage({ id, args });
    });
}

// 시험이 끝날 때 스레드를 닫는다(서버는 계속 쓴다)
function close() { if (worker) { const w = worker; worker = null; return w.terminate(); } return Promise.resolve(); }

module.exports = { request, close };
