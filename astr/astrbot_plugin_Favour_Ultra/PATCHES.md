# Favour Ultra Vendor Patches

Upstream: `astrbot_plugin_Favour_Ultra v4.4.5`  
Source: `F:/harness/reference document/astrbot_plugin_Favour_Ultra`  
License: Apache-2.0 (see `LICENSE`)

This file records every bridge-specific change to the vendored copy. Each patch
is minimal, additive, and replayable against a future upstream release.

## Applied patches

1. **Owner guard — prompt injection** (`main.py`, `inject_favour_prompt`):
   the bridge owner (mapped to AstrBot `admins_id` by the unified host) gets no
   favour instructions and the model produces no favour markers for the owner.

2. **Owner guard — response parsing** (`main.py`, `handle_llm_response`):
   tags in a reply to the owner are never stashed for settlement.

3. **Owner guard — settlement write** (`main.py`, `update_data`):
   settlement for owner-originated replies returns early; the owner record is
   never rewritten by ordinary scoring.

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

## Not needed (verified against the unified host)

- **Data directory derivation**: the host sets the AstrBot compat key
  `plugin.data_dir`, which the plugin already reads; no patch required.
- **T2I rendering degradation**: not triggered in the host integration path;
  revisit only if table rendering fails in practice.
