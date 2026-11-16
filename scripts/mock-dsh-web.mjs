#!/usr/bin/env node
/** 本地 mock dsh-web：用于在没有真实 DSH 的情况下验证 Haos 的 HTTP/WS 反向 Tunnel。 */
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const port = Number(process.argv[2] || 3099);
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Mock DSH Web</title>
<style>
body{font-family:system-ui,sans-serif;background:#0b1020;color:#e8eefc;margin:0;padding:32px}
.card{max-width:720px;margin:auto;background:#111a2e;border:1px solid #263247;border-radius:14px;padding:22px}
h1{font-size:20px;margin:0 0 8px}p{color:#8b9ab5;font-size:13px}
#out{white-space:pre-wrap;background:#070b14;border:1px solid #263247;border-radius:10px;padding:12px;min-height:120px;font-family:monospace;font-size:12px;margin-top:12px}
input{width:100%;box-sizing:border-box;padding:9px;background:#070b14;border:1px solid #263247;color:#e8eefc;border-radius:8px}
button{margin-top:8px;padding:8px 12px;background:#5eead4;color:#04121a;border:0;border-radius:8px;font-weight:700}
</style></head><body><div class="card">
<h1>Mock DSH Web</h1><p>这是一个模拟的 dsh-web，用于验证 Haos 反向 Tunnel、Cookie 重写、iframe 和 WebSocket。</p>
<input id="q" value="hello haos" /><button id="send">发送 WebSocket</button>
<div id="out">session: ${Date.now()}</div>
<script>
const out=document.getElementById('out');
const ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');
ws.onopen=()=>{out.textContent += '\\n[ws] connected';};
ws.onmessage=(e)=>{out.textContent += '\\n[ws] '+e.data;};
ws.onclose=()=>{out.textContent += '\\n[ws] closed';};
document.getElementById('send').onclick=()=>ws.send(document.getElementById('q').value);
fetch('/api/echo?q='+encodeURIComponent('http-ok')).then(r=>r.json()).then(j=>{out.textContent += '\\n[http] '+JSON.stringify(j);});
</script></div></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname === '/api/echo') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-frame-options': 'DENY' });
      res.end(JSON.stringify({ ok: true, q: url.searchParams.get('q'), body, host: req.headers.host, cookie: req.headers.cookie || null }));
    });
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port }));
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'x-frame-options': 'DENY',
    'set-cookie': `mock_session=${Date.now()}; Path=/; HttpOnly; SameSite=Lax`,
    'cache-control': 'no-store',
  });
  res.end(html);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.send('mock ws ready');
  ws.on('message', (data, isBinary) => {
    if (isBinary) ws.send(data, { binary: true });
    else ws.send(`echo: ${data.toString()}`);
  });
  if (ws.readyState === WebSocket.OPEN) {
    const timer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30000);
    ws.on('close', () => clearInterval(timer));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock DSH Web: http://127.0.0.1:${port}/`);
});
