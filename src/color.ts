//! Terminal styling. picocolors handles tty detection and `NO_COLOR`.

import pc from 'picocolors'

export const ok = (s: string): string => pc.green(s)
export const warn = (s: string): string => pc.yellow(s)
export const err = (s: string): string => pc.red(s)
export const title = (s: string): string => pc.bold(pc.cyan(s))
export const accent = (s: string): string => pc.cyan(s)
export const dim = (s: string): string => pc.dim(s)
