import type { Register, ThemeSetArgs } from 'claude-code'

import { makeColors } from './make-colors.js'

// A winter night: deep navy surfaces, ice-blue accent, warm amber for warnings.
// No backdrop: the page is the plain surface-0 navy.
const { theme, problems } = makeColors({
  label: 'Navy night',
  only: 'dark',
  roles: { accent: '#8fc8ff', danger: '#e5607a', success: '#6fc48f', warning: '#f2b45a', pro: '#b9a6f0' },
  dark: {
    gray: {
      anchors: {
        'surface-0': '#0b0f1a',
        'surface-1': '#111727',
        'surface-2': '#161d30',
        'surface-3': '#1b2338',
        'text-primary': '#e8eef8',
        'text-secondary': '#b9c6dc',
        'text-muted': '#8e9bb4',
      },
    },
  },
})

const LOOK: ThemeSetArgs = { colors: theme, overrideColorScheme: 'dark' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const unpainted = problems.find(line => line.startsWith("Desktop won't paint"))
    if (unpainted !== undefined) {
      $.ui.toast(unpainted)
    }
    await $.theme.set(LOOK)
    return next(e)
  })
}
