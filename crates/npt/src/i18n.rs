//! Tiny locale-aware string picker.
//!
//! UI/guidance text is localized (currently English + Simplified Chinese);
//! **error messages deliberately stay English** so technical details remain
//! searchable. Language is detected once from `NPT_LANG` (override) or the system
//! locale (`zh*` → Chinese).

use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Zh,
}

static LANG: OnceLock<Lang> = OnceLock::new();

pub fn lang() -> Lang {
    *LANG.get_or_init(detect)
}

pub fn is_zh() -> bool {
    lang() == Lang::Zh
}

fn detect() -> Lang {
    if let Ok(v) = std::env::var("NPT_LANG") {
        let v = v.to_lowercase();
        if v.starts_with("zh") {
            return Lang::Zh;
        }
        if v.starts_with("en") {
            return Lang::En;
        }
    }
    match sys_locale::get_locale() {
        Some(l) if l.to_lowercase().starts_with("zh") => Lang::Zh,
        _ => Lang::En,
    }
}

/// Pick a static string by the active language.
pub fn t(en: &'static str, zh: &'static str) -> &'static str {
    if is_zh() {
        zh
    } else {
        en
    }
}
