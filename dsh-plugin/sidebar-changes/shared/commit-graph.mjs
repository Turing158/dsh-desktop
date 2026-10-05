/** Stable lanes for a topologically ordered prefix, including its page frontier. */
export function layoutCommits(entries) {
  let lanes = [], nextColor = 0
  return entries.map(entry => {
    const before = lanes.map(lane => ({ ...lane }))
    let column = lanes.findIndex(lane => lane.id === entry.id)
    const incoming = column !== -1
    if (!incoming) { column = lanes.length; lanes.push({ id: entry.id, color: nextColor++ % 6 }) }
    const color = lanes[column].color
    lanes.splice(column, 1)
    const parents = [...new Set(entry.parents)]
    parents.forEach((id, index) => {
      if (!lanes.some(lane => lane.id === id)) lanes.splice(Math.min(column + index, lanes.length), 0, { id, color: index === 0 ? color : nextColor++ % 6 })
    })
    const after = lanes.map(lane => ({ ...lane }))
    return { id: entry.id, column, color, incoming,
      passing: before.flatMap((lane, from) => lane.id === entry.id ? [] : [{ from, to: after.findIndex(value => value.id === lane.id), color: lane.color }]),
      parents: parents.map(id => { const to = after.findIndex(lane => lane.id === id); return { id, to, color: after[to].color } }),
      columns: Math.max(1, before.length, after.length, column + 1), frontier: after }
  })
}
