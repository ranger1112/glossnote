//! FSRS-4.5 的紧凑实现，使用公开默认参数，不做个性化权重训练。
//! 复习界面展示的四个间隔都由这里计算，保证“到期时间可解释”。

use crate::models::RatingPreview;

const DAY_MS: i64 = 86_400_000;
const AGAIN_MS: i64 = 10 * 60 * 1000;
const DESIRED_RETENTION: f64 = 0.9;
const DECAY: f64 = -0.5;
/// 19/81，与 DECAY 配合使 retention=0.9 时的间隔恰好等于 stability。
const FACTOR: f64 = 19.0 / 81.0;
const MAX_INTERVAL_DAYS: f64 = 3650.0;

const W: [f64; 17] = [
    0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616, 0.1544, 1.0824, 1.9813,
    0.0953, 0.2975, 2.2042, 0.2407, 2.9466,
];

const LABELS: [&str; 4] = ["重来", "困难", "良好", "容易"];

#[derive(Clone, Copy, Debug, Default)]
pub struct MemoryState {
    pub stability: f64,
    pub difficulty: f64,
    pub reps: u32,
    pub lapses: u32,
    pub last_reviewed_at: i64,
}

#[derive(Clone, Debug)]
pub struct ReviewOutcome {
    pub stability: f64,
    pub difficulty: f64,
    pub due_at: i64,
    pub reps: u32,
    pub lapses: u32,
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn initial_stability(rating: u8) -> f64 {
    W[(rating.clamp(1, 4) - 1) as usize]
}

pub fn initial_difficulty(rating: u8) -> f64 {
    let rating = rating.clamp(1, 4) as f64;
    clamp(W[4] - (W[5] * (rating - 1.0)).exp() + 1.0, 1.0, 10.0)
}

pub fn retrievability(elapsed_days: f64, stability: f64) -> f64 {
    if stability <= 0.0 {
        return 0.0;
    }
    (1.0 + FACTOR * elapsed_days.max(0.0) / stability).powf(DECAY)
}

/// 期望保留率 `retention` 下应安排的间隔（天）。
pub fn interval_days(stability: f64, retention: f64) -> f64 {
    if stability <= 0.0 {
        return 0.0;
    }
    stability / FACTOR * (retention.powf(1.0 / DECAY) - 1.0)
}

fn next_difficulty(difficulty: f64, rating: u8) -> f64 {
    let rating = rating.clamp(1, 4) as f64;
    let delta = difficulty - W[6] * (rating - 3.0);
    let reverted = W[7] * initial_difficulty(4) + (1.0 - W[7]) * delta;
    clamp(reverted, 1.0, 10.0)
}

fn recall_stability(difficulty: f64, stability: f64, retrievability: f64, rating: u8) -> f64 {
    let hard_penalty = if rating == 2 { W[15] } else { 1.0 };
    let easy_bonus = if rating == 4 { W[16] } else { 1.0 };
    let growth = W[8].exp()
        * (11.0 - difficulty)
        * stability.powf(-W[9])
        * ((W[10] * (1.0 - retrievability)).exp() - 1.0)
        * hard_penalty
        * easy_bonus;

    (stability * (1.0 + growth)).max(0.1)
}

fn forget_stability(difficulty: f64, stability: f64, retrievability: f64) -> f64 {
    (W[11]
        * difficulty.powf(-W[12])
        * ((stability + 1.0).powf(W[13]) - 1.0)
        * (W[14] * (1.0 - retrievability)).exp())
    .max(0.1)
}

pub fn schedule(state: MemoryState, rating: u8, now: i64) -> ReviewOutcome {
    let rating = rating.clamp(1, 4);
    let is_new = state.reps == 0 || state.last_reviewed_at <= 0;

    let (stability, difficulty) = if is_new {
        (initial_stability(rating), initial_difficulty(rating))
    } else {
        let elapsed_days = ((now - state.last_reviewed_at).max(0) as f64) / DAY_MS as f64;
        let retrieved = retrievability(elapsed_days, state.stability);
        let difficulty = next_difficulty(state.difficulty, rating);
        let stability = if rating == 1 {
            forget_stability(state.difficulty, state.stability, retrieved)
        } else {
            recall_stability(state.difficulty, state.stability, retrieved, rating)
        };
        (stability, difficulty)
    };

    let due_at = if rating == 1 {
        now + AGAIN_MS
    } else {
        let days = clamp(
            interval_days(stability, DESIRED_RETENTION).max(1.0),
            1.0,
            MAX_INTERVAL_DAYS,
        );
        now + (days * DAY_MS as f64).round() as i64
    };

    ReviewOutcome {
        stability,
        difficulty,
        due_at,
        reps: state.reps.saturating_add(1),
        lapses: state.lapses + u32::from(rating == 1),
    }
}

pub fn previews(state: MemoryState, now: i64) -> Vec<RatingPreview> {
    (1..=4)
        .map(|rating| {
            let outcome = schedule(state, rating, now);
            RatingPreview {
                rating,
                label: LABELS[(rating - 1) as usize].to_string(),
                due_at: outcome.due_at,
                interval_days: (outcome.due_at - now) as f64 / DAY_MS as f64,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_review_intervals_are_monotonic() {
        let now = 1_000_000_000_000;
        let state = MemoryState::default();
        let outcomes: Vec<ReviewOutcome> =
            (1..=4).map(|rating| schedule(state, rating, now)).collect();

        assert!(outcomes[0].due_at > now);
        assert!(outcomes[0].due_at < outcomes[1].due_at);
        assert!(outcomes[1].due_at < outcomes[2].due_at);
        assert!(outcomes[2].due_at < outcomes[3].due_at);
        assert_eq!(outcomes[2].reps, 1);
        assert_eq!(outcomes[0].lapses, 1);
        assert_eq!(outcomes[2].lapses, 0);
    }

    #[test]
    fn successful_review_grows_stability_and_interval() {
        let now = 1_000_000_000_000;
        let state = MemoryState {
            stability: 3.0,
            difficulty: 5.0,
            reps: 2,
            lapses: 0,
            last_reviewed_at: now - 10 * DAY_MS,
        };
        let outcome = schedule(state, 3, now);

        assert!(outcome.stability > state.stability);
        assert!(outcome.due_at - now > 10 * DAY_MS);
        assert_eq!(outcome.reps, 3);
        assert_eq!(outcome.lapses, 0);
    }

    #[test]
    fn again_shortens_interval_and_counts_lapse() {
        let now = 1_000_000_000_000;
        let state = MemoryState {
            stability: 20.0,
            difficulty: 5.0,
            reps: 5,
            lapses: 1,
            last_reviewed_at: now - 20 * DAY_MS,
        };
        let outcome = schedule(state, 1, now);

        assert!(outcome.stability < state.stability);
        assert_eq!(outcome.due_at, now + AGAIN_MS);
        assert_eq!(outcome.lapses, 2);
    }

    #[test]
    fn difficulty_stays_in_range() {
        for rating in 1..=4 {
            let difficulty = initial_difficulty(rating);
            assert!((1.0..=10.0).contains(&difficulty));

            let next = next_difficulty(10.0, rating);
            assert!((1.0..=10.0).contains(&next));
        }
    }

    #[test]
    fn retrievability_decays_with_time() {
        let fresh = retrievability(0.0, 5.0);
        let later = retrievability(5.0, 5.0);
        assert!((fresh - 1.0).abs() < 1e-9);
        assert!(later < fresh);
        assert!(later > 0.0);
    }

    #[test]
    fn previews_cover_four_ratings() {
        let now = 1_700_000_000_000;
        let previews = previews(MemoryState::default(), now);
        assert_eq!(previews.len(), 4);
        assert_eq!(previews[0].label, "重来");
        assert_eq!(previews[3].label, "容易");
        assert!(previews
            .windows(2)
            .all(|pair| pair[0].due_at <= pair[1].due_at));
    }
}
