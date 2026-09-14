# Favour Ultra Vendor Patches

Upstream: `astrbot_plugin_Favour_Ultra v4.4.5`  
Source: `F:/harness/reference document/astrbot_plugin_Favour_Ultra`  
License: Apache-2.0 (see `LICENSE`)

This file records every bridge-specific change to the vendored copy. Each patch
is minimal, additive, and replayable against a future upstream release.

## Applied patches

1. **REMOVED 2026-09-09 — Owner guard, prompt injection** (`main.py`,
   `inject_favour_prompt`): the owner previously got no favour instructions.
   Removed at owner's request (owner is bound 亲密): the owner now receives the
   full `<FavorabilityPlugin>` rules and `<FavourContext>` (level description,
   score, relationship, exclusivity snapshot) like any other user.

2. **REMOVED 2026-09-09 — Owner guard, response parsing** (`main.py`,
   `handle_llm_response`): tags in replies to the owner are now stashed for
   settlement like everyone else's.

3. **REMOVED 2026-09-09 — Owner guard, settlement write** (`main.py`,
   `update_data`): settlement for owner-originated replies now runs. The owner
   record is still pinned by the storage-layer guards (patches 4/9/10): any
   scoring write is rejected or canonicalized back to
   `favour=max (1000), relationship=亲密, is_unique=true`, so the pinned
   intimate binding cannot drift.

4. **Owner record immutability** (`main.py`, `_write_favour`):
   any plugin write path touching the owner record is forced to
   `favour=max (1000)`, `relationship=亲密`, `is_unique=true`; attempts to write
   any other favour value for the owner are rejected. This covers global
   modification, relation updates, decay propagation, and page-API writes.

5. **Cold-violence ops command** (`main.py`, `impose_cold_violence`):
   new admin-only command `施加冷暴力` (alias `冷暴力`) following the upstream
   command registration pattern, mirroring the existing `取消冷暴力`.
   It reuses the upstream permission system, cold-violence key derivation,
   duration config, and reply style. The owner is exempt from being targeted.

6. **Help menu** (`main.py`, `help_menu`): the new command is listed under the
   Bot管理员 commands.

7. **Shared-mode exclusive snapshot** (`main.py`, `inject_favour_prompt`):
   upstream skips the exclusive-relationship injection entirely in shared
   (global) sessions. The patch builds a minimal exclusive snapshot from the
   global records — the owner binding pinned first — so other users' contexts
   can see existing exclusive bindings, giving the model one consistent source
   of truth for exclusivity semantics. Snapshot failure degrades silently.

8. **Data directory derivation** (`config_manager.py`, `__init__`):
   upstream derives `plugin_data` from the plugin directory's
   parent-of-parent, assuming an AstrBot `data/plugins/` install. The vendored
   layout would put the config in the repo root. The patch prefers the
   framework-provided data directory (constructor argument, set by the host's
   `data` compat key) and keeps upstream behavior when absent.

9. **Owner guard — database write layer** (`storage.py`):
   the write chokepoint for every mutable path (scoring, global modify,
   panel single-record edit/delete, session/global clear, decay). Owner
   records accept only canonical writes (favour=max, relationship=亲密,
   is_unique=true); deletes are refused and logged; decay never selects the
   owner; clears preserve the owner rows.

10. **Owner record rebuild** (`storage.py` `ensure_owner_records`, called from
    `main.py` `_init_storage` and after clears): (re)creates the owner row at
     max favour with the default exclusive intimate relation and fixed title,
     repairing external corruption and post-clear state.

11. **Bridge proactive-turn exemption** (`main.py`, `inject_favour_prompt` /
    `handle_llm_response` / `update_data`): bridge-synthesized proactive
    interjections (trigger type `ai_decision`) get no favour injection, no
    tag parsing, and no settlement write — mirroring the legacy affection
    chain, where proactive turns never evaluated favour (the bridge prompt
    explicitly says "此类无需评价好感度"; injecting the MandatoryFooter on
    those turns contradicted it). The host passes the bridge trigger type
    through the event extra `_bridge_trigger_type`
    (`hermes_layer/contracts.py` `from_payload` + `context_builder.build_event`;
    the bridge sends `triggerType` on enrich, llm.response and decorate
    bodies). Tag stripping in `update_data` still runs so tags echoed from
    history never leak to chat.

## Not needed (verified against the unified host)

- **T2I rendering degradation**: not triggered in the host integration path;
  revisit only if table rendering fails in practice.
