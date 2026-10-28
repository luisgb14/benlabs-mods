import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { cell, DARK, narrowRows, partsOf, type Seg } from '../hooks/band'
import { classify, parseGitStatus, parseIni, parseKubeconfig, shortName, ssoExpiry } from '../hooks/probe'
import type { Where } from '../types'

const NOW = Date.parse('2026-10-06T14:00:00Z')
const HOME = '/Users/dev'

const KUBECONFIG = `apiVersion: v1
clusters:
- cluster:
    server: https://example.eks.amazonaws.com
  name: arn:aws:eks:us-east-1:111122223333:cluster/globex-production
contexts:
- context:
    cluster: arn:aws:eks:us-east-1:111122223333:cluster/globex-production
    namespace: orders
    user: arn:aws:eks:us-east-1:111122223333:cluster/globex-production
  name: arn:aws:eks:us-east-1:111122223333:cluster/globex-production
- context:
    cluster: sandbox1
    user: sandbox1
  name: sandbox1
current-context: CURRENT
kind: Config
users:
- name: sandbox1
  user:
    token: not-a-real-token
`

const AWS_CONFIG = `[default]
region = us-east-1

[profile globex-production]
sso_session = globex
sso_account_id = 111122223333
sso_role_name = Admin
region = us-east-1

[profile sandbox1]
sso_session = globex
region = us-west-2

[sso-session globex]
sso_start_url = https://globex.awsapps.com/start
sso_region = us-east-1
`

const SSO_TOKEN = JSON.stringify({
  startUrl: 'https://globex.awsapps.com/start',
  region: 'us-east-1',
  accessToken: 'x',
  expiresAt: '2026-10-06T17:12:00Z',
})

const GIT = `# branch.oid 0123456789abcdef
# branch.head feature/where-am-i
# branch.upstream origin/feature/where-am-i
# branch.ab +1 -0
1 .M N... 100644 100644 100644 abc abc hooks/register.tsx
? tests/new.test.tsx
`

const band = (bodyColumns: number) =>
  ({
    plugin: 'where-am-i',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns, scroll: { offset: 0, bodyRows: 11 }, view: {} },
  }) as const

/** The engine beneath the plugin, over a fake home with the given current context and profile. */
function engine(on: On, context: string, profile: string, theme = 'dark') {
  mock.store(on)
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME, AWS_PROFILE: profile })
  const files: Record<string, string> = {
    [`${HOME}/.kube/config`]: KUBECONFIG.replace('CURRENT', context),
    [`${HOME}/.aws/config`]: AWS_CONFIG,
    [`${HOME}/.aws/sso/cache/abc.json`]: SSO_TOKEN,
  }
  on('fs.read', ($, e) => {
    const body = files[e.path]
    if (body === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: body }
  })
  on('fs.list', () => ({ value: [{ name: 'abc.json', kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false }] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: GIT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('config.list', () => ({ value: [{ key: 'theme', value: theme }] as never }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>from-below</Text>
  })
}

const PROD_CONTEXT = 'arn:aws:eks:us-east-1:111122223333:cluster/globex-production'

test('parses kubeconfig, AWS config, SSO cache and git status', () => {
  const kube = parseKubeconfig(KUBECONFIG.replace('CURRENT', PROD_CONTEXT))
  expect(kube.current).toBe(PROD_CONTEXT)
  expect(kube.contexts[PROD_CONTEXT]?.namespace).toBe('orders')
  expect(shortName(PROD_CONTEXT)).toBe('globex-production')
  expect(parseIni(AWS_CONFIG)['sso-session globex']?.['sso_start_url']).toBe('https://globex.awsapps.com/start')
  expect(ssoExpiry([JSON.parse(SSO_TOKEN)], 'https://globex.awsapps.com/start')).toBe(Date.parse('2026-10-06T17:12:00Z'))
  expect(parseGitStatus(GIT)).toEqual({
    branch: 'feature/where-am-i',
    changes: 2,
    staged: 0,
    unstaged: 1,
    untracked: 1,
    conflicted: 0,
    ahead: 1,
    behind: 0,
  })
  const busy = '# branch.oid 0\n# branch.head main\n1 MM N... a\n1 A. N... b\nu UU N... c\n? d\n'
  expect(parseGitStatus(busy)).toMatchObject({ changes: 4, staged: 2, unstaged: 1, untracked: 1, conflicted: 1 })
})

test('names environments: prod, pre-prod and sandboxes, as whole words only', () => {
  expect(classify('globex-production')).toEqual({ tier: 'prod', env: 'PRODUCTION' })
  expect(classify('orders-prd')).toEqual({ tier: 'prod', env: 'PRODUCTION' })
  expect(classify('preprod')).toEqual({ tier: 'caution', env: 'PREPROD' })
  expect(classify('globex-staging')).toEqual({ tier: 'caution', env: 'STAGING' })
  expect(classify('sandbox1')).toEqual({ tier: 'safe', env: 'SANDBOX1' })
  expect(classify('devint')).toEqual({ tier: 'safe', env: 'DEVINT' })
  expect(classify('rancher-desktop')).toEqual({ tier: 'safe', env: 'LOCAL' })
  expect(classify('kind-orders')).toEqual({ tier: 'safe', env: 'LOCAL' })
  expect(classify('devops-admin').tier).toBe('neutral')
  expect(classify('productivity').tier).toBe('neutral')
  expect(classify('sandbox1', 'globex-production').tier).toBe('prod')
})

test('production: a red banner on the limits-meter grid, with a PROD badge, stacked above other mods', async ($, on) => {
  engine(on, PROD_CONTEXT, 'globex-production')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...band(150), surface: 'terminal' })
  const tree = await ui.drawn()
  expect(tree).toMatchObject({ type: 'Box', props: { flexDirection: 'column' } })
  expect((await ui.find({ type: 'Box', key: 'where' }))?.props.borderStyle).toBeUndefined()
  const badge = await ui.find({ type: 'Text', text: ' PROD ' })
  expect(badge?.props.backgroundColor).toBe('#d20f39')
  // Every other cell sits on the dark red banner, which runs the full width.
  const name = await ui.find({ type: 'Text', text: 'globex-production' })
  expect(name?.props).toMatchObject({ color: '#d20f39', backgroundColor: '#2c1418', bold: true })
  const band150 = await ui.find({ type: 'Box', key: 'where' })
  expect(band150?.text.length).toBe(150)
  const row = await ui.find({ type: 'Box', key: 'row-0' })
  const cells = (row?.children ?? []) as Array<{ props?: Record<string, unknown> }>
  expect(cells.length).toBeGreaterThan(5)
  expect(cells.every(c => c.props?.backgroundColor !== undefined)).toBe(true)
  expect(await ui.find({ text: 'orders' })).toBeDefined()
  expect(await ui.find({ text: 'sso 3h 12m' })).toBeDefined()
  expect(await ui.find({ text: 'feature/where-am-i' })).toBeDefined()
  // git marks as powerlevel10k writes them: ahead, modified, untracked.
  expect((await ui.find({ type: 'Text', text: '⇡1' }))?.props.color).toBe('#1e66f5')
  expect((await ui.find({ type: 'Text', text: '!1' }))?.props.color).toBe('#df8e1d')
  expect((await ui.find({ type: 'Text', text: '?1' }))?.props.color).toBe('#04a5e5')
  // What the next plugin down drew is still there.
  expect(await ui.find({ text: 'from-below' })).toBeDefined()
  await ui.unmount()

  const desk = await $.ui.mount({ ...band(150), surface: 'desktop' })
  const svg = await desk.find({ type: 'Svg' })
  expect(String(svg?.props.alt)).toMatch(
    /Environment PRODUCTION; kube globex-production namespace orders; aws globex-production, SSO 3h 12m; git feature\/where-am-i, 1 modified, 1 untracked, 1 to push/,
  )
  const source = String(svg?.props.source)
  expect(source).toMatch(/^<svg /)
  // The same banner, badge and marks as the terminal line.
  expect(source).toMatch(/<rect class="banner"/)
  expect(source).toMatch(/fill="#d20f39"\/><text [^>]*>PROD<\/text>/)
  expect(source).toMatch(/<tspan fill="#1e66f5" font-weight="700">⇡1<\/tspan>/)
  expect(await desk.find({ text: 'from-below' })).toBeDefined()
})

test('sandbox: no banner, a green environment word, and /where explains it all', async ($, on) => {
  engine(on, 'sandbox1', 'sandbox1')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...band(150), surface: 'terminal' })
  expect((await ui.find({ type: 'Box', key: 'where' }))?.props.borderStyle).toBeUndefined()
  const named = await ui.findAll({ type: 'Text', text: 'sandbox1' })
  // The kube value in blue, its environment word in green, the AWS profile in peach.
  expect(named.map(t => t.props.color)).toEqual(['#1e66f5', '#40a02b', '#fe640b'])
  expect(named.every(t => t.props.backgroundColor === undefined)).toBe(true)
  await ui.unmount()

  const desk = await $.ui.mount({ ...band(150), surface: 'desktop' })
  const source = String((await desk.find({ type: 'Svg' }))?.props.source)
  expect(source).not.toMatch(/class="banner"/)
  expect(source).toMatch(/<tspan fill="#40a02b">sandbox1<\/tspan>/)
  await desk.unmount()

  const out = await $.command.run({ command: 'where', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(out.text).toMatch(/Where am I · SANDBOX1/)
  expect(out.text).toMatch(/aws {2}sandbox1 · us-west-2 · SSO expires in 3h 12m/)
  expect(out.text).toMatch(/git {2}feature\/where-am-i · 1 modified · 1 untracked · 1 to push/)

  await $.command.run({ command: 'where', args: 'hide', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  const hidden = await $.ui.mount({ ...band(150), surface: 'terminal' })
  expect(await hidden.find({ key: 'where' })).toBeUndefined()
  expect(await hidden.find({ text: 'from-below' })).toBeDefined()
})

test('narrow terminals: one part per row when one line is too tight; light themes get their banner', async ($, on) => {
  engine(on, PROD_CONTEXT, 'globex-production', 'light')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...band(60), surface: 'terminal' })
  const rows = await Promise.all(['row-0', 'row-1', 'row-2'].map(key => ui.find({ type: 'Box', key })))
  expect(rows.map(r => r?.text.trimEnd())).toEqual([
    ' k8s globex-production   orders  PROD',
    ' aws globex-production   us-east-1 · sso 3h 12m',
    ' git feature/where-am-i  ⇡1 !1 ?1',
  ])
  expect(rows.every(r => r?.text.length === 60)).toBe(true)
  expect((await ui.find({ type: 'Text', text: 'globex-production' }))?.props).toMatchObject({ color: '#d20f39', backgroundColor: '#fde4e8' })
})

test('fitting: whole names before minor details; PROD badges, git marks and expiring logins stay', () => {
  const text = (segs: Seg[]) => segs.map(s => s.text).join('')
  const calm: Where = {
    kube: { context: 'rancher-desktop', name: 'rancher-desktop', tier: 'safe', env: 'LOCAL' },
    aws: { profile: 'cn-globex-ey', region: 'us-east-1', ssoExpiresAt: NOW + 53 * 60_000, tier: 'neutral' },
    git: { branch: 'main', changes: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, ahead: 0, behind: 0 },
  }
  const [kube, aws, git] = partsOf(calm, NOW, DARK)
  if (kube === undefined || aws === undefined || git === undefined) throw new Error('three parts')
  // Wide: everything. Narrow: "local" goes rather than clip the name.
  expect(text(cell(kube, 35))).toBe(`k8s rancher-desktop${' '.repeat(11)}local`)
  expect(text(cell(kube, 25))).toBe(`k8s rancher-desktop${' '.repeat(6)}`)
  expect(text(cell(aws, 46))).toBe(`aws cn-globex-ey${' '.repeat(11)}us-east-1 · sso 53m`)
  expect(text(cell(aws, 35))).toBe(`aws cn-globex-ey${' '.repeat(12)}sso 53m`)
  // One line at 66 columns: minor details go, git's mark stays.
  expect(narrowRows([kube, aws, git], 66).map(text)).toEqual([' k8s rancher-desktop   aws cn-globex-ey   git main !1'])
  // A production cluster keeps its badge and clips its name instead.
  const prod = partsOf({ kube: { context: 'x', name: 'globex-production-blue', namespace: 'orders', tier: 'prod', env: 'PRODUCTION' } }, NOW, DARK)[0]
  if (prod === undefined) throw new Error('kube part')
  expect(text(cell(prod, 25))).toBe('k8s globex-produ…   PROD ')
})
