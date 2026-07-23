//! Thin styling helpers over `console`, which handles tty detection, `NO_COLOR`,
//! and enabling ANSI on Windows automatically.

use console::style;

pub fn ok(s: &str) -> String {
    style(s).green().to_string()
}

pub fn warn(s: &str) -> String {
    style(s).yellow().to_string()
}

pub fn err(s: &str) -> String {
    style(s).red().to_string()
}

/// Bold cyan — used for titles/headers.
pub fn title(s: &str) -> String {
    style(s).cyan().bold().to_string()
}

/// Cyan — used for values worth highlighting (package name, binding).
pub fn accent(s: &str) -> String {
    style(s).cyan().to_string()
}

pub fn dim(s: &str) -> String {
    style(s).dim().to_string()
}
