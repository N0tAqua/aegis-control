import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';

export const COLORS = {
  brand: 0x6f9bff,
  on: 0x38e8b0,
  off: 0xff6482,
  warn: 0xffb457,
  urgent: 0xff5f6d,
  muted: 0x8b98b8,
  ticket: 0x5865f2,
};

export const EPHEMERAL = MessageFlags.Ephemeral;

export function embed(title, description, color = COLORS.brand) {
  const built = new EmbedBuilder().setColor(color);
  if (title) built.setTitle(String(title).slice(0, 256));
  if (description) built.setDescription(String(description).slice(0, 4000));
  return built;
}

export function okEmbed(title, description) {
  return embed(title, description, COLORS.on);
}

export function errorEmbed(title, description) {
  return embed(title, description, COLORS.off);
}

export function warnEmbed(title, description) {
  return embed(title, description, COLORS.warn);
}

export function isSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value.trim());
}

export function randomId(length = 6) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function hexToInt(input) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(input ?? '').trim());
  return match ? Number.parseInt(match[1], 16) : null;
}

export function truncate(text, max = 900) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function channelSafeName(input, fallback = 'text') {
  const cleaned = String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
  return cleaned || fallback;
}

export function number(value) {
  return Math.round(Number(value) || 0).toLocaleString('en-US');
}

export function percent(part, total) {
  if (!total) return '0%';
  return `${Math.round((Number(part) / Number(total)) * 100)}%`;
}

export function dateKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function dayKeys(count, from = Date.now()) {
  const keys = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    keys.push(dateKey(from - index * 86_400_000));
  }
  return keys;
}

export function parseDuration(input) {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 60_000;
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(w|d|h|m|s)/g)];
  if (matches.length === 0) return null;
  const units = { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
  let total = 0;
  for (const match of matches) total += Number(match[1]) * units[match[2]];
  return total > 0 ? Math.round(total) : null;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function relative(timestamp) {
  return `<t:${Math.floor(Number(timestamp) / 1000)}:R>`;
}

export function shortDate(timestamp) {
  return `<t:${Math.floor(Number(timestamp) / 1000)}:d>`;
}

export function canManageGuild(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

export function hasAnyRole(member, roleIds) {
  if (!member || !Array.isArray(roleIds) || roleIds.length === 0) return false;
  return roleIds.some((roleId) => member.roles?.cache?.has(roleId));
}

export function isStaffMember(member, supportRoleIds) {
  if (!member) return false;
  if (canManageGuild(member)) return true;
  return hasAnyRole(member, supportRoleIds);
}

export function chunk(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export function levenshtein(a, b) {
  const left = String(a);
  const right = String(b);
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');
}

export function similarName(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

export function parseList(input, { max = 12, maxLength = 40 } = {}) {
  return String(input ?? '')
    .split(/[,;|]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((entry) => entry.slice(0, maxLength));
}

export function bar(value, total, size = 10) {
  const filled = total > 0 ? Math.round((Math.max(0, value) / total) * size) : 0;
  return '█'.repeat(Math.min(size, Math.max(0, filled))) + '░'.repeat(Math.max(0, size - filled));
}

export async function tryDelete(message) {
  try {
    await message?.delete();
  } catch {
    // Message already gone or missing permission.
  }
}

export function summarizeLines(lines, limit = 20) {
  const filtered = lines.filter(Boolean);
  if (filtered.length <= limit) return filtered.join('\n');
  return `${filtered.slice(0, limit).join('\n')}\n…and ${filtered.length - limit} more`;
}
