use crate::error::{EngineError, EngineResult};
use serde::{Deserialize, Serialize};

/// Integer minor units (paise for INR). Money never uses floating point.
pub type Minor = i64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum RoundingMode {
    #[default]
    HalfUp,
    HalfEven,
}

impl RoundingMode {
    pub fn parse(value: &str) -> Self {
        match value {
            "half-even" => RoundingMode::HalfEven,
            _ => RoundingMode::HalfUp,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            RoundingMode::HalfUp => "half-up",
            RoundingMode::HalfEven => "half-even",
        }
    }
}

/// Round a minor amount to a positive step. Half-up rounds away from zero.
pub fn round_to_step(value: Minor, step: Minor, mode: RoundingMode) -> EngineResult<Minor> {
    if step <= 0 {
        return Err(EngineError::InvalidStep(step));
    }
    let remainder = value % step;
    if remainder == 0 {
        return Ok(value);
    }

    let sign = if value < 0 { -1 } else { 1 };
    let abs = value.unsigned_abs();
    let step_u = step as u64;
    let quotient = abs / step_u;
    let rem = abs % step_u;
    let half = step_u / 2;

    let round_up = if step_u.is_multiple_of(2) {
        match rem.cmp(&half) {
            std::cmp::Ordering::Greater => true,
            std::cmp::Ordering::Less => false,
            std::cmp::Ordering::Equal => match mode {
                RoundingMode::HalfUp => true,
                RoundingMode::HalfEven => quotient % 2 == 1,
            },
        }
    } else {
        // No exact half for odd steps: compare 2*rem with step.
        (rem * 2) > step_u
    };

    let rounded = if round_up { quotient + 1 } else { quotient };
    let result = (rounded as i128) * (step as i128) * (sign as i128);
    i64::try_from(result).map_err(|_| EngineError::AmountOverflow(value.to_string()))
}

/// The explicit round-off posting needed to move `value` to the nearest step.
pub fn round_off_difference(value: Minor, step: Minor, mode: RoundingMode) -> EngineResult<Minor> {
    Ok(round_to_step(value, step, mode)? - value)
}

/// Split a total across non-negative integer weights using the largest-remainder
/// method, guaranteeing the parts sum exactly to the total.
pub fn allocate_minor(total: Minor, weights: &[i64]) -> EngineResult<Vec<Minor>> {
    if weights.is_empty() {
        return Err(EngineError::ZeroWeights);
    }
    if weights.iter().any(|w| *w < 0) {
        return Err(EngineError::InvalidAmount(
            "weights must be non-negative".into(),
        ));
    }
    let weight_sum: i128 = weights.iter().map(|w| *w as i128).sum();
    if weight_sum == 0 {
        return Err(EngineError::ZeroWeights);
    }

    let sign: i128 = if total < 0 { -1 } else { 1 };
    let abs_total = (total as i128).abs();

    let mut floors = Vec::with_capacity(weights.len());
    let mut remainders = Vec::with_capacity(weights.len());
    let mut assigned: i128 = 0;
    for (index, weight) in weights.iter().enumerate() {
        let numerator = abs_total * (*weight as i128);
        let floor = numerator / weight_sum;
        let remainder = numerator % weight_sum;
        floors.push(floor);
        remainders.push((index, remainder));
        assigned += floor;
    }

    let mut leftover = abs_total - assigned;
    remainders.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    for (index, _) in remainders {
        if leftover <= 0 {
            break;
        }
        floors[index] += 1;
        leftover -= 1;
    }

    floors
        .into_iter()
        .map(|value| {
            let signed = value * sign;
            i64::try_from(signed).map_err(|_| EngineError::AmountOverflow(total.to_string()))
        })
        .collect()
}

/// Parse a human-formatted amount into integer minor units.
///
/// Accepts Indian/Western grouping, currency symbols/codes, parentheses
/// negatives, trailing `-`, and `Dr`/`Cr` suffixes.
pub fn parse_amount_to_minor(
    input: &str,
    minor_unit: u32,
    mode: RoundingMode,
) -> EngineResult<Minor> {
    let mut text = input.trim().to_string();
    if text.is_empty() {
        return Err(EngineError::InvalidAmount("empty amount".into()));
    }

    let mut negative = false;
    if text.starts_with('(') && text.ends_with(')') {
        negative = true;
        text = text[1..text.len() - 1].to_string();
    }
    if text.ends_with('-') {
        negative = !negative;
        text.pop();
    }

    // Strip currency symbols/codes, grouping separators and whitespace.
    let mut cleaned = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            ',' | ' ' | '\u{00a0}' | '\u{20b9}' | '$' => continue,
            _ => cleaned.push(ch),
        }
    }
    let lower = cleaned.to_ascii_lowercase();
    for prefix in ["rs.", "rs", "inr", "usd", "eur", "gbp", "aed", "sgd"] {
        if lower.starts_with(prefix) {
            cleaned = cleaned[prefix.len()..].to_string();
            break;
        }
    }

    let lower = cleaned.to_ascii_lowercase();
    let (mut body, dr_cr) = if lower.ends_with("dr") {
        (&cleaned[..cleaned.len() - 2], Some("dr"))
    } else if lower.ends_with("cr") {
        (&cleaned[..cleaned.len() - 2], Some("cr"))
    } else {
        (cleaned.as_str(), None)
    };
    if dr_cr == Some("cr") {
        negative = !negative;
    }
    body = body.trim();
    if let Some(stripped) = body.strip_prefix('+') {
        body = stripped;
    }
    if let Some(stripped) = body.strip_prefix('-') {
        negative = !negative;
        body = stripped;
    }

    let body = if body.starts_with('.') {
        format!("0{body}")
    } else {
        body.to_string()
    };
    if body.is_empty() || !body.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return Err(EngineError::InvalidAmount(input.to_string()));
    }
    let mut parts = body.split('.');
    let whole_part = parts.next().unwrap_or("0");
    let fraction_part = parts.next().unwrap_or("");
    if parts.next().is_some() {
        return Err(EngineError::InvalidAmount(input.to_string()));
    }

    let whole: i128 = whole_part
        .parse()
        .map_err(|_| EngineError::InvalidAmount(input.to_string()))?;
    let factor = 10_i128.pow(minor_unit);
    let mut minor = whole * factor;

    if minor_unit > 0 && !fraction_part.is_empty() {
        // Keep one guard digit beyond the minor unit so we can round. Any
        // non-zero digits after the guard mean the value is strictly greater
        // than the half step, which matters for half-even rounding.
        let keep = minor_unit as usize + 1;
        let head: String = fraction_part.chars().take(keep).collect();
        let padded = format!("{:0<width$}", head, width = keep);
        let guard = padded
            .chars()
            .last()
            .and_then(|c| c.to_digit(10))
            .unwrap_or(0);
        let fractional: i128 = padded[..padded.len() - 1].parse().unwrap_or(0);
        minor += fractional;

        let trailing_non_zero = fraction_part.chars().skip(keep).any(|c| c != '0');
        if guard > 0 || trailing_non_zero {
            let round_up = match guard.cmp(&5) {
                std::cmp::Ordering::Greater => true,
                std::cmp::Ordering::Less => false,
                std::cmp::Ordering::Equal => {
                    if trailing_non_zero {
                        true
                    } else {
                        match mode {
                            RoundingMode::HalfUp => true,
                            RoundingMode::HalfEven => minor % 2 == 1,
                        }
                    }
                }
            };
            if round_up {
                minor += 1;
            }
        }
    }

    if negative {
        minor = -minor;
    }
    i64::try_from(minor).map_err(|_| EngineError::AmountOverflow(input.to_string()))
}

/// Export-friendly decimal string with no grouping or symbol.
pub fn minor_to_decimal_string(minor: Minor, minor_unit: u32) -> String {
    let sign = if minor < 0 { "-" } else { "" };
    let abs = minor.unsigned_abs();
    let factor = 10_u64.pow(minor_unit);
    let whole = abs / factor;
    let fraction = abs % factor;
    if minor_unit == 0 {
        format!("{sign}{whole}")
    } else {
        format!(
            "{sign}{whole}.{:0width$}",
            fraction,
            width = minor_unit as usize
        )
    }
}

/// Human-readable decimal string (alias kept for shell symmetry with the TS API).
pub fn format_minor(minor: Minor, minor_unit: u32) -> String {
    minor_to_decimal_string(minor, minor_unit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_grouped_and_negative_amounts() {
        assert_eq!(
            parse_amount_to_minor("1,23,456.78", 2, RoundingMode::HalfUp).unwrap(),
            12_345_678
        );
        assert_eq!(
            parse_amount_to_minor("(₹ 1,000.50)", 2, RoundingMode::HalfUp).unwrap(),
            -100_050
        );
        assert_eq!(
            parse_amount_to_minor("500.00 Cr", 2, RoundingMode::HalfUp).unwrap(),
            -50_000
        );
        assert_eq!(
            parse_amount_to_minor("99.999", 2, RoundingMode::HalfUp).unwrap(),
            10_000
        );
    }

    #[test]
    fn rounds_half_up_and_half_even() {
        assert_eq!(round_to_step(105, 10, RoundingMode::HalfUp).unwrap(), 110);
        assert_eq!(round_to_step(105, 10, RoundingMode::HalfEven).unwrap(), 100);
        assert_eq!(round_to_step(-105, 10, RoundingMode::HalfUp).unwrap(), -110);
        assert_eq!(
            round_to_step(-105, 10, RoundingMode::HalfEven).unwrap(),
            -100
        );
    }

    #[test]
    fn half_even_considers_digits_after_the_guard() {
        assert_eq!(
            parse_amount_to_minor("0.0051", 2, RoundingMode::HalfEven).unwrap(),
            1
        );
        assert_eq!(
            parse_amount_to_minor("0.0049", 2, RoundingMode::HalfEven).unwrap(),
            0
        );
        assert_eq!(
            parse_amount_to_minor("1.0051", 2, RoundingMode::HalfEven).unwrap(),
            101
        );
        assert_eq!(
            parse_amount_to_minor("1.005", 2, RoundingMode::HalfEven).unwrap(),
            100
        );
        assert_eq!(
            parse_amount_to_minor("1.015", 2, RoundingMode::HalfEven).unwrap(),
            102
        );
    }

    #[test]
    fn allocation_sums_exactly() {
        let parts = allocate_minor(1000, &[1, 1, 1]).unwrap();
        assert_eq!(parts, vec![334, 333, 333]);
        assert_eq!(parts.iter().sum::<i64>(), 1000);
    }

    #[test]
    fn formats_minor_units() {
        assert_eq!(minor_to_decimal_string(-123_456, 2), "-1234.56");
        assert_eq!(minor_to_decimal_string(7, 0), "7");
    }
}
