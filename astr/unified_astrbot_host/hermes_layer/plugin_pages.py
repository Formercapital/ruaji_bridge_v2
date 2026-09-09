"""hermes_layer.plugin_pages —— 插件原生页面的通用伺服层。

## 解决什么问题

上游插件的 WebUI 走 AstrBot 的 ``context.register_web_api`` 注册 Quart
handler + ``pages/`` 目录放静态页面。以前宿主没有这套的通用消费者
（LivingMemory 是 web_services.py 里手搓的专属路由）——每接一个带页面
的插件就要再粘一次宿主。

本模块是**通用**的：对所有挂载插件生效，零插件名。

约定（与 AstrBot 插件生态一致）：

- ``<插件目录>/pages/**/index.html`` —— 页面入口（取最浅的一个）
- ``context.registered_web_apis`` —— API 路由表（Quart handler）

暴露的 URL（挂在宿主自己的端口上，不新增监听）：

- ``GET /plug/{key}/page``        页面 HTML（相对路径改写 + SDK 兼容层注入）
- ``GET /plug/{key}/assets/{..}`` 静态资源（防路径穿越）
- ``ANY  /plug/{key}/api/{name}`` API 桥（Quart test_request_context）

SDK 兼容层：页面的 ``AstrBotPluginPage.ready/apiGet/apiPost`` 由注入的
JS 桥实现，打到同源 ``/plug/{key}/api/`` —— 插件前端零改动。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from aiohttp import web

from astrbot.core import logger

_CONTENT_TYPES = {
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}


def _json(payload: Any, status: int = 200) -> web.Response:
    return web.json_response(
        payload,
        status=status,
        dumps=lambda obj: json.dumps(obj, ensure_ascii=False, default=str),
    )


class GenericPluginPages:
    """所有插件原生页面的通用伺服器。``register(app)`` 一次挂全。"""

    def __init__(self, unified: Any) -> None:
        self.unified = unified
        self._quart: Any = None

    # ------------------------------------------------------------------
    # 装配
    # ------------------------------------------------------------------

    def register(self, app: web.Application) -> None:
        app.router.add_get("/plug/{key}/page", self.handle_page)
        app.router.add_get("/plug/{key}/page/", self.handle_page)
        app.router.add_get("/plug/{key}/assets/{filename:.*}", self.handle_asset)
        app.router.add_route("*", "/plug/{key}/api/{endpoint}", self.handle_page_api)

    def nav_entries(self) -> list[dict[str, Any]]:
        """有页面的插件 → 导航项（/api/v1/plugins/pages 用，去重交给调用方）。"""
        out: list[dict[str, Any]] = []
        for key, mount in self.unified.mounts.items():
            html = self._index_html(key)
            if html is None:
                continue
            out.append(
                {
                    "id": key,
                    "title": getattr(mount, "name", key),
                    "category": "plugin",
                    "icon": "puzzle-piece",
                    "port": 0,
                    "url": f"/plug/{key}/page",
                    "description": "插件原生页面（宿主通用伺服）",
                    "enabled": True,
                }
            )
        return out

    # ------------------------------------------------------------------
    # 路径发现
    # ------------------------------------------------------------------

    def _mount(self, key: str) -> Any:
        return self.unified.mounts.get(key)

    def _plugin_dir(self, key: str) -> Path | None:
        mount = self._mount(key)
        if mount is None:
            return None
        spec_path = getattr(getattr(mount, "spec", None), "path", None)
        if spec_path and Path(spec_path).is_dir():
            return Path(spec_path)
        return None

    def _pages_dir(self, key: str) -> Path | None:
        plugin_dir = self._plugin_dir(key)
        if plugin_dir is None:
            return None
        pages = plugin_dir / "pages"
        return pages if pages.is_dir() else None

    def _index_html(self, key: str) -> Path | None:
        pages = self._pages_dir(key)
        if pages is None:
            return None
        candidates = sorted(pages.glob("*/index.html"), key=lambda p: len(p.parts))
        direct = pages / "index.html"
        if direct.is_file():
            candidates.insert(0, direct)
        # index.html 相对 pages/ 的父目录就是静态资源根（./style.css 等）
        return candidates[0] if candidates else None

    def _asset_root(self, key: str) -> Path | None:
        html = self._index_html(key)
        return html.parent if html is not None else None

    def _package_name(self, key: str) -> str:
        mount = self._mount(key)
        return str(getattr(getattr(mount, "spec", None), "package", None) or key)

    # ------------------------------------------------------------------
    # 页面与静态资源
    # ------------------------------------------------------------------

    def _sdk_bridge(self, key: str, package: str) -> str:
        return f"""<script>
window.AstrBotPluginPage = {{
  ready: async () => ({{ plugin_name: '{package}' }}),
  getContext: () => ({{ plugin_name: '{package}' }}),
  apiGet: async (path, params={{}}) => {{
    const q = new URLSearchParams(params).toString();
    const r = await fetch('/plug/{key}/api/' + path + (q ? '?' + q : ''));
    if (!r.ok) throw new Error(await r.text()); return await r.json();
  }},
  apiPost: async (path, body={{}}) => {{
    const r = await fetch('/plug/{key}/api/' + path, {{method:'POST', headers:{{'Content-Type':'application/json'}}, body: JSON.stringify(body)}});
    if (!r.ok) throw new Error(await r.text()); return await r.json();
  }}
}};
</script>"""

    async def handle_page(self, request: web.Request) -> web.Response:
        key = request.match_info["key"]
        html_path = self._index_html(key)
        if html_path is None or not html_path.is_file():
            raise web.HTTPNotFound(text=f"插件 {key} 没有页面")
        html = html_path.read_text(encoding="utf-8")
        # 相对引用改写到同源资源路由：./style.css → /plug/<key>/assets/style.css
        html = html.replace('href="./', f'href="/plug/{key}/assets/').replace(
            'src="./', f'src="/plug/{key}/assets/'
        )
        # SDK 桥注入到 </head> 前（早于一切模块脚本执行）
        bridge = self._sdk_bridge(key, self._package_name(key))
        html = html.replace("</head>", bridge + "</head>")
        return web.Response(text=html, content_type="text/html", charset="utf-8")

    async def handle_asset(self, request: web.Request) -> web.StreamResponse:
        key = request.match_info["key"]
        root = self._asset_root(key)
        if root is None:
            raise web.HTTPNotFound(text="not found")
        base = root.resolve()
        target = (base / request.match_info["filename"]).resolve()
        if base not in target.parents and target != base or not target.is_file():
            raise web.HTTPNotFound(text="not found")
        content_type = _CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        return web.FileResponse(target, headers={"Content-Type": content_type, "Cache-Control": "no-cache"})

    # ------------------------------------------------------------------
    # 页面 API 桥（Quart handler → aiohttp）
    # ------------------------------------------------------------------

    def _find_api_specs(self, key: str, endpoint: str) -> list[tuple[str, Any, list[str]]]:
        """在 registered_web_apis 里按插件包名前缀 + 端点名收集**全部** spec。

        表是上游语义的 (route, handler, methods, desc) 列表：同路由不同方法
        的注册共存（Favour Ultra 的 /config 是 GET/POST 两个 handler 双注册），
        必须整体返回，由调用方按请求方法挑，不能像单值表那样取一条就算。

        兼容旧 dict 形状的表项（防外部代码直接塞 dict 进来）。
        """
        table = getattr(self.unified.context, "registered_web_apis", None) or []
        specs: list[tuple[str, Any, list[str]]] = []
        for api in table:
            if isinstance(api, dict):
                route = str(api.get("route", ""))
                handler = api.get("handler")
                methods = [str(m).upper() for m in (api.get("methods") or ["GET"])]
            else:
                route = str(api[0])
                handler = api[1]
                methods = [str(m).upper() for m in (api[2] or ["GET"])]
            specs.append((route, handler, methods))

        package = self._package_name(key)
        normalized = f"{package}/{endpoint}".strip("/").lower()
        exact = [s for s in specs if s[0].strip("/").lower() == normalized]
        if exact:
            return exact
        # 兜底：尾缀匹配（不同上游对前导斜杠/大小写写法不一）
        suffix = "/" + endpoint.strip("/").lower()
        return [s for s in specs if s[0].strip("/").lower().endswith(suffix)]

    async def handle_page_api(self, request: web.Request) -> web.Response:
        key = request.match_info["key"]
        endpoint = request.match_info["endpoint"].strip("/")

        if self._mount(key) is None:
            return _json({"ok": False, "error": f"plugin_not_mounted: {key}"}, status=404)

        specs = self._find_api_specs(key, endpoint)
        if not specs:
            return _json({"ok": False, "error": f"unknown page route: {key}/{endpoint}"}, status=404)

        handler = None
        for _route, candidate, methods in specs:
            if request.method in methods:
                handler = candidate
                break
        if handler is None:
            allowed = sorted({m for _r, _h, ms in specs for m in ms})
            return _json(
                {"ok": False, "error": "method_not_allowed", "allowed": allowed},
                status=405,
            )

        if self._quart is None:
            from quart import Quart

            self._quart = Quart("plugin_pages_bridge")

        body = None
        if request.method == "POST":
            try:
                body = await request.json()
            except Exception:  # noqa: BLE001 —— 空/非法体按 {} 交给 handler 校验
                body = {}
        query_params = dict(request.query)

        try:
            async with self._quart.test_request_context(
                f"/{self._package_name(key)}/{endpoint}",
                method=request.method,
                query_string=query_params,
                json=body,
            ):
                result = await handler()
        except Exception as exc:  # noqa: BLE001
            logger.exception("插件页面 API %s/%s 执行失败", key, endpoint)
            return _json({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, status=500)

        return await self._quart_result_to_aiohttp(result)

    async def _quart_result_to_aiohttp(self, result: Any) -> web.Response:
        """Quart handler 返回值（Response / (body, status[, headers])）→ aiohttp 响应。"""
        from quart.wrappers.response import Response as QuartResponse

        if isinstance(result, QuartResponse):
            try:
                payload = await result.get_json()
            except Exception:  # noqa: BLE001
                payload = await result.get_data()
            return _json(payload if payload is not None else {}, status=result.status_code)
        if isinstance(result, tuple):
            body_part, status = result[0], (result[1] if len(result) > 1 else 200)
            if isinstance(body_part, QuartResponse):
                try:
                    payload = await body_part.get_json()
                except Exception:  # noqa: BLE001
                    payload = await body_part.get_data()
                return _json(payload, status=status or body_part.status_code)
            if isinstance(body_part, (bytes, str)):
                return web.Response(
                    text=body_part if isinstance(body_part, str) else body_part.decode("utf-8", "replace"),
                    status=int(status or 200),
                    content_type="application/json; charset=utf-8",
                )
        if result is None:
            return _json({"ok": True})
        return _json(result)


__all__ = ["GenericPluginPages"]
