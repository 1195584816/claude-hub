// 让 lib/auth.js 用 Electron 自带的网络模块发请求。
//
// 为什么:Node 自带的 https 不走系统代理。只开了系统代理、没开 TUN 的人,
// 用 https 直连账号服务器会一直「网络连不上」;Electron 的 net 和浏览器一样走系统代理 / PAC。
//
// 这里只做一件事:把 net.request 包成 auth.js 用到的那几个 https.request 接口
// (on('error') / write / end / destroy,回调拿到的响应有 statusCode 和 data / end / aborted / error 事件)。
// net 没有「空闲超时」事件 —— auth.js 自己有一个总时限兜底,到点会调 destroy。
function electronRequest(net) {
  return (opts, onResponse) => {
    const headers = Object.assign({}, opts.headers);
    delete headers['Content-Length'];           // net 不许自己设这个头,它会按 body 自己算
    const req = net.request({ method: opts.method, protocol: 'https:', hostname: opts.hostname, port: opts.port, path: opts.path, headers });
    const onErr = [];
    const emitErr = (e) => { for (const f of onErr.slice()) { try { f(e); } catch {} } };
    req.on('response', onResponse);
    req.on('error', emitErr);
    const shim = {
      on(ev, fn) { if (ev === 'error') onErr.push(fn); return shim; },
      write(d) { req.write(d); },
      end() { req.end(); },
      destroy(e) { try { req.abort(); } catch {} if (e) emitErr(e); }
    };
    return shim;
  };
}

module.exports = { electronRequest };
