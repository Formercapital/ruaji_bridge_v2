"""Run explicit read-only plugin guards, never context or lifecycle hooks."""
import asyncio
import inspect


async def check_reply_preflight(unified, event, required_plugins=()):
    checked = []
    try:
        for key in required_plugins:
            mount = unified.mounts.get(key)
            plugin = getattr(mount, "instance", None) or mount
            if not callable(getattr(plugin, "check_reply_gate", None)):
                return {"ok": False, "allowed": False, "reason": "guard_unavailable", "plugin": key}
        for key, mount in unified.mounts.items():
            plugin = getattr(mount, "instance", None) or mount
            guard = getattr(plugin, "check_reply_gate", None)
            if not callable(guard):
                continue
            result = guard(event)
            if inspect.isawaitable(result):
                result = await asyncio.wait_for(result, timeout=1.0)
            if not isinstance(result, dict) or type(result.get("allowed")) is not bool:
                raise ValueError(f"invalid guard result: {key}")
            checked.append(key)
            if not result["allowed"]:
                return {**result, "ok": True, "checked": checked}
        return {"ok": True, "allowed": True, "checked": checked}
    except Exception:
        return {"ok": False, "allowed": False, "reason": "guard_failed", "checked": checked}
