/**
 * web/proxy.js — 本地插件通用反向代理网关
 *
 * 彻底根治 iframe 跨域安全头拦截（X-Frame-Options / Content-Security-Policy）：
 * 1. 仅限代理到 127.0.0.1 上的本地服务（杜绝外网 SSRF）
 * 2. 自动清洗阻止 iframe 嵌入的响应头（X-Frame-Options、CSP frame-ancestors）
 * 3. 透传请求体、查询参数、状态码与响应流
 *
 * 两个入口：
 *   /proxy/plugin/<port>/<path>  任意本地插件服务（注入 <base>，让相对引用直连源站）
 *   /plug/<path>                 统一宿主原生页面（不注入 <base>，保持同源回环）
 */

import http from 'node:http';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function handlePluginProxy(req, res, pathname) {
  // 匹配 /proxy/plugin/<port>/<subpath>
  const match = pathname.match(/^\/proxy\/plugin\/(\d+)(\/.*)?$/);
  if (!match) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '无效的代理路径，格式必须为 /proxy/plugin/<port>/<path>' }));
    return;
  }

  const port = parseInt(match[1], 10);
  const subpath = match[2] || '/';
  const url = new URL(req.url, 'http://localhost');
  const targetPath = subpath + (url.search || '');

  // 端口安全范围限制：仅限非特权本地端口 (1024 - 65535)
  if (isNaN(port) || port < 1024 || port > 65535) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '禁止代理到受保护系统端口' }));
    return;
  }

  forwardToLoopback(req, res, { port, targetPath, injectBaseTag: true });
}

/**
 * 统一宿主原生页面透传：/plug/{key}/page|assets|api → 宿主端口同路径。
 *
 * 关键差异：不注入 <base>。宿主页面层输出的引用全是同源绝对路径
 * （/plug/{key}/assets|api），注入 base 会把页内 fetch 甩到宿主端口上
 * 变成跨域请求；保持同源让这些请求继续落回本代理，CORS 问题不存在。
 */
export function handleUnifiedHostProxy(req, res, pathname, baseUrl) {
  let target;
  try {
    target = new URL(baseUrl || 'http://127.0.0.1:8870');
  } catch {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `统一宿主地址不合法: ${baseUrl}` }));
    return;
  }

  if (!LOOPBACK_HOSTS.has(target.hostname)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `仅允许代理到 loopback 上的统一宿主: ${target.hostname}` }));
    return;
  }

  const port = parseInt(target.port, 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `统一宿主端口不合法: ${target.port || '(缺失)'}` }));
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  forwardToLoopback(req, res, {
    hostname: target.hostname,
    port,
    targetPath: pathname + (url.search || ''),
    injectBaseTag: false,
  });
}

function forwardToLoopback(req, res, { hostname = '127.0.0.1', port, targetPath, injectBaseTag }) {
  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${port}`;
  // 避免 gzip 解压麻烦或直接透传
  delete headers['accept-encoding'];

  const proxyReq = http.request(
    {
      hostname,
      port,
      path: targetPath,
      method: req.method,
      headers,
      timeout: 10000,
    },
    (proxyRes) => {
      const respHeaders = { ...proxyRes.headers };

      // 核心：彻底剥离和清洗阻止 iframe 嵌入的安全头
      delete respHeaders['x-frame-options'];
      delete respHeaders['content-security-policy'];
      delete respHeaders['content-security-policy-report-only'];

      respHeaders['access-control-allow-origin'] = '*';

      const contentType = (respHeaders['content-type'] || '').toLowerCase();
      if (injectBaseTag && contentType.includes('text/html')) {
        delete respHeaders['content-length'];
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8');
          const baseTag = `<base href="http://127.0.0.1:${port}/">`;
          if (html.includes('<head>')) {
            html = html.replace('<head>', `<head>\n  ${baseTag}`);
          } else if (html.includes('<HEAD>')) {
            html = html.replace('<HEAD>', `<HEAD>\n  ${baseTag}`);
          } else {
            html = baseTag + html;
          }
          res.writeHead(proxyRes.statusCode || 200, respHeaders);
          res.end(html);
        });
        return;
      }

      res.writeHead(proxyRes.statusCode || 200, respHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <div style="font-family: sans-serif; padding: 24px; color: #e5e7eb; background: #1f2937; border-radius: 8px; margin: 16px;">
          <h3 style="color: #f87171; margin-top: 0;">🔌 插件服务未连接或未就绪</h3>
          <p>无法连接到本地端口 <code>127.0.0.1:${port}</code> (${err.message})</p>
          <p style="color: #9ca3af; font-size: 13px;">请检查该插件是否已在统一宿主中成功装配并启动。</p>
        </div>
      `);
    }
  });

  req.pipe(proxyReq);
}
