/// Window presentation only. Never used as an execution/permission decision.
pub fn dimensions(mode: &str) -> Result<(f64, f64), &'static str> {
    match mode {
        "launcher" => Ok((780.0, 700.0)),
        "companion" => Ok((560.0, 840.0)),
        "workspace" => Ok((1440.0, 920.0)),
        _ => Err("Unknown entry presentation mode"),
    }
}

#[cfg(test)]
mod tests {
    use super::dimensions;
    #[test]
    fn modes_are_bounded_and_unknown_modes_rejected() {
        assert_eq!(dimensions("launcher"), Ok((780.0, 700.0)));
        assert_eq!(dimensions("companion"), Ok((560.0, 840.0)));
        assert_eq!(dimensions("workspace"), Ok((1440.0, 920.0)));
        assert!(dimensions("full_access").is_err());
        assert!(dimensions("").is_err());
    }
}
