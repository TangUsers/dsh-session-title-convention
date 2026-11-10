/**
 * Session title convention (Host plugin)
 *
 * Keeps DSH session names in a structured form
 *   【<stage><status>】<workspace>｜<module>｜<MMDD>｜<brief>
 * whenever the Harness' own automatic title generation produces a plain title.
 *
 * This plugin carries no workspace-specific data: the workspace label, the
 * module vocabulary and the directories it applies to all come from config.
 * With the defaults it works for any repository; without `workspace` it uses
 * the session's working-directory name.
 *
 * Automatic titles arrive as `session/title` events with source.kind
 * 'fallback' (instant, raw prompt) or 'provider' (LLM, a few seconds later).
 * This plugin prefers the provider title, waits a few seconds after the
 * fallback, and then pins the formatted title through sessionTitle.rename().
 * Because rename() records source.kind 'user' and pins the title, the plugin
 * never fights a human rename and never rewrites its own output.
 */

const DEFAULT_CONFIG = {
  /** Label between 【..】 and the module. Empty = the session working directory's name. */
  workspace: '',
  /** Only sessions whose cwd is under one of these roots are named. Empty = every workspace. */
  roots: [],
  /** Stage to use when none is known; the convention allows leaving it empty. */
  defaultStage: '',
  defaultStatus: '🟢',
  /** Module used when no `moduleRules` pattern matches. */
  defaultModule: '通用',
  maxBrief: 40,
  /** IANA zone used for the MMDD date. Empty = the machine's local zone. */
  timeZone: '',
  fallbackDelayMs: 8000,
  /** Rename already-open sessions that still carry an automatic title. */
  sweepOnStart: false,
  sweepMaxAgeMinutes: 1440,
  /**
   * Module inference rules, checked in order against the current title:
   * [regularExpression, module] pairs, or { pattern, module } objects.
   */
  moduleRules: [],
}

const STAGES = ['盘点', '设计', '实现', '验证', '收口', '归档']
const STATUSES = ['🟢', '🟡', '🔴', '✅', '🧊']
const TITLE_RE = /^【([^】]*)】([^｜]+)｜([^｜]+)｜(\d{4})｜(.+)$/

function sanitizeSegment(value) {
  return String(value ?? '')
    .replace(/[｜|]/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
}

function basenameOf(cwd) {
  if (typeof cwd !== 'string') return ''
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

function workspaceOf(session, config) {
  const configured = sanitizeSegment(config.workspace)
  if (configured !== '') return configured
  const fromCwd = sanitizeSegment(basenameOf(session?.header?.cwd))
  return fromCwd !== '' ? fromCwd : 'workspace'
}

function parseTitle(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const match = TITLE_RE.exec(text)
  if (match === null) return undefined
  const inner = match[1]
  const status = STATUSES.find(status => inner.includes(status))
  if (status === undefined) return undefined
  const stage = inner.split(status).join('').trim()
  if (stage !== '' && !STAGES.includes(stage)) return undefined
  const workspace = match[2].trim()
  const module = match[3].trim()
  const brief = match[5].trim()
  if (workspace === '' || module === '' || brief === '') return undefined
  return { stage, status, workspace, module, date: match[4], brief }
}

function buildTitle(parts) {
  return `【${parts.stage}${parts.status}】${parts.workspace}｜${parts.module}｜${parts.date}｜${parts.brief}`
}

function briefOf(raw, maxBrief) {
  let text = typeof raw === 'string' ? raw : ''
  text = text.replace(/^【[^】]*】/, '')
  text = text.replace(/\s+/g, ' ').trim()
  text = text.replace(/^[\s"'“”「」《》]+|[\s"'“”「」《》]+$/g, '').trim()
  text = text.replace(/[。．.！!？?，,；;：:、～~]+$/g, '').trim()
  text = text.replace(/[。．.！!？?～~]+/g, ' ').replace(/[，,；;：:、]+/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  text = sanitizeSegment(text)
  if (text === '') return undefined
  if (text.length > maxBrief) text = `${text.slice(0, Math.max(1, maxBrief - 1))}…`
  return text
}

function mmdd(createdAt, timeZone) {
  const date = new Date(Number.isFinite(createdAt) ? createdAt : Date.now())
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: typeof timeZone === 'string' && timeZone !== '' ? timeZone : undefined,
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)
    const month = parts.find(part => part.type === 'month')?.value
    const day = parts.find(part => part.type === 'day')?.value
    if (typeof month === 'string' && typeof day === 'string') return `${month}${day}`
  } catch {
    /* fall through to UTC */
  }
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

function moduleRulesOf(config) {
  const rules = Array.isArray(config.moduleRules) ? config.moduleRules : []
  const normalized = []
  for (const rule of rules) {
    if (Array.isArray(rule) && rule.length >= 2) {
      normalized.push([String(rule[0]), String(rule[1])])
    } else if (rule !== null && typeof rule === 'object') {
      const pattern = rule.pattern ?? rule.re
      const module = rule.module
      if (typeof pattern === 'string' && typeof module === 'string') {
        normalized.push([pattern, module])
      }
    }
  }
  return normalized
}

function inferModule(text, config) {
  const haystack = String(text ?? '')
  if (haystack !== '') {
    for (const [pattern, module] of moduleRulesOf(config)) {
      let re
      try {
        re = new RegExp(pattern, 'i')
      } catch {
        continue
      }
      if (re.test(haystack)) return module
    }
  }
  return config.defaultModule
}

function cwdAllowed(cwd, config) {
  if (!Array.isArray(config.roots) || config.roots.length === 0) return true
  if (typeof cwd !== 'string' || cwd === '') return false
  return config.roots.some(root => cwd === root || cwd.startsWith(`${root}/`))
}

function eligible(session, config) {
  const header = session?.header
  if (header === undefined || header === null) return false
  if (header.isSeeded === true) return false
  if ((header.delegationDepth ?? 0) > 0) return false
  if (header.origin === 'subagent') return false
  if (header.parentSession !== undefined && header.parentSession !== null) return false
  return cwdAllowed(header.cwd, config)
}

function composeTitle(session, currentTitle, config, overrides) {
  const previous = parseTitle(currentTitle)
  const brief = overrides.brief !== undefined
    ? briefOf(overrides.brief, config.maxBrief)
    : previous?.brief ?? briefOf(currentTitle, config.maxBrief)
  if (brief === undefined) return undefined
  const stage = overrides.stage !== undefined ? overrides.stage : previous?.stage ?? config.defaultStage
  const status = overrides.status !== undefined ? overrides.status : previous?.status ?? config.defaultStatus
  const module = sanitizeSegment(
    overrides.module ?? previous?.module ?? inferModule(currentTitle, config),
  )
  const date = previous?.date ?? mmdd(session?.header?.createdAt, config.timeZone)
  return buildTitle({
    stage: STAGES.includes(stage) ? stage : '',
    status: STATUSES.includes(status) ? status : config.defaultStatus,
    workspace: previous?.workspace ?? workspaceOf(session, config),
    module: module === '' ? config.defaultModule : module,
    date,
    brief,
  })
}

export const inject = ['tools']

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const timers = new Map()
  const attempts = new Map()

  const clearTimer = sessionId => {
    const timer = timers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(sessionId)
    }
  }

  ctx.effect(() => () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    attempts.clear()
  }, 'session-title-convention: timers')

  ctx.inject(['sessionTitle', 'sessions'], sub => {
    const titleService = sub.sessionTitle
    const sessions = sub.sessions
    if (titleService === undefined || typeof titleService.rename !== 'function') return

    const readSnapshot = session => {
      try {
        return titleService.get(session)
      } catch {
        return undefined
      }
    }

    const rewriteNow = (session, reason) => {
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      if (sessionId === '') return undefined
      const count = (attempts.get(sessionId) ?? 0) + 1
      if (count > 3) return undefined
      attempts.set(sessionId, count)

      const snapshot = readSnapshot(session)
      if (snapshot === undefined || typeof snapshot.title !== 'string') return undefined
      if (snapshot.source?.kind === 'user') return undefined
      if (parseTitle(snapshot.title) !== undefined) return undefined
      const next = composeTitle(session, snapshot.title, config, {})
      if (next === undefined) return undefined
      try {
        titleService.rename(session, next)
        attempts.delete(sessionId)
        return next
      } catch (error) {
        const message = String(error)
        // Defensive: a rename that lands inside another append publication is
        // refused by the Session store. Retry on the next tick instead of
        // dropping the title (the attempts cap bounds the retries).
        if (message.includes('cannot reenter') && count < 3) {
          const retry = setTimeout(() => {
            timers.delete(sessionId)
            rewriteNow(session, `${reason}-retry`)
          }, 0)
          retry.unref?.()
          timers.set(sessionId, retry)
          return undefined
        }
        ctx.logger?.warn?.(`session-title-convention: rename failed (${reason}): ${message}`)
        return undefined
      }
    }

    const onSessionEvent = (session, event) => {
      if (event?.type !== 'session/title') return
      const data = event.data
      if (data === undefined || data === null || typeof data.title !== 'string') return
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      if (sessionId === '') return
      if (data.source?.kind === 'user') {
        clearTimer(sessionId)
        return
      }
      if (!eligible(session, config)) return
      if (parseTitle(data.title) !== undefined) {
        clearTimer(sessionId)
        return
      }
      if (data.source?.kind === 'provider') {
        clearTimer(sessionId)
        // Never rename inside the publication of the title event itself:
        // Session.append refuses re-entry while another append is being
        // published, so a synchronous rename() here throws and is swallowed,
        // which is why provider titles stayed unformatted. Defer one tick.
        const timer = setTimeout(() => {
          timers.delete(sessionId)
          rewriteNow(session, 'provider')
        }, 0)
        timer.unref?.()
        timers.set(sessionId, timer)
        return
      }
      clearTimer(sessionId)
      const timer = setTimeout(() => {
        timers.delete(sessionId)
        rewriteNow(session, 'fallback-delay')
      }, Math.max(0, Number(config.fallbackDelayMs) || 0))
      timer.unref?.()
      timers.set(sessionId, timer)
    }

    ctx.on('session/event', onSessionEvent)
    ctx.on('session/disposed', session => {
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      if (sessionId !== '') {
        clearTimer(sessionId)
        attempts.delete(sessionId)
      }
    })

    ctx.tools.register({
      name: 'session_title',
      description:
        'Set the current session title using the workspace convention '
        + '【<stage><status>】<workspace>｜<module>｜<创建日期MMDD>｜<问题简述>. '
        + 'Call it when the session moves to another stage or status (实现/验证/收口/完成). '
        + 'Omitted fields keep the current title parts.',
      parameters: {
        type: 'object',
        properties: {
          stage: { type: 'string', enum: ['', ...STAGES] },
          status: { type: 'string', enum: STATUSES },
          module: { type: 'string' },
          brief: { type: 'string' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
      },
      execute: async (args, exec) => {
        const session = exec?.agent?.session
        if (session === undefined || session === null) {
          throw new Error('session_title: no live agent session is attached to this call')
        }
        const snapshot = readSnapshot(session)
        const currentTitle = typeof snapshot?.title === 'string' ? snapshot.title : ''
        const next = composeTitle(session, currentTitle, config, {
          stage: args?.stage,
          status: args?.status,
          module: args?.module,
          brief: args?.brief,
        })
        if (next === undefined) throw new Error('session_title: the title would be empty')
        titleService.rename(session, next)
        return next
      },
    })

    if (titleService.get !== undefined && sessions?.list !== undefined && config.sweepOnStart === true) {
      const maxAgeMs = Math.max(0, Number(config.sweepMaxAgeMinutes) || 0) * 60_000
      setTimeout(() => {
        let live = []
        try {
          live = sessions.list()
        } catch {
          return
        }
        const now = Date.now()
        for (const session of live) {
          if (!eligible(session, config)) continue
          if (maxAgeMs > 0) {
            const createdAt = Number(session?.header?.createdAt)
            if (!Number.isFinite(createdAt) || now - createdAt > maxAgeMs) continue
          }
          const snapshot = readSnapshot(session)
          if (snapshot === undefined || parseTitle(snapshot.title) !== undefined) continue
          if (snapshot.source?.kind === 'user') continue
          rewriteNow(session, 'sweep')
        }
      }, 2000).unref?.()
    }
  })
}
