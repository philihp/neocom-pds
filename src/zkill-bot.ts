import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { AtpAgent, RichText } from "@atproto/api"
import type { BotConfig } from "./config.js"
import type { CharacterStore } from "./character-store.js"
import type { AdminDeps } from "./provision.js"
import { resetAndLogin } from "./provision.js"

// --- R2Z2 API types -------------------------------------------------------

const R2Z2_SEQUENCE_URL = "https://r2z2.zkillboard.com/ephemeral/sequence.json"
const r2z2KillUrl = (seq: number) =>
  `https://r2z2.zkillboard.com/ephemeral/${seq}.json`
const USER_AGENT = "eve-pds/0.1.0 (edencom zkill-bot; github.com/edencom)"
const SLEEP_ON_404_MS = 6_000

interface R2Z2SequenceResponse {
  readonly sequence: number
}

interface R2Z2Victim {
  readonly character_id?: number
  readonly corporation_id?: number
  readonly alliance_id?: number
  readonly ship_type_id?: number
  readonly damage_taken: number
}

interface R2Z2Attacker {
  readonly character_id?: number
  readonly corporation_id?: number
  readonly alliance_id?: number
  readonly ship_type_id?: number
  readonly damage_done: number
  readonly final_blow: boolean
}

interface R2Z2Kill {
  readonly killmail_id: number
  readonly sequence_id: number
  readonly killmail: {
    readonly killmail_time: string
    readonly victim: R2Z2Victim
    readonly attackers: ReadonlyArray<R2Z2Attacker>
    readonly solar_system_id: number
  }
  readonly zkb: {
    readonly totalValue: number
    readonly npc: boolean
    readonly solo: boolean
  }
}

// --- Sequence persistence -------------------------------------------------

const sequencePath = (dataDir: string): string =>
  path.join(dataDir, "bot-sequence.json")

const readSequence = (dataDir: string): number | null => {
  try {
    const raw = JSON.parse(fs.readFileSync(sequencePath(dataDir), "utf8")) as {
      sequence: number
    }
    return raw.sequence
  } catch {
    return null
  }
}

const writeSequence = (dataDir: string, seq: number): void => {
  fs.writeFileSync(
    sequencePath(dataDir),
    JSON.stringify({ sequence: seq }),
    "utf8",
  )
}

const fetchCurrentSequence = async (): Promise<number> => {
  const res = await fetch(R2Z2_SEQUENCE_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`R2Z2 sequence fetch failed: ${res.status}`)
  const data = (await res.json()) as R2Z2SequenceResponse
  return data.sequence
}

// --- Bot account ----------------------------------------------------------

interface BotAccountRecord {
  readonly did: string
  readonly handle: string
}

const botAccountPath = (dataDir: string): string =>
  path.join(dataDir, "bot-account.json")

const readBotAccount = (dataDir: string): BotAccountRecord | null => {
  try {
    return JSON.parse(
      fs.readFileSync(botAccountPath(dataDir), "utf8"),
    ) as BotAccountRecord
  } catch {
    return null
  }
}

const writeBotAccount = (dataDir: string, record: BotAccountRecord): void => {
  fs.writeFileSync(
    botAccountPath(dataDir),
    JSON.stringify(record, null, 2),
    "utf8",
  )
}

const ensureBotAccount = async (
  deps: AdminDeps,
  dataDir: string,
  handle: string,
): Promise<BotAccountRecord> => {
  const existing = readBotAccount(dataDir)
  if (existing) return existing

  const password = crypto.randomBytes(32).toString("base64url")
  const agent = new AtpAgent({ service: deps.pdsUrl })
  const res = await agent.api.com.atproto.server.createAccount({
    handle,
    email: "bot-zkill@invalid.local",
    password,
  })

  const record: BotAccountRecord = {
    did: res.data.did,
    handle: res.data.handle,
  }
  writeBotAccount(dataDir, record)
  console.log(
    `[zkill-bot] Created bot account: ${record.handle} (${record.did})`,
  )
  return record
}

// --- ESI name lookups (in-memory cache) -----------------------------------

const nameCache = new Map<string, string>()

const esiName = async (
  cacheKey: string,
  url: string,
  fallback: string,
): Promise<string> => {
  const hit = nameCache.get(cacheKey)
  if (hit !== undefined) return hit
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    })
    if (!res.ok) return fallback
    const data = (await res.json()) as { name: string }
    nameCache.set(cacheKey, data.name)
    return data.name
  } catch {
    return fallback
  }
}

const fetchTypeName = (typeId: number): Promise<string> =>
  esiName(
    `type:${typeId}`,
    `https://esi.evetech.net/latest/universe/types/${typeId}/`,
    `Ship#${typeId}`,
  )

const fetchSystemName = (systemId: number): Promise<string> =>
  esiName(
    `system:${systemId}`,
    `https://esi.evetech.net/latest/universe/systems/${systemId}/`,
    `J${systemId}`,
  )

const fetchCharacterName = (characterId: number): Promise<string> =>
  esiName(
    `char:${characterId}`,
    `https://esi.evetech.net/latest/characters/${characterId}/`,
    `Pilot#${characterId}`,
  )

// --- Kill filtering -------------------------------------------------------

const isRelevantKill = (
  kill: R2Z2Kill,
  cfg: BotConfig,
  characters: CharacterStore,
): boolean => {
  console.log(JSON.stringify(kill, undefined, 2))

  const { victim, attackers } = kill.killmail
  const allCharacters = [victim, ...attackers]

  if (cfg.filterCorpId) {
    return allCharacters.some((p) => p.corporation_id === cfg.filterCorpId)
  }
  if (cfg.filterAllianceId) {
    return allCharacters.some((p) => p.alliance_id === cfg.filterAllianceId)
  }
  if (cfg.filterSystemId) {
    return kill.killmail.solar_system_id === cfg.filterSystemId
  }

  // No filter configured — only post kills involving registered PDS characters
  return allCharacters.some(
    (p) => p.character_id && characters.findByCharacterId(p.character_id),
  )
}

// --- Post text ------------------------------------------------------------

const formatIsk = (value: number): string => {
  if (value >= 1_000_000_000)
    return `${(value / 1_000_000_000).toFixed(1)}B ISK`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M ISK`
  return `${(value / 1_000).toFixed(0)}K ISK`
}

const buildPostText = async (
  kill: R2Z2Kill,
  characters: CharacterStore,
): Promise<string> => {
  const { killmail_id, killmail, zkb } = kill
  const { victim, attackers, solar_system_id } = killmail

  const victimName = victim.character_id
    ? (characters.findByCharacterId(victim.character_id)?.characterName ??
      (await fetchCharacterName(victim.character_id)))
    : "Unknown Pilot"

  const shipName = victim.ship_type_id
    ? await fetchTypeName(victim.ship_type_id)
    : "Unknown Ship"

  const systemName = await fetchSystemName(solar_system_id)

  const finalBlow = attackers.find((a) => a.final_blow)
  const killerName = finalBlow?.character_id
    ? (characters.findByCharacterId(finalBlow.character_id)?.characterName ??
      (await fetchCharacterName(finalBlow.character_id)))
    : "Unknown"

  const tags = [zkb.solo && "solo", zkb.npc && "npc"].filter(Boolean).join(", ")
  const tagSuffix = tags ? ` [${tags}]` : ""

  return (
    `☠️ ${victimName} lost a ${shipName} in ${systemName}${tagSuffix}\n` +
    `Killed by ${killerName} • ${formatIsk(zkb.totalValue)}\n` +
    `https://zkillboard.com/kill/${killmail_id}/`
  )
}

// --- ATProto post ---------------------------------------------------------

const postKill = async (
  agent: AtpAgent,
  botDid: string,
  text: string,
): Promise<void> => {
  const rt = new RichText({ text })
  await rt.detectFacets(agent)
  await agent.api.app.bsky.feed.post.create(
    { repo: botDid },
    {
      $type: "app.bsky.feed.post",
      text: rt.text,
      facets: rt.facets,
      createdAt: new Date().toISOString(),
    },
  )
}

// --- Main bot loop --------------------------------------------------------

export interface BotDeps {
  readonly admin: AdminDeps
  readonly characters: CharacterStore
  readonly cfg: BotConfig
  readonly dataDir: string
  readonly serviceHandleDomains: string
}

export const startZkillBot = async (deps: BotDeps): Promise<() => void> => {
  const { admin, characters, cfg, dataDir, serviceHandleDomains } = deps

  const handle = `${cfg.botHandle}${serviceHandleDomains}`
  const botRecord = await ensureBotAccount(admin, dataDir, handle)

  let agent = new AtpAgent({ service: admin.pdsUrl })
  const refreshSession = async (): Promise<void> => {
    const session = await resetAndLogin(admin, botRecord.did)
    agent = new AtpAgent({ service: admin.pdsUrl })
    await agent.resumeSession({
      did: session.did,
      handle: session.handle,
      accessJwt: session.accessJwt,
      refreshJwt: session.refreshJwt,
      active: true,
    })
  }
  await refreshSession()

  // Refresh the session every 90 minutes (tokens expire at ~2 hours)
  const sessionTimer = setInterval(refreshSession, 90 * 60_000)

  // Start from the saved sequence, or the current live sequence on first run
  let sequence = readSequence(dataDir) ?? (await fetchCurrentSequence())
  console.log(`[zkill-bot] Starting at sequence ${sequence}`)

  let running = true

  const poll = async (): Promise<void> => {
    while (running) {
      try {
        const res = await fetch(r2z2KillUrl(sequence), {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        })

        if (res.status === 404) {
          // No kill at this sequence yet — wait before retrying
          await new Promise((r) => setTimeout(r, SLEEP_ON_404_MS))
          continue
        }

        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("retry-after") ?? "10")
          console.warn(`[zkill-bot] Rate limited, waiting ${retryAfter}s`)
          await new Promise((r) => setTimeout(r, retryAfter * 1_000))
          continue
        }

        if (!res.ok) {
          console.error(
            `[zkill-bot] R2Z2 HTTP ${res.status} at sequence ${sequence}`,
          )
          await new Promise((r) => setTimeout(r, 10_000))
          continue
        }

        const kill = (await res.json()) as R2Z2Kill

        if (isRelevantKill(kill, cfg, characters)) {
          const text = await buildPostText(kill, characters)
          await postKill(agent, botRecord.did, text)
          console.log(
            `[zkill-bot] Posted kill ${kill.killmail_id} (seq ${sequence})`,
          )
        }

        sequence++
        writeSequence(dataDir, sequence)
      } catch (err) {
        if (running) {
          console.error("[zkill-bot] Poll error:", err)
          await new Promise((r) => setTimeout(r, 10_000))
        }
      }
    }
  }

  poll().catch((err) => console.error("[zkill-bot] Fatal poll error:", err))

  return (): void => {
    running = false
    clearInterval(sessionTimer)
    console.log("[zkill-bot] Stopped")
  }
}
