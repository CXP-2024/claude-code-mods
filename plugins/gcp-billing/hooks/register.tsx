import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot, Vm } from '../types'

const PANE = 'gcp-billing'
const POLL_MS = 60_000
const WARN_HOURS = 1

const snapshot = atom({ plugin: 'gcp-billing', key: 'snapshot' } as const, null, { shape: 'snap-1' })
const nowAtom = atom({ plugin: 'gcp-billing', key: 'now' } as const, 0, { shape: 'now-1' })

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

async function tick($: EngineInterface): Promise<void> {
    const snap = await poll($)
    await update($, snapshot, () => snap)
    await update($, nowAtom, () => snap.checkedAt)
    const running = snap.vms.filter(v => v.status === 'RUNNING')
    if (running.length === 0) {
      $.ui.status(undefined)
    } else {
      const total = running.reduce((s, v) => s + (rate(v) ?? 0) * hours(v, snap.checkedAt), 0)
      $.ui.status(`GCP ${running.length} 台运行中 ≈${usd(total)}`)
    }
    for (const v of running) {
      const h = hours(v, snap.checkedAt)
      const id = `${v.name}@${v.startedAt}`
      if (h >= WARN_HOURS && !warned.has(id)) {
        warned.add(id)
        void $.ui.notify(`${v.name} 已运行 ${hm(h)}，记得检查或删除`, { title: 'GCP 计费提醒' })
        $.ui.toast(`GCP：${v.name} 已运行超过 ${WARN_HOURS} 小时`, { timeoutMs: 10_000 })
      }
    }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gcp', description: '打开 GCP 计费面板并立即刷新' })
    void tick($)
    $.clock.every(POLL_MS, () => void tick($))
    // 每 15 秒只走本地时钟，让时长和金额跳动，不额外调用 gcloud。
    $.clock.every(15_000, () => {
      void $.clock.now().then(t => update($, nowAtom, () => t))
    })
    void $.ui.open({ id: PANE, title: 'GCP 计费' })
    return next(e)
  })

  on('command.run', { command: 'gcp' }, async $ => {
    await $.ui.open({ id: PANE, title: 'GCP 计费' })
    await tick($)
    return { text: 'GCP 计费面板已刷新。' }
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

    return (
      <Box flexDirection="column" gap={2}>
        {snap.error !== null && (
          <Text color="error" size="footnote">
            查询失败：{snap.error}
          </Text>
        )}

        <Box flexDirection="column" gap={1}>
          <Text size="caption" dimColor>
            {running.length === 0 ? '当前' : `运行中 ${running.length} 台`}
          </Text>
          <Text size="title" weight="semibold" tabular>
            {running.length === 0 ? '空闲' : `${usd(spent)}`}
          </Text>
          <Text size="footnote" dimColor tabular>
            {running.length === 0
              ? '没有运行中的虚拟机，不产生机器费用'
              : `本次开机至今 · 每小时 ${usd(perHour)}${unknown ? '+' : ''}`}
          </Text>
          {unknown && (
            <Text size="footnote" color="warning">
              有机型不在价格表里，未计入
            </Text>
          )}
        </Box>

        {running.map(v => {
          const r = rate(v)
          const h = hours(v, now)
          const isLong = h >= WARN_HOURS
          return (
            <Box flexDirection="column" key={v.name}>
              <Text weight="semibold" color={isLong ? 'warning' : undefined}>
                {v.name}
                {isLong ? ' · 超过 1 小时' : ''}
              </Text>
              <Text size="footnote" dimColor>
                {v.machine} · {v.zone}
              </Text>
              <Text size="footnote" dimColor>
                {v.isSpot ? 'Spot' : '按需'} · 磁盘 {v.diskGb} GB
              </Text>
              <Text size="footnote" tabular>
                {hm(h)} · {r === null ? '单价未知' : `${usd(r)}/时 · ${usd(r * h)}`}
              </Text>
            </Box>
          )
        })}

        {others.length > 0 && (
          <Box flexDirection="column">
            <Text size="caption" dimColor>
              已停止 {others.length} 台 · 磁盘约 {usd(idleDisk * DISK_PER_GB_MONTH)}/月
            </Text>
            {others.map(v => (
              <Text size="footnote" dimColor key={v.name}>
                {v.name} · {v.zone}
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column" gap={1}>
          <Box>
            <Button key="refresh" label="立即刷新" onPress={() => tick($)} />
          </Box>
          <Text size="caption" dimColor>
            {ago <= 1 ? '刚刚刷新' : `${ago} 秒前刷新`} · 每分钟自动
          </Text>
          <Text size="caption" dimColor>
            单价按 11-09 实测，含机器和磁盘
          </Text>
          <Text size="caption" dimColor>
            不含下行流量，以账单为准
          </Text>
        </Box>
      </Box>
    )
  })
}
