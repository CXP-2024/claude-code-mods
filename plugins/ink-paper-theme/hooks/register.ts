import type { Register, ThemeSetArgs } from 'claude-code'

import { makeColors } from './make-colors.js'

// 月白·青黛：日间是带一点灰的月白纸，不发黄；夜间是冷调的夜墨。
// 强调色用青黛（墨绿蓝），报错用褪色的砖红，不再用朱砂。
export const { theme, problems } = makeColors({
  label: 'Moon white and indigo ink',
  // 代码块的底色来自代码高亮主题：默认的浅色方案是纯白，太突兀。
  // catppuccin-latte 底色 #eff1f5，和月白页面同一色系；vitesse-dark 近黑，贴合夜墨。
  codeTheme: { light: 'catppuccin-latte', dark: 'vitesse-dark' },
  roles: {
    accent: '#2f6b73', // 青黛
    danger: '#b5523b', // 砖红，偏橙、低饱和，不像血
    success: '#4f7f5c', // 竹青
    warning: '#a8822e', // 秋香
    pro: '#46608f', // 黛蓝（不用紫）
  },
  light: {
    gray: {
      anchors: {
        // 真正的“月白”：带一点青蓝的白。面板色正好等于终端和代码块的底色
        // （catppuccin-latte 的 #eff1f5），三者连成一片，不再有色差。
        'surface-0': '#eaecf0',
        'surface-1': '#edeff3',
        'surface-2': '#eff1f5',
        'text-primary': '#1b1e25',
        'text-secondary': '#3f4450',
        'text-muted': '#5a6070',
      },
    },
  },
  dark: {
    gray: {
      anchors: {
        'surface-0': '#14171a',
        'surface-1': '#181b1f',
        'surface-2': '#1c2024',
        'surface-3': '#22272c',
        'text-primary': '#e6e9ea',
        'text-secondary': '#bfc5c8',
        'text-muted': '#98a0a5',
      },
    },
  },
})

// 七宝纹：五个相交的圆拼成一块 96×96 的砖，平铺。
// 线色取 surface-2，比底色只亮一点，日夜自动跟随，若隐若现。
const R = 48
const circle = (cx: number, cy: number) =>
  `M${cx - R} ${cy}a${R} ${R} 0 1 0 ${2 * R} 0a${R} ${R} 0 1 0 ${-2 * R} 0`

const LOOK: ThemeSetArgs = {
  colors: theme,
  backdrop: {
    vector: {
      viewBox: [96, 96],
      size: [96, 96],
      repeat: true,
      paths: [
        { d: circle(0, 0), strokeWidth: 1 },
        { d: circle(96, 0), strokeWidth: 1 },
        { d: circle(0, 96), strokeWidth: 1 },
        { d: circle(96, 96), strokeWidth: 1 },
        { d: circle(48, 48), strokeWidth: 1 },
      ],
      color: 'surface-2',
    },
  },
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const unpainted = problems.find(line => line.startsWith("Desktop won't paint"))
    if (unpainted !== undefined) {
      $.ui.toast(unpainted)
    }
    // 重载瞬间桌面端可能还没连上，isDrawn 会是 false，但主题之后照样生效，
    // 所以不再把这句原因挂在底栏上。
    // 清掉旧版本留在底栏的那句提示。
    $.ui.status(undefined)
    await $.theme.set(LOOK)
    return next(e)
  })
}
