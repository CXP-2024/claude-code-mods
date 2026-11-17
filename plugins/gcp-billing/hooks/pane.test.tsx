import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'gcp-billing',
  component: 'Pane',
  requestId: 'gcp-billing',
  props: {
    title: 'GCP · Colab 计费',
    isFocused: false,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)

// What the pane reads, as the session's state holds it (shape tag + value).
const SEED: Record<string, unknown> = {
  snapshot: {
    shape: 'snap-1',
    value: {
      checkedAt: NOW,
      error: null,
      vms: [
        { name: 'h3-run', zone: 'us-east1-b', machine: 'g4-standard-48', status: 'RUNNING', isSpot: true, startedAt: NOW - 90 * 60_000, diskGb: 200 },
        { name: 'old-box', zone: 'us-west1-a', machine: 'g2-standard-8', status: 'TERMINATED', isSpot: true, startedAt: null, diskGb: 50 },
      ],
    },
  },
  now: { shape: 'now-1', value: NOW },
  colab: { shape: 'colab-1', value: { balance: 812.5, ratePerHour: 9, active: 1, checkedAt: NOW, error: null } },
  storage: {
    shape: 'storage-2',
    value: {
      checkedAt: NOW,
      error: null,
      items: [{ kind: 'image', name: 'example-image-20261024', gib: 48, location: 'us', usdPerMonth: 2.4, createdAt: NOW - 30 * 86_400_000 }],
    },
  },
  credit: {
    shape: 'credit-1',
    value: {
      baselineUsd: 166.66,
      baselineAt: NOW - 86_400_000,
      vmUsd: 2.15,
      diskUsd: 0.05,
      storageUsd: 0.2,
      last7dUsd: 12.25,
      vmHours: 1.5,
      checkedAt: NOW,
      error: null,
    },
  },
}

test('both columns draw, with a running VM and a billed Colab runtime', async ($, on) => {
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    return { value: { value: SEED[key], version: 1 } }
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /GCP 赠金余额/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /≈ \$/ }))?.text).toContain('$')
    expect((await ui.find({ type: 'Text', text: /h3-run/ }))?.text).toContain('超过 1 小时')
    // 1.5 h at 1.43 USD/h in us-east1 = $2.15; no NaN anywhere.
    expect((await ui.find({ type: 'Text', text: /g4-standard-48 · us-east1-b/ }))?.text).toContain('$2.15')
    expect(await ui.find({ type: 'Text', text: /NaN/ })).toBeFalsy()
    expect((await ui.find({ type: 'Text', text: /example-image/ }))?.text).toContain('48 GiB')
    expect((await ui.find({ type: 'Text', text: /812\.5 CU/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /1 个运行时在计费/ }))?.text).toBeTruthy()
    await ui.unmount()
  }
})

test('a short pane splits into two columns, a tall one stays single', async ($, on) => {
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    return { value: { value: SEED[key], version: 1 } }
  })

  const directions = async (bodyRows: number) => {
    const ui = await $.ui.mount({
      ...PANE,
      surface: 'desktop',
      props: { ...PANE.props, bodyColumns: 33, scroll: { offset: 0, bodyRows } },
    })
    const boxes = await ui.findAll({ type: 'Box' })
    const dirs = boxes.map(b => b.props.flexDirection)
    await ui.unmount()
    return dirs
  }

  // The refresh line is always a row; the columns add a second one only when split.
  const rows = (dirs: unknown[]) => dirs.filter(d => d === 'row').length
  expect(rows(await directions(20))).toBe(2)
  expect(rows(await directions(200))).toBe(1)
})
