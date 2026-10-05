/** DSH 0.2 projects the selected conversation through mainView ownership. */
export function currentSessionId(list) {
  return list.current ?? Object.values(list.byId || {}).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id
}
