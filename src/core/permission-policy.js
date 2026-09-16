import { COMMANDS } from './command-registry.js';

export function getIdentityRole(userId, identity = {}) {
  const uid = String(userId ?? '').trim();
  if (uid && uid === String(identity.ownerId ?? '').trim()) return 'owner';
  const admins = Array.isArray(identity.adminIds) ? identity.adminIds.map((id) => String(id).trim()) : [];
  return uid && admins.includes(uid) ? 'admin' : 'member';
}
export function canIntervene(role) { return role === 'owner' || role === 'admin'; }
export function canUseCommand(role, command, identity = {}) {
  const entry = COMMANDS.find((c) => c.id === command);
  if (!entry) return false;
  if (role === 'owner') return true;
  if (role === 'admin') return entry.adminGrantable === true &&
    Array.isArray(identity.adminCommands) && identity.adminCommands.includes(entry.id);
  return role === 'member' && entry.memberAllowed === true;
}
