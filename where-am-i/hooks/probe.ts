import type { AwsInfo, GitInfo, KubeInfo, Tier, Where } from '../types'

// ── Environment names ─────────────────────────────────────────────────────────
// Matched as whole words in kube contexts, namespaces and AWS profile names.
// Edit these lists to match how your environments are named.
const CAUTION = /(?:^|[^a-z])(pre-?prod|staging|stage|stg|demo|launch|uat)(?:\d*)(?=[^a-z]|$)/i
const PROD = /(?:^|[^a-z])(production|prod|prd)(?=[^a-z]|$)/i
const SAFE = /(?:^|[^a-z])(sandbox\d*|devint|dev|qa|test)(?=[^a-z]|$)/i
// Clusters running on this machine: shown as LOCAL.
const LOCAL = /(?:^|[^a-z])(rancher-desktop|docker-desktop|orbstack|minikube|kind|k3d|colima|microk8s|local)(?=[^a-z]|$)/i

const RANK: Record<Tier, number> = { neutral: 0, safe: 1, caution: 2, prod: 3 }

export type Classified = { tier: Tier; env?: string }

/** The most dangerous environment any of `names` points at. */
export function classify(...names: Array<string | undefined>): Classified {
  let best: Classified = { tier: 'neutral' }
  for (const name of names) {
    if (!name) continue
    const one = classifyOne(name)
    if (RANK[one.tier] > RANK[best.tier]) best = one
  }
  return best
}

function classifyOne(name: string): Classified {
  const caution = name.match(CAUTION)
  if (caution?.[1]) return { tier: 'caution', env: caution[1].toUpperCase() }
  const prod = name.match(PROD)
  if (prod?.[1]) return { tier: 'prod', env: 'PRODUCTION' }
  if (LOCAL.test(name)) return { tier: 'safe', env: 'LOCAL' }
  const safe = name.match(SAFE)
  if (safe?.[1]) return { tier: 'safe', env: safe[1].toUpperCase() }
  return { tier: 'neutral' }
}

export function worst(where: Where): Classified {
  let best: Classified = { tier: 'neutral' }
  for (const part of [where.kube, where.aws]) {
    if (part && RANK[part.tier] > RANK[best.tier]) best = { tier: part.tier, env: part.env }
  }
  return best
}

// ── Kubernetes ────────────────────────────────────────────────────────────────

export type Kubeconfig = {
  current?: string
  contexts: Record<string, { cluster?: string; namespace?: string }>
}

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2')

/**
 * The current context and each context's cluster and namespace, read from a
 * kubeconfig as kubectl writes it (block-style YAML). Enough for display; not
 * a general YAML parser.
 */
export function parseKubeconfig(text: string): Kubeconfig {
  const contexts: Kubeconfig['contexts'] = {}
  let current: string | undefined
  let inContexts = false
  let entry: { name?: string; cluster?: string; namespace?: string } | null = null
  const flush = () => {
    if (entry?.name !== undefined && contexts[entry.name] === undefined) {
      contexts[entry.name] = { cluster: entry.cluster, namespace: entry.namespace }
    }
    entry = null
  }
  const field = (s: string) => {
    const m = s.match(/^(name|cluster|namespace):\s*(.*)$/)
    if (m && entry) entry[m[1] as 'name' | 'cluster' | 'namespace'] = unquote(m[2] ?? '')
  }
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue
    if (/^[A-Za-z]/.test(raw)) {
      flush()
      inContexts = /^contexts:/.test(raw)
      const m = raw.match(/^current-context:\s*(.*)$/)
      if (m) current = unquote(m[1] ?? '') || undefined
      continue
    }
    if (!inContexts) continue
    const item = raw.match(/^\s*-\s+(.*)$/)
    if (item) {
      flush()
      entry = {}
      field(item[1] ?? '')
    } else {
      field(raw.trim())
    }
  }
  flush()
  return { current, contexts }
}

/** A short display name: an EKS ARN's cluster, an eksctl context's cluster, or the context. */
export function shortName(context: string, cluster?: string): string {
  const arn = (cluster ?? context).match(/^arn:aws[^:]*:eks:[^:]*:[^:]*:cluster\/(.+)$/)
  if (arn?.[1]) return arn[1]
  const eksctl = context.match(/^[^@]+@([^.]+)\.[^.]+\.eksctl\.io$/)
  if (eksctl?.[1]) return eksctl[1]
  return context
}

export function kubeInfo(config: Kubeconfig): KubeInfo | undefined {
  if (!config.current) return undefined
  const ctx = config.contexts[config.current]
  const name = shortName(config.current, ctx?.cluster)
  const { tier, env } = classify(config.current, name, ctx?.namespace)
  const info: KubeInfo = { context: config.current, name, tier }
  if (ctx?.namespace) info.namespace = ctx.namespace
  if (env) info.env = env
  return info
}

// ── AWS ───────────────────────────────────────────────────────────────────────

/** An INI file as `{ "profile x": { key: value } }`. */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  let section: Record<string, string> | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const head = line.match(/^\[\s*(.+?)\s*\]$/)
    if (head?.[1]) {
      section = out[head[1]] ??= {}
      continue
    }
    const kv = line.match(/^([^=]+?)\s*=\s*(.*)$/)
    if (kv?.[1] && section) section[kv[1]] = kv[2] ?? ''
  }
  return out
}

export type AwsProfile = { profile: string; region?: string; startUrl?: string }

export function awsProfile(
  ini: Record<string, Record<string, string>>,
  profile: string,
  envRegion?: string,
): AwsProfile | undefined {
  const section = profile === 'default' ? ini['default'] : ini[`profile ${profile}`]
  if (!section) return undefined
  const session = section['sso_session'] ? ini[`sso-session ${section['sso_session']}`] : undefined
  const out: AwsProfile = { profile }
  const region = envRegion ?? section['region'] ?? section['sso_region']
  if (region) out.region = region
  const startUrl = section['sso_start_url'] ?? session?.['sso_start_url']
  if (startUrl) out.startUrl = startUrl
  return out
}

/** The latest expiry among SSO token caches for `startUrl`, as epoch ms. */
export function ssoExpiry(caches: unknown[], startUrl: string): number | undefined {
  let best: number | undefined
  for (const c of caches) {
    if (typeof c !== 'object' || c === null) continue
    const { startUrl: url, expiresAt, accessToken } = c as Record<string, unknown>
    if (url !== startUrl || typeof expiresAt !== 'string' || typeof accessToken !== 'string') continue
    const at = Date.parse(expiresAt.replace(/UTC$/, 'Z'))
    if (Number.isFinite(at) && (best === undefined || at > best)) best = at
  }
  return best
}

export function awsInfo(p: AwsProfile, expiresAt?: number): AwsInfo {
  const { tier, env } = classify(p.profile)
  const info: AwsInfo = { profile: p.profile, tier }
  if (p.region) info.region = p.region
  if (expiresAt !== undefined) info.ssoExpiresAt = expiresAt
  if (env) info.env = env
  return info
}

// ── git ───────────────────────────────────────────────────────────────────────

/**
 * `git status --porcelain=v2 --branch` as the branch, ahead and behind, and
 * the entries by kind: staged and unstaged (one entry can be both), untracked
 * and conflicted.
 */
export function parseGitStatus(stdout: string): GitInfo | undefined {
  let head: string | undefined
  let oid: string | undefined
  let ahead = 0
  let behind = 0
  let changes = 0
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicted = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) head = line.slice(14).trim()
    else if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/)
      ahead = Number(m?.[1] ?? 0)
      behind = Number(m?.[2] ?? 0)
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // "1 XY …": X is the staged status, Y the unstaged one, "." for none.
      changes += 1
      if (line[2] !== '.') staged += 1
      if (line[3] !== '.') unstaged += 1
    } else if (line.startsWith('u ')) {
      changes += 1
      conflicted += 1
    } else if (line.startsWith('? ')) {
      changes += 1
      untracked += 1
    }
  }
  if (head === undefined) return undefined
  const branch = head === '(detached)' ? `detached ${oid?.slice(0, 7) ?? ''}`.trim() : head
  return { branch, changes, staged, unstaged, untracked, conflicted, ahead, behind }
}

// ── Display helpers ───────────────────────────────────────────────────────────

/** Time left on an SSO login: "3h 12m", "45m", or "expired". */
export function ssoLeft(expiresAt: number, now: number): string {
  const ms = expiresAt - now
  if (ms <= 0) return 'expired'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export const SSO_WARN_MS = 30 * 60_000

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}
