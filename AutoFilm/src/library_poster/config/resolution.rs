use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum Resolution {
    P480,
    P720,
    P1080,
    Custom { width: u32, height: u32 },
}

impl Default for Resolution {
    fn default() -> Self {
        Self::P1080
    }
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum ResolutionRepr {
    Preset(String),
    Custom { width: u32, height: u32 },
}

impl Serialize for Resolution {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::P480 => ResolutionRepr::Preset("480p".to_string()),
            Self::P720 => ResolutionRepr::Preset("720p".to_string()),
            Self::P1080 => ResolutionRepr::Preset("1080p".to_string()),
            Self::Custom { width, height } => ResolutionRepr::Custom {
                width: *width,
                height: *height,
            },
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Resolution {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let resolution = match ResolutionRepr::deserialize(deserializer)? {
            ResolutionRepr::Preset(value) => match value.as_str() {
                "480p" => Self::P480,
                "720p" => Self::P720,
                "1080p" => Self::P1080,
                _ => return Err(de::Error::custom(format!("不支持的分辨率预设: {value}"))),
            },
            ResolutionRepr::Custom { width, height } => Self::Custom { width, height },
        };

        resolution.dimensions().map_err(de::Error::custom)?;
        Ok(resolution)
    }
}

impl Resolution {
    /// 将配置分辨率转换为图像库使用的宽高。
    ///
    /// 自定义尺寸会拒绝零值，避免创建无效画布。
    pub fn dimensions(self) -> Result<(u32, u32), String> {
        match self {
            Self::P480 => Ok((854, 480)),
            Self::P720 => Ok((1280, 720)),
            Self::P1080 => Ok((1920, 1080)),
            Self::Custom { width: 0, .. } | Self::Custom { height: 0, .. } => {
                Err("自定义分辨率的宽高必须大于零".to_string())
            }
            Self::Custom { width, height } => Ok((width, height)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_preset_and_custom_resolutions() {
        let preset: Resolution = serde_yaml::from_str("1080p").unwrap();
        let custom: Resolution = serde_yaml::from_str("{width: 1600, height: 900}").unwrap();

        assert_eq!(preset, Resolution::P1080);
        assert_eq!(preset.dimensions().unwrap(), (1920, 1080));
        assert_eq!(
            custom,
            Resolution::Custom {
                width: 1600,
                height: 900
            }
        );
        assert_eq!(custom.dimensions().unwrap(), (1600, 900));
    }

    #[test]
    fn serializes_custom_resolution_with_named_dimensions() {
        let yaml = serde_yaml::to_string(&Resolution::Custom {
            width: 1600,
            height: 900,
        })
        .unwrap();

        assert!(!yaml.contains("custom"));
        assert!(yaml.contains("width: 1600"));
        assert!(yaml.contains("height: 900"));
    }

    #[test]
    fn rejects_invalid_custom_resolution() {
        let zero = serde_yaml::from_str::<Resolution>("{width: 0, height: 1080}");

        assert!(zero.is_err());
    }
}
