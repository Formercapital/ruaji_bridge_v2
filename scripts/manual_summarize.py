# -*- coding: utf-8 -*-
"""manual_summarize.py —— LivingMemory 手动总结与状态诊断脚本。

使用方式:
    python scripts/manual_summarize.py              # 查看所有会话未总结情况，并自动总结所有待处理会话
    python scripts/manual_summarize.py -s           # 仅查看所有会话未总结状态，不执行总结
    python scripts/manual_summarize.py 1076958977   # 指定总结特定群聊
    python scripts/manual_summarize.py 1076958977 -c 30 # 强制总结最近 30 条消息
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

HOST_BASE_URL = "http://127.0.0.1:8870"


def _http_get(url: str, timeout: float = 10.0) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_post(url: str, data: dict, timeout: float = 120.0) -> dict:
    payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json; charset=utf-8", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_sessions() -> list[dict]:
    url = f"{HOST_BASE_URL}/api/v1/livingmemory/sessions"
    try:
        res = _http_get(url)
        if res.get("ok"):
            return res.get("sessions", [])
        print(f"[错误] 获取会话列表失败: {res.get('error')}")
        return []
    except urllib.error.URLError as e:
        print(f"[错误] 无法连接到统一宿主 ({HOST_BASE_URL}): {e.reason}")
        print("请确认统一宿主 (host_server.py / 端口 8870) 正在运行。")
        return []


def print_status(sessions: list[dict]) -> None:
    print("\n" + "=" * 70)
    print(f"{'会话ID':<42} | {'总消息':<6} | {'已总结':<6} | {'未总结':<6} | 待重试")
    print("-" * 70)
    total_unsum = 0
    for s in sessions:
        sid = s["session_id"]
        cnt = s["message_count"]
        last = s["last_summarized_index"]
        unsum = s["unsummarized_count"]
        total_unsum += unsum
        pending = s.get("pending_summary")
        pending_str = f"是(重试{pending.get('retry_count', 0)}次)" if pending else "否"
        
        # 标色提示
        flag = " [!]" if unsum >= 10 or pending else "    "
        print(f"{sid:<42} | {cnt:<6} | {last:<6} | {unsum:<6}{flag} | {pending_str}")
    print("=" * 70)
    print(f"统计: 共 {len(sessions)} 个会话，累计待总结消息 {total_unsum} 条。\n")


def trigger_summarize(session_id: str = "", message_count: int | None = None, force: bool = False) -> None:
    url = f"{HOST_BASE_URL}/api/v1/livingmemory/summarize"
    data = {
        "session_id": session_id,
        "message_count": message_count,
        "force": force,
    }
    target_desc = f"会话 [{session_id}]" if session_id else "所有待总结会话"
    print(f">>> 正在向统一宿主请求手动总结: {target_desc} ...")
    if message_count:
        print(f">>> 指定消息条数: 最近 {message_count} 条")

    try:
        res = _http_post(url, data, timeout=180.0)
    except urllib.error.HTTPError as e:
        try:
            err_body = json.loads(e.read().decode("utf-8"))
            print(f"\n[HTTP {e.code} 错误] {err_body.get('message', err_body.get('error'))}")
        except Exception:
            print(f"\n[HTTP {e.code} 错误] {e.reason}")
        return
    except urllib.error.URLError as e:
        print(f"\n[连接失败] 无法连通宿主 ({HOST_BASE_URL}): {e.reason}")
        return

    if not res.get("ok"):
        print(f"\n[总结未完全成功] 部分或全部会话执行失败: {res.get('message', '')}")
    else:
        print("\n[总结完成] 宿主返回成功！")

    results = res.get("results", [])
    if not results and res.get("message"):
        print(f"提示: {res['message']}")
        return

    for r in results:
        sid = r.get("session_id", "未知")
        if r.get("ok"):
            if r.get("skipped"):
                print(f"  [-] {sid}: 跳过 ({r.get('message')})")
            else:
                rng = r.get("range", [])
                topics = ", ".join(r.get("topics", [])) or "无明确主题"
                imp = r.get("importance", 0)
                atoms = r.get("atoms_count", 0)
                print(f"  [+] {sid}: 总结成功！")
                print(f"      - 范围: [{rng[0]}:{rng[1]}] (共 {r.get('message_count', 0)} 条)")
                print(f"      - 提炼主题: {topics}")
                print(f"      - 重要性评分: {imp} | 生成记忆原子: {atoms} 个")
                if r.get("summary"):
                    print(f"      - 总结摘要: {r.get('summary')}")
        else:
            print(f"  [!] {sid}: 总结失败！")
            print(f"      - 错误类型: {r.get('error_type', r.get('error'))}")
            print(f"      - 错误详情: {r.get('error_message', r.get('message'))}")
            if r.get("traceback"):
                print("      - 异常堆栈片段:")
                for line in r["traceback"].strip().split("\n")[-6:]:
                    print(f"        {line}")


def main() -> int:
    parser = argparse.ArgumentParser(description="LivingMemory 手动总结与状态诊断")
    parser.add_argument("session", nargs="?", default="", help="可选。目标QQ群号、私聊QQ或完整会话ID。不传则总结所有待总结会话。")
    parser.add_argument("-s", "--status", action="store_true", help="仅查看所有会话的未总结状态与待重试信息，不执行总结")
    parser.add_argument("-c", "--count", type=int, default=None, help="可选。指定总结最近 N 条消息")
    parser.add_argument("-f", "--force", action="store_true", help="即使未总结消息不足 2 条也强制触发")
    args = parser.parse_args()

    sessions = get_sessions()
    if not sessions and args.status:
        return 1

    if args.status:
        print_status(sessions)
        return 0

    print_status(sessions)
    trigger_summarize(session_id=args.session, message_count=args.count, force=args.force)

    # 总结完再拉一次最新状态对比
    print("\n>>> 正在刷新最新状态...")
    latest_sessions = get_sessions()
    if latest_sessions:
        print_status(latest_sessions)

    return 0


if __name__ == "__main__":
    sys.exit(main())
