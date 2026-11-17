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

export type StorageItem = {
  kind: 'image' | 'disk' | 'snapshot' | 'machine-image'
  name: string
  gib: number
  location: string
  usdPerMonth: number
  createdAt: number | null
}

export type Credit = {
  baselineUsd: number
  baselineAt: number
  vmUsd: number
  diskUsd: number
  storageUsd: number
  last7dUsd: number
  vmHours: number
  checkedAt: number
  error: string | null
}

export type Storage = {
  items: StorageItem[]
  checkedAt: number
  error: string | null
}

export type Colab = {
  balance: number | null
  ratePerHour: number | null
  active: number | null
  checkedAt: number
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'gcp-billing': {
      snapshot: Shaped<Snapshot | null>
      now: Shaped<number>
      colab: Shaped<Colab | null>
      storage: Shaped<Storage | null>
      credit: Shaped<Credit | null>
    }
  }
}
