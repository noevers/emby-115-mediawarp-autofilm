use std::collections::HashMap;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct User {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Library {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub collection_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct MediaItem {
    pub id: String,
    #[serde(rename = "Type", default)]
    pub item_type: String,
    #[serde(default)]
    pub series_id: Option<String>,
    #[serde(default)]
    pub series_primary_image_tag: Option<String>,
    #[serde(default)]
    pub parent_backdrop_item_id: Option<String>,
    #[serde(default)]
    pub parent_backdrop_image_tags: Vec<String>,
    #[serde(default)]
    pub backdrop_image_tags: Vec<String>,
    #[serde(default)]
    pub image_tags: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum ImageKind {
    Primary,
    Backdrop,
}

impl ImageKind {
    pub(crate) fn path(self) -> &'static str {
        match self {
            Self::Primary => "Primary",
            Self::Backdrop => "Backdrop/0",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct QueryResult<T> {
    pub items: Vec<T>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_media_item_image_metadata() {
        let item: MediaItem = serde_json::from_str(
            r#"{
                "Id": "episode",
                "Type": "Episode",
                "SeriesId": "series",
                "SeriesPrimaryImageTag": "primary-tag",
                "ParentBackdropItemId": "series",
                "ParentBackdropImageTags": ["backdrop-tag"],
                "ImageTags": {"Primary": "episode-tag"}
            }"#,
        )
        .unwrap();

        assert_eq!(item.item_type, "Episode");
        assert_eq!(item.series_id.as_deref(), Some("series"));
        assert_eq!(
            item.parent_backdrop_image_tags.first().map(String::as_str),
            Some("backdrop-tag")
        );
    }
}
