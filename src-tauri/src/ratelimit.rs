use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// Simple per-command rate limiter using a sliding window.
pub struct RateLimiter {
    buckets: Mutex<HashMap<&'static str, Vec<Instant>>>,
    max_calls: usize,
    window_secs: u64,
}

impl RateLimiter {
    pub fn new(max_calls: usize, window_secs: u64) -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
            max_calls,
            window_secs,
        }
    }

    pub fn check(&self, command: &'static str) -> bool {
        let now = Instant::now();
        // A panicking holder must not poison the limiter into crashing every
        // later command; recover the inner data instead of propagating.
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        let timestamps = buckets.entry(command).or_default();

        let cutoff = now - std::time::Duration::from_secs(self.window_secs);
        timestamps.retain(|&t| t > cutoff);

        if timestamps.len() >= self.max_calls {
            return false;
        }

        timestamps.push(now);
        true
    }
}

/// General commands: 10 calls/sec
pub static RATE_LIMITER: Lazy<RateLimiter> = Lazy::new(|| RateLimiter::new(10, 1));

/// SIP commands: 2 calls/sec
pub static SIP_RATE_LIMITER: Lazy<RateLimiter> = Lazy::new(|| RateLimiter::new(2, 1));
