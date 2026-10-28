import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AwsInfo, GitInfo, KubeInfo, Where } from '../types'
import { DARK, GRID_MIN, gridRow, LIGHT, narrowRows, partsOf, tint, type Seg } from './band'
import { whereCard } from './draw'
import {
  awsInfo,
  awsProfile,
  kubeInfo,
  parseGitStatus,
  parseIni,
  parseKubeconfig,
  ssoExpiry,
  ssoLeft,
  worst,
  type Kubeconfig,
} from './probe'

// Shape-tagged: a hot reload from 0.2.0, which kept fewer git counts, reads it as absent.
const where = atom({ plugin: 'where-am-i', key: 'where' } as const, null, { shape: 'where-v2' })
const isHidden = atom({ plugin: 'where-am-i', key: 'isHidden' } as const, false)

const STORE_HIDDEN = 'isHidden'
const TICK_MS = 15_000
const SSO_CACHE_FILES = 40

type $ = EngineInterface

/** The session's working directory; follows `cd` through CwdChanged. */
let cwd: string | undefined

/** Set per session from the /config theme; light themes get the deeper palette. */
let isLightTheme = false

async function readTheme($: $) {
  try {
    const row = (await $.config.list()).find(r => r.key === 'theme')
    isLightTheme = typeof row?.value === 'string' && row.value.includes('light')
  } catch {
    isLightTheme = false
  }
}

const text = (v: unknown) => (typeof v === 'string' ? v : undefined)

async function readText($: $, path: string): Promise<string | undefined> {
  try {
    return text(await $.fs.read(path))
  } catch {
    return undefined
  }
}

/** Current kube context from the kubeconfig files themselves: no kubectl, no PATH. */
async function probeKube($: $, home: string): Promise<KubeInfo | undefined> {
  const env = await $.env.get('KUBECONFIG')
  const files = (env ? env.split(':') : [`${home}/.kube/config`])
    .filter(Boolean)
    .map(f => f.replace(/^~(?=\/|$)/, home))
  const merged: Kubeconfig = { contexts: {} }
  for (const file of files) {
    const body = await readText($, file)
    if (body === undefined) continue
    const one = parseKubeconfig(body)
    merged.current ??= one.current
    for (const [name, ctx] of Object.entries(one.contexts)) merged.contexts[name] ??= ctx
  }
  return kubeInfo(merged)
}

/** The session's AWS profile, its region, and when its SSO login expires. */
async function probeAws($: $, home: string): Promise<AwsInfo | undefined> {
  const explicit = (await $.env.get('AWS_PROFILE')) ?? (await $.env.get('AWS_DEFAULT_PROFILE'))
  const profile = explicit ?? 'default'
  const region = (await $.env.get('AWS_REGION')) ?? (await $.env.get('AWS_DEFAULT_REGION'))
  const configPath = (await $.env.get('AWS_CONFIG_FILE')) ?? `${home}/.aws/config`
  const body = await readText($, configPath)
  const p = awsProfile(parseIni(body ?? ''), profile, region)
  if (p === undefined) {
    // A profile set in the environment but not in the config still says where you are.
    return explicit ? awsInfo(region ? { profile, region } : { profile }) : undefined
  }
  if (p.startUrl === undefined) return awsInfo(p)

  const dir = `${home}/.aws/sso/cache`
  const entries = await $.fs.list(dir).catch(() => [])
  const newest = entries
    .filter(f => f.kind === 'file' && f.name.endsWith('.json'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, SSO_CACHE_FILES)
  const caches: unknown[] = []
  for (const f of newest) {
    const raw = await readText($, `${dir}/${f.name}`)
    try {
      if (raw !== undefined) caches.push(JSON.parse(raw))
    } catch {
      // not a token cache
    }
  }
  return awsInfo(p, ssoExpiry(caches, p.startUrl))
}

async function probeGit($: $): Promise<GitInfo | undefined> {
  try {
    const run = await $.process.run(
      ['git', 'status', '--porcelain=v2', '--branch'],
      cwd === undefined ? { timeoutMs: 5_000 } : { cwd, timeoutMs: 5_000 },
    )
    return run.exitCode === 0 ? parseGitStatus(run.stdout) : undefined
  } catch {
    return undefined
  }
}

/** Look again; write the state only when something changed, so idle ticks draw nothing. */
async function refresh($: $) {
  const home = (await $.env.get('HOME')) ?? ''
  const [kube, aws, git] = await Promise.all([probeKube($, home), probeAws($, home), probeGit($)])
  const next: Where = {}
  if (kube) next.kube = kube
  if (aws) next.aws = aws
  if (git) next.git = git
  const current = await read($, where)
  if (JSON.stringify(current) !== JSON.stringify(next)) await update($, where, () => next)
}

function detail(w: Where | null, now: number): string {
  if (w === null || (!w.kube && !w.aws && !w.git)) return 'No kube context, AWS profile or git repository found.'
  const { env } = worst(w)
  const lines = [`Where am I${env ? ` · ${env}` : ''}`]
  if (w.kube) lines.push(`  k8s  ${w.kube.context}${w.kube.namespace ? `  (namespace ${w.kube.namespace})` : ''}`)
  if (w.aws) {
    let line = `  aws  ${w.aws.profile}${w.aws.region ? ` · ${w.aws.region}` : ''}`
    if (w.aws.ssoExpiresAt !== undefined) {
      const left = ssoLeft(w.aws.ssoExpiresAt, now)
      line += left === 'expired' ? ' · SSO expired' : ` · SSO expires in ${left}`
    }
    lines.push(line)
  }
  if (w.git) {
    const g = w.git
    const bits = [g.branch]
    for (const [n, what] of [
      [g.conflicted, 'conflicted'],
      [g.staged, 'staged'],
      [g.unstaged, 'modified'],
      [g.untracked, 'untracked'],
      [g.ahead, 'to push'],
      [g.behind, 'to pull'],
    ] as const) {
      if (n > 0) bits.push(`${n} ${what}`)
    }
    lines.push(`  git  ${bits.join(' · ')}`)
  }
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await readTheme($)
    await $.command.register({
      name: 'where',
      description: 'Show your kube context, AWS profile and git branch (show | hide the band)',
    })
    const hidden = await $.store.get(STORE_HIDDEN)
    await update($, isHidden, () => hidden === true)
    await refresh($)
    $.clock.every(TICK_MS, () => {
      void refresh($)
      $.ui.invalidate('ui.render') // the SSO countdown
    })
    return next(e)
  })

  // Claude's shell commands are what switch contexts and profiles: look after each.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    void refresh($)
    return ran
  }).catch(($, e, next) => next(e))

  on('classic.CwdChanged', async ($, e, next) => {
    cwd = e.new_cwd
    void refresh($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'where' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'hide' || arg === 'off') {
      await update($, isHidden, () => true)
      await $.store.set(STORE_HIDDEN, true)
      return { text: 'Where-am-i band hidden in every session. Run /where show to bring it back.' }
    }
    if (arg === 'show' || arg === 'on') {
      await update($, isHidden, () => false)
      await $.store.set(STORE_HIDDEN, false)
      return { text: 'Where-am-i band is back above the prompt.' }
    }
    await refresh($)
    return { text: detail(await read($, where), await $.clock.now()) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const hidden = await read($, isHidden)
    const w = await read($, where)
    // Whatever other mods draw here stays: this band stacks above it.
    const rest = await next(e)
    if (hidden || w === null || (!w.kube && !w.aws && !w.git)) return rest
    const now = await $.clock.now()

    // The desktop app draws the same line as an image, on limits-meter's card columns.
    if (e.surface === 'desktop') {
      const { Box, Svg } = $.ui.resolve(e)
      const card = whereCard(w, now, e.props.bodyColumns)
      return (
        <Box flexDirection="column">
          <Svg key="where" source={card.source} alt={card.alt} />
          {rest}
        </Box>
      )
    }
    if (e.surface !== 'terminal') return rest

    // One row on limits-meter's columns (narrow terminals: packed, or one part per row);
    // a red banner on production.
    const { Box, Text } = $.ui.resolve(e)
    const p = isLightTheme ? LIGHT : DARK
    const columns = e.props.bodyColumns
    const parts = partsOf(w, now, p)
    let rows: Seg[][] = columns >= GRID_MIN ? [gridRow(parts, columns)] : narrowRows(parts, columns)
    if (worst(w).tier === 'prod') rows = rows.map(row => tint(row, columns, p.prodBg))
    return (
      <Box flexDirection="column">
        <Box key="where" flexDirection="column">
          {rows.map((row, r) => (
            <Box key={`row-${r}`} flexDirection="row">
              {row.map((s, i) => (
                <Text
                  key={`where-${r}-${i}`}
                  {...(s.color === undefined ? {} : { color: s.color })}
                  {...(s.bg === undefined ? {} : { backgroundColor: s.bg })}
                  {...(s.bold === true ? { bold: true } : {})}
                  {...(s.dim === true ? { dimColor: true } : {})}
                >
                  {s.text}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
        {rest}
      </Box>
    )
  })
}
