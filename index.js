#!/usr/bin/env node
// Console WhatsApp client built on Baileys (WhatsApp Web multi-device protocol).
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
} from 'baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.WA_DATA_DIR || path.join(ROOT, 'data')
const AUTH_DIR = path.join(DATA_DIR, 'auth')
const STORE_FILE = path.join(DATA_DIR, 'store.json')
const MAX_MSGS_PER_CHAT = 200

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
}

// ---------- local store (Baileys v7 ships none) ----------

const store = loadStore()

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
  } catch {
    return { chats: {}, names: {}, lidToPn: {} }
  }
}

let saveTimer
function saveStore() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(STORE_FILE, JSON.stringify(store))
  }, 500)
}

// Chats can be addressed by LID (@lid) or phone number (@s.whatsapp.net);
// we prefer the phone-number form as the canonical key when we know it.
function canonical(jid) {
  if (!jid) return jid
  jid = jidNormalizedUser(jid)
  return store.lidToPn[jid] || jid
}

function rememberLid(lid, pn) {
  if (!lid || !pn || !isLidUser(lid) || !isPnUser(pn)) return
  lid = jidNormalizedUser(lid)
  pn = jidNormalizedUser(pn)
  if (store.lidToPn[lid] === pn) return
  store.lidToPn[lid] = pn
  // merge any chat that was stored under the LID
  const old = store.chats[lid]
  if (old) {
    const target = getChat(pn)
    target.messages = [...old.messages, ...target.messages]
      .sort((a, b) => a.ts - b.ts)
      .filter((m, i, arr) => i === 0 || m.id !== arr[i - 1].id)
      .slice(-MAX_MSGS_PER_CHAT)
    target.lastTs = Math.max(target.lastTs, old.lastTs)
    target.unread += old.unread
    delete store.chats[lid]
  }
  if (store.names[lid] && !store.names[pn]) store.names[pn] = store.names[lid]
  saveStore()
}

function getChat(jid) {
  return (store.chats[jid] ||= { jid, lastTs: 0, unread: 0, messages: [] })
}

function setName(jid, name, { force = false } = {}) {
  if (!jid || !name) return
  jid = canonical(jid)
  if (force || !store.names[jid]) {
    store.names[jid] = name
    saveStore()
  }
}

function displayName(jid) {
  jid = canonical(jid)
  if (store.names[jid]) return store.names[jid]
  if (isPnUser(jid)) return '+' + jid.split('@')[0]
  return jid.split('@')[0]
}

function messageText(msg) {
  const m = normalizeMessageContent(msg.message)
  if (!m) return null
  const type = getContentType(m)
  if (!type) return null
  const body = m[type]
  switch (type) {
    case 'conversation': return m.conversation
    case 'extendedTextMessage': return body.text
    case 'imageMessage': return `[image]${body.caption ? ' ' + body.caption : ''}`
    case 'videoMessage': return `[video]${body.caption ? ' ' + body.caption : ''}`
    case 'audioMessage': return body.ptt ? '[voice note]' : '[audio]'
    case 'documentMessage': return `[document] ${body.fileName || ''}`.trim()
    case 'stickerMessage': return '[sticker]'
    case 'contactMessage': return `[contact] ${body.displayName || ''}`.trim()
    case 'locationMessage': return `[location] ${body.degreesLatitude},${body.degreesLongitude}`
    case 'pollCreationMessage':
    case 'pollCreationMessageV3': return `[poll] ${body.name}`
    case 'reactionMessage': return body.text ? `[reacted ${body.text}]` : null
    case 'protocolMessage':
    case 'senderKeyDistributionMessage':
    case 'messageContextInfo': return null
    default: return `[${type.replace(/Message$/, '')}]`
  }
}

// Record a message in the store. Returns the stored entry, or null if skipped.
function recordMessage(msg, { live = false } = {}) {
  const key = msg.key
  if (!key?.remoteJid || key.remoteJid === 'status@broadcast') return null
  if (key.remoteJidAlt) rememberLid(key.remoteJid, key.remoteJidAlt)
  if (key.participantAlt) rememberLid(key.participant, key.participantAlt)

  const text = messageText(msg)
  if (text == null) return null

  const chatJid = canonical(key.remoteJid)
  const chat = getChat(chatJid)
  if (chat.messages.some((m) => m.id === key.id)) return null

  const sender = key.fromMe ? 'me' : canonical(key.participant || key.remoteJid)
  if (!key.fromMe && msg.pushName) setName(sender, msg.pushName)

  const ts = Number(msg.messageTimestamp || Date.now() / 1000)
  const entry = { id: key.id, ts, fromMe: !!key.fromMe, sender, text }
  chat.messages.push(entry)
  chat.messages.sort((a, b) => a.ts - b.ts)
  if (chat.messages.length > MAX_MSGS_PER_CHAT) chat.messages.splice(0, chat.messages.length - MAX_MSGS_PER_CHAT)
  chat.lastTs = Math.max(chat.lastTs, ts)
  if (live && !key.fromMe && chatJid !== activeChat) chat.unread++
  saveStore()
  return { chatJid, entry }
}

// ---------- terminal UI ----------

let activeChat = null
let sock = null
let lastListing = [] // jids from the most recent /chats, for /open <n>

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })

function updatePrompt() {
  rl.setPrompt(activeChat ? c.green(`[${displayName(activeChat)}] `) : c.dim('[no chat] '))
}

// Print a line without clobbering what the user is typing.
function out(line = '') {
  readline.clearLine(process.stdout, 0)
  readline.cursorTo(process.stdout, 0)
  process.stdout.write(line + '\n')
  rl.prompt(true)
}

function fmtTime(ts) {
  const d = new Date(ts * 1000)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtMessage(chatJid, m) {
  const who = m.fromMe
    ? c.green('me')
    : isJidGroup(chatJid) ? c.cyan(displayName(m.sender)) : c.cyan(displayName(chatJid))
  return `${c.dim(fmtTime(m.ts))} ${who}: ${m.text}`
}

function sortedChats() {
  return Object.values(store.chats)
    .filter((ch) => ch.messages.length || store.names[ch.jid])
    .sort((a, b) => b.lastTs - a.lastTs)
}

function showChats(filter) {
  let chats = sortedChats()
  if (filter) {
    const f = filter.toLowerCase()
    chats = chats.filter((ch) => displayName(ch.jid).toLowerCase().includes(f) || ch.jid.includes(f))
  }
  chats = chats.slice(0, 30)
  lastListing = chats.map((ch) => ch.jid)
  if (!chats.length) return out(c.dim('No chats yet. History may still be syncing, or use /new <phone>.'))
  chats.forEach((ch, i) => {
    const last = ch.messages.at(-1)
    const unread = ch.unread ? c.yellow(` (${ch.unread})`) : ''
    const group = isJidGroup(ch.jid) ? c.dim(' [group]') : ''
    const preview = last ? c.dim(' — ' + last.text.replace(/\s+/g, ' ').slice(0, 50)) : ''
    out(`${String(i + 1).padStart(3)}. ${c.bold(displayName(ch.jid))}${group}${unread}${preview}`)
  })
}

function showHistory(jid, n = 20) {
  const chat = store.chats[jid]
  const msgs = chat?.messages.slice(-n) || []
  out(c.dim(`── ${displayName(jid)} ${'─'.repeat(30)}`))
  if (!msgs.length) out(c.dim('(no messages stored locally)'))
  for (const m of msgs) out(fmtMessage(jid, m))
}

function resolveChat(arg) {
  if (/^\d{1,3}$/.test(arg) && lastListing[Number(arg) - 1]) return lastListing[Number(arg) - 1]
  if (arg.includes('@')) return canonical(arg)
  const f = arg.toLowerCase()
  const match = sortedChats().find((ch) => displayName(ch.jid).toLowerCase().includes(f))
  return match?.jid
}

function openChat(jid) {
  activeChat = jid
  getChat(jid).unread = 0
  saveStore()
  updatePrompt()
  showHistory(jid)
}

const HELP = `
${c.bold('Commands')}
  /chats [filter]     list recent chats (numbered)
  /open <n|name>      open a chat by number from /chats, or by name
  /new <phone>        start a chat with a phone number (international format, e.g. 447700900123)
  /history [n]        show the last n messages of the open chat (default 20)
  /close              close the current chat
  /logout             unlink this device and delete the local session
  /quit               exit
  <text>              send text to the open chat
`

async function handleLine(line) {
  const input = line.trim()
  if (!input) return
  if (!input.startsWith('/')) {
    if (!activeChat) return out(c.yellow('No chat open. Use /chats then /open <n>, or /new <phone>.'))
    if (!sock?.user) return out(c.red('Not connected yet.'))
    await sock.sendMessage(activeChat, { text: input })
    // our own message comes back through messages.upsert and is printed there
    return
  }
  const [cmd, ...rest] = input.slice(1).split(' ')
  const arg = rest.join(' ').trim()
  switch (cmd) {
    case 'help': case 'h': return out(HELP)
    case 'chats': case 'c': return showChats(arg)
    case 'open': case 'o': {
      if (!arg) return out(c.yellow('Usage: /open <n|name>'))
      const jid = resolveChat(arg)
      return jid ? openChat(jid) : out(c.yellow(`No chat matching "${arg}".`))
    }
    case 'new': case 'n': {
      const digits = arg.replace(/\D/g, '')
      if (!digits) return out(c.yellow('Usage: /new <phone in international format>'))
      const [res] = (await sock.onWhatsApp(digits)) || []
      if (!res?.exists) return out(c.yellow(`+${digits} is not on WhatsApp.`))
      return openChat(canonical(res.jid))
    }
    case 'history': {
      if (!activeChat) return out(c.yellow('No chat open.'))
      return showHistory(activeChat, Number(arg) || 20)
    }
    case 'close': activeChat = null; return updatePrompt()
    case 'logout': {
      await sock?.logout().catch(() => {})
      fs.rmSync(AUTH_DIR, { recursive: true, force: true })
      out('Logged out. Local session removed.')
      return shutdown()
    }
    case 'quit': case 'q': case 'exit': return shutdown()
    default: return out(c.yellow(`Unknown command /${cmd}. Try /help.`))
  }
}

function shutdown() {
  clearTimeout(saveTimer)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(STORE_FILE, JSON.stringify(store))
  sock?.end(undefined)
  rl.close()
  process.exit(0)
}

rl.on('line', (line) => {
  handleLine(line)
    .catch((err) => out(c.red('Error: ' + (err?.message || err))))
    .finally(() => rl.prompt())
})
rl.on('close', shutdown)

// ---------- WhatsApp connection ----------

async function loadGroupNames() {
  try {
    const groups = await sock.groupFetchAllParticipating()
    for (const g of Object.values(groups)) {
      setName(g.id, g.subject, { force: true })
      getChat(g.id)
    }
  } catch { /* non-fatal */ }
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion().catch(() => ({}))

  sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: process.env.WA_LOG_LEVEL || 'silent' }),
    markOnlineOnConnect: false, // don't suppress notifications on your phone
    syncFullHistory: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      out(c.bold('\nScan this QR code with WhatsApp → Settings → Linked devices → Link a device:\n'))
      qrcode.generate(qr, { small: true }, (code) => out(code))
    }
    if (connection === 'open') {
      out(c.green(`Connected as ${sock.user?.name || sock.user?.id}. Type /help for commands.`))
      loadGroupNames()
    }
    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode
      if (status === DisconnectReason.loggedOut) {
        out(c.red('This device was unlinked. Delete ./data/auth and restart to pair again.'))
        fs.rmSync(AUTH_DIR, { recursive: true, force: true })
        return shutdown()
      }
      out(c.dim(`Connection closed (${status ?? 'unknown'}), reconnecting…`))
      setTimeout(connect, status === DisconnectReason.restartRequired ? 0 : 2000)
    }
  })

  sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
    for (const m of lidPnMappings || []) rememberLid(m.lid, m.pn)
    for (const ct of contacts || []) {
      if (ct.lid && ct.phoneNumber) rememberLid(ct.lid, ct.phoneNumber)
      setName(ct.id, ct.name || ct.notify || ct.verifiedName, { force: !!ct.name })
    }
    for (const ch of chats || []) {
      const chat = getChat(canonical(ch.id))
      if (ch.name) setName(ch.id, ch.name, { force: true })
      chat.lastTs = Math.max(chat.lastTs, Number(ch.conversationTimestamp || 0))
      chat.unread = ch.unreadCount || chat.unread
    }
    for (const msg of messages || []) recordMessage(msg)
  })

  const onContacts = (list) => {
    for (const ct of list) {
      if (ct.lid && ct.phoneNumber) rememberLid(ct.lid, ct.phoneNumber)
      if (ct.name) setName(ct.id, ct.name, { force: true })
      else setName(ct.id, ct.notify || ct.verifiedName)
    }
  }
  sock.ev.on('contacts.upsert', onContacts)
  sock.ev.on('contacts.update', onContacts)
  sock.ev.on('lid-mapping.update', ({ lid, pn }) => rememberLid(lid, pn))

  sock.ev.on('groups.update', (updates) => {
    for (const g of updates) if (g.id && g.subject) setName(g.id, g.subject, { force: true })
  })

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
      const rec = recordMessage(msg, { live: type === 'notify' })
      if (!rec || type !== 'notify') continue
      const { chatJid, entry } = rec
      if (chatJid === activeChat) {
        out(fmtMessage(chatJid, entry))
        if (!entry.fromMe) sock.readMessages([msg.key]).catch(() => {})
      } else if (!entry.fromMe) {
        const where = isJidGroup(chatJid) ? `${displayName(entry.sender)} @ ${displayName(chatJid)}` : displayName(chatJid)
        out(`${c.yellow('●')} ${c.bold(where)}: ${entry.text}`)
      }
    }
  })
}

updatePrompt()
out(c.bold('WhatsApp CLI') + c.dim(' — connecting…'))
connect().catch((err) => {
  out(c.red('Failed to start: ' + err.message))
  process.exit(1)
})
