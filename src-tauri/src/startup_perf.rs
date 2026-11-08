//! Opt-in startup timings in the existing DSH_DESKTOP_DEBUG log.
use std::{sync::OnceLock, time::Instant};

static START: OnceLock<Instant> = OnceLock::new();

pub fn mark(stage: &str) {
    let started = START.get_or_init(Instant::now);
    crate::debug_log(&format!("[startup-perf] stage={stage} elapsed_ms={}", started.elapsed().as_millis()));
}
