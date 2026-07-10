const MAX_LEN = 1900
const OWNER_ID = "874994122237280266"
let TOKEN = null
const API = "https://discord.com/api/v10"
const INTENTS = 1 << 0 | 1 << 12 | 1 << 15
const AGENT = "openn-02"

let discordChannelId = null
let sessionId = null
let ws = null
let heartbeatTimer = null
let seq = null
let opencodeClient = null
const sentPartIds = new Set()

// ── Screen capture & file upload (dynamic imports for runtime compat) ─────

async function captureScreenToFile() {
  const { execSync } = await import("child_process")
  const { writeFileSync, unlinkSync, mkdtempSync } = await import("fs")
  const { join } = await import("path")
  const { tmpdir } = await import("os")

  const tmpDir = mkdtempSync(join(tmpdir(), "screenshot-"))
  const psFile = join(tmpDir, "capture.ps1")
  const outFile = join(tmpDir, "screen.png")

  const psScript = [
    `Add-Type -AssemblyName System.Drawing`,
    `Add-Type -AssemblyName System.Windows.Forms`,
    `$screen = [System.Windows.Forms.Screen]::PrimaryScreen`,
    `$bounds = $screen.Bounds`,
    `$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height`,
    `$graphics = [System.Drawing.Graphics]::FromImage($bitmap)`,
    `$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)`,
    `$bitmap.Save('${outFile.replace(/\\/g, "\\\\").replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    `$graphics.Dispose()`,
    `$bitmap.Dispose()`,
  ].join("\n")

  writeFileSync(psFile, psScript, "utf-8")
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, {
      timeout: 30000,
      windowsHide: true,
    })
    return outFile
  } finally {
    try { unlinkSync(psFile) } catch {}
  }
}

async function uploadFileToDiscord(filePath, caption) {
  if (!discordChannelId) return
  const { readFileSync, unlinkSync, rmSync } = await import("fs")
  const { join } = await import("path")

  const buffer = readFileSync(filePath)
  const filename = "screen.png"
  const boundary = `----Boundary${Date.now()}${Math.random().toString(36).slice(2)}`

  // Build multipart body manually
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`
  const footer = caption
    ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n${caption}\r\n--${boundary}--`
    : `\r\n--${boundary}--`

  const enc = new TextEncoder()
  const headBuf = enc.encode(header)
  const footBuf = enc.encode(footer)
  const full = new Uint8Array(headBuf.length + buffer.length + footBuf.length)
  full.set(headBuf, 0)
  full.set(buffer, headBuf.length)
  full.set(footBuf, headBuf.length + buffer.length)

  const r = await fetch(`${API}/channels/${discordChannelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: full,
  })
  if (!r.ok) {
    const err = await r.text()
    console.error(`[discord] Upload error: ${r.status} ${err}`)
  }
  // Cleanup temp files
  try { unlinkSync(filePath) } catch {}
  const parentDir = join(filePath, "..")
  if (parentDir && parentDir.includes("screenshot-")) {
    try { rmSync(parentDir, { recursive: true, force: true }) } catch {}
  }
}

function splitMsg(text) {
  if (text.length <= MAX_LEN) return [text]
  const parts = []
  let s = text
  while (s.length > 0) {
    if (s.length <= MAX_LEN) { parts.push(s); break }
    let i = s.lastIndexOf("\n", MAX_LEN)
    if (i <= 0) i = MAX_LEN
    parts.push(s.slice(0, i))
    s = s.slice(i)
  }
  return parts
}

async function sendToDiscord(text) {
  if (!discordChannelId || !text) return
  for (const part of splitMsg(text)) {
    const r = await fetch(`${API}/channels/${discordChannelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: part }),
    })
    if (!r.ok) {
      const err = await r.text()
      console.error(`[discord] Send error: ${r.status} ${err}`)
    }
  }
}

async function sendTyping() {
  if (!discordChannelId) return
  await fetch(`${API}/channels/${discordChannelId}/typing`, {
    method: "POST",
    headers: { Authorization: `Bot ${TOKEN}` },
  }).catch(() => {})
}

async function handleCommand(msg) {
  const text = msg.content.trim()

  if (text === "/start-ns") {
    const s = await opencodeClient.session.create({ body: { title: "Discord", agent: AGENT } })
    sessionId = s?.id ?? s?.data?.id
    await sendToDiscord(sessionId ? `New session: \`${sessionId}\`` : "Failed to create session.")
    return true
  }

  if (text === "/screen" || text === "/screenshot") {
    await sendToDiscord("📸 Capturing your screen... one moment!")
    try {
      const filePath = await captureScreenToFile()
      await uploadFileToDiscord(filePath, "Here's your screenshot!")
    } catch (err) {
      await sendToDiscord(`Screenshot failed: ${err?.message ?? String(err)}`)
    }
    return true
  }

  if (text === "/help") {
    await sendToDiscord(
      "**Commands:**\n" +
      "`/start-ns` - new session\n" +
      "`/list-s` - list sessions\n" +
      "`/s-chose <name>` - switch session\n" +
      "`/screen` - capture and send a screenshot\n" +
      "`/help` - this message\n\n" +
      "Anything else is sent as a prompt to the current session."
    )
    return true
  }

  if (text === "/list-s") {
    const sessions = await opencodeClient.session.list()
    const list = (sessions ?? []).map((s, i) => {
      const id = s?.id ?? s?.data?.id ?? "?"
      const title = s?.title ?? s?.data?.title ?? "(untitled)"
      return `${i + 1}. **${title}** (\`${id.slice(0, 8)}...\`)${id === sessionId ? " ← current" : ""}`
    }).join("\n") || "No sessions."
    await sendToDiscord(list)
    return true
  }

  const choseMatch = text.match(/^\/s-chose\s+(.+)/)
  if (choseMatch) {
    const target = choseMatch[1].toLowerCase()
    const sessions = await opencodeClient.session.list()
    const found = (sessions ?? []).find(s => {
      const title = (s?.title ?? s?.data?.title ?? "").toLowerCase()
      const id = s?.id ?? s?.data?.id ?? ""
      return title === target || id === target || id.startsWith(target)
    })
    if (found) {
      sessionId = found?.id ?? found?.data?.id
      const title = found?.title ?? found?.data?.title ?? "(untitled)"
      await sendToDiscord(`Switched to **${title}** (\`${sessionId}\`)`)
    } else {
      await sendToDiscord(`No session matching "${target}".`)
    }
    return true
  }

  return false
}

function connect() {
  if (ws) try { ws.close() } catch {}

  fetch(`${API}/gateway/bot`, {
    headers: { Authorization: `Bot ${TOKEN}` },
  }).then(r => r.json()).then(({ url }) => {
    ws = new WebSocket(url ? `${url}/?v=10&encoding=json` : "wss://gateway.discord.gg/?v=10&encoding=json")

    ws.onopen = () => console.log("[discord] WebSocket connected")
    ws.onclose = (e) => {
      console.log(`[discord] WebSocket closed (code=${e.code})`)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      ws = null
      setTimeout(connect, 5000)
    }
    ws.onerror = (e) => console.error("[discord] WS error:", e.message ?? e)

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data)
      const { op, d, s: newSeq, t } = data
      if (newSeq) seq = newSeq

      if (op === 10) {
        const interval = d.heartbeat_interval
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        heartbeatTimer = setInterval(() => {
          ws?.send(JSON.stringify({ op: 1, d: seq }))
        }, interval)
        ws?.send(JSON.stringify({
          op: 2,
          d: {
            token: TOKEN,
            intents: INTENTS,
            properties: { os: "windows", browser: "opencode", device: "opencode" },
          },
        }))
      } else if (op === 0) {
        if (t === "READY") {
          console.log(`[discord] Logged in as ${d.user.username} (${d.user.id})`)
          console.log(`[discord] Owner: ${OWNER_ID}`)
        } else if (t === "MESSAGE_CREATE") {
          const msg = d
          if (msg.author?.bot) return
          if (msg.guild_id) return

          discordChannelId = msg.channel_id

          if (msg.author.id !== OWNER_ID) {
            await sendToDiscord("This bot is private.")
            return
          }

          if (!opencodeClient) {
            await sendToDiscord("Client not ready yet. Try again.")
            return
          }

          try {
            if (await handleCommand(msg)) return

            if (!sessionId) {
              const s = await opencodeClient.session.create({ body: { title: "Discord", agent: AGENT } })
              sessionId = s?.id ?? s?.data?.id
              if (!sessionId) {
                await sendToDiscord("Failed to create session.")
                return
              }
            }

            await sendTyping()

            const result = await opencodeClient.session.prompt({
              path: { id: sessionId },
              body: { agent: AGENT, parts: [{ type: "text", text: msg.content }] },
            })

            const resultParts = Array.isArray(result?.parts) ? result.parts
              : Array.isArray(result?.data?.parts) ? result.data.parts
              : Array.isArray(result?.info?.parts) ? result.info.parts
              : null

            if (resultParts) {
              for (const part of resultParts) {
                if (part.type === "text" && part.text && !sentPartIds.has(part.id)) {
                  sentPartIds.add(part.id)
                  await sendToDiscord(part.text)
                }
              }
            }
          } catch (err) {
            await sendToDiscord(`Error: ${err?.message ?? String(err)}`)
          }
        }
      } else if (op === 9) {
        console.log("[discord] Invalid session, reconnecting...")
        ws?.close()
      } else if (op === 7) {
        console.log("[discord] Gateway requested reconnect")
        ws?.close()
      }
    }
  }).catch(err => {
    console.error("[discord] Failed to get gateway URL:", err)
    setTimeout(connect, 10000)
  })
}

async function plugin(input) {
  console.log("[discord] Plugin loaded")
  opencodeClient = input?.client ?? null

  TOKEN = process.env.DISCORD_BOT_TOKEN
  if (!TOKEN) {
    try {
      const { readFileSync } = await import("fs")
      const { join } = await import("path")
      const { fileURLToPath } = await import("url")
      const dir = fileURLToPath(new URL(".", import.meta.url))
      const envPath = join(dir, "..", "..", ".env")
      const content = readFileSync(envPath, "utf-8")
      const match = content.match(/^DISCORD_BOT_TOKEN=(.+)$/m)
      if (match) TOKEN = match[1].trim()
    } catch {}
  }

  if (!opencodeClient) console.error("[discord] No client in plugin input")
  if (!TOKEN) console.error("[discord] No bot token found. Set DISCORD_BOT_TOKEN env var or create .env file")
  connect()
  return {
    "tool.execute.before": async (input) => {
      if (!discordChannelId || !input || input.sessionID !== sessionId) return
      const toolName = input.tool ?? "unknown"
      const argsStr = input.args ? JSON.stringify(input.args, null, 2) : ""
      const preview = argsStr.length > 800 ? argsStr.slice(0, 800) + "\n..." : argsStr
      if (preview) await sendToDiscord(`**${toolName}**\n\`\`\`json\n${preview}\n\`\`\``)
    },
    "tool.execute.after": async (input, output) => {
      if (!discordChannelId || !input || input.sessionID !== sessionId) return
      const toolName = input.tool ?? "unknown"

      // Auto-upload screenshots from the discord_screenshot tool
      if (toolName === "discord_screenshot") {
        const filePath = output?.output
        if (filePath && typeof filePath === "string" && filePath.endsWith(".png")) {
          await sendToDiscord("📸 Captured your screen! Uploading...")
          await uploadFileToDiscord(filePath, "Here's your screenshot!")
        }
        return
      }

      const o = output?.output
      let s = null
      if (typeof o === "string") s = o
      else if (o?.content && typeof o.content === "string") s = o.content
      else if (o?.stdout) s = o.stdout
      else if (o) s = JSON.stringify(o, null, 2)
      if (!s) return
      const body = s.length > 1500 ? s.slice(0, 1500) + "\n..." : s
      await sendToDiscord(`**${toolName}** result\n\`\`\`\n${body}\n\`\`\``)
    },
  }
}

export default plugin
