const api = window.aegis;
const $ = (id) => document.getElementById(id);

const SCOPES = ['manageBot', 'manageRules', 'useConsole', 'viewLogs', 'manageKeys', 'manageRooms'];
const SCOPE_LABELS = {
  manageBot: 'Manage bot',
  manageRules: 'Protections',
  useConsole: 'Console',
  viewLogs: 'Activity',
  manageKeys: 'Keys',
  manageRooms: 'Rooms',
  linkConsole: 'Linked console',
};
const PRESETS = {
  full: ['manageBot', 'manageRules', 'useConsole', 'viewLogs', 'manageKeys', 'manageRooms'],
  operator: ['manageBot', 'manageRules', 'useConsole', 'viewLogs'],
  viewer: ['viewLogs'],
  linked: ['viewLogs'],
  rooms: ['manageRooms', 'viewLogs'],
};

function can(scope) {
  const user = state?.auth?.user;
  if (!user) return false;
  // Everyone in a room can drive the host bot. Key and room administration stay separate.
  if (state?.room && scope !== 'manageKeys' && scope !== 'manageRooms') return true;
  if (user.role === 'owner') return true;
  return Array.isArray(user.scopes) && user.scopes.includes(scope);
}

const PAGE_META = {
  overview: ['Overview', 'Live status of Aegis and your servers.'],
  servers: ['Servers', 'Server-wide protection, per-member rules and sticky force mute/deafen.'],
  roles: ['Roles', 'Create, edit, reorder and delete roles without opening Discord.'],
  tools: ['Server tools', 'Panic mode, anti-nuke, audits, coins, events, stats and the copilot.'],
  access: ['Access', 'Choose exactly which Discord users can control Aegis.'],
  console: ['Console', 'Run Aegis commands without leaving the dashboard.'],
  activity: ['Activity', 'Everything Aegis has done since the dashboard opened.'],
  messages: ['Messages', 'Messages Aegis has seen, grouped by channel.'],
  licenses: ['Licences', 'Create, edit and revoke panel keys.'],
  room: ['Room', 'Create or join a room to use Aegis.'],
  settings: ['Settings', 'Token, command registration and startup behaviour.'],
};

const state = {
  status: null,
  config: null,
  info: null,
  auth: null,
  keys: [],
  logs: [],
  statusAt: Date.now(),
  consoleLines: [],
  consoleSeeded: false,
  page: 'overview',
  busy: false,
  expanded: new Set(),
  roles: null,
  roleEdit: null,
  tools: null,
  toolPlan: null,
  authView: 'login',
  update: null,
  offlineNotified: false,
  linked: false,
  linkedTimer: null,
  linkedAt: 0,
  linkedHost: '',
  linkedSignature: '',
  room: null,
  rooms: [],
  availableRooms: [],
  messages: [],
  messageChannel: 'all',
  social: null,
  publicId: '',
  socialSeen: new Set(),
  socialTimer: null,
  roomTimer: null,
  updatedToastShown: false,
};

/* ---------------------------------------------------------------- helpers --- */

function cleanError(error) {
  const message = error?.message ?? String(error);
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '');
}

function toast(message, kind = 'ok') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('toasts').append(node);
  setTimeout(() => node.remove(), 3800);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDuration(ms) {
  if (!ms || ms < 1000) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/* ------------------------------------------------------------------- auth --- */

function showAuthError(message) {
  const node = $('auth-error');
  node.hidden = false;
  node.textContent = message;
}

function clearAuthError() {
  const node = $('auth-error');
  node.hidden = true;
  node.textContent = '';
}

function renderAuth(authState) {
  clearAuthError();
  $('auth-machine').textContent = authState.machine ?? '—';
  $('auth-server').textContent = authState.server ?? 'not set';

  // No baked-in address (an old build, or a portable copy on a new PC): ask for
  // it here instead of showing an error the user cannot act on.
  const serverField = $('server-url');
  if (serverField && authState.server && !serverField.value) serverField.value = authState.server;
  if (!authState.server) {
    $('auth-server-edit').hidden = false;
    $('toggle-server').hidden = true;
  }

  const firstRun = Boolean(authState.firstRun);
  const registering = state.authView === 'register';
  $('auth-firstrun').hidden = registering || !firstRun;
  $('auth-login').hidden = registering || firstRun;
  $('auth-register').hidden = !registering;
  $('auto-login').hidden = firstRun || !authState.autoLoginUser;
  $('auto-user').textContent = authState.autoLoginUser ?? '';
  $('owner-key').textContent = authState.ownerKey ?? '—';
  const discordReady = Boolean(authState.discordSupported);
  $('discord-login').hidden = !discordReady;
  $('auth-divider').hidden = !discordReady;
}

function renderIdentity(authState) {
  const user = authState?.user ?? {};
  const discordLine = $('account-discord-line');
  const keyLine = $('account-key-line');
  const identity = $('dashboard-identity');

  if (discordLine) {
    discordLine.hidden = false;
    discordLine.textContent = user.discordId
      ? `Discord: ${user.discordUsername || 'linked'} · ${user.discordId}`
      : 'Discord is optional. Link it to verify the Discord ID on your licence key.';
  }
  const linkDiscord = $('link-discord-account');
  const unlinkDiscord = $('unlink-discord-account');
  if (linkDiscord) {
    linkDiscord.hidden = Boolean(user.discordId) || !authState.discordSupported;
  }
  if (unlinkDiscord) unlinkDiscord.hidden = !user.discordId;
  const redirectLine = $('discord-redirect-line');
  if (redirectLine) {
    redirectLine.hidden = !authState.discordSupported;
    redirectLine.textContent = authState.server
      ? `Discord redirect URL: ${authState.server}/api/auth/discord/callback`
      : '';
  }
  if (keyLine) {
    keyLine.hidden = !user.key;
    keyLine.textContent = user.key
      ? `Licence key: ${user.key.label ? `${user.key.label} · ` : ''}${user.key.masked}`
      : '';
  }
  if (identity) {
    identity.textContent = user.discordId
      ? `The dashboard signs in with your linked Discord (${user.discordId}) and keeps this key's permissions.`
      : 'Sign in with Discord on the dashboard.';
  }
}

function renderNavGate() {
  const hasRoom = Boolean(state.room);
  const show = (selector, visible) => {
    const node = document.querySelector(selector);
    if (node) node.hidden = !visible;
  };

  show('[data-goto="overview"]', hasRoom);
  show('[data-goto="servers"]', hasRoom);
  // Roles are edited through the licence server, so they work without a room.
  show('[data-goto="roles"]', can('manageBot'));
  show('[data-goto="access"]', hasRoom);
  show('[data-goto="activity"]', hasRoom && can('viewLogs'));
  show('[data-goto="messages"]', hasRoom);
  show('[data-goto="console"]', hasRoom && can('useConsole'));
  show('#licenses-nav', hasRoom && can('manageKeys'));
  show('#room-nav', true);
  show('[data-goto="settings"]', true);

  const canHost = hasRoom && !state.linked && can('manageBot');
  $('token-card').hidden = !canHost;
  $('commands-card').hidden = !canHost;
  $('startup-card').hidden = !canHost;
}

async function applyAuth(authState) {
  state.auth = authState;

  if (authState.offline && !state.offlineNotified) {
    state.offlineNotified = true;
    toast(
      authState.authenticated
        ? 'Aegis server unreachable — using the saved session until it is back.'
        : 'Aegis server unreachable. Check your internet connection and try again.',
      'err',
    );
  }

  if (!authState.authenticated) {
    state.room = null;
    state.linked = false;
    state.social = null;
    state.publicId = '';
    state.socialSeen.clear();
    stopLinkedPolling();
    stopSocialPolling();
    renderNavGate();
    $('auth-screen').hidden = false;
    document.querySelector('.app').classList.add('locked');
    renderAuth(authState);
    return false;
  }

  $('auth-screen').hidden = true;
  document.querySelector('.app').classList.remove('locked');

  state.publicId = authState.user?.publicId ?? '';
  $('account-name').textContent = authState.user?.username ?? '—';
  $('account-role').textContent = authState.user?.role ?? '—';
  $('account-role').title = can('manageKeys')
    ? 'This account can manage licence keys.'
    : 'This account cannot manage licence keys.';
  renderIdentity(authState);

  state.room = await api.rooms.current().catch(() => null);
  state.linked = Boolean(state.room && !state.room.isHost);
  if (!state.linked) stopLinkedPolling();
  startSocialPolling();
  loadSocial();
  renderNavGate();

  if (!state.room) {
    state.status = null;
    state.logs = [];
    state.rooms = [];
    state.availableRooms = [];
    state.info = await api.getInfo().catch(() => null);
    stopLinkedPolling();
    renderAll();
    await loadRooms();
    setPage('room');
    return true;
  }

  await loadDashboard();
  if (state.linked) startLinkedPolling();
  setPage(state.page === 'licenses' && can('manageKeys') ? 'licenses' : 'overview');
  return true;
}

async function loadDashboard() {
  if (state.linked) {
    state.info = await api.getInfo();
    state.config = { hasToken: false, tokenHint: '', guildId: '', autoStart: false };
    state.status = null;
    state.logs = [];
    state.messages = [];
    await refreshLinkedConsole(true);
    state.statusAt = Date.now();
    if (state.info?.updatedTo && !state.updatedToastShown) {
      state.updatedToastShown = true;
      toast(`Updated to v${state.info.updatedTo}.`);
    }
    renderAll();
    return;
  }

  const [config, status, info] = await Promise.all([
    api.getConfig(),
    api.getStatus(),
    api.getInfo(),
  ]);
  state.config = config;
  state.status = status;
  state.info = info;
  state.logs = can('viewLogs') ? ((await api.getLogs()) ?? []) : [];
  state.messages = (await api.messages.get().catch(() => [])) ?? [];
  state.statusAt = Date.now();

  if (!state.consoleSeeded) {
    const history = await api.getConsoleHistory().catch(() => []);
    if (Array.isArray(history) && history.length) {
      state.consoleLines = history.map((line) => ({
        text: line.text,
        kind: line.kind ?? 'out',
      }));
      state.consoleSeeded = true;
      renderConsole();
    } else {
      appendConsole('Aegis console ready. Type "help" for commands.', 'out');
      state.consoleSeeded = true;
    }
  }
  if (state.info?.updatedTo && !state.updatedToastShown) {
    state.updatedToastShown = true;
    toast(`Updated to v${state.info.updatedTo}.`);
  }
  renderAll();
}

/* ---------------------------------------------------------------- linked --- */

// Every request counts against the hosting allowance, so the linked console
// checks every 15s while something is happening and backs off to every 3
// minutes when nothing changes. A hidden window does not poll at all.
const LINKED_POLL_MS = 15_000;
const LINKED_POLL_MAX_MS = 180_000;

function stopLinkedPolling() {
  if (state.linkedTimer) {
    clearTimeout(state.linkedTimer);
    state.linkedTimer = null;
  }
}

function scheduleLinkedPoll(delay = LINKED_POLL_MS) {
  stopLinkedPolling();
  if (!state.linked) return;
  state.linkedTimer = setTimeout(async () => {
    state.linkedTimer = null;
    if (!state.linked) return;
    if (document.hidden) {
      scheduleLinkedPoll(LINKED_POLL_MAX_MS);
      return;
    }
    const changed = await refreshLinkedConsole();
    if (!state.linked) return;
    state.linkedIdle = changed ? 0 : Math.min((state.linkedIdle ?? 0) + 1, 4);
    scheduleLinkedPoll(Math.min(LINKED_POLL_MS * 2 ** state.linkedIdle, LINKED_POLL_MAX_MS));
  }, delay);
}

function startLinkedPolling() {
  state.linkedIdle = 0;
  scheduleLinkedPoll(LINKED_POLL_MS);
}

async function refreshLinkedConsole(initial = false) {
  try {
    const room = await api.rooms.current();
    if (!room) {
      state.room = null;
      state.linked = false;
      stopLinkedPolling();
      state.status = null;
      state.logs = [];
      renderNavGate();
      renderAll();
      await loadRooms();
      setPage('room');
      toast('You are no longer in that room.', 'err');
      return false;
    }

    state.room = room;
    state.linked = !room.isHost;
    state.messages = Array.isArray(room.messages) ? room.messages : [];
    if (room.status) {
      state.status = room.status;
      state.logs = Array.isArray(room.logs) ? room.logs : [];
      state.linkedAt = room.updatedAt ?? 0;
      state.linkedHost = room.host ?? '';
    } else {
      state.status = null;
      state.logs = [];
      state.linkedAt = 0;
      state.linkedHost = room.host ?? '';
    }
    state.statusAt = Date.now();

    const signature = JSON.stringify({ status: state.status, logs: state.logs, messages: state.messages });
    const changed = initial || signature !== state.linkedSignature;
    if (changed) {
      state.linkedSignature = signature;
      renderAll();
    } else {
      renderLinkedBanner();
    }
    return changed;
  } catch (error) {
    const message = cleanError(error);
    if (/no longer exists|join this room/i.test(message)) {
      state.room = null;
      state.linked = false;
      stopLinkedPolling();
      state.status = null;
      state.logs = [];
      renderNavGate();
      renderAll();
      await loadRooms();
      setPage('room');
      toast('That room is no longer available.', 'err');
      return false;
    }
    if (initial) toast(message, 'err');
  }
}

function renderLinkedBanner() {
  const banner = $('linked-banner');
  if (!banner) return;
  if (!state.linked) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  if (!state.linkedAt) {
    $('linked-note').textContent = 'Waiting for the host panel to share its console…';
    return;
  }
  const age = Date.now() - state.linkedAt;
  const seconds = Math.max(1, Math.round(age / 1000));
  const host = state.linkedHost ? `${state.linkedHost}'s` : 'the host';
  $('linked-note').textContent =
    age > 20000
      ? `Host offline — last update ${seconds}s ago.`
      : `Live from ${host} panel · updated ${seconds}s ago.`;
}

/* ----------------------------------------------------------------- status --- */

function renderChrome() {
  const status = state.status;
  const running = Boolean(status?.running);
  const starting = Boolean(status?.starting);

  const dot = $('side-dot');
  dot.className = `dot${running ? ' online' : starting ? ' starting' : ''}`;
  $('side-status').textContent = running ? 'Aegis online' : starting ? 'Starting…' : 'Aegis offline';

  const pill = $('token-pill');
  if (!state.room) {
    pill.textContent = 'No room';
    pill.classList.remove('ok');
  } else if (state.linked) {
    pill.textContent = `Linked · ${state.room.name}`;
    pill.classList.add('ok');
  } else if (state.config?.hasToken) {
    pill.textContent = `Token ${state.config.tokenHint}`;
    pill.classList.add('ok');
  } else {
    pill.textContent = 'No token';
    pill.classList.remove('ok');
  }

  const busy = state.busy;
  const canBot = can('manageBot') && Boolean(state.room);
  const topButton = $('top-start');
  topButton.textContent = running ? 'Stop Aegis' : starting ? 'Starting…' : 'Start Aegis';
  topButton.disabled = busy || starting || !canBot;
  topButton.classList.toggle('btn-primary', !running);
  topButton.classList.toggle('btn-ghost', running);

  $('hero-start').disabled = busy || running || starting || !canBot;
  $('hero-stop').disabled = busy || (!running && !starting) || !canBot;
  $('hero-deploy').disabled = busy || starting || !canBot;
  if (!state.room) {
    topButton.textContent = 'Join a room';
    topButton.disabled = true;
  }
}

function renderHero() {
  const status = state.status;
  const running = Boolean(status?.running);
  const starting = Boolean(status?.starting);

  $('hero-orb').className = `orb${running ? ' online' : ''}`;
  $('hero-status').textContent = running
    ? 'Aegis is online'
    : starting
      ? 'Aegis is starting…'
      : 'Aegis is offline';

  $('hero-tag').textContent = running
    ? `${status.tag} · protecting ${status.guilds.length} server(s)`
    : status.restartAt
      ? `Aegis crashed and is restarting automatically (attempt ${status.restartAttempts}).`
      : state.config?.hasToken
        ? 'Your token is saved. Press Start to bring Aegis online.'
        : 'Add your bot token in Settings, then start Aegis.';

  if (!state.room) {
    $('hero-status').textContent = 'No room yet';
    $('hero-tag').textContent = 'Create a room or join one with a code to unlock Aegis.';
  }

  if (state.linked) {
    $('hero-status').textContent = running ? 'Host Aegis is online' : 'Host Aegis is offline';
    $('hero-tag').textContent = 'Linked console — you can control the host bot from here.';
  }

  const error = $('hero-error');
  if (status?.lastError) {
    error.hidden = false;
    error.textContent = status.lastError;
  } else {
    error.hidden = true;
    error.textContent = '';
  }

  const invite = $('hero-invite');
  invite.hidden = !running;
  if (running && status.id) {
    invite.dataset.invite = `https://discord.com/oauth2/authorize?client_id=${status.id}&scope=bot%20applications.commands&permissions=50332672`;
  }
}

function countRules(guilds) {
  return guilds.reduce((total, guild) => {
    let count = (guild.antiServerMute ? 1 : 0) + (guild.antiServerDeafen ? 1 : 0);
    for (const member of guild.members ?? []) {
      count +=
        (member.antiServerMute === true ? 1 : 0) +
        (member.antiServerDeafen === true ? 1 : 0) +
        (member.forceServerMute ? 1 : 0) +
        (member.forceServerDeafen ? 1 : 0);
    }
    return total + count;
  }, 0);
}

function renderStats() {
  const status = state.status;
  const guilds = status?.guilds ?? [];
  $('stat-servers').textContent = String(guilds.length);
  $('stat-protections').textContent = String(countRules(guilds));
  $('stat-allowed').textContent = String(status?.allowlist?.length ?? 0);
  $('stat-uptime').textContent = status?.running
    ? formatDuration(status.uptimeMs + (Date.now() - state.statusAt))
    : '—';
}

/* ------------------------------------------------------------ guild cards --- */

function guildBadge(guild) {
  if (guild.icon) {
    const image = el('img', 'server-icon');
    image.src = guild.icon;
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    return image;
  }
  return el('div', 'server-icon ph', (guild.name || '?').slice(0, 1).toUpperCase());
}

function toggleRow(guild, key, title, note, disabled = false) {
  const row = el('div', 'toggle-row');

  const labels = el('div');
  labels.append(el('span', 'toggle-title', title), el('span', 'toggle-note', note));

  const button = el('button', 'switch');
  button.type = 'button';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', String(Boolean(guild[key])));
  button.setAttribute('aria-label', `${title} for ${guild.name}`);
  button.dataset.guild = guild.id;
  button.dataset.key = key;
  button.dataset.label = title;
  button.dataset.guildName = guild.name;
  if (disabled) {
    button.disabled = true;
    button.title = 'Your panel account cannot change protections.';
  }

  row.append(labels, button);
  return row;
}

function memberAntiControl(guild, member, key, title) {
  const label = el('div', 'mini');
  label.append(el('span', 'mini-label', title));

  const select = el('select', 'mini-select');
  select.dataset.guild = guild.id;
  select.dataset.user = member.id;
  select.dataset.memberKey = key;

  for (const [value, text] of [
    ['inherit', 'Inherit'],
    ['on', 'On'],
    ['off', 'Off'],
  ]) {
    const option = el('option', '', text);
    option.value = value;
    select.append(option);
  }

  select.value = member[key] === null ? 'inherit' : member[key] ? 'on' : 'off';
  label.append(select);
  return label;
}

function memberForceControl(guild, member, key, title) {
  const label = el('div', 'mini');
  label.append(el('span', 'mini-label', title));

  const button = el('button', 'switch');
  button.type = 'button';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', String(Boolean(member[key])));
  button.setAttribute('aria-label', `${title} for ${member.id}`);
  button.dataset.guild = guild.id;
  button.dataset.user = member.id;
  button.dataset.memberKey = key;
  button.dataset.guildName = guild.name;
  button.dataset.label = title;

  label.append(button);
  return label;
}

function memberRow(guild, member) {
  const row = el('div', 'member-row');

  const meta = el('div', 'member-meta');
  const name = member.displayName || (member.username ? `@${member.username}` : 'Discord member');
  const sub = member.username && member.displayName
    ? `@${member.username} · ${member.id}`
    : member.id;
  meta.append(el('div', 'member-name', name));
  meta.append(el('div', 'member-id mono', sub));

  const controls = el('div', 'member-controls');
  controls.append(
    memberAntiControl(guild, member, 'antiServerMute', 'Anti mute'),
    memberAntiControl(guild, member, 'antiServerDeafen', 'Anti deafen'),
    memberForceControl(guild, member, 'forceServerMute', 'Force mute'),
    memberForceControl(guild, member, 'forceServerDeafen', 'Force deafen'),
  );

  const remove = el('button', 'remove', 'Remove');
  remove.type = 'button';
  remove.dataset.memberRemove = member.id;
  remove.dataset.guild = guild.id;

  row.append(meta, controls, remove);
  return row;
}

function memberEditor(guild) {
  const wrap = el('div', 'member-editor');

  const form = el('form', 'member-add');
  form.dataset.memberAdd = guild.id;

  const input = el('input');
  input.placeholder = 'Discord user ID (17–20 digits)';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 20;

  const add = el('button', 'btn btn-ghost btn-small', 'Add member');
  add.type = 'submit';
  form.append(input, add);

  const list = el('div', 'member-list');
  if (guild.members.length === 0) {
    list.append(el('div', 'empty-rules', 'No member rules yet. Add an ID to override the server switches or hold someone muted.'));
  } else {
    for (const member of guild.members) list.append(memberRow(guild, member));
  }

  wrap.append(form, list);
  return wrap;
}

function guildCard(guild, { compact = false } = {}) {
  const card = el('div', 'server');
  const row = el('div', 'server-row');

  const head = el('div', 'server-head');
  const meta = el('div', 'server-meta');
  meta.append(el('div', 'server-name', guild.name), el('div', 'server-id mono', guild.id));
  head.append(guildBadge(guild), meta);

  const right = el('div', 'server-right');
  const editable = can('manageRules');

  const toggles = el('div', 'server-toggles');
  toggles.append(
    toggleRow(guild, 'antiServerMute', 'Server mute', 'unmute instantly', !editable),
    toggleRow(guild, 'antiServerDeafen', 'Server deafen', 'undeafen instantly', !editable),
  );

  right.append(toggles);
  if (!compact && editable) {
    const addAll = el('button', 'btn btn-ghost btn-small', 'Add all members');
    addAll.type = 'button';
    addAll.dataset.addAllMembers = guild.id;
    right.append(addAll);
  }
  if (!compact && editable) {
    const memberButton = el('button', 'member-button', `Members (${guild.members.length})`);
    memberButton.type = 'button';
    memberButton.dataset.expand = guild.id;
    if (state.expanded.has(guild.id)) memberButton.classList.add('open');
    right.append(memberButton);
  }

  row.append(head, right);
  card.append(row);

  const missing = [];
  if (guild.canMute === false) missing.push('Mute Members');
  if (guild.canDeafen === false) missing.push('Deafen Members');
  if (guild.canManageRoles === false) missing.push('Manage Roles');
  if (missing.length) {
    card.append(el('div', 'access-warning', `Aegis is missing: ${missing.join(', ')}.`));
  }

  if (!compact && editable && state.expanded.has(guild.id)) card.append(memberEditor(guild));
  return card;
}

function emptyCard(text) {
  return el('div', 'empty', text);
}

function renderGuilds() {
  const status = state.status;
  const guilds = status?.guilds ?? [];

  const quick = $('quick-controls');
  quick.replaceChildren();
  if (guilds.length === 0) {
    quick.append(
      emptyCard(
        status?.running
          ? 'Aegis is not in any server yet. Use the invite link on the Overview page.'
          : 'Start Aegis to see and configure your servers.',
      ),
    );
  } else {
    for (const guild of guilds.slice(0, 3)) quick.append(guildCard(guild, { compact: true }));
  }

  const list = $('server-list');
  list.replaceChildren();
  if (guilds.length === 0) {
    list.append(
      emptyCard(
        status?.running
          ? 'No servers connected. Invite Aegis with the button on the Overview page.'
          : 'Start Aegis (Overview page) to load your servers.',
      ),
    );
  } else {
    for (const guild of guilds) list.append(guildCard(guild));
  }

  $('servers-count').textContent = guilds.length
    ? `${guilds.length} server${guilds.length === 1 ? '' : 's'}`
    : '';
}

/* ----------------------------------------------------------------- access --- */

function renderAccess() {
  const allowlist = state.status?.allowlist ?? [];
  const editable = can('manageRules');
  const list = $('allow-list');
  list.replaceChildren();

  $('allow-form').hidden = !editable;
  $('allow-empty').hidden = allowlist.length > 0;
  $('access-count').textContent = allowlist.length
    ? `${allowlist.length} user${allowlist.length === 1 ? '' : 's'}`
    : '';

  for (const id of allowlist) {
    const row = el('div', 'allow-row');
    const meta = el('div');
    meta.append(
      el('div', 'allow-id mono', id),
      el('div', 'allow-note', 'Can run every Aegis command'),
    );

    row.append(meta);
    if (editable) {
      const remove = el('button', 'remove', 'Remove');
      remove.type = 'button';
      remove.dataset.remove = id;
      row.append(remove);
    }
    list.append(row);
  }
}

/* ------------------------------------------------------------------ feeds --- */

function feedItem(entry) {
  const item = el('li', entry.level);
  item.append(
    el('span', 'lvl'),
    el('time', '', formatTime(entry.at)),
    el('span', 'txt', entry.message),
  );
  return item;
}

function renderFeeds() {
  const preview = $('activity-preview');
  const list = $('activity-list');
  preview.replaceChildren();
  list.replaceChildren();

  const recent = [...state.logs].reverse();
  if (recent.length === 0) {
    preview.append(el('li', '', 'Nothing yet. Start Aegis to see activity.'));
    list.append(el('li', '', 'Nothing yet. Start Aegis to see activity.'));
    return;
  }

  for (const entry of recent.slice(0, 7)) preview.append(feedItem(entry));
  for (const entry of recent.slice(0, 300)) list.append(feedItem(entry));
}

function renderCrashes() {
  const card = $('crash-card');
  if (!card) return;
  const owner = state.auth?.user?.role === 'owner';
  card.hidden = !owner;
  if (!owner) return;

  const crashes = state.status?.crashes ?? [];
  $('crash-count').textContent = crashes.length
    ? `${crashes.length} recent${state.status?.crashCount > crashes.length ? ` of ${state.status.crashCount}` : ''}`
    : '';

  const list = $('crash-list');
  list.replaceChildren();
  if (!crashes.length) {
    list.append(el('li', '', 'No crashes recorded. That is the good outcome.'));
    return;
  }

  for (const entry of crashes) {
    const item = el('li', 'error');
    const head = el('div');
    head.append(
      el('span', 'lvl'),
      el('time', '', formatTime(entry.at)),
      el(
        'span',
        'txt',
        `${entry.reason} · ${entry.name}: ${entry.message}${entry.repeats ? ` (×${entry.repeats + 1})` : ''}`,
      ),
    );
    item.append(head);
    if (entry.stack) {
      const details = el('details');
      details.append(el('summary', 'muted small', 'Stack'));
      const stack = el('pre', 'muted small mono', entry.stack);
      stack.style.whiteSpace = 'pre-wrap';
      stack.style.overflowX = 'auto';
      details.append(stack);
      item.append(details);
    }
    list.append(item);
  }
}

/* ---------------------------------------------------------------- console --- */

function appendConsole(text, kind = 'out') {
  state.consoleLines.push({ text, kind });
  if (state.consoleLines.length > 500) state.consoleLines.shift();
  renderConsole();
}

function renderConsole() {
  const output = $('console-out');
  output.replaceChildren();
  for (const line of state.consoleLines) output.append(el('div', line.kind, line.text));
  output.scrollTop = output.scrollHeight;
}

async function submitConsole(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  appendConsole(`aegis › ${trimmed}`, 'echo');
  try {
    const result = await api.runCommand(trimmed);
    if (result) appendConsole(result, 'out');
  } catch (error) {
    appendConsole(cleanError(error), 'err');
  }
}

/* --------------------------------------------------------------- licences --- */

async function loadKeys() {
  if (!can('manageKeys')) return;
  try {
    state.keys = await api.auth.keys.list();
    renderKeys();
  } catch (error) {
    toast(cleanError(error), 'err');
  }
}

function renderScopePicker(container, selected = []) {
  container.replaceChildren();
  for (const scope of SCOPES) {
    const label = el('label');
    const input = el('input');
    input.type = 'checkbox';
    input.value = scope;
    input.checked = selected.includes(scope);
    input.dataset.keyScope = '';
    label.append(input, el('span', '', SCOPE_LABELS[scope] ?? scope));
    container.append(label);
  }
}

function keyRow(entry) {
  const row = el('div', 'key-row');
  row.dataset.keyId = entry.id;

  const top = el('div', 'key-top');
  top.append(el('code', 'key-value', entry.key));
  top.append(el('span', `badge ${entry.role === 'owner' ? 'owner' : ''}`, entry.role));
  top.append(el('span', `badge ${entry.disabled ? 'off' : 'ok'}`, entry.disabled ? 'disabled' : 'active'));
  top.append(el('span', 'badge', entry.usedBy ? `used by ${entry.usedBy}` : 'unused'));
  if (entry.discordId) top.append(el('span', 'badge ok', `discord ${entry.discordId}`));
  if (entry.bound) top.append(el('span', 'badge warn', `device ${entry.boundMachine}`));

  const meta = el('div', 'key-meta');
  meta.textContent = `${entry.label} · created ${new Date(entry.createdAt).toLocaleDateString()}`;

  const badges = el('div', 'scope-badges');
  for (const scope of entry.scopes ?? []) {
    badges.append(el('span', 'scope-badge', SCOPE_LABELS[scope] ?? scope));
  }

  const controls = el('div', 'key-controls');

  const label = el('input', 'key-label-input');
  label.value = entry.label;
  label.maxLength = 40;
  label.autocomplete = 'off';

  const save = el('button', 'btn btn-ghost', 'Save label');
  save.type = 'button';
  save.dataset.keyAction = 'save';

  const discord = el('input', 'key-discord-input');
  discord.value = entry.discordId ?? '';
  discord.placeholder = 'Discord user ID';
  discord.maxLength = 20;
  discord.inputMode = 'numeric';
  discord.autocomplete = 'off';

  const saveDiscord = el('button', 'btn btn-ghost', 'Save Discord ID');
  saveDiscord.type = 'button';
  saveDiscord.dataset.keyAction = 'save-discord';

  const copy = el('button', 'btn btn-ghost', 'Copy');
  copy.type = 'button';
  copy.dataset.keyAction = 'copy';

  controls.append(label, save, discord, saveDiscord, copy);

  if (!entry.disabled || entry.role !== 'owner') {
    const toggle = el('button', 'btn btn-ghost', entry.disabled ? 'Enable' : 'Disable');
    toggle.type = 'button';
    toggle.dataset.keyAction = 'toggle';
    if (entry.role !== 'owner') controls.append(toggle);
  }

  const reset = el('button', 'btn btn-ghost', 'Reset device');
  reset.type = 'button';
  reset.dataset.keyAction = 'reset';
  controls.append(reset);

  if (entry.role !== 'owner') {
    const remove = el('button', 'remove', 'Delete');
    remove.type = 'button';
    remove.dataset.keyAction = 'delete';
    controls.append(remove);
  }

  row.append(top, meta, badges, controls);

  if (entry.role !== 'owner') {
    const details = el('details', 'key-perms');
    details.append(el('summary', '', 'Permissions'));
    const picker = el('div', 'scope-picker');
    renderScopePicker(picker, entry.scopes ?? []);
    const save = el('button', 'btn btn-ghost btn-small', 'Save permissions');
    save.type = 'button';
    save.dataset.keyAction = 'save-perms';
    details.append(picker, save);
    row.append(details);
  }

  return row;
}

function renderKeys() {
  const list = $('key-list');
  list.replaceChildren();
  $('keys-count').textContent = state.keys.length
    ? `${state.keys.length} key${state.keys.length === 1 ? '' : 's'}`
    : '';
  $('keys-empty').hidden = state.keys.length > 0;
  for (const entry of state.keys) list.append(keyRow(entry));
}

/* --------------------------------------------------------------- settings --- */

function renderSettings() {
  const config = state.config;
  if (!config) return;

  const tokenState = $('token-state');
  if (config.hasToken) {
    tokenState.textContent = `Token saved (${config.tokenHint}). Paste a new one to replace it.`;
    tokenState.classList.add('ok');
  } else {
    tokenState.textContent = 'No token saved. Aegis cannot start without one.';
    tokenState.classList.remove('ok');
  }

  if (document.activeElement !== $('guild-input')) {
    $('guild-input').value = config.guildId ?? '';
  }
  $('autostart-input').checked = Boolean(config.autoStart);

  const linkedState = $('linked-state');
  if (linkedState) {
    linkedState.hidden = !state.linked;
    linkedState.textContent = state.linked
      ? 'You are a room member: controls you use are sent to the host PC and run on their bot.'
      : '';
  }
}

function renderInfo() {
  const info = state.info;
  if (!info) return;
  $('side-version').textContent = `${info.name} v${info.version}`;
  $('about-version').textContent = `${info.name} ${info.version} · Electron ${info.electron}`;
  $('about-data').textContent = info.dataDir;
  $('about-device').textContent = state.auth?.machine ?? '—';
  $('about-server').textContent = info.server ?? '—';
  $('about-encrypted').textContent = info.encrypted
    ? 'Encrypted with Windows DPAPI'
    : 'Stored as plain text (encryption unavailable)';
}

/* ----------------------------------------------------------------- updates --- */

function setUpdateState(text) {
  const node = $('update-state');
  if (node) node.textContent = text;
}

function renderUpdate() {
  const banner = $('update-banner');
  const update = state.update;
  if (!banner) return;
  if (!update || update.status === 'dismissed') {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  const install = $('update-install');
  const dismiss = $('update-dismiss');
  const version = update.release?.version ?? '';
  install.hidden = true;
  dismiss.hidden = false;
  install.textContent = 'Restart & update';

  if (update.status === 'found' || update.status === 'downloading') {
    $('update-title').textContent = `Update v${version} available`;
    $('update-note').textContent = `Downloading… ${update.percent ?? 0}%`;
  } else if (update.status === 'ready') {
    $('update-title').textContent = `Update v${version} ready`;
    $('update-note').textContent = 'Restart Aegis to install it. The bot reconnects in a few seconds.';
    install.hidden = false;
  } else if (update.status === 'installing') {
    $('update-title').textContent = `Installing v${version}`;
    $('update-note').textContent = 'Aegis is restarting with the new version…';
    dismiss.hidden = true;
  } else if (update.status === 'error') {
    $('update-title').textContent = 'Update failed';
    $('update-note').textContent = update.message || 'Try again.';
    install.textContent = 'Retry';
    install.hidden = false;
  }
}

function showUpdateOverlay(title, note, percent = 0) {
  const overlay = $('update-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  $('update-overlay-title').textContent = title;
  $('update-overlay-note').textContent = note;
  setOverlayProgress(percent);
}

function setOverlayProgress(percent) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  const bar = $('update-progress-bar');
  if (bar) bar.style.width = `${value}%`;
  const label = $('update-progress-label');
  if (label) label.textContent = `${value}%`;
}

function hideUpdateOverlay() {
  const overlay = $('update-overlay');
  if (overlay) overlay.hidden = true;
}

async function checkForUpdates(options = {}) {
  setUpdateState('Checking for updates…');
  if (options.install) {
    showUpdateOverlay('Checking for updates…', 'Contacting the Aegis update server.', 0);
  }
  try {
    const release = await api.checkUpdate();
    if (!release) {
      state.update = null;
      setUpdateState(
        `You're on the latest version${state.info?.version ? ` (v${state.info.version})` : ''}.`,
      );
      renderUpdate();
      if (options.install) {
        setOverlayProgress(100);
        showUpdateOverlay(
          'You are up to date',
          `Aegis v${state.info?.version ?? ''} is the latest version.`,
          100,
        );
        setTimeout(hideUpdateOverlay, 1400);
      }
      return;
    }

    state.update = { release, status: 'downloading', percent: 0 };
    renderUpdate();
    setUpdateState(`Downloading v${release.version}…`);
    if (options.install) {
      showUpdateOverlay(
        `Downloading v${release.version}…`,
        'The new version is downloading in the background.',
        0,
      );
    }
    await api.downloadUpdate(release);
    state.update.status = 'ready';
    setUpdateState(`v${release.version} is downloaded. Restart Aegis to install it.`);
    renderUpdate();
    if (options.install) {
      setOverlayProgress(100);
      await installDownloadedUpdate();
    }
  } catch (error) {
    const message = cleanError(error);
    if (state.update?.release) {
      state.update.status = 'error';
      state.update.message = message;
    }
    setUpdateState(message);
    renderUpdate();
    if (options.install) hideUpdateOverlay();
    toast(`Update failed: ${message}`, 'err');
  }
}

async function installDownloadedUpdate() {
  const update = state.update;
  if (!update?.release) return;
  if (update.status === 'error') {
    checkForUpdates({ install: true });
    return;
  }
  if (update.status !== 'ready') return;

  update.status = 'installing';
  renderUpdate();
  showUpdateOverlay(
    `Installing v${update.release.version}…`,
    'Aegis closes for a moment, swaps the files and starts again by itself.',
    100,
  );
  try {
    await api.installUpdate(update.release);
  } catch (error) {
    update.status = 'error';
    update.message = cleanError(error);
    renderUpdate();
    hideUpdateOverlay();
  }
}

/* ------------------------------------------------------------------- live --- */

function renderAll() {
  renderChrome();
  renderHero();
  renderStats();
  renderGuilds();
  renderAccess();
  renderFeeds();
  renderCrashes();
  renderMessages();
  renderSocial();
  renderSettings();
  renderInfo();
  renderRoom();
  renderLinkedBanner();
}

function setPage(page) {
  const roomPage = state.room ? 'overview' : 'room';
  if (!['room', 'settings', 'roles', 'tools'].includes(page) && !state.room) page = 'room';
  if (page === 'licenses' && !can('manageKeys')) page = roomPage;
  if (page === 'roles' && !can('manageBot')) page = roomPage;
  if (page === 'tools' && !can('manageBot')) page = roomPage;
  if (page === 'console' && (!can('useConsole') || state.linked)) page = roomPage;
  if (page === 'activity' && !can('viewLogs')) page = roomPage;

  state.page = page;
  for (const section of document.querySelectorAll('.page')) {
    section.classList.toggle('active', section.dataset.page === page);
  }
  for (const button of document.querySelectorAll('.nav-item')) {
    button.classList.toggle('active', button.dataset.goto === page);
  }
  const [title, subtitle] = PAGE_META[page] ?? PAGE_META.overview;
  $('page-title').textContent = title;
  $('page-sub').textContent = subtitle;

  if (page === 'console') $('console-input').focus();
  if (page === 'licenses') loadKeys();
  if (page === 'roles') loadRoles();
  if (page === 'tools') loadTools();
  if (page === 'room') {
    loadRooms();
    loadSocial();
  }
  if (page === 'messages') renderMessages();
}

/* --------------------------------------------------------------- messages --- */

function messageChannels() {
  const map = new Map();
  for (const message of state.messages) {
    const key = message.channelId ?? 'unknown';
    const current = map.get(key) ?? {
      id: key,
      name: message.channelName ?? 'unknown-channel',
      guildName: message.guildName ?? '',
      count: 0,
      last: 0,
    };
    current.count += 1;
    current.last = Math.max(current.last, message.createdAt ?? 0);
    map.set(key, current);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function renderMessages() {
  const channelList = $('message-channels');
  const list = $('message-list');
  if (!channelList || !list) return;

  const channels = messageChannels();
  if (state.messageChannel !== 'all' && !channels.some((channel) => channel.id === state.messageChannel)) {
    state.messageChannel = 'all';
  }

  const makeChannel = (label, id, count) => {
    const button = el('button', 'channel-button');
    button.type = 'button';
    button.classList.toggle('active', state.messageChannel === id);
    button.append(el('span', '', label), el('span', 'channel-count', String(count)));
    button.addEventListener('click', () => {
      state.messageChannel = id;
      renderMessages();
    });
    return button;
  };

  channelList.replaceChildren(makeChannel('All messages', 'all', state.messages.length));
  for (const channel of channels) {
    const button = makeChannel(`# ${channel.name}`, channel.id, channel.count);
    if (channel.guildName) button.title = `${channel.guildName} · #${channel.name}`;
    channelList.append(button);
  }

  const filtered =
    state.messageChannel === 'all'
      ? state.messages
      : state.messages.filter((message) => message.channelId === state.messageChannel);
  const intentWarning = $('message-intent-warning');
  if (intentWarning) {
    intentWarning.hidden = state.status?.messageContentEnabled !== false;
  }

  const current = channels.find((channel) => channel.id === state.messageChannel);
  $('message-title').textContent = current ? `# ${current.name}` : 'All messages';
  $('message-channel-note').textContent = `${filtered.length} message${filtered.length === 1 ? '' : 's'}`;
  $('message-count').textContent = state.messages.length ? `${state.messages.length} total` : '';

  list.replaceChildren();
  if (!filtered.length) {
    list.append(
      el(
        'div',
        'message-empty',
        state.messages.length
          ? 'No messages in this channel yet.'
          : 'No messages yet. Aegis records messages once it is started and has the Message Content intent.',
      ),
    );
    return;
  }

  for (const message of [...filtered].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
    const item = el('div', 'message-item');
    const head = el('div', 'message-head');
    const author = el('span', 'message-author', message.authorName ?? 'unknown');
    if (message.bot) author.textContent += ' · bot';
    head.append(author, el('span', 'message-channel', `#${message.channelName ?? 'unknown'}`));
    head.append(
      el(
        'span',
        'message-time',
        new Date(message.createdAt ?? Date.now()).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
      ),
    );
    const hidden =
      message.contentHidden ||
      (!message.content?.trim() && state.status?.messageContentEnabled === false);
    const body = message.content?.trim()
      ? message.content
      : hidden
        ? 'Text hidden by Discord — enable Message Content Intent and restart Aegis.'
        : message.attachments
          ? `(${message.attachments} attachment${message.attachments === 1 ? '' : 's'})`
          : '(no text)';
    item.append(head, el('div', hidden ? 'message-body message-hidden' : 'message-body', body));
    list.append(item);
  }
}

/* ----------------------------------------------------------------- social --- */

function socialAction(label, handler, className = 'btn btn-ghost btn-small') {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await handler();
    } catch (error) {
      toast(cleanError(error), 'err');
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function renderSocial() {
  const idNode = $('my-public-id');
  if (!idNode) return;
  const social = state.social;
  state.publicId = social?.me?.publicId ?? state.publicId ?? state.auth?.user?.publicId ?? '';
  idNode.textContent = state.publicId ? `#${state.publicId}` : '—';

  const inviteForm = $('room-invite-form');
  if (inviteForm) inviteForm.hidden = !state.room?.isHost;

  const friendsBox = $('friend-list');
  const requestsBox = $('social-requests');
  if (!friendsBox || !requestsBox) return;
  friendsBox.replaceChildren();
  requestsBox.replaceChildren();
  if (!social) return;

  const friends = social.friends ?? [];
  if (friends.length) {
    friendsBox.append(el('h3', '', 'Friends'));
    for (const friend of friends) {
      const row = el('div', 'social-row');
      const meta = el('div', 'social-row-meta');
      meta.append(
        el('span', 'social-row-name', friend.username ?? 'Unknown'),
        el('span', 'social-row-note', friend.publicId ? `#${friend.publicId}` : ''),
      );
      const actions = el('div', 'social-row-actions');
      if (state.room?.isHost) {
        actions.append(
          socialAction('Invite', async () => {
            await api.social.invite(state.room.id, friend.publicId);
            toast(`Invited ${friend.username} to ${state.room.name}.`);
          }),
        );
      }
      actions.append(
        socialAction('Remove', async () => {
          await api.social.removeFriend(friend.accountId ?? friend.id);
          await loadSocial();
          toast('Friend removed.');
        }),
      );
      row.append(meta, actions);
      friendsBox.append(row);
    }
  }

  const friendRequests = social.requests?.friends ?? [];
  if (friendRequests.length) {
    requestsBox.append(el('h3', '', 'Friend requests'));
    for (const request of friendRequests) {
      const row = el('div', 'social-row');
      const meta = el('div', 'social-row-meta');
      meta.append(
        el('span', 'social-row-name', request.from?.username ?? 'Unknown'),
        el('span', 'social-row-note', request.from?.publicId ? `#${request.from.publicId} wants to be friends` : 'wants to be friends'),
      );
      const actions = el('div', 'social-row-actions');
      actions.append(
        socialAction('Accept', async () => {
          await api.social.respondFriend(request.id, true);
          await loadSocial();
          toast('Friend request accepted.');
        }, 'btn btn-primary btn-small'),
        socialAction('Decline', async () => {
          await api.social.respondFriend(request.id, false);
          await loadSocial();
        }),
      );
      row.append(meta, actions);
      requestsBox.append(row);
    }
  }

  const invites = social.requests?.invites ?? [];
  if (invites.length) {
    requestsBox.append(el('h3', '', 'Room invites'));
    for (const invite of invites) {
      const row = el('div', 'social-row');
      const meta = el('div', 'social-row-meta');
      meta.append(
        el('span', 'social-row-name', invite.room?.name ?? 'Room'),
        el('span', 'social-row-note', `Invited by ${invite.from?.username ?? 'someone'}`),
      );
      const actions = el('div', 'social-row-actions');
      actions.append(
        socialAction('Join', async () => {
          const data = await api.social.respondInvite(invite.id, true);
          if (data.room) await enterRoom(data.room);
          else await loadSocial();
        }, 'btn btn-primary btn-small'),
        socialAction('Decline', async () => {
          await api.social.respondInvite(invite.id, false);
          await loadSocial();
        }),
      );
      row.append(meta, actions);
      requestsBox.append(row);
    }
  }

  const joinRequests = social.requests?.joins ?? [];
  if (joinRequests.length) {
    requestsBox.append(el('h3', '', 'Join requests'));
    for (const request of joinRequests) {
      const row = el('div', 'social-row');
      const meta = el('div', 'social-row-meta');
      meta.append(
        el('span', 'social-row-name', request.from?.username ?? 'Unknown'),
        el('span', 'social-row-note', request.from?.publicId ? `#${request.from.publicId} wants to join ${request.room?.name ?? 'your room'}` : 'wants to join your room'),
      );
      const actions = el('div', 'social-row-actions');
      actions.append(
        socialAction('Accept', async () => {
          await api.social.respondRoomRequest(request.id, true);
          await loadSocial();
          toast('They can now join the room.');
        }, 'btn btn-primary btn-small'),
        socialAction('Decline', async () => {
          await api.social.respondRoomRequest(request.id, false);
          await loadSocial();
        }),
      );
      row.append(meta, actions);
      requestsBox.append(row);
    }
  }

  const friendRooms = social.friendRooms ?? [];
  if (friendRooms.length) {
    requestsBox.append(el('h3', '', "Friends' rooms"));
    for (const room of friendRooms) {
      const row = el('div', 'social-row');
      const meta = el('div', 'social-row-meta');
      meta.append(
        el('span', 'social-row-name', room.name),
        el('span', 'social-row-note', `${room.host ? `${room.host}'s room` : 'Friend room'} · ${room.memberCount ?? 0} member(s)`),
      );
      const actions = el('div', 'social-row-actions');
      if (room.requested) {
        actions.append(el('span', 'social-row-note', 'Requested'));
      } else {
        actions.append(
          socialAction('Request to join', async () => {
            await api.social.requestRoom(room.id);
            await loadSocial();
            toast(`Asked ${room.host ?? 'the host'} to join ${room.name}.`);
          }),
        );
      }
      row.append(meta, actions);
      requestsBox.append(row);
    }
  }

  if (!friends.length && !friendRequests.length && !invites.length && !joinRequests.length && !friendRooms.length) {
    requestsBox.append(
      el('p', 'muted small', 'Add a friend with their ID, or invite someone into your room using theirs.'),
    );
  }
}

async function loadSocial() {
  if (!state.auth?.authenticated) return;
  try {
    const data = await api.social.get();
    state.social = {
      me: data.me ?? {},
      friends: data.friends ?? [],
      requests: {
        friends: (data.incoming ?? []).map((entry) => ({
          id: entry.id,
          from: {
            id: entry.accountId,
            username: entry.username,
            publicId: entry.publicId,
          },
        })),
        invites: (data.invites ?? []).map((entry) => ({
          id: entry.id,
          room: { id: entry.roomId, name: entry.roomName },
          from: { username: entry.from, publicId: entry.fromPublicId },
        })),
        joins: (data.joinRequests ?? []).map((entry) => ({
          id: entry.id,
          room: { id: entry.roomId, name: entry.roomName },
          from: { username: entry.username, publicId: entry.publicId },
        })),
      },
      friendRooms: data.friendRooms ?? [],
    };
    renderSocial();
    notifySocial();
  } catch {
    // Keep the last social snapshot when the server is briefly unreachable.
  }
}

function startSocialPolling() {
  if (state.socialTimer) return;
  state.socialTimer = setInterval(() => {
    if (document.hidden) return;
    if (state.auth?.authenticated) loadSocial();
  }, 180_000);
}

function stopSocialPolling() {
  if (state.socialTimer) {
    clearInterval(state.socialTimer);
    state.socialTimer = null;
  }
}

function socialPopup(key, title, text, actions) {
  if (state.socialSeen.has(key)) return;
  state.socialSeen.add(key);
  const container = $('social-popups');
  if (!container) return;

  const popup = el('div', 'social-popup');
  popup.dataset.socialKey = key;
  popup.append(el('h3', '', title), el('p', '', text));
  const row = el('div', 'social-popup-actions');
  for (const [label, handler, className] of actions) {
    row.append(
      socialAction(
        label,
        async () => {
          popup.remove();
          await handler();
        },
        className,
      ),
    );
  }
  const dismiss = socialAction(
    'Later',
    async () => {
      popup.remove();
    },
    'btn btn-ghost btn-small',
  );
  row.append(dismiss);
  popup.append(row);
  container.append(popup);
}

function notifySocial() {
  if (!state.social) return;
  const pendingKeys = new Set([
    ...(state.social.requests?.friends ?? []).map((entry) => `friend:${entry.id}`),
    ...(state.social.requests?.invites ?? []).map((entry) => `invite:${entry.id}`),
    ...(state.social.requests?.joins ?? []).map((entry) => `join:${entry.id}`),
  ]);
  for (const popup of document.querySelectorAll('.social-popup[data-social-key]')) {
    if (!pendingKeys.has(popup.dataset.socialKey)) popup.remove();
  }

  for (const request of state.social.requests?.friends ?? []) {
    socialPopup(
      `friend:${request.id}`,
      'Friend request',
      `${request.from?.username ?? 'Someone'}${request.from?.publicId ? ` (#${request.from.publicId})` : ''} wants to be friends.`,
      [
        [
          'Accept',
          async () => {
            await api.social.respondFriend(request.id, true);
            await loadSocial();
            toast('Friend request accepted.');
          },
          'btn btn-primary btn-small',
        ],
        [
          'Decline',
          async () => {
            await api.social.respondFriend(request.id, false);
            await loadSocial();
          },
          'btn btn-ghost btn-small',
        ],
      ],
    );
  }

  for (const invite of state.social.requests?.invites ?? []) {
    socialPopup(
      `invite:${invite.id}`,
      'Room invite',
      `${invite.from?.username ?? 'Someone'} invited you to ${invite.room?.name ?? 'their room'}.`,
      [
        [
          'Join room',
          async () => {
            const data = await api.social.respondInvite(invite.id, true);
            if (data.room) await enterRoom(data.room);
            else await loadSocial();
          },
          'btn btn-primary btn-small',
        ],
        [
          'Decline',
          async () => {
            await api.social.respondInvite(invite.id, false);
            await loadSocial();
          },
          'btn btn-ghost btn-small',
        ],
      ],
    );
  }

  for (const request of state.social.requests?.joins ?? []) {
    socialPopup(
      `join:${request.id}`,
      'Join request',
      `${request.from?.username ?? 'Someone'} wants to join ${request.room?.name ?? 'your room'}.`,
      [
        [
          'Accept',
          async () => {
            await api.social.respondRoomRequest(request.id, true);
            await loadSocial();
            toast('They can now join the room.');
          },
          'btn btn-primary btn-small',
        ],
        [
          'Decline',
          async () => {
            await api.social.respondRoomRequest(request.id, false);
            await loadSocial();
          },
          'btn btn-ghost btn-small',
        ],
      ],
    );
  }
}

/* ------------------------------------------------------------- room polling --- */

// Same idea as the linked console: fast while members come and go, slower when
// the lobby is quiet, and nothing at all while the window is hidden.
const ROOM_POLL_MS = 15_000;
const ROOM_POLL_MAX_MS = 180_000;

function stopRoomPolling() {
  if (state.roomTimer) {
    clearTimeout(state.roomTimer);
    state.roomTimer = null;
  }
}

function scheduleRoomPoll(delay = ROOM_POLL_MS) {
  stopRoomPolling();
  if (!state.room || state.linked) return;
  state.roomTimer = setTimeout(async () => {
    state.roomTimer = null;
    if (!state.auth?.authenticated || !state.room || state.linked) return;
    if (document.hidden) {
      scheduleRoomPoll(ROOM_POLL_MAX_MS);
      return;
    }
    let changed = false;
    try {
      const before = JSON.stringify(state.room.members ?? null);
      const room = await api.rooms.current();
      if (room) {
        state.room = room;
        changed = JSON.stringify(room.members ?? null) !== before;
        renderRoom();
        renderNavGate();
      }
    } catch {
      // The room may have been deleted; the next action surfaces it.
    }
    state.roomIdle = changed ? 0 : Math.min((state.roomIdle ?? 0) + 1, 4);
    scheduleRoomPoll(Math.min(ROOM_POLL_MS * 2 ** state.roomIdle, ROOM_POLL_MAX_MS));
  }, delay);
}

function startRoomPolling() {
  if (state.roomTimer || !state.room || state.linked) return;
  state.roomIdle = 0;
  scheduleRoomPoll(ROOM_POLL_MS);
}

// A hidden window skips its polls, so catch up the moment it is shown again.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.auth?.authenticated) return;
  if (state.linked) scheduleLinkedPoll(0);
  else if (state.room) scheduleRoomPoll(0);
  loadSocial();
});

function renderRoomMembers() {
  const box = $('room-members');
  if (!box) return;
  box.replaceChildren();
  const room = state.room;
  if (!room) return;
  const members = Array.isArray(room.members) ? room.members : [];
  if (!members.length) {
    box.append(el('p', 'muted small', 'The member list updates when the host app is open.'));
    return;
  }

  box.append(el('h3', '', 'In this room'));
  for (const member of members) {
    const row = el('div', 'room-member');
    const meta = el('div', 'room-member-meta');
    const creator = Boolean(member.isHost) || (member.publicId && member.publicId === room.hostPublicId);
    const mine = member.accountId === state.auth?.user?.id;
    meta.append(
      el('span', 'social-row-name', `${member.username ?? 'Unknown'}${mine ? ' (you)' : ''}`),
      el('span', 'badge', creator ? 'creator' : member.role ?? 'member'),
      el('span', 'room-member-id', member.publicId ? `#${member.publicId}` : ''),
    );
    const actions = el('div', 'social-row-actions');
    if (room.isHost && !mine && member.accountId) {
      actions.append(
        socialAction('Remove', async () => {
          await api.social.removeRoomMember(room.id, member.accountId);
          const current = await api.rooms.current();
          if (current) state.room = current;
          renderRoom();
          toast(`${member.username} was removed from the room.`);
        }),
      );
    }
    row.append(meta, actions);
    box.append(row);
  }
}

/* ------------------------------------------------------------------ rooms --- */

async function loadRooms() {
  if (!state.auth?.authenticated) return;
  try {
    const data = await api.rooms.list();
    state.rooms = data.rooms ?? [];
    state.availableRooms = data.available ?? [];
    $('room-status').textContent = '';
  } catch (error) {
    $('room-status').textContent = cleanError(error);
  }
  renderRoom();
}

function renderRoom() {
  const none = $('room-none');
  if (!none) return;
  const inRoom = Boolean(state.room);
  none.hidden = inRoom;
  $('room-active').hidden = !inRoom;
  $('room-create-form').hidden = !can('manageRooms');

  if (inRoom) {
    const room = state.room;
    const count = room.members?.length ?? room.memberCount ?? 1;
    $('room-name-title').textContent = room.name;
    $('room-role-badge').textContent = room.isHost ? 'creator' : 'member';
    $('room-meta').textContent = `Created by ${room.host ?? '—'}${room.hostPublicId ? ` #${room.hostPublicId}` : ''} · ${count} member${count === 1 ? '' : 's'}`;
    $('room-code-box').hidden = !room.code;
    $('room-code-value').textContent = room.code ?? '—';
    $('delete-room').hidden = !room.isHost;
    $('leave-room').hidden = Boolean(room.isHost);
    $('room-note').textContent = room.isHost
      ? 'You created this room. Everyone here can use the host controls while your app is open. Remove anyone you do not want.'
      : 'You are a room member, so you can use the host controls while their app is open.';
    renderRoomMembers();
    renderRoomSwitcher(state.rooms.filter((entry) => entry.id !== room.id));
    startRoomPolling();
    return;
  }

  stopRoomPolling();
  const memberBox = $('room-members');
  if (memberBox) memberBox.replaceChildren();

  renderRoomSwitcher([]);
  const openList = $('room-open-list');
  openList.replaceChildren();
  if (state.rooms.length) {
    openList.append(el('h3', '', 'Your rooms'));
    for (const joined of state.rooms) {
      const row = el('div', 'room-row');
      const meta = el('div', 'room-row-meta');
      meta.append(el('span', 'room-row-name', joined.name));
      meta.append(
        el(
          'span',
          'room-row-note',
          `${joined.isHost ? 'You host' : `Host: ${joined.host ?? '—'}`} · ${joined.memberCount ?? 0} member(s)`,
        ),
      );
      const button = el('button', 'btn btn-ghost btn-small', 'Open');
      button.type = 'button';
      button.dataset.roomSwitch = joined.id;
      row.append(meta, button);
      openList.append(row);
    }
  }

  const list = $('room-available');
  list.replaceChildren();
  if (!can('manageRooms')) {
    list.append(
      el(
        'p',
        'muted small',
        'Ask the host for their room code. A key with the Rooms permission can also create rooms and join any room without a code.',
      ),
    );
    return;
  }
  if (state.availableRooms.length === 0) return;

  list.append(el('h3', '', 'Join without a code'));
  for (const room of state.availableRooms) {
    const row = el('div', 'room-row');
    const meta = el('div', 'room-row-meta');
    meta.append(el('span', 'room-row-name', room.name));
    meta.append(
      el(
        'span',
        'room-row-note',
        `${room.host ? `Host: ${room.host} · ` : ''}${room.memberCount ?? 0} member(s)`,
      ),
    );
    const button = el('button', 'btn btn-ghost btn-small', 'Join');
    button.type = 'button';
    button.dataset.roomJoin = room.id;
    row.append(meta, button);
    list.append(row);
  }
}

function renderRoomSwitcher(rooms) {
  const list = $('room-switch-list');
  if (!list) return;
  list.replaceChildren();
  if (!rooms.length) return;
  list.append(el('h3', '', 'Your other rooms'));
  for (const room of rooms) {
    const row = el('div', 'room-row');
    const meta = el('div', 'room-row-meta');
    meta.append(el('span', 'room-row-name', room.name));
    meta.append(
      el(
        'span',
        'room-row-note',
        `${room.isHost ? 'You host' : `Host: ${room.host ?? '—'}`} · ${room.memberCount ?? 0} member(s)`,
      ),
    );
    const button = el('button', 'btn btn-ghost btn-small', 'Switch');
    button.type = 'button';
    button.dataset.roomSwitch = room.id;
    row.append(meta, button);
    list.append(row);
  }
}

async function enterRoom(room) {
  state.room = room;
  state.linked = !room.isHost;
  state.status = null;
  state.logs = [];
  state.messages = [];
  state.messageChannel = 'all';
  state.social = null;
  state.linkedAt = 0;
  state.linkedSignature = '';
  stopRoomPolling();
  renderNavGate();
  if (state.linked) startLinkedPolling();
  else stopLinkedPolling();
  await loadDashboard();
  await loadSocial();
  await loadRooms();
  setPage('overview');
  toast(state.linked ? `Linked to ${room.name}.` : `Room ${room.name} is live.`);
}

async function clearRoom() {
  state.room = null;
  state.linked = false;
  state.linkedSignature = '';
  state.linkedAt = 0;
  stopLinkedPolling();
  stopRoomPolling();
  state.status = null;
  state.logs = [];
  state.messages = [];
  renderNavGate();
  renderAll();
  await loadRooms();
  setPage('room');
}

/* ---------------------------------------------------------------- actions --- */

async function startBot() {
  if (state.busy) return;
  if (!state.room) {
    toast('Create or join a room before starting Aegis.', 'err');
    setPage('room');
    return;
  }
  if (!state.linked && !state.config?.hasToken) {
    toast('Save a bot token in Settings first.', 'err');
    setPage('settings');
    $('token-input').focus();
    return;
  }
  state.busy = true;
  renderChrome();
  try {
    state.status = await api.startBot();
    state.statusAt = Date.now();
    toast('Aegis is online.');
    renderAll();
  } catch (error) {
    toast(cleanError(error), 'err');
    await refreshStatus();
  } finally {
    state.busy = false;
    renderChrome();
  }
}

async function stopBot() {
  if (state.busy) return;
  state.busy = true;
  renderChrome();
  try {
    state.status = await api.stopBot();
    state.statusAt = Date.now();
    toast('Aegis stopped.');
    renderAll();
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    state.busy = false;
    renderChrome();
  }
}

async function deployCommands() {
  state.busy = true;
  renderChrome();
  try {
    const result = await api.deployCommands(state.config?.guildId ?? '');
    if (typeof result === 'string') toast(result);
    else {
      toast(
        `Registered ${result.count} commands ${result.scope === 'guild' ? 'on your server' : 'globally'}.${
          result.removed?.length ? ` Removed ${result.removed.length} duplicate(s).` : ''
        }`,
      );
    }
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    state.busy = false;
    renderChrome();
  }
}

async function refreshStatus() {
  if (!state.auth?.authenticated) return;
  if (state.linked) {
    await refreshLinkedConsole();
    return;
  }
  try {
    state.status = await api.getStatus();
    state.statusAt = Date.now();
    renderAll();
  } catch (error) {
    toast(cleanError(error), 'err');
  }
}

/* ------------------------------------------------------------------ roles --- */

function roleColour(color) {
  return `#${Number(color ?? 0).toString(16).padStart(6, '0')}`;
}

function roleButton(label, title, onClick, className = 'btn btn-ghost btn-small') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

function renderRoles() {
  const data = state.roles;
  const list = $('role-list');
  const empty = $('roles-empty');
  list.replaceChildren();
  if (!data) return;

  const select = $('roles-guild');
  const signature = `${data.guildId}:${(data.guilds ?? []).map((guild) => guild.id).join(',')}`;
  if (select.dataset.signature !== signature) {
    select.replaceChildren(
      ...(data.guilds ?? []).map((guild) => {
        const option = document.createElement('option');
        option.value = guild.id;
        option.textContent = guild.name;
        option.selected = guild.id === data.guildId;
        return option;
      }),
    );
    select.dataset.signature = signature;
  }
  select.hidden = (data.guilds ?? []).length < 2;

  $('roles-note').textContent = data.guildId
    ? `${data.roles.length} role${data.roles.length === 1 ? '' : 's'}${data.canManage ? '' : ' · read-only'}`
    : '';

  if (!data.guildId) {
    empty.hidden = false;
    empty.textContent = 'The bot has not reported a server yet. Start Aegis, then press Add all.';
    return;
  }
  if (!data.roles.length) {
    empty.hidden = false;
    empty.textContent = data.hostOnline
      ? 'No roles loaded yet. Press Add all to read them from Discord.'
      : 'The host runner is offline, so Discord cannot be reached right now.';
    return;
  }
  empty.hidden = true;

  for (const role of data.roles) {
    const row = document.createElement('div');
    row.className = 'role-row';

    const head = document.createElement('div');
    head.className = 'role-head';
    const dot = document.createElement('span');
    dot.className = 'role-dot';
    dot.style.background = roleColour(role.color);
    const name = document.createElement('span');
    name.className = 'role-name';
    name.textContent = role.name;
    const meta = document.createElement('span');
    meta.className = 'role-meta';
    const bits = [roleColour(role.color), `${role.memberCount ?? 0} member(s)`];
    if (role.hoist) bits.push('separate');
    if (role.mentionable) bits.push('mentionable');
    if (role.isEveryone) bits.push('everyone');
    if (role.managed) bits.push('managed');
    meta.textContent = bits.join(' · ');
    head.append(dot, name, meta);
    row.append(head);

    if (role.canManage) {
      const actions = document.createElement('div');
      actions.className = 'role-actions';
      actions.append(
        roleButton('↑', 'Move up', () => moveRole(role, 'up')),
        roleButton('↓', 'Move down', () => moveRole(role, 'down')),
        roleButton('Edit', 'Edit this role', () => openRoleForm(role)),
        roleButton('Delete', 'Delete this role', () => deleteRole(role), 'btn btn-ghost btn-small remove'),
      );
      row.append(actions);
    }
    list.append(row);
  }
}

async function loadRoles(guildId) {
  if (!can('manageBot')) return;
  try {
    state.roles = await api.roles.list(guildId ?? state.roles?.guildId ?? '');
    renderRoles();
  } catch (error) {
    $('roles-empty').hidden = false;
    $('roles-empty').textContent = cleanError(error);
    $('role-list').replaceChildren();
  }
}

async function runRoleTask(payload) {
  const { id } = await api.roles.action({ ...payload, guildId: state.roles?.guildId });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const task = await api.roles.task(id).catch(() => null);
    if (!task) continue;
    if (task.status === 'done') return task.result;
    if (task.status === 'error') throw new Error(task.result?.error || 'That change failed in Discord.');
  }
  throw new Error('The host runner did not answer. Check that it is online.');
}

function openRoleForm(role) {
  state.roleEdit = role?.id ?? null;
  $('role-form').hidden = false;
  $('role-name').value = role?.name ?? '';
  $('role-color').value = role && role.color ? role.hex : '';
  $('role-hoist').checked = Boolean(role?.hoist);
  $('role-mentionable').checked = Boolean(role?.mentionable);
  $('role-save').textContent = role ? 'Save changes' : 'Create role';
  $('role-name').focus();
}

async function saveRole() {
  const name = $('role-name').value.trim();
  if (!name) {
    toast('Give the role a name.', 'err');
    return;
  }
  const color = $('role-color').value.trim();
  if (color && !/^#?[0-9a-f]{6}$/i.test(color)) {
    toast('The colour should look like #5865f2.', 'err');
    return;
  }
  const editing = Boolean(state.roleEdit);
  const button = $('role-save');
  button.disabled = true;
  try {
    await runRoleTask({
      action: editing ? 'update' : 'create',
      ...(editing ? { roleId: state.roleEdit } : {}),
      name,
      color: color || null,
      hoist: $('role-hoist').checked,
      mentionable: $('role-mentionable').checked,
    });
    $('role-form').hidden = true;
    state.roleEdit = null;
    toast(editing ? 'Role updated.' : 'Role created.');
    await loadRoles();
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
}

async function moveRole(role, direction) {
  try {
    await runRoleTask({ action: 'move', roleId: role.id, direction });
    await loadRoles();
  } catch (error) {
    toast(cleanError(error), 'err');
  }
}

async function deleteRole(role) {
  if (!window.confirm(`Delete the role "${role.name}"? Members lose it immediately.`)) return;
  try {
    await runRoleTask({ action: 'delete', roleId: role.id });
    toast('Role deleted.');
    await loadRoles();
  } catch (error) {
    toast(cleanError(error), 'err');
  }
}

async function addAllRoles() {
  const button = $('roles-add-all');
  button.disabled = true;
  try {
    await runRoleTask({ action: 'refresh' });
    await loadRoles();
    toast(`All ${state.roles?.roles.length ?? 0} roles loaded.`);
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------ server tools --- */

function toolEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toolButton(label, onClick, className = 'btn btn-ghost btn-small') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await onClick();
    } catch (error) {
      toast(cleanError(error), 'err');
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function fillToolSelect(node, placeholder, items, selected) {
  const signature = `${placeholder}:${items.map((item) => `${item.id}=${item.name}`).join(',')}`;
  if (node.dataset.signature === signature) {
    node.value = selected ?? '';
    return;
  }
  node.replaceChildren();
  if (placeholder !== null) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = placeholder;
    node.append(option);
  }
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    node.append(option);
  }
  node.dataset.signature = signature;
  node.value = selected ?? '';
}

async function loadTools(guildId) {
  if (!can('manageBot')) return;
  try {
    state.tools = await api.tools.state(guildId ?? state.tools?.guildId ?? '');
    renderTools();
  } catch (error) {
    $('tools-note').textContent = cleanError(error);
  }
}

async function runToolTask(action, payload = {}, { reload = true } = {}) {
  const { id } = await api.tools.action({ action, guildId: state.tools?.guildId, payload });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const task = await api.tools.task(id).catch(() => null);
    if (!task) continue;
    if (task.status === 'done') {
      if (reload) await loadTools();
      return task.result;
    }
    if (task.status === 'error') throw new Error(task.result?.error || 'That action failed in Discord.');
  }
  throw new Error('The host runner did not answer. Check that it is online.');
}

function renderTools() {
  const data = state.tools;
  if (!data) return;
  const features = data.features ?? {};
  const guilds = data.guilds ?? [];
  const select = $('tools-guild');
  const signature = `${data.guildId}:${guilds.map((guild) => guild.id).join(',')}`;
  if (select.dataset.signature !== signature) {
    select.replaceChildren(
      ...guilds.map((guild) => {
        const option = document.createElement('option');
        option.value = guild.id;
        option.textContent = guild.name;
        option.selected = guild.id === data.guildId;
        return option;
      }),
    );
    select.dataset.signature = signature;
  }
  select.hidden = guilds.length < 2;
  $('tools-note').textContent = data.guildName
    ? `${data.guildName} · ${data.hostOnline ? 'runner online' : 'runner offline'}${data.updatedAt ? ` · ${new Date(data.updatedAt).toLocaleTimeString()}` : ''}`
    : 'The bot has not reported a server yet.';

  const roles = features.roles ?? [];
  const channels = features.channels ?? [];
  const textChannels = channels.filter((channel) => channel.type === 0);
  fillToolSelect($('panic-role'), 'No quarantine role', roles, features.panic?.quarantineRoleId ?? '');
  fillToolSelect($('guard-channel'), 'Moderation log channel', textChannels, features.guard?.channelId ?? '');
  fillToolSelect($('shop-role'), 'Choose a role', roles);
  fillToolSelect($('event-channel'), 'Event channel', textChannels);

  renderPanicTool(features);
  renderGuardTool(features);
  renderDoctorTool(features);
  renderCoinsTool(features);
  renderEventsTool(features);
  renderStatsTool(features);
  $('copilot-hint').textContent = features.ai
    ? 'Describe a change, review the plan, then apply it.'
    : 'AI key not set on the host runner, so the copilot only understands simple requests (categories, channels, roles, panic mode, stat counters).';
}

function renderPanicTool(features) {
  const panic = features.panic ?? {};
  const node = $('panic-state');
  node.textContent = panic.active
    ? `LOCKED since ${new Date(panic.startedAt).toLocaleTimeString()} by ${panic.by ?? 'dashboard'} · ${panic.channels} channel(s)${panic.quarantined ? ` · ${panic.quarantined} quarantined` : ''}`
    : panic.endedAt
      ? `Off · last used ${new Date(panic.endedAt).toLocaleString()}`
      : 'Off · ready';
  node.classList.toggle('danger', Boolean(panic.active));
  $('panic-window').value = Math.round((panic.joinWindowMs ?? 3_600_000) / 60_000);
  const list = $('panic-timeline');
  list.replaceChildren();
  const quarantine = panic.quarantineReport;
  if (quarantine?.targets !== undefined) {
    const summary = toolEl('div', `tool-item ${quarantine.incomplete || quarantine.failed ? 'danger' : ''}`);
    const body = toolEl('div', 'tool-body');
    body.append(
      toolEl(
        'strong',
        '',
        `Quarantine: ${quarantine.quarantined} of ${quarantine.targets} recent join(s)${quarantine.failed ? ` · ${quarantine.failed} failed` : ''}`,
      ),
    );
    if (quarantine.note) body.append(toolEl('div', 'muted small', quarantine.note));
    summary.append(body);
    list.append(summary);
  }
  for (const entry of [...(panic.timeline ?? [])].reverse()) {
    list.append(toolEl('div', 'tool-item', `${new Date(entry.at).toLocaleTimeString()} — ${entry.text}`));
  }
  for (const failure of panic.failed ?? []) {
    list.append(toolEl('div', 'tool-item danger', failure));
  }
}

function renderGuardTool(features) {
  const guard = features.guard ?? {};
  $('guard-enabled').checked = Boolean(guard.enabled);
  $('guard-threshold').value = guard.threshold ?? 3;
  $('guard-window').value = Math.round((guard.windowMs ?? 60_000) / 1000);
  $('guard-state').textContent = guard.enabled
    ? `On · ${guard.threshold} actions in ${Math.round(guard.windowMs / 1000)}s · ${(guard.trustedRoles ?? []).length} trusted role(s)`
    : 'Off · destructive staff actions are not watched';
  $('guard-state').classList.toggle('danger', Boolean(guard.enabled));
  const list = $('guard-incidents');
  list.replaceChildren();
  if (!(guard.incidents ?? []).length) {
    list.append(toolEl('div', 'tool-item', 'No incidents recorded.'));
    return;
  }
  for (const incident of guard.incidents) {
    const row = toolEl('div', 'tool-item');
    row.append(toolEl('span', '', `${new Date(incident.at).toLocaleString()} — ${incident.actorName} did ${incident.count}× ${incident.label}`));
    row.append(toolEl('span', 'tool-badge', incident.removed?.length ? `stripped ${incident.removed.length} role(s)` : incident.note || 'no roles removed'));
    list.append(row);
  }
}

function renderDoctorTool(features) {
  const doctor = features.doctor ?? {};
  $('doctor-state').textContent = doctor.lastRunAt
    ? `Health ${doctor.score}/100 (${doctor.grade}) · last audit ${new Date(doctor.lastRunAt).toLocaleString()}`
    : 'No audit yet.';
  const list = $('doctor-checks');
  list.replaceChildren();
  if (!doctor.lastRunAt) {
    list.append(toolEl('div', 'tool-item', 'Run an audit to check permissions, leaks and dead channels.'));
    return;
  }
  if (!(doctor.checks ?? []).length) {
    list.append(toolEl('div', 'tool-item', 'Everything looks healthy.'));
    return;
  }
  for (const check of doctor.checks) {
    const row = toolEl('div', `tool-item ${check.severity === 'high' ? 'danger' : ''}`);
    const body = toolEl('div', 'tool-body');
    body.append(toolEl('strong', '', check.title));
    body.append(toolEl('div', 'muted small', check.detail));
    if (check.samples?.length) body.append(toolEl('div', 'muted small', check.samples.slice(0, 5).join(', ')));
    row.append(body);
    if (check.fix) {
      row.append(
        toolButton('Fix', async () => {
          await runToolTask('doctor_fix', { kind: check.fix });
          toast('Fix applied.');
        }, 'btn btn-ghost btn-small'),
      );
    }
    list.append(row);
  }
}

function renderCoinsTool(features) {
  const economy = features.economy ?? {};
  $('coins-enabled').checked = economy.enabled !== false;
  $('coins-message').value = economy.perMessage ?? 3;
  $('coins-voice').value = economy.perVoiceMinute ?? 2;
  $('coins-cooldown').value = economy.cooldownSec ?? 45;

  const shop = $('shop-items');
  shop.replaceChildren();
  if (!(economy.items ?? []).length) shop.append(toolEl('div', 'tool-item', 'The shop is empty.'));
  for (const item of economy.items ?? []) {
    const row = toolEl('div', 'tool-item');
    const name = toolEl('input', 'tool-inline-input');
    name.value = item.name;
    name.maxLength = 80;
    const price = toolEl('input', 'tool-inline-number');
    price.type = 'number';
    price.min = '0';
    price.value = item.price;
    const stock = toolEl('input', 'tool-inline-number');
    stock.type = 'number';
    stock.min = '0';
    stock.value = item.stock ?? 0;
    const label = toolEl('span', 'muted small', 'coins / stock');
    row.append(name, price, label, stock);
    row.append(
      toolButton('Save', async () => {
        await runToolTask('shop_save', { itemId: item.id, roleId: item.roleId, name: name.value, price: price.value, stock: stock.value });
        toast('Reward saved.');
      }),
      toolButton('Remove', async () => {
        await runToolTask('shop_delete', { itemId: item.id });
        toast('Reward removed.');
      }, 'btn btn-ghost btn-small remove'),
    );
    shop.append(row);
  }

  const top = $('coins-top');
  top.replaceChildren();
  if (!(economy.top ?? []).length) top.append(toolEl('div', 'tool-item', 'Nobody has coins yet.'));
  for (const row of economy.top ?? []) {
    top.append(toolEl('div', 'tool-item', `${row.userId} — ${row.coins} coins`));
  }
}

function renderEventsTool(features) {
  const list = $('event-list');
  list.replaceChildren();
  const items = features.events?.items ?? [];
  if (!items.length) {
    list.append(toolEl('div', 'tool-item', 'No events yet.'));
    return;
  }
  for (const item of items) {
    const row = toolEl('div', 'tool-item');
    const body = toolEl('div', 'tool-body');
    body.append(toolEl('strong', '', item.title));
    body.append(
      toolEl(
        'div',
        'muted small',
        `${new Date(item.startsAt).toLocaleString()} · ${item.going} going${item.waitlist ? ` · ${item.waitlist} waitlist` : ''} · ${item.status}`,
      ),
    );
    row.append(body);
    if (item.status !== 'cancelled') {
      row.append(
        toolButton('Cancel', async () => {
          await runToolTask('event_cancel', { eventId: item.id });
          toast('Event cancelled.');
        }, 'btn btn-ghost btn-small remove'),
      );
    }
    list.append(row);
  }
}

function renderStatsTool(features) {
  const stats = features.stats ?? {};
  $('stats-state').textContent = stats.enabled
    ? `On · ${Object.keys(stats.channels ?? {}).length} counter(s) · refreshed ${stats.lastRunAt ? new Date(stats.lastRunAt).toLocaleTimeString() : 'never'}`
    : 'Off · no counter channels';
  const list = $('stats-list');
  list.replaceChildren();
  for (const name of Object.values(stats.lastNames ?? {})) list.append(toolEl('div', 'tool-item', name));
}

/* ---------------------------------------------------------------- wiring --- */

$('firstrun-continue').addEventListener('click', () => {
  state.authView = 'register';
  $('reg-key').value = state.auth?.ownerKey ?? '';
  renderAuth(state.auth ?? {});
  $('reg-username').focus();
});

$('copy-owner-key').addEventListener('click', async () => {
  await api.copyText(state.auth?.ownerKey ?? '');
  toast('Owner key copied.');
});

$('go-register').addEventListener('click', () => {
  state.authView = 'register';
  renderAuth(state.auth ?? {});
});

$('go-login').addEventListener('click', () => {
  state.authView = 'login';
  renderAuth(state.auth ?? {});
});

$('toggle-server').addEventListener('click', () => {
  const box = $('auth-server-edit');
  box.hidden = !box.hidden;
  if (!box.hidden) {
    $('server-url').value = state.auth?.server ?? '';
    $('server-url').focus();
  }
});

async function saveServer() {
  const value = $('server-url').value.trim();
  if (!value) {
    showAuthError('Enter your server address, for example http://your-host:14651');
    return;
  }
  try {
    const status = await api.auth.setServer(value);
    state.auth = status;
    $('auth-server-edit').hidden = true;
    $('toggle-server').hidden = false;
    renderAuth(status);
    toast('Server address saved.');
  } catch (error) {
    showAuthError(error?.message || 'That server address could not be saved.');
  }
}

$('save-server').addEventListener('click', saveServer);
$('server-url').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveServer();
  }
});

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearAuthError();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const authState = await api.auth.login({
      username: $('login-username').value,
      password: $('login-password').value,
    });
    $('login-password').value = '';
    state.authView = 'login';
    await applyAuth(authState);
  } catch (error) {
    showAuthError(cleanError(error));
  } finally {
    button.disabled = false;
  }
});

$('register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearAuthError();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const authState = await api.auth.register({
      username: $('reg-username').value,
      password: $('reg-password').value,
      key: $('reg-key').value,
    });
    $('reg-password').value = '';
    $('reg-key').value = '';
    state.authView = 'login';
    await applyAuth(authState);
  } catch (error) {
    showAuthError(cleanError(error));
  } finally {
    button.disabled = false;
  }
});

$('auto-login').addEventListener('click', async () => {
  clearAuthError();
  try {
    const authState = await api.auth.autoLogin();
    await applyAuth(authState);
  } catch (error) {
    showAuthError(cleanError(error));
  }
});

async function signInWithDiscord() {
  clearAuthError();
  const buttons = [$('discord-login')].filter(Boolean);
  buttons.forEach((button) => (button.disabled = true));
  try {
    const authState = await api.auth.startDiscordLogin();
    state.authView = 'login';
    await applyAuth(authState);
    toast('Discord linked.');
  } catch (error) {
    showAuthError(cleanError(error));
  } finally {
    buttons.forEach((button) => (button.disabled = false));
  }
}

$('discord-login')?.addEventListener('click', signInWithDiscord);
$('link-discord-account')?.addEventListener('click', signInWithDiscord);
$('unlink-discord-account')?.addEventListener('click', async () => {
  try {
    const authState = await api.auth.unlinkDiscord();
    await applyAuth(authState);
    toast('Discord unlinked.');
  } catch (error) {
    toast(cleanError(error), 'err');
  }
});
$('lock-btn').addEventListener('click', async () => {
  try {
    const authState = await api.auth.lock();
    state.status = null;
    state.authView = 'login';
    await applyAuth(authState);
    toast('Panel locked. Use auto login to continue.');
  } catch (error) {
    toast(cleanError(error), 'err');
  }
});

$('logout-btn').addEventListener('click', async () => {
  try {
    const authState = await api.auth.logout();
    state.logs = [];
    state.consoleLines = [];
    state.consoleSeeded = false;
    state.status = null;
    state.room = null;
    state.rooms = [];
    state.availableRooms = [];
    state.linked = false;
    stopLinkedPolling();
    state.authView = 'login';
    await applyAuth(authState);
    toast('Signed out.');
  } catch (error) {
    toast(cleanError(error), 'err');
  }
});

$('top-start').addEventListener('click', () => {
  if (state.status?.running) stopBot();
  else startBot();
});
$('new-dashboard-token')?.addEventListener('click', async () => {
  const button = $('new-dashboard-token');
  button.disabled = true;
  try {
    const data = await api.auth.createDashboardToken('Web dashboard');
    $('dashboard-token-box').hidden = false;
    $('dashboard-token-value').textContent = data.token;
    toast('Dashboard token created. Copy it into the web dashboard.');
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
  }
});

$('copy-dashboard-token')?.addEventListener('click', () => {
  const value = $('dashboard-token-value').textContent;
  if (value && value !== '—') api.copyText(value);
});

$('open-dashboard')?.addEventListener('click', () => {
  const server = state.auth?.server || state.info?.server;
  if (server) api.openExternal(server);
});

$('hero-start').addEventListener('click', startBot);
$('hero-stop').addEventListener('click', stopBot);
$('hero-deploy').addEventListener('click', deployCommands);
$('hero-invite').addEventListener('click', () => {
  const url = $('hero-invite').dataset.invite;
  if (url) api.openExternal(url);
});

$('roles-guild').addEventListener('change', () => loadRoles($('roles-guild').value));
$('roles-add-all').addEventListener('click', addAllRoles);
$('roles-new').addEventListener('click', () => openRoleForm(null));
$('role-save').addEventListener('click', saveRole);
$('role-cancel').addEventListener('click', () => {
  $('role-form').hidden = true;
  state.roleEdit = null;
});

/* ------------------------------------------------------------ tool wiring --- */

function toolTab(name) {
  for (const tab of document.querySelectorAll('.tool-tab')) {
    tab.classList.toggle('active', tab.dataset.tool === name);
  }
  for (const panel of document.querySelectorAll('[data-tool-panel]')) {
    panel.classList.toggle('active', panel.dataset.toolPanel === name);
  }
}

for (const tab of document.querySelectorAll('.tool-tab')) {
  tab.addEventListener('click', () => toolTab(tab.dataset.tool));
}
$('tools-guild').addEventListener('change', () => loadTools($('tools-guild').value));

$('panic-on').addEventListener('click', async () => {
  const button = $('panic-on');
  button.disabled = true;
  try {
    const minutes = Math.max(1, Number($('panic-window').value) || 60);
    await runToolTask('panic_on', {
      reason: $('panic-reason').value.trim(),
      quarantineRoleId: $('panic-role').value || null,
      windowMs: minutes * 60_000,
    });
    toast('Panic mode is on.');
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
});

$('panic-off').addEventListener('click', async () => {
  const button = $('panic-off');
  button.disabled = true;
  try {
    await runToolTask('panic_off', {});
    toast('Server restored.');
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
});

$('guard-save').addEventListener('click', async () => {
  const button = $('guard-save');
  button.disabled = true;
  try {
    await runToolTask('guard_update', {
      enabled: $('guard-enabled').checked,
      threshold: Number($('guard-threshold').value) || 3,
      windowMs: (Number($('guard-window').value) || 60) * 1000,
      channelId: $('guard-channel').value || null,
    });
    toast('Guard settings saved.');
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
});

$('doctor-run').addEventListener('click', async () => {
  const button = $('doctor-run');
  button.disabled = true;
  try {
    await runToolTask('doctor_run', {});
    toast('Audit complete.');
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
});

$('coins-save').addEventListener('click', async () => {
  const button = $('coins-save');
  button.disabled = true;
  try {
    await runToolTask('economy_update', {
      enabled: $('coins-enabled').checked,
      perMessage: Number($('coins-message').value) || 0,
      perVoiceMinute: Number($('coins-voice').value) || 0,
      cooldownSec: Number($('coins-cooldown').value) || 0,
    });
    toast('Coin settings saved.');
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
});

$('shop-add').addEventListener('click', async () => {
  const button = $('shop-add');
  const roleId = $('shop-role').value;
  if (!roleId) {
    toast('Choose a role first.', 'err');
    return;
  }
  button.disabled = true;
  try {
    await runToolTask('shop_save', {
      roleId,
      name: $('shop-name').value.trim(),
      price: Number($('shop-price').value) || 0,
      stock: Number($('shop-stock').value) || 0,
    });
    $('shop-name').value = '';
    toast('Reward added.');
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
});

$('coins-give').addEventListener('click', async () => {
  const button = $('coins-give');
  const userId = $('coins-user').value.trim();
  if (!/^\d{17,20}$/.test(userId)) {
    toast('Paste a Discord member ID.', 'err');
    return;
  }
  button.disabled = true;
  try {
    await runToolTask('coins_give', { userId, amount: Number($('coins-amount').value) || 1 });
    $('coins-user').value = '';
    toast('Coins added.');
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
});

$('event-create').addEventListener('click', async () => {
  const button = $('event-create');
  const title = $('event-title').value.trim();
  const channelId = $('event-channel').value;
  if (!title || !channelId) {
    toast('Add an event title and pick a channel.', 'err');
    return;
  }
  button.disabled = true;
  try {
    await runToolTask('event_create', {
      title,
      channelId,
      startsIn: $('event-starts').value.trim() || '1h',
      capacity: Number($('event-capacity').value) || 0,
    });
    $('event-title').value = '';
    toast('Event posted in Discord.');
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
});

$('stats-setup').addEventListener('click', async () => {
  const button = $('stats-setup');
  button.disabled = true;
  try {
    await runToolTask('stats_setup', { categoryName: $('stats-category').value.trim() || '📊 Server Stats' });
    toast('Counter channels created.');
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
});

$('stats-off').addEventListener('click', async () => {
  const button = $('stats-off');
  button.disabled = true;
  try {
    await runToolTask('stats_off', {});
    toast('Counter channels removed.');
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
});

function copilotStepLabel(step) {
  if (step.op === 'create_category') return `Create category ${step.name}`;
  if (step.op === 'create_text') return `Create text channel #${step.name}${step.category ? ` in ${step.category}` : ''}`;
  if (step.op === 'create_voice') return `Create voice channel ${step.name}${step.category ? ` in ${step.category}` : ''}`;
  if (step.op === 'create_role') return `Create role ${step.name}`;
  if (step.op === 'slowmode') return `Slowmode on ${step.channel || 'a channel'} → ${step.seconds}s`;
  if (step.op === 'post_message') return `Post a message in ${step.channel || 'the first channel'}`;
  if (step.op === 'panic') return step.on ? 'Turn on panic mode' : 'Turn off panic mode';
  return 'Create the stat channels';
}

$('copilot-plan').addEventListener('click', async () => {
  const button = $('copilot-plan');
  const request = $('copilot-request').value.trim();
  if (!request) {
    toast('Describe what you want first.', 'err');
    return;
  }
  button.disabled = true;
  try {
    const result = await runToolTask('copilot_plan', { request }, { reload: false });
    state.toolPlan = result?.data?.result ?? null;
    const plan = state.toolPlan?.steps ? state.toolPlan : null;
    const list = $('copilot-output');
    list.replaceChildren();
    if (!plan || !plan.steps.length) {
      list.append(toolEl('div', 'tool-item', state.toolPlan?.summary || 'The copilot could not turn that into changes.'));
      $('copilot-apply').hidden = true;
      return;
    }
    list.append(toolEl('div', 'tool-item', plan.summary));
    plan.steps.forEach((step, index) => list.append(toolEl('div', 'tool-item', `${index + 1}. ${copilotStepLabel(step)}`)));
    $('copilot-apply').hidden = false;
    $('copilot-apply').dataset.plan = JSON.stringify(plan);
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
});

$('copilot-apply').addEventListener('click', async () => {
  const button = $('copilot-apply');
  let plan = null;
  try {
    plan = JSON.parse(button.dataset.plan || 'null');
  } catch {
    plan = state.toolPlan;
  }
  if (!plan) return;
  button.disabled = true;
  try {
    const result = await runToolTask('copilot_apply', { plan });
    const steps = result?.data?.result?.steps ?? [];
    const list = $('copilot-output');
    list.replaceChildren();
    for (const step of steps) {
      list.append(toolEl('div', `tool-item ${step.ok ? '' : 'danger'}`, `${step.ok ? '✓' : '✕'} ${step.detail}`));
    }
    $('copilot-apply').hidden = true;
    toast('Plan applied.');
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
});

for (const button of document.querySelectorAll('[data-goto]')) {
  button.addEventListener('click', () => setPage(button.dataset.goto));
}

$('room-create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('room-name').value.trim();
  if (name.length < 2) {
    toast('Give the room a name first.', 'err');
    return;
  }
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const room = await api.rooms.create(name);
    $('room-name').value = '';
    await enterRoom(room);
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
});

$('room-join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('room-code').value.trim();
  if (!code) {
    toast('Enter the room code first.', 'err');
    return;
  }
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const room = await api.rooms.joinCode(code);
    $('room-code').value = '';
    await enterRoom(room);
  } catch (error) {
    toast(cleanError(error), 'err');
  } finally {
    button.disabled = false;
  }
});

$('copy-room-code').addEventListener('click', async () => {
  if (!state.room?.code) return;
  await api.copyText(state.room.code);
  toast('Room code copied — send it to your friends.');
});

$('copy-public-id').addEventListener('click', async () => {
  if (!state.publicId) {
    toast('Your ID is still loading.', 'err');
    return;
  }
  await api.copyText(state.publicId);
  toast('Your app ID was copied.');
});

$('room-invite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.room?.isHost) {
    toast('Only the room creator can invite people.', 'err');
    return;
  }
  const input = $('invite-id');
  const id = input.value.trim().replace(/^#/, '').toUpperCase();
  if (!id) {
    toast('Enter the app ID to invite.', 'err');
    return;
  }
  try {
    await api.social.invite(state.room.id, id);
    input.value = '';
    await loadSocial();
    toast('Room invite sent.');
  } catch (error) {
    toast(cleanError(error), 'err');
  }
});

$('friend-add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('friend-id');
  const id = input.value.trim().replace(/^#/, '').toUpperCase();
  if (!id) {
    toast('Enter your friend\'s app ID.', 'err');
    return;
  }
  try {
    await api.social.addFriend(id);
    input.value = '';
    await loadSocial();
    toast('Friend request sent.');
  } catch (error) {
    toast(cleanError(error), 'err');
  }
});

$('leave-room').addEventListener('click', async () => {
  if (!state.room || !window.confirm(`Leave ${state.room.name}?`)) return;
  try {
    await api.rooms.leave(state.room.id);
    await clearRoom();
    toast('Left the room.');
  } catch (error) {
    toast(cleanError(error), 'err');
  }
});

$('delete-room').addEventListener('click', async () => {
  if (!state.room || !window.confirm(`Delete ${state.room.name} for everyone?`)) return;
  try {
    await api.rooms.remove(state.room.id);
    await clearRoom();
    toast('Room deleted.');
  } catch (error) {
    toast(cleanError(error), 'err');
  }
});

document.addEventListener('click', async (event) => {
  const join = event.target.closest('[data-room-join]');
  if (join) {
    join.disabled = true;
    try {
      const room = await api.rooms.join(join.dataset.roomJoin);
      await enterRoom(room);
    } catch (error) {
      toast(cleanError(error), 'err');
      join.disabled = false;
    }
    return;
  }

  const switchRoom = event.target.closest('[data-room-switch]');
  if (switchRoom) {
    switchRoom.disabled = true;
    try {
      const room = await api.rooms.select(switchRoom.dataset.roomSwitch);
      await enterRoom(room);
    } catch (error) {
      toast(cleanError(error), 'err');
      switchRoom.disabled = false;
    }
  }
});

document.addEventListener('click', async (event) => {
  const addAll = event.target.closest('[data-add-all-members]');
  if (addAll) {
    addAll.disabled = true;
    try {
      const result = await api.addAllMembers(addAll.dataset.addAllMembers);
      if (result?.status) state.status = result.status;
      state.statusAt = Date.now();
      renderAll();
      toast(
        result?.added
          ? `Added ${result.added} member${result.added === 1 ? '' : 's'} from that server.`
          : 'Every member in that server is already on the list.',
      );
    } catch (error) {
      toast(cleanError(error), 'err');
    } finally {
      addAll.disabled = false;
    }
    return;
  }

  const expand = event.target.closest('[data-expand]');
  if (expand) {
    const guildId = expand.dataset.expand;
    if (state.expanded.has(guildId)) state.expanded.delete(guildId);
    else state.expanded.add(guildId);
    renderGuilds();
    return;
  }

  const switchEl = event.target.closest('.switch');
  if (switchEl) {
    const guildId = switchEl.dataset.guild;
    const key = switchEl.dataset.memberKey ?? switchEl.dataset.key;
    const userId = switchEl.dataset.user;
    const next = switchEl.getAttribute('aria-checked') !== 'true';
    const label = switchEl.dataset.label;
    const guildName = switchEl.dataset.guildName;

    switchEl.setAttribute('aria-checked', String(next));
    try {
      const result = userId
        ? await api.setMemberSetting(guildId, userId, key, next)
        : await api.setGuildSetting(guildId, key, next);
      state.status = result.status;
      state.statusAt = Date.now();
      renderChrome();
      renderHero();
      renderStats();
      toast(`${label} ${next ? 'enabled' : 'disabled'}${guildName ? ` for ${guildName}` : ''}.`);
    } catch (error) {
      switchEl.setAttribute('aria-checked', String(!next));
      toast(cleanError(error), 'err');
    }
    return;
  }

  const removeMember = event.target.closest('[data-member-remove]');
  if (removeMember) {
    try {
      state.status = await api.removeMember(removeMember.dataset.guild, removeMember.dataset.memberRemove);
      state.statusAt = Date.now();
      renderAll();
      toast('Member rule removed.');
    } catch (error) {
      toast(cleanError(error), 'err');
    }
    return;
  }

  const remove = event.target.closest('[data-remove]');
  if (remove) {
    try {
      state.status = await api.removeAllowedUser(remove.dataset.remove);
      state.statusAt = Date.now();
      renderAll();
      toast('User removed from the allowlist.');
    } catch (error) {
      toast(cleanError(error), 'err');
    }
  }
});

document.addEventListener('change', async (event) => {
  const select = event.target.closest('select[data-member-key]');
  if (!select) return;
  const value = select.value === 'inherit' ? null : select.value === 'on';
  try {
    const result = await api.setMemberSetting(
      select.dataset.guild,
      select.dataset.user,
      select.dataset.memberKey,
      value,
    );
    state.status = result.status;
    state.statusAt = Date.now();
    renderStats();
    renderChrome();
    toast('Member rule updated.');
  } catch (error) {
    toast(cleanError(error), 'err');
    await refreshStatus();
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('.member-add');
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector('input');
  const id = input.value.trim();
  if (!/^\d{17,20}$/.test(id)) {
    toast('A Discord user ID is 17-20 digits.', 'err');
    return;
  }
  try {
    state.status = await api.addMember(form.dataset.memberAdd, id);
    state.statusAt = Date.now();
    state.expanded.add(form.dataset.memberAdd);
    input.value = '';
    renderAll();
    toast('Member added.');
  } catch (error) {
    toast(cleanError(error), 'err');
  }
});

$('allow-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('allow-input');
  const value = input.value.trim();
  if (!value) return;
  try {
    state.status = await api.addAllowedUser(value);
    state.statusAt = Date.now();
    input.value = '';
    renderAll();
    toast('User added to the allowlist.');
  } catch (error) {
    toast(cleanError(error), 'err');
  }
});

$('console-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('console-input');
  const value = input.value;
  input.value = '';
  await submitConsole(value);
});

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => submitConsole(chip.dataset.cmd));
}

$('console-input').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    const previous = [...state.consoleLines].reverse().find((line) => line.kind === 'echo');
    if (previous) $('console-input').value = previous.text.replace(/^aegis › /, '');
  }
});

$('key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const scopes = [...document.querySelectorAll('#key-scopes input:checked')].map(
    (input) => input.value,
  );
  if (scopes.length === 0) {
    toast('Pick at least one permission for the key.', 'err');
    return;
  }
  try {
    state.keys = await api.auth.keys.create({
      label: $('key-label').value,
      scopes,
      discordId: $('key-discord').value.trim(),
    });
    $('key-label').value = '';
    $('key-discord').value = '';
    renderKeys();
    toast('Key created.');
  } catch (error) {
    toast(cleanError(error), 'err');
  }
});

for (const preset of document.querySelectorAll('[data-preset]')) {
  preset.addEventListener('click', () => {
    const scopes = PRESETS[preset.dataset.preset] ?? PRESETS.operator;
    for (const input of document.querySelectorAll('#key-scopes input')) {
      input.checked = scopes.includes(input.value);
    }
  });
}

$('show-app-file').addEventListener('click', () => api.showAppFile());

function downloadPageUrl() {
  return state.info?.server ? `${state.info.server}/download` : '';
}

$('copy-download-link').addEventListener('click', async () => {
  const url = downloadPageUrl();
  if (!url) return;
  await api.copyText(url);
  toast('Download link copied — send it to your friends.');
});

$('open-download-page').addEventListener('click', () => {
  const url = downloadPageUrl();
  if (url) api.openExternal(url);
});

$('update-install').addEventListener('click', installDownloadedUpdate);
$('update-dismiss').addEventListener('click', () => {
  if (state.update) state.update.status = 'dismissed';
  renderUpdate();
});
$('check-updates').addEventListener('click', () => checkForUpdates({ install: true }));

api.onUpdateProgress(({ percent }) => {
  if (state.update?.status === 'downloading') {
    state.update.percent = percent;
    renderUpdate();
  }
  if (!$('update-overlay').hidden) setOverlayProgress(percent);
});

$('key-list').addEventListener('click', async (event) => {
  const row = event.target.closest('[data-key-id]');
  const button = event.target.closest('button[data-key-action]');
  if (!row || !button) return;

  const id = row.dataset.keyId;
  const action = button.dataset.keyAction;

  try {
    if (action === 'copy') {
      const entry = state.keys.find((key) => key.id === id);
      if (entry) {
        await api.copyText(entry.key);
        toast('Key copied.');
      }
      return;
    }
    if (action === 'delete') {
      if (!window.confirm('Delete this key? The account created with it keeps working.')) return;
      state.keys = await api.auth.keys.remove(id);
      renderKeys();
      toast('Key deleted.');
      return;
    }
    if (action === 'save') {
      const input = row.querySelector('.key-label-input');
      state.keys = await api.auth.keys.update({ id, label: input.value });
      renderKeys();
      toast('Label saved.');
      return;
    }
    if (action === 'save-discord') {
      const input = row.querySelector('.key-discord-input');
      state.keys = await api.auth.keys.update({ id, discordId: input.value.trim() });
      renderKeys();
      toast('Discord ID saved.');
      return;
    }
    if (action === 'toggle') {
      const entry = state.keys.find((key) => key.id === id);
      state.keys = await api.auth.keys.update({ id, disabled: !entry.disabled });
      renderKeys();
      toast(entry.disabled ? 'Key enabled.' : 'Key disabled.');
      return;
    }
    if (action === 'reset') {
      state.keys = await api.auth.keys.update({ id, resetHwid: true });
      renderKeys();
      toast('Device lock reset.');
      return;
    }
    if (action === 'save-perms') {
      const scopes = [...row.querySelectorAll('input[data-key-scope]:checked')].map(
        (input) => input.value,
      );
      state.keys = await api.auth.keys.update({ id, scopes });
      renderKeys();
      toast('Permissions saved.');
    }
  } catch (error) {
    toast(cleanError(error), 'err');
  }
});

$('save-token').addEventListener('click', async () => {
  const input = $('token-input');
  const token = input.value.trim();
  if (!token) {
    toast('Paste a bot token first.', 'err');
    return;
  }
  try {
    state.config = await api.saveConfig({ token });
    input.value = '';
    renderChrome();
    renderSettings();
    toast('Token saved.');
  } catch (error) {
    toast(cleanError(error), 'err');
  }
});

$('token-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('save-token').click();
});

$('save-guild').addEventListener('click', async () => {
  try {
    state.config = await api.saveConfig({ guildId: $('guild-input').value.trim() });
    renderSettings();
    toast('Saved.');
  } catch (error) {
    toast(cleanError(error), 'err');
  }
});

$('deploy-btn').addEventListener('click', deployCommands);

$('autostart-input').addEventListener('change', async () => {
  try {
    state.config = await api.saveConfig({ autoStart: $('autostart-input').checked });
    toast(state.config.autoStart ? 'Aegis will start after sign-in.' : 'Autostart disabled.');
  } catch (error) {
    toast(cleanError(error), 'err');
  }
});

$('clear-activity').addEventListener('click', () => {
  state.logs = [];
  renderFeeds();
  toast('Activity view cleared.');
});

api.onStatus((status) => {
  if (!state.auth?.authenticated || state.linked || !state.room) return;
  state.status = status;
  state.statusAt = Date.now();
  renderChrome();
  renderHero();
  renderStats();
  renderGuilds();
  renderAccess();
  renderMessages();
  renderSettings();
});

api.onLog((entry) => {
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.shift();
  renderFeeds();
});

api.onMessage((entry) => {
  if (!state.room || state.linked) return;
  state.messages.push(entry);
  if (state.messages.length > 2000) state.messages.shift();
  if (state.page === 'messages') renderMessages();
});

setInterval(() => {
  if (state.status?.running) {
    $('stat-uptime').textContent = formatDuration(
      state.status.uptimeMs + (Date.now() - state.statusAt),
    );
  }
}, 1000);

/* -------------------------------------------------------------------- boot --- */

renderScopePicker($('key-scopes'), PRESETS.operator);

(async function boot() {
  try {
    const authState = await api.auth.status();
    await applyAuth(authState);
    checkForUpdates();
  } catch (error) {
    showAuthError(cleanError(error));
  }
})();
