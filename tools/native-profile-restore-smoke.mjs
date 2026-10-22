// Extend the affected transaction scenarios to all three components. Existing
// two-component evidence is retained separately and need not be repeated.
process.env.DSH_RESTORE_PROFILE_CHECK='1'
await import('./native-backup-restore-smoke.mjs')
