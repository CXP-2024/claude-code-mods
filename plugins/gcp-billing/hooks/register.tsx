import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Colab, Credit, Snapshot, Storage, StorageItem, Vm } from '../types'

const PANE = 'gcp-billing'
const POLL_MS = 60_000
const WARN_HOURS = 1

const snapshot = atom({ plugin: 'gcp-billing', key: 'snapshot' } as const, null, { shape: 'snap-1' })
const nowAtom = atom({ plugin: 'gcp-billing', key: 'now' } as const, 0, { shape: 'now-1' })
const colabAtom = atom({ plugin: 'gcp-billing', key: 'colab' } as const, null, { shape: 'colab-1' })
const storageAtom = atom({ plugin: 'gcp-billing', key: 'storage' } as const, null, { shape: 'storage-2' })

// 机器本身的每小时单价（USD，不含磁盘和下行流量）。
// 来源：Google Cloud Billing Catalog，2026-11-09 查询；Spot 价每天浮动。
const PRICES: Record<string, number> = {
  'g4-standard-48|us-east1|spot': 1.43,
  'g4-standard-48|us-west1|spot': 1.43,
  'g4-standard-48|us-central1|spot': 1.68,
  'g4-standard-48|asia-east1|spot': 2.6,
  'g4-standard-48|us-central1|std': 4.5,
  'g4-standard-24|us-central1|spot': 0.94,
  'g4-standard-12|us-central1|spot': 0.47,
  'g4-standard-6|us-central1|spot': 0.23,
  'g2-standard-8|us-central1|spot': 0.51,
}
// 磁盘按 GiB·月计，约 0.08 USD，折成每小时。
const DISK_PER_GB_MONTH = 0.08
const DISK_PER_GB_HOUR = DISK_PER_GB_MONTH / 730

const lastPart = (path: string) => path.split('/').pop() ?? path
const regionOf = (zone: string) => zone.replace(/-[a-z]$/, '')

function rate(vm: Vm): number | null {
  const key = `${vm.machine}|${regionOf(vm.zone)}|${vm.isSpot ? 'spot' : 'std'}`
  return PRICES[key] ?? null
}

function hours(vm: Vm, now: number): number {
  return vm.status === 'RUNNING' && vm.startedAt !== null ? Math.max(0, (now - vm.startedAt) / 3_600_000) : 0
}

function hm(h: number): string {
  const m = Math.floor(h * 60)
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

const usd = (n: number) => `$${n.toFixed(2)}`

type Raw = {
  name: string
  zone: string
  machineType: string
  status: string
  lastStartTimestamp?: string
  scheduling?: { provisioningModel?: string; preemptible?: boolean }
  disks?: { diskSizeGb?: string }[]
}

const GCLOUD =
  'gcloud compute instances list --format=json(name,zone,machineType,status,lastStartTimestamp,scheduling,disks[].diskSizeGb)'

async function poll($: EngineInterface): Promise<Snapshot> {
  const checkedAt = await $.clock.now()
  try {
    const res = await $.process.run(['cmd.exe', '/d', '/s', '/c', GCLOUD], { timeoutMs: 45_000 })
    if (res.exitCode !== 0) {
      const line = res.stderr.trim().split('\n').pop() ?? ''
      return { vms: [], checkedAt, error: line || 'gcloud 失败' }
    }
    const raw = JSON.parse(res.stdout || '[]') as Raw[]
    return {
      checkedAt,
      error: null,
      vms: raw.map(r => ({
        name: r.name,
        zone: lastPart(r.zone),
        machine: lastPart(r.machineType),
        status: r.status,
        isSpot: r.scheduling?.provisioningModel === 'SPOT' || r.scheduling?.preemptible === true,
        startedAt: r.lastStartTimestamp ? Date.parse(r.lastStartTimestamp) : null,
        diskGb: (r.disks ?? []).reduce((s, d) => s + Number(d.diskSizeGb ?? 0), 0),
      })),
    }
  } catch (err) {
    return { vms: [], checkedAt, error: String(err).slice(0, 160) }
  }
}

const warned = new Set<string>()

// Colab：官方 Colab CLI 只能在 Linux 上跑，这里装在 WSL 里（/root/envs/colab-cli）。
// `colab usage` 只读，不开运行时、不花计算单元。余额本身有延迟，5 分钟查一次足够。
const COLAB_CLI = '/root/envs/colab-cli/bin/colab'
const COLAB_POLL_MS = 5 * 60_000
// Pro+ 49.99 USD / 600 CU。
const USD_PER_CU = 49.99 / 600

async function pollColab($: EngineInterface): Promise<Colab> {
  const checkedAt = await $.clock.now()
  const empty = { balance: null, ratePerHour: null, active: null, checkedAt }
  try {
    const res = await $.process.run(
      ['wsl.exe', '-e', 'bash', '-lc', `${COLAB_CLI} usage </dev/null 2>&1`],
      { timeoutMs: 60_000 },
    )
    const out = res.stdout
    if (/accounts\.google\.com|authorization code|invalid_grant/i.test(out)) {
      return { ...empty, error: 'Colab 登录已失效：在 WSL 里运行 colab usage 重新登录' }
    }
    const num = (re: RegExp) => {
      const m = re.exec(out)
      return m?.[1] !== undefined ? Number(m[1]) : null
    }
    const balance = num(/balance:\s*([\d.]+)/i)
    if (balance === null) {
      const line = out.trim().split('\n').pop() ?? ''
      return { ...empty, error: line ? line.slice(0, 160) : 'colab usage 没有输出' }
    }
    return {
      balance,
      ratePerHour: num(/rate:\s*([\d.]+)/i),
      active: num(/assignments:\s*(\d+)/i),
      checkedAt,
      error: null,
    }
  } catch (err) {
    return { ...empty, error: String(err).slice(0, 160) }
  }
}

// 存储：不开机也一直计费的东西。镜像和快照按存储的（压缩后）大小计，闲置磁盘按容量计。
// 单价（USD / GiB·月，美国区，2026-11 公开价，约数）：
const GIB = 1024 ** 3
const IMAGE_PER_GIB_MONTH = 0.05
const SNAPSHOT_PER_GIB_MONTH = 0.05
const DISK_TYPE_PER_GB_MONTH: Record<string, number> = {
  'pd-standard': 0.04,
  'pd-balanced': 0.1,
  'pd-ssd': 0.17,
  'hyperdisk-balanced': 0.08,
}
const STORAGE_POLL_MS = 10 * 60_000
const when = (iso?: string) => (iso ? Date.parse(iso) : null)

async function gcloudJson<T>($: EngineInterface, args: string): Promise<T[]> {
  const res = await $.process.run(['cmd.exe', '/d', '/s', '/c', `gcloud ${args}`], { timeoutMs: 60_000 })
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim().split('\n').pop() || `gcloud ${args.split(' ')[1]} 失败`)
  }
  return JSON.parse(res.stdout || '[]') as T[]
}

async function pollStorage($: EngineInterface): Promise<Storage> {
  const checkedAt = await $.clock.now()
  try {
    const [images, disks, snapshots, machineImages] = await Promise.all([
      gcloudJson<{ name: string; archiveSizeBytes?: string; storageLocations?: string[]; creationTimestamp?: string }>(
        $,
        'compute images list --no-standard-images --format=json(name,archiveSizeBytes,storageLocations,creationTimestamp)',
      ),
      gcloudJson<{ name: string; zone: string; sizeGb?: string; type?: string; users?: string[]; creationTimestamp?: string }>(
        $,
        'compute disks list --format=json(name,zone,sizeGb,type,users,creationTimestamp)',
      ),
      gcloudJson<{ name: string; storageBytes?: string; storageLocations?: string[]; creationTimestamp?: string }>(
        $,
        'compute snapshots list --format=json(name,storageBytes,storageLocations,creationTimestamp)',
      ),
      gcloudJson<{ name: string; totalStorageBytes?: string; storageLocations?: string[]; creationTimestamp?: string }>(
        $,
        'compute machine-images list --format=json(name,totalStorageBytes,storageLocations,creationTimestamp)',
      ),
    ])
    const items: StorageItem[] = []
    for (const i of images) {
      const gib = Number(i.archiveSizeBytes ?? 0) / GIB
      items.push({ kind: 'image', name: i.name, gib, location: (i.storageLocations ?? []).join(','), usdPerMonth: gib * IMAGE_PER_GIB_MONTH, createdAt: when(i.creationTimestamp) })
    }
    // 挂在虚拟机上的磁盘已在虚拟机那里算过，这里只算没挂载的。
    for (const d of disks.filter(d => (d.users ?? []).length === 0)) {
      const gib = Number(d.sizeGb ?? 0)
      const type = lastPart(d.type ?? '')
      items.push({ kind: 'disk', name: d.name, gib, location: lastPart(d.zone), usdPerMonth: gib * (DISK_TYPE_PER_GB_MONTH[type] ?? 0.1), createdAt: when(d.creationTimestamp) })
    }
    for (const s of snapshots) {
      const gib = Number(s.storageBytes ?? 0) / GIB
      items.push({ kind: 'snapshot', name: s.name, gib, location: (s.storageLocations ?? []).join(','), usdPerMonth: gib * SNAPSHOT_PER_GIB_MONTH, createdAt: when(s.creationTimestamp) })
    }
    for (const m of machineImages) {
      const gib = Number(m.totalStorageBytes ?? 0) / GIB
      items.push({ kind: 'machine-image', name: m.name, gib, location: (m.storageLocations ?? []).join(','), usdPerMonth: gib * SNAPSHOT_PER_GIB_MONTH, createdAt: when(m.creationTimestamp) })
    }
    return { items, checkedAt, error: null }
  } catch (err) {
    return { items: [], checkedAt, error: String(err instanceof Error ? err.message : err).slice(0, 160) }
  }
}

async function tickStorage($: EngineInterface): Promise<void> {
  const s = await pollStorage($)
  await update($, storageAtom, () => s)
}

// ---- 赠金余额推算 ----------------------------------------------------------
// 控制台里的赠金余额，gcloud 和 API 都读不到。做法：用户用 /gcp-credit <金额> 设一次基准，
// 之后从审计日志还原每台虚拟机的开机区间（开机 / 关机 / 删除 / Spot 抢占），
// 按单价算机器费和启动盘费，再加镜像等存储费，从基准里扣。不含下行流量和税。
// 审计日志默认只保留 30 天，所以基准最好每两三周按控制台校准一次。
const creditAtom = atom({ plugin: 'gcp-billing', key: 'credit' } as const, null, { shape: 'credit-1' })
const BASELINE_KEY = 'credit-baseline'
const HOUR = 3_600_000
const DAY = 24 * HOUR
// 日志里不记磁盘大小：G4 按 200 GB hyperdisk，其他按 50 GB pd-balanced 估。
const defaultDiskUsdPerHour = (machine: string) =>
  machine.startsWith('g4-') ? (200 * 0.08) / 730 : (50 * 0.1) / 730

type Baseline = { usd: number; at: number }

// 基准存在用户目录下的一个文件里，而不是 $.store：$.store 按插件来源分开存，
// 开发版和正式安装版、不同会话之间会读不到彼此设的基准。
async function baselinePath($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  return `${home}\\.claude\\gcp-billing-credit.json`
}

const isBaseline = (v: unknown): v is Baseline =>
  typeof v === 'object' && v !== null && typeof (v as Baseline).usd === 'number' && typeof (v as Baseline).at === 'number'

async function readBaseline($: EngineInterface): Promise<Baseline | null> {
  try {
    const path = await baselinePath($)
    if (await $.fs.exists(path)) {
      const v: unknown = JSON.parse(await $.fs.read(path))
      if (isBaseline(v)) return v
    }
  } catch {
    // 文件坏了就当没设，走下面的旧存储
  }
  // 兼容 0.4.0 存在 $.store 里的基准，读到就迁到文件里。
  const old: unknown = await $.store.get(BASELINE_KEY)
  if (isBaseline(old)) {
    await writeBaseline($, old)
    return old
  }
  return null
}

async function writeBaseline($: EngineInterface, b: Baseline): Promise<void> {
  await $.fs.write(await baselinePath($), JSON.stringify(b, null, 2))
}

let gcloudPy: [string, string] | null = null

// gcloud.cmd 经过 cmd.exe，带空格和引号的日志过滤条件会被吃掉；
// 改为直接调用 SDK 自带的 python.exe + gcloud.py，参数原样传入。
async function findGcloudPy($: EngineInterface): Promise<[string, string]> {
  if (gcloudPy) return gcloudPy
  const res = await $.process.run(['cmd.exe', '/d', '/s', '/c', 'where gcloud.cmd'], { timeoutMs: 15_000 })
  const cmdPath = res.stdout.split(/\r?\n/).find(l => l.trim().toLowerCase().endsWith('gcloud.cmd'))?.trim()
  if (!cmdPath) throw new Error('找不到 gcloud.cmd')
  const root = cmdPath.replace(/[\\/]bin[\\/]gcloud\.cmd$/i, '')
  gcloudPy = [`${root}\\platform\\bundledpython\\python.exe`, `${root}\\lib\\gcloud.py`]
  return gcloudPy
}

type AuditEntry = {
  timestamp: string
  operation?: { first?: boolean; last?: boolean }
  resource?: { labels?: { zone?: string } }
  protoPayload: {
    methodName: string
    resourceName: string
    status?: { code?: number }
    request?: { machineType?: string }
  }
}

async function readAudit($: EngineInterface, days: number): Promise<AuditEntry[]> {
  const [py, script] = await findGcloudPy($)
  const res = await $.process.run(
    [
      py,
      script,
      'logging',
      'read',
      'resource.type="gce_instance" AND protoPayload.methodName:"compute.instances."',
      `--freshness=${days}d`,
      '--limit=5000',
      '--format=json(timestamp,protoPayload.methodName,protoPayload.resourceName,resource.labels.zone,operation.first,operation.last,protoPayload.status.code,protoPayload.request.machineType)',
    ],
    { timeoutMs: 120_000 },
  )
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim().split('\n').pop() || 'gcloud logging read 失败')
  }
  return JSON.parse(res.stdout || '[]') as AuditEntry[]
}

type VmLife = { machine: string; zone: string; ups: [number, number][]; lives: [number, number][] }

// 把审计日志还原成每台虚拟机的“运行区间”和“存在区间”。
function reconstruct(entries: AuditEntry[], snap: Snapshot | null, now: number): Map<string, VmLife> {
  const vms = new Map<string, VmLife>()
  const get = (name: string) => {
    let v = vms.get(name)
    if (!v) {
      v = { machine: '', zone: '', ups: [], lives: [] }
      vms.set(name, v)
    }
    return v
  }
  const open = new Map<string, { up: number | null; born: number | null }>()
  const sorted = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  for (const e of sorted) {
    const p = e.protoPayload
    const method = p.methodName.split('.').pop() ?? ''
    const name = lastPart(p.resourceName)
    const op = e.operation ?? {}
    const t = Date.parse(e.timestamp)
    const v = get(name)
    if (method === 'insert' && op.first && p.request?.machineType) {
      v.machine = lastPart(p.request.machineType)
      v.zone = e.resource?.labels?.zone ?? ''
    }
    if ((p.status?.code ?? 0) !== 0) continue // 缺货等失败操作不计费
    const o = open.get(name) ?? { up: null, born: null }
    open.set(name, o)
    if ((method === 'insert' || method === 'start' || method === 'resume') && op.last) {
      if (o.up === null) o.up = t
      if (method === 'insert') o.born = t
    } else if (
      ((method === 'stop' || method === 'deferredStop' || method === 'suspend') && op.last) ||
      ((method === 'preempted' || method === 'guestTerminate' || method === 'delete') && op.first)
    ) {
      if (o.up !== null) v.ups.push([o.up, t])
      o.up = null
      if (method === 'delete') {
        v.lives.push([o.born ?? 0, t])
        o.born = null
      }
    }
  }
  // 还开着的：以 gcloud 当前状态为准，补上没有关机记录的区间。
  for (const vm of snap?.vms ?? []) {
    const v = get(vm.name)
    if (!v.machine) {
      v.machine = vm.machine
      v.zone = vm.zone
    }
    const o = open.get(vm.name) ?? { up: null, born: null }
    if (vm.status === 'RUNNING') v.ups.push([o.up ?? vm.startedAt ?? now, now])
    v.lives.push([o.born ?? 0, now])
  }
  return vms
}

const overlapHours = ([a, b]: [number, number], from: number, to: number) =>
  Math.max(0, Math.min(b, to) - Math.max(a, from)) / HOUR

function spendBetween(vms: Map<string, VmLife>, storage: Storage | null, from: number, to: number) {
  let vmUsd = 0
  let diskUsd = 0
  let vmHours = 0
  for (const v of vms.values()) {
    const r = PRICES[`${v.machine}|${regionOf(v.zone)}|spot`] ?? 0
    for (const u of v.ups) {
      const hrs = overlapHours(u, from, to)
      vmHours += hrs
      vmUsd += hrs * r
    }
    for (const l of v.lives) diskUsd += overlapHours(l, from, to) * defaultDiskUsdPerHour(v.machine)
  }
  let storageUsd = 0
  for (const i of storage?.items ?? []) {
    storageUsd += overlapHours([i.createdAt ?? 0, to], from, to) * (i.usdPerMonth / 730)
  }
  return { vmUsd, diskUsd, storageUsd, vmHours }
}

async function tickCredit($: EngineInterface): Promise<void> {
  const base = await readBaseline($)
  if (base === null) {
    await update($, creditAtom, () => null)
    return
  }
  const now = await $.clock.now()
  const from7 = now - 7 * DAY
  const since = Math.min(base.at, from7)
  const days = Math.min(30, Math.ceil((now - since) / DAY) + 1)
  try {
    const [entries, snap, storage] = await Promise.all([
      readAudit($, days),
      read($, snapshot),
      read($, storageAtom),
    ])
    const vms = reconstruct(entries, snap, now)
    const s = spendBetween(vms, storage, base.at, now)
    const w = spendBetween(vms, storage, from7, now)
    const credit: Credit = {
      baselineUsd: base.usd,
      baselineAt: base.at,
      ...s,
      last7dUsd: w.vmUsd + w.diskUsd + w.storageUsd,
      checkedAt: now,
      error: now - base.at > 30 * DAY ? '基准已超过 30 天，日志不全，请按控制台重设一次' : null,
    }
    await update($, creditAtom, () => credit)
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 160)
    await update($, creditAtom, old => (old ? { ...old, error: msg } : null))
  }
}

const KIND_LABEL: Record<StorageItem['kind'], string> = {
  image: '镜像',
  disk: '闲置磁盘',
  snapshot: '快照',
  'machine-image': '机器映像',
}

async function tickColab($: EngineInterface): Promise<void> {
  const c = await pollColab($)
  await update($, colabAtom, () => c)
  await refreshStatus($)
}

async function refreshStatus($: EngineInterface): Promise<void> {
  const parts: string[] = []
  const snap = await read($, snapshot)
  const running = snap?.vms.filter(v => v.status === 'RUNNING') ?? []
  if (snap !== null && running.length > 0) {
    const total = running.reduce((s, v) => s + (rate(v) ?? 0) * hours(v, snap.checkedAt), 0)
    parts.push(`GCP ${running.length} 台运行中 ≈${usd(total)}`)
  }
  const c = await read($, colabAtom)
  if (c !== null && (c.active ?? 0) > 0) {
    parts.push(`Colab ${c.active} 个运行时 ${c.ratePerHour ?? '?'} CU/时`)
  }
  $.ui.status(parts.length > 0 ? parts.join(' · ') : undefined)
}

async function tick($: EngineInterface): Promise<void> {
    const snap = await poll($)
    await update($, snapshot, () => snap)
    await update($, nowAtom, () => snap.checkedAt)
    const running = snap.vms.filter(v => v.status === 'RUNNING')
    await refreshStatus($)
    for (const v of running) {
      const hrs = hours(v, snap.checkedAt)
      const id = `${v.name}@${v.startedAt}`
      if (hrs >= WARN_HOURS && !warned.has(id)) {
        warned.add(id)
        void $.ui.notify(`${v.name} 已运行 ${hm(hrs)}，记得检查或删除`, { title: 'GCP 计费提醒' })
        $.ui.toast(`GCP：${v.name} 已运行超过 ${WARN_HOURS} 小时`, { timeoutMs: 10_000 })
      }
    }
}

async function refreshAll($: EngineInterface): Promise<void> {
  await tick($)
  await tickStorage($)
  await tickCredit($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gcp', description: '打开 GCP / Colab 计费面板并立即刷新' })
    await $.command.register({
      name: 'gcp-credit',
      description: '设定 GCP 赠金余额基准（控制台显示的剩余金额），如 /gcp-credit 166.66',
    })
    void tickColab($)
    // 余额推算要用到虚拟机状态和存储列表，按顺序跑。
    void tick($).then(() => tickStorage($)).then(() => tickCredit($))
    $.clock.every(POLL_MS, () => void tick($))
    $.clock.every(COLAB_POLL_MS, () => void tickColab($))
    $.clock.every(STORAGE_POLL_MS, () => void tickStorage($).then(() => tickCredit($)))
    // 每 15 秒只走本地时钟，让时长和金额跳动，不额外调用 gcloud。
    $.clock.every(15_000, () => {
      void $.clock.now().then(t => update($, nowAtom, () => t))
    })
    void $.ui.open({ id: PANE, title: 'GCP · Colab 计费' })
    return next(e)
  })

  on('command.run', { command: 'gcp' }, async $ => {
    await $.ui.open({ id: PANE, title: 'GCP · Colab 计费' })
    await Promise.all([refreshAll($), tickColab($)])
    return { text: 'GCP / Colab 计费面板已刷新。' }
  })

  on('command.run', { command: 'gcp-credit' }, async ($, e) => {
    const usdText = e.args.trim().replace(/^\$/, '')
    const usd = Number(usdText)
    if (usdText === '' || !Number.isFinite(usd) || usd < 0) {
      const base = await readBaseline($)
      return {
        text: base
          ? `当前基准：$${base.usd.toFixed(2)}（${new Date(base.at).toLocaleString()} 设定）。用法：/gcp-credit 166.66`
          : '用法：/gcp-credit 166.66（填控制台 Billing > Credits 里所有可用赠金的剩余金额之和）',
      }
    }
    await writeBaseline($, { usd, at: await $.clock.now() })
    await $.ui.open({ id: PANE, title: 'GCP · Colab 计费' })
    await tickCredit($)
    return { text: `已设定赠金基准 $${usd.toFixed(2)}，之后面板会按审计日志自动往下扣。` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)

    if (snap === null) {
      return <Text dimColor>正在查询 gcloud…</Text>
    }

    const now = Math.max(await read($, nowAtom), snap.checkedAt)
    const running = snap.vms.filter(v => v.status === 'RUNNING')
    const others = snap.vms.filter(v => v.status !== 'RUNNING')
    let perHour = 0
    let spent = 0
    let unknown = false
    for (const v of running) {
      const r = rate(v)
      if (r === null) unknown = true
      const all = (r ?? 0) + v.diskGb * DISK_PER_GB_HOUR
      perHour += all
      spent += all * hours(v, now)
    }
    const idleDisk = others.reduce((s, v) => s + v.diskGb, 0)
    const ago = Math.round((now - snap.checkedAt) / 1000)
    const colab = await read($, colabAtom)
    const colabActive = (colab?.active ?? 0) > 0
    const colabRate = colab?.ratePerHour ?? 0
    const colabAgo = colab === null ? 0 : Math.round((now - colab.checkedAt) / 60_000)
    const storage = await read($, storageAtom)
    const storageMonthly = (storage?.items ?? []).reduce((s, i) => s + i.usdPerMonth, 0)
    const storageGib = (storage?.items ?? []).reduce((s, i) => s + i.gib, 0)
    const credit = await read($, creditAtom)
    // 推算结果每 10 分钟更新；其间把正在跑的机器按秒加上去，数字随时间走。
    const liveExtra = credit === null ? 0 : perHour * Math.max(0, now - credit.checkedAt) / HOUR
    const creditSpent = credit === null ? 0 : credit.vmUsd + credit.diskUsd + credit.storageUsd + liveExtra
    const creditLeft = credit === null ? 0 : credit.baselineUsd - creditSpent
    const perDay7 = credit === null ? 0 : credit.last7dUsd / 7
    const daysLeft = perDay7 > 0 ? Math.floor(creditLeft / perDay7) : null
    const md = (t: number) => {
      const d = new Date(t)
      return `${d.getMonth() + 1}-${d.getDate()}`
    }

    // 左右两栏：左 GCP（余额推算 / 虚拟机 / 存储），右 Colab；底部一行刷新状态。
    // 每块只留一个大数字，其余压成一两行小字，整块尽量不用滚动。
    const section = (title: string) => (
      <Text size="caption" weight="medium" dimColor>
        {title}
      </Text>
    )

    const gcpColumn = (
      <Box flexDirection="column" gap={2} width="58%" flexShrink={1}>
        {/* 赠金余额 */}
        <Box flexDirection="column">
          {section('GCP 赠金余额 · 推算')}
          {credit === null ? (
            <Text size="footnote" dimColor>
              输入 /gcp-credit 加控制台显示的剩余赠金，设一次基准
            </Text>
          ) : (
            <Box flexDirection="column">
              <Text size="title" weight="semibold" tabular color={creditLeft < 20 ? 'warning' : undefined}>
                ≈ {usd(creditLeft)}
              </Text>
              <Text size="footnote" dimColor tabular>
                基准 {usd(credit.baselineUsd)}（{md(credit.baselineAt)}）· 已用 {usd(creditSpent)}
              </Text>
              <Text size="footnote" dimColor tabular>
                日均 {usd(perDay7)}（近 7 天）{daysLeft !== null ? ` · 约 ${daysLeft} 天用完` : ''}
              </Text>
              {credit.error !== null && (
                <Text size="footnote" color="warning">
                  {credit.error}
                </Text>
              )}
            </Box>
          )}
        </Box>

        {/* 虚拟机 */}
        <Box flexDirection="column">
          {section(running.length === 0 ? '虚拟机' : `虚拟机 · 运行中 ${running.length} 台`)}
          {snap.error !== null && (
            <Text size="footnote" color="error">
              查询失败：{snap.error}
            </Text>
          )}
          {running.length === 0 ? (
            <Text size="footnote" dimColor>
              空闲，不产生机器费用
            </Text>
          ) : (
            <Text size="heading" weight="semibold" tabular>
              {usd(spent)}
              <Text size="footnote" weight="regular" dimColor>
                {'  '}每小时 {usd(perHour)}
                {unknown ? '+' : ''}
              </Text>
            </Text>
          )}
          {running.map(v => {
            const r = rate(v)
            const hrs = hours(v, now)
            const isLong = hrs >= WARN_HOURS
            return (
              <Box flexDirection="column" key={v.name}>
                <Text size="footnote" weight="semibold" color={isLong ? 'warning' : undefined}>
                  {v.name}
                  {isLong ? ' · 超过 1 小时' : ''}
                </Text>
                <Text size="footnote" dimColor tabular>
                  {v.machine} · {v.zone} · {v.isSpot ? 'Spot' : '按需'} · {hm(hrs)} ·{' '}
                  {r === null ? '单价未知' : `${usd(r * hrs)}`}
                </Text>
              </Box>
            )
          })}
          {others.length > 0 && (
            <Text size="footnote" dimColor>
              已停止 {others.length} 台（{others.map(v => v.name).join('、')}）· 磁盘约{' '}
              {usd(idleDisk * DISK_PER_GB_MONTH)}/月
            </Text>
          )}
        </Box>

        {/* 存储 */}
        <Box flexDirection="column">
          {section('存储 · 不开机也计费')}
          {storage === null ? (
            <Text size="footnote" dimColor>
              正在查询…
            </Text>
          ) : storage.error !== null ? (
            <Text size="footnote" color="error">
              {storage.error}
            </Text>
          ) : storage.items.length === 0 ? (
            <Text size="footnote" dimColor>
              没有镜像、闲置磁盘或快照
            </Text>
          ) : (
            <Box flexDirection="column">
              <Text size="footnote" tabular>
                {usd(storageMonthly)}/月 · {storageGib.toFixed(0)} GiB · {usd(storageMonthly / 30)}/天
              </Text>
              {storage.items.map(i => (
                <Text size="caption" dimColor tabular key={`${i.kind}:${i.name}`}>
                  {KIND_LABEL[i.kind]} {i.name} · {i.gib.toFixed(0)} GiB · {usd(i.usdPerMonth)}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      </Box>
    )

    const colabColumn = (
      <Box flexDirection="column" gap={2} width="42%" flexShrink={1}>
        <Box flexDirection="column">
          {section('Colab Pro+')}
          {colab === null ? (
            <Text size="footnote" dimColor>
              正在查询 colab usage…
            </Text>
          ) : colab.error !== null ? (
            <Text size="footnote" color="error">
              {colab.error}
            </Text>
          ) : (
            <Box flexDirection="column">
              <Text size="title" weight="semibold" tabular>
                {(colab.balance ?? 0).toFixed(1)} CU
              </Text>
              <Text size="footnote" dimColor tabular>
                约值 {usd((colab.balance ?? 0) * USD_PER_CU)}（Pro+ 单价）
              </Text>
              {colabActive ? (
                <Box flexDirection="column">
                  <Text size="footnote" color="warning" tabular>
                    {colab.active} 个运行时在计费 · {colabRate} CU/时
                  </Text>
                  <Text size="footnote" dimColor tabular>
                    约 {usd(colabRate * USD_PER_CU)}/时
                    {colabRate > 0 ? ` · 约 ${Math.floor((colab.balance ?? 0) / colabRate)} 小时用完` : ''}
                  </Text>
                  <Text size="footnote" dimColor>
                    用完 colab stop，再 colab sessions 确认
                  </Text>
                </Box>
              ) : (
                <Text size="footnote" dimColor>
                  没有运行时在计费
                </Text>
              )}
            </Box>
          )}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={2}>
        <Box flexDirection="row" columnGap={3} alignItems="flex-start">
          {gcpColumn}
          {colabColumn}
        </Box>

        <Box flexDirection="row" columnGap={2} alignItems="center">
          <Button
            key="refresh"
            label="立即刷新"
            onPress={async () => {
              await Promise.all([refreshAll($), tickColab($)])
            }}
          />
          <Text size="caption" dimColor>
            GCP {ago <= 1 ? '刚刚' : `${ago} 秒前`} · Colab {colabAgo < 1 ? '刚刚' : `${colabAgo} 分钟前`} ·
            不含流量，以账单为准
          </Text>
        </Box>
      </Box>
    )
  })
}
