use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("invalid amount: {0}")]
    InvalidAmount(String),
    #[error("amount overflow: {0}")]
    AmountOverflow(String),
    #[error("invalid rounding step: {0}")]
    InvalidStep(i64),
    #[error("cannot allocate across zero weights")]
    ZeroWeights,
    #[error("invalid date: {0}")]
    InvalidDate(String),
    #[error("validation failed: {0}")]
    ValidationFailed(String),
}

pub type EngineResult<T> = Result<T, EngineError>;
