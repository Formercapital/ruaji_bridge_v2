"""Read-only reply eligibility shared by prompt injection and intervention preflight."""
from datetime import datetime


def check_reply_gate(plugin, event):
    session_id = plugin._get_session_id(event)
    user_id = str(event.get_sender_id())
    if event.get_extra("_is_active_chat_synthetic") and event.get_extra("_active_chat_target_uid"):
        user_id = str(event.get_extra("_active_chat_target_uid"))
    shared = plugin._is_shared_session(session_id)
    if not shared:
        if plugin.allowed_sessions and not plugin._session_in_list(session_id, plugin.allowed_sessions):
            return {"allowed": True, "reason": "out_of_scope"}
        if plugin._session_in_list(session_id, plugin.blocked_sessions):
            return {"allowed": True, "reason": "out_of_scope"}
    blacklist_key = user_id if shared else f"{session_id}:{user_id}"
    if blacklist_key in plugin.auto_blacklisted:
        return {"allowed": False, "reason": "auto_blacklisted"}
    if plugin.enable_cold_violence:
        expiry = plugin.cold_violence_users.get(plugin._get_cold_violence_key(user_id, session_id))
        now = datetime.now()
        if expiry and now < expiry:
            remaining = f"{int((expiry - now).total_seconds() // 60)}分"
            return {"allowed": False, "reason": "cold_violence",
                    "reply": plugin.cold_violence_replies["on_message"].replace("{time_str}", remaining)}
    return {"allowed": True, "reason": "allowed"}
