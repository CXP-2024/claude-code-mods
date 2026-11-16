export type Vm = {
  name: string
  zone: string
  machine: string
  status: string
  isSpot: boolean
  startedAt: number | null
  diskGb: number
}

export type Snapshot = {
  vms: Vm[]
  checkedAt: number
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'gcp-billing': { snapshot: Shaped<Snapshot | null>; now: Shaped<number> }
  }
}
