export function diffLines(before, after, options = {}) {
  const left = before.split(/\r?\n/)
  const right = after.split(/\r?\n/)
  const maxCells = options.maxCells ?? 2_000_000
  if (left.length * right.length > maxCells) return simpleDiff(left, right)
  const dp = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1))
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const operations = []
  let i = 0
  let j = 0
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      operations.push(` ${left[i]}`), i += 1, j += 1
    } else if (j < right.length && (i === left.length || dp[i][j + 1] >= dp[i + 1][j])) {
      operations.push(`+${right[j++]}`)
    } else operations.push(`-${left[i++]}`)
  }
  return compactOperations(operations, options.context ?? 3).join('\n')
}

function compactOperations(operations, context) {
  const changed = operations.flatMap((line, index) => line[0] === ' ' ? [] : [index])
  if (!changed.length) return ['--- before', '+++ after', ' (no changes)']
  const keep = new Set()
  for (const index of changed) {
    for (let cursor = Math.max(0, index - context); cursor <= Math.min(operations.length - 1, index + context); cursor += 1) keep.add(cursor)
  }
  const output = ['--- before', '+++ after']
  let previous = -2
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index > previous + 1) output.push(`@@ ${index + 1} @@`)
    output.push(operations[index])
    previous = index
  }
  return output
}

function simpleDiff(left, right) {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return ['--- before', '+++ after', ...left.filter(line => !rightSet.has(line)).map(line => `-${line}`), ...right.filter(line => !leftSet.has(line)).map(line => `+${line}`)].join('\n')
}
